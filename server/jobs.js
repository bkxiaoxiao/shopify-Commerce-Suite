import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInvoiceSnapshot } from './domain/documents.js';
import { buildRestockJobs, isSellable, renderRestockEmail } from './domain/restock.js';
import {generatePdf} from './pdf.js';
import { orderFromWebhook, creditFromWebhook } from './order-adapter.js';

const PDF_FONT = fileURLToPath(new URL('./assets/fonts/NotoSansSC.ttf', import.meta.url));
const PRIVATE_TOPICS = new Set(['customers/data_request', 'customers/redact', 'shop/redact']);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const shortId = value => String(value ?? '').split('/').at(-1);
const stableJson = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const email = value => {
  if (typeof value !== 'string' || value.length > 254 || /[\u0000-\u001f\u007f]/.test(value) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)) throw new Error('A valid single email recipient is required');
  return value.trim().toLowerCase();
};

export async function documentSettings(store, shopId) {
  const state = await store.get(shopId, `commerce-documents-${shopId}`, {});
  const settings = state?.settings ?? {};
  return {
    ...settings,
    seller: structuredClone(settings.seller ?? settings.legalEntity ?? state?.seller ?? state?.entity ?? {}),
    language: settings.language ?? 'en',
    automaticInvoices: settings.automaticInvoices === true,
    automaticEmail: settings.automaticEmail === true,
    automaticCreditNotes: settings.automaticCreditNotes === true || settings.creditNotes === true,
  };
}

function onlineQuantity(data) {
  if (!Array.isArray(data?.inventoryLevels) || data.tracked === false || data.inventoryLevelsTruncated === true) return null;
  let quantity = 0;
  for (const level of data.inventoryLevels) {
    if (typeof level.isActive !== 'boolean' || typeof level.location?.isActive !== 'boolean' || typeof level.location?.fulfillsOnlineOrders !== 'boolean') return null;
    if (level.isActive && level.location.isActive && level.location.fulfillsOnlineOrders) {
      const value = level.available ?? level.quantities?.find(entry => entry.name === 'available')?.quantity;
      if (!Number.isSafeInteger(value)) return null;
      quantity += Math.max(0, value);
    }
  }
  return Number.isSafeInteger(quantity) ? quantity : null;
}

function variantFor(data, available, market) {
  return {
    id: data.variantId ?? data.id, inventoryItemId: data.inventoryItemId,
    inventoryItem: { tracked: data.tracked }, inventoryPolicy: data.inventoryPolicy,
    published: Boolean(available?.id && available?.availableForSale),
    availableForSale: available?.availableForSale === true,
    contextualAvailability: { [market]: Boolean(available?.id && available?.availableForSale) },
    product: { status: data.status ?? 'ACTIVE' },
  };
}

export function createJobRunner({ config, store, shopify, fetchImpl = fetch }) {
  function configuredShop(shopId) {
    const shop = config.stores.find(value => value.id === shopId);
    if (!shop) throw new Error('The configured store no longer exists');
    return shop;
  }
  async function active(shopId) {
    const installation = await store.installation(shopId);
    if (!installation?.active || !installation.token_cipher) throw new Error('Shopify installation is inactive; reconnect before processing this job');
  }
  async function restockEnabled(shopId) {
    const state = await store.get(shopId, `commerce-restock-${shopId}`, {});
    if (state?.automatic !== true) {
      const error = new Error('Automatic restock notifications are paused');
      error.code = 'AUTOMATION_PAUSED'; throw error;
    }
  }
  async function product(shopId, variantId) {
    return (await store.pool.query('SELECT data FROM products WHERE shop_id=$1 AND id=$2', [shopId, variantId])).rows[0]?.data ?? null;
  }
  async function rememberStock(shopId, id, quantity, job, baselineOnly = false) {
    if (quantity == null) return;
    await store.transaction(async client => {
      const key = `restock-stock:${id}`;
      await client.query('INSERT INTO app_state(shop_id,key,value) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [shopId, key, JSON.stringify({ quantity })]);
      if (baselineOnly) return;
      const row = (await client.query('SELECT value FROM app_state WHERE shop_id=$1 AND key=$2 FOR UPDATE', [shopId, key])).rows[0];
      if (row?.value?.quantity === 0 && quantity > 0) {
        const cycleId = `stock-cycle:${hash(`${job.id}:${id}`)}`;
        await store.enqueue(shopId, 'restock-scan', { variantId: id, cycleId }, `restock-scan:${cycleId}`, client);
      }
      await client.query('UPDATE app_state SET value=$3,revision=revision+1,updated_at=now() WHERE shop_id=$1 AND key=$2', [shopId, key, JSON.stringify({ quantity })]);
    });
  }
  async function sync(job) {
    await active(job.shop_id);
    if (job.payload.resource && job.payload.resource !== 'products') throw new Error('This sync resource is not implemented');
    const prior = await store.list('products', job.shop_id);
    // Baselines are persisted before Shopify mutates the cache. If the sync
    // dies after upserting products, a retry still observes the stock crossing.
    for (const row of prior) await rememberStock(job.shop_id, row.id, onlineQuantity(row.data), job, true);
    const count = await shopify.syncProducts(job.shop_id, job.payload.cursor ?? null);
    const current = await store.list('products', job.shop_id);
    for (const row of current) await rememberStock(job.shop_id, row.id, onlineQuantity(row.data), job);
    return { products: count };
  }
  async function scan(job) {
    await active(job.shop_id);
    await restockEnabled(job.shop_id);
    const data = await product(job.shop_id, job.payload.variantId);
    if (!data) return { skipped: 'variant_removed' };
    const subscribers = (await store.pool.query('SELECT * FROM subscriptions WHERE shop_id=$1 AND variant_id=$2 AND active=true', [job.shop_id, job.payload.variantId])).rows;
    let queued = 0;
    for (const market of [...new Set(subscribers.map(row => row.market))]) {
      if (!/^[A-Z]{2}$/.test(market)) throw new Error('Restock subscriptions require an ISO country market');
      const availability = await shopify.contextualAvailability(job.shop_id, job.payload.variantId, market);
      const variant = variantFor(data, availability, market);
      const jobs = buildRestockJobs({ subscriptions: subscribers.filter(row => row.market === market).map(row => ({ ...row.data, id: row.id, email: row.email, variantId: row.variant_id, market: row.market, shopId: job.shop_id, status: row.data.status ?? 'active' })), variant, inventoryLevels: data.inventoryLevels, market, restockCycleId: job.payload.cycleId });
      for (const notification of jobs) {
        await store.enqueue(job.shop_id, 'restock-email', { subscriptionId: notification.subscriptionId, variantId: notification.variantId, market, cycleId: job.payload.cycleId }, notification.id);
        queued++;
      }
    }
    return { queued };
  }
  async function cacheMessage(job, message) {
    const stable = job.payload.message ?? message;
    const checkWindow = value => {
      const started = Date.parse(value);
      if (!Number.isFinite(started) || started > Date.now() + 60000) {
        const error = new Error('Stored delivery state has an invalid first-attempt timestamp');
        error.code = 'INVALID_DELIVERY_STATE'; throw error;
      }
      if (Date.now() - started >= 23 * 3600000) {
        const error = new Error('The safe email retry window expired; review provider records before creating a new delivery request');
        error.code = 'DELIVERY_WINDOW_EXPIRED'; throw error;
      }
    };
    if (job.payload.deliveryStartedAt) checkWindow(job.payload.deliveryStartedAt);
    const startedAt = job.payload.deliveryStartedAt ?? new Date().toISOString();
    const result = await store.pool.query("UPDATE jobs SET payload=payload || jsonb_build_object('message',$3::jsonb,'deliveryStartedAt',COALESCE(payload->>'deliveryStartedAt',$4::text)),lease_until=now()+interval '3 minutes' WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id,payload->>'deliveryStartedAt' AS delivery_started_at", [job.id, job.lease_token, JSON.stringify(stable), startedAt]);
    if (!result.rows.length) throw new Error('Job lease was lost; no outbound message was sent');
    checkWindow(result.rows[0].delivery_started_at);
    return stable;
  }
  async function send(job, message) {
    if (config.mode === 'demo') throw new Error('Demo mode does not send external email');
    if (!config.resendApiKey || !config.mailFrom) throw new Error('Email provider and verified sender must be configured');
    const stable = await cacheMessage(job, message);
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `commerce-suite/${hash(job.id)}` },
      body: stableJson(stable),
    });
    if (!response.ok) throw new Error(`Email provider rejected this delivery (${response.status})`);
    const result = await response.json();
    if (!result.id) throw new Error('Email provider did not return a confirmed delivery request ID');
    return result.id;
  }
  async function documentEmail(job) {
    await active(job.shop_id);
    const document = await store.document(job.shop_id, job.payload.documentId);
    if (!document) throw new Error('Document no longer exists');
    const snapshot = document.snapshot;
    const to = email(job.payload.to ?? snapshot.customer.email);
    let message = job.payload.message;
    if (!message) {
      if (!config.resendApiKey || !config.mailFrom || config.mode === 'demo') throw new Error('Real email is not configured for this environment');
      const pdf = await generatePdf(snapshot, { font: config.pdfFontPath ?? PDF_FONT });
      const name = `${snapshot.type === 'credit' ? 'Credit note' : snapshot.type === 'quote' ? 'Quotation' : 'Invoice'} ${snapshot.number}`;
      message = { from: config.mailFrom, to: [to], subject: name, html: `<p>${escape(name)}</p><p>${escape(snapshot.seller.name)}</p><p>Your document is attached as a PDF.</p>`, text: `${name}\n${snapshot.seller.name}\nYour document is attached as a PDF.`, attachments: [{ filename: `${snapshot.number.replace(/[^a-zA-Z0-9._-]/g, '_')}.pdf`, content: pdf.toString('base64') }] };
    }
    const providerId = await send(job, message);
    await store.audit(job.shop_id, 'document.email_accepted', { documentId: document.id, jobId: job.id, providerId });
    return { providerId, documentId: document.id };
  }
  function unsubscribeUrl(job, subscriptionId) {
    // Derive issuance from the durable job rather than wall-clock retries so
    // provider idempotency sees the exact same message after a process crash.
    const issued = Math.floor(new Date(job.created_at).getTime() / 1000);
    if (!Number.isFinite(issued)) throw new Error('Job creation timestamp is missing');
    const data = Buffer.from(JSON.stringify({ purpose: 'unsubscribe', shopId: job.shop_id, subscriptionId, exp: issued + 365 * 86400, iat: issued })).toString('base64url');
    const token = `${data}.${createHmac('sha256', config.authSecret).update(data).digest('base64url')}`;
    return `${config.appUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
  }
  async function restockEmail(job) {
    await active(job.shop_id);
    await restockEnabled(job.shop_id);
    const row = await store.subscription(job.shop_id, job.payload.subscriptionId);
    if (!row?.active || row.data.suppressed || row.data.unsubscribedAt) return { skipped: 'subscription_inactive' };
    if (row.variant_id !== job.payload.variantId || row.market !== job.payload.market) throw new Error('Restock job does not match its subscription');
    const data = await product(job.shop_id, row.variant_id);
    if (!data) return { skipped: 'variant_removed' };
    // Refresh inventory, not just cached stock: notifications can sit in a
    // durable queue after another buyer consumes the replenished units.
    const current = await shopify.graphql(job.shop_id, 'query RestockInventory($id:ID!){productVariant(id:$id){id inventoryPolicy product{status} inventoryItem{id tracked inventoryLevels(first:100){nodes{isActive location{id isActive fulfillsOnlineOrders} quantities(names:["available"]){name quantity}}pageInfo{hasNextPage}}}}}', { id: row.variant_id });
    const live = current?.productVariant;
    if (!live) return { skipped: 'variant_removed' };
    if (live.inventoryItem.inventoryLevels.pageInfo?.hasNextPage) throw new Error('Variant inventory has additional locations; complete inventory lookup is required');
    const availability = await shopify.contextualAvailability(job.shop_id, row.variant_id, row.market);
    const variant = variantFor({ ...data, ...live, status: live.product?.status, inventoryItemId: live.inventoryItem.id, tracked: live.inventoryItem.tracked }, availability, row.market);
    const levels = live.inventoryItem.inventoryLevels.nodes.map(level => ({ ...level, available: level.quantities.find(entry => entry.name === 'available')?.quantity }));
    if (!isSellable({ variant, inventoryLevels: levels, market: row.market })) return { skipped: 'not_currently_sellable' };
    const shop = configuredShop(job.shop_id);
    let message = job.payload.message;
    if (!message) {
      const rendered = renderRestockEmail({ subscription: { ...row.data, email: row.email, variantId: row.variant_id, market: row.market }, product: { title: availability.product?.title ?? data.name ?? data.title, variantTitle: data.variantTitle, handle: availability.product?.handle ?? data.handle, imageUrl: data.image }, shop: { name: shop.name, domain: shop.domain }, unsubscribeUrl: unsubscribeUrl(job, row.id) });
      message = { from: config.mailFrom, to: [email(row.email)], ...rendered };
    }
    const providerId = await send(job, message);
    await store.pool.query("UPDATE subscriptions SET active=false,data=data || jsonb_build_object('status','sent','lastNotifiedCycleId',$3::text,'notifiedAt',$4::text) WHERE shop_id=$1 AND id=$2", [job.shop_id, row.id, job.payload.cycleId, new Date().toISOString()]);
    await store.audit(job.shop_id, 'restock.email_accepted', { subscriptionId: row.id, jobId: job.id, providerId });
    return { subscriptionId: row.id, providerId };
  }
  async function privacy(job, topic, data) {
    const requestId = `privacy:${hash(job.id)}`;
    if (topic === 'customers/data_request') {
      await store.set(job.shop_id, requestId, { topic, status: 'requires_secure_admin_export', requestId: String(data.data_request?.id ?? ''), customerId: String(data.customer?.id ?? ''), requestedAt: new Date().toISOString() });
    } else if (topic === 'customers/redact') {
      const targetEmail = typeof data.customer?.email === 'string' ? data.customer.email.trim().toLowerCase() : null;
      const orderIds = Array.isArray(data.orders_to_redact) ? data.orders_to_redact.map(value => shortId(value)) : [];
      await store.transaction(async client => {
        const removed = targetEmail ? (await client.query('DELETE FROM subscriptions WHERE shop_id=$1 AND lower(email)=$2 RETURNING id', [job.shop_id, targetEmail])).rows : [];
        await client.query("DELETE FROM orders WHERE shop_id=$1 AND (regexp_replace(id,'^.*/','')=ANY($2::text[]) OR ($3::text IS NOT NULL AND lower(data->'customer'->>'email')=$3))", [job.shop_id, orderIds, targetEmail]);
        await client.query("UPDATE jobs SET status='cancelled',payload=jsonb_build_object('redacted',true),last_error=NULL,lease_token=NULL,lease_until=NULL WHERE shop_id=$1 AND id<>$2 AND ((kind='restock-email' AND payload->>'subscriptionId'=ANY($3::text[])) OR (kind='document-email' AND lower(payload->>'to')=$4) OR (kind='webhook' AND status IN('done','failed','cancelled')))", [job.shop_id, job.id, removed.map(row => row.id), targetEmail]);
      });
      await store.set(job.shop_id, requestId, { topic, status: 'financial_retention_review_required', orderIds, customerId: String(data.customer?.id ?? ''), requestedAt: new Date().toISOString(), reason: 'Issued financial records retain their immutable snapshot pending the company tax-retention policy.' });
    } else {
      await store.transaction(async client => {
        for (const table of ['subscriptions', 'products', 'orders', 'installations', 'oauth_nonces', 'app_state']) await client.query(`DELETE FROM ${table} WHERE shop_id=$1`, [job.shop_id]);
        await client.query("UPDATE jobs SET status='cancelled',payload=jsonb_build_object('redacted',true),last_error=NULL,lease_token=NULL,lease_until=NULL WHERE shop_id=$1 AND id<>$2", [job.shop_id, job.id]);
        await client.query("UPDATE audit_log SET metadata=jsonb_build_object('redacted',true) WHERE shop_id=$1", [job.shop_id]);
      });
      await store.set(job.shop_id, requestId, { topic, status: 'financial_retention_review_required', requestedAt: new Date().toISOString(), reason: 'Issued financial records require a documented retention decision.' });
    }
    await store.pool.query("UPDATE jobs SET payload=jsonb_build_object('topic',$2::text,'redacted',true) WHERE id=$1", [job.id, topic]);
    await store.audit(job.shop_id, 'privacy.request_processed', { topic, requestKey: requestId, followUp: true });
    return { processed: true, manualReview: true };
  }
  async function webhook(job) {
    const { topic, data } = job.payload;
    if (PRIVATE_TOPICS.has(topic)) return privacy(job, topic, data ?? {});
    if (topic === 'app/uninstalled') {
      await store.pool.query('UPDATE installations SET active=false,token_cipher=NULL,carrier_token=NULL,updated_at=now() WHERE shop_id=$1', [job.shop_id]);
      await store.pool.query("UPDATE jobs SET status='cancelled',lease_until=NULL,lease_token=NULL WHERE shop_id=$1 AND id<>$2 AND status IN('pending','running') AND kind<>'webhook'", [job.shop_id, job.id]);
      await store.audit(job.shop_id, 'shopify.uninstalled');
      return { deactivated: true };
    }
    await active(job.shop_id);
    if (topic === 'orders/paid') {
      const settings = await documentSettings(store, job.shop_id);
      const order = orderFromWebhook(data);
      await store.upsert('orders', job.shop_id, order.id, order);
      if (!settings.automaticInvoices) return { skipped: 'automatic_invoices_disabled' };
      const document = await store.createDocument(job.shop_id, `invoice:${shortId(order.id)}`, 'invoice', number => createInvoiceSnapshot({ order, settings, number }));
      if (settings.automaticEmail && document.snapshot.customer.email) await store.enqueue(job.shop_id, 'document-email', { documentId: document.id, to: document.snapshot.customer.email }, `document-email:${job.shop_id}:${document.id}`);
      await store.audit(job.shop_id, 'invoice.issued', { documentId: document.id, orderId: order.id });
      return { documentId: document.id };
    }
    if (topic === 'refunds/create') {
      const settings = await documentSettings(store, job.shop_id);
      if (!settings.automaticCreditNotes) return { skipped: 'automatic_credit_notes_disabled' };
      const orderId = shortId(data.order_id);
      const original = (await store.pool.query("SELECT * FROM documents WHERE shop_id=$1 AND snapshot->>'type'='invoice' AND (snapshot->>'orderId'=$2 OR snapshot->>'orderId'=$3) ORDER BY created_at LIMIT 1", [job.shop_id, orderId, `gid://shopify/Order/${orderId}`])).rows[0];
      if (!original) throw new Error('Original invoice is not available yet; retry before creating the credit');
      const order = creditFromWebhook(data, original.snapshot);
      const document = await store.createDocument(job.shop_id, `refund:${shortId(order.refundId)}`, 'credit', number => createInvoiceSnapshot({ order, settings: { ...settings, seller: original.snapshot.seller, language: original.snapshot.language }, number, type: 'credit' }));
      if (settings.automaticEmail && document.snapshot.customer.email) await store.enqueue(job.shop_id, 'document-email', { documentId: document.id, to: document.snapshot.customer.email }, `document-email:${job.shop_id}:${document.id}`);
      await store.audit(job.shop_id, 'credit.issued', { documentId: document.id, refundId: order.refundId });
      return { documentId: document.id };
    }
    if (topic === 'products/delete') await store.pool.query("DELETE FROM products WHERE shop_id=$1 AND (data->>'productId'=$2 OR data->>'productId'=$3)", [job.shop_id, String(data.id), `gid://shopify/Product/${data.id}`]);
    if (topic?.startsWith('products/') || topic?.startsWith('inventory_levels/') || topic?.startsWith('inventory_items/')) {
      await store.enqueue(job.shop_id, 'sync', { resource: 'products' }, `webhook-sync:${hash(job.id)}`);
      return { syncQueued: true };
    }
    return { skipped: 'topic_not_implemented' };
  }
  return async function run(limit = 5) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new Error('Job limit must be an integer between 1 and 5');
    const deadline = Date.now() + 55000;
    const results = [];
    for (let processed = 0; processed < limit && Date.now() < deadline; processed++) {
      const [job] = await store.claim(1);
      if (!job) break;
      try {
        const lease = await store.pool.query("UPDATE jobs SET lease_until=now()+interval '3 minutes' WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id", [job.id, job.lease_token]);
        if (!lease.rows.length) throw new Error('Job lease was lost before processing');
        let result;
        if (job.kind === 'webhook') result = await webhook(job);
        else if (job.kind === 'sync' || job.kind === 'sync-products') result = await sync(job);
        else if (job.kind === 'restock-scan') result = await scan(job);
        else if (job.kind === 'document-email') result = await documentEmail(job);
        else if (job.kind === 'restock-email') result = await restockEmail(job);
        else throw new Error('Unknown durable job kind');
        await store.finish(job);
        results.push({ id: job.id, kind: job.kind, status: 'done', result });
      } catch (error) {
        if (error.code === 'AUTOMATION_PAUSED') {
          await store.pool.query("UPDATE jobs SET status='pending',attempts=GREATEST(0,attempts-1),run_at=now()+interval '5 minutes',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2", [job.id, job.lease_token]);
          results.push({ id: job.id, kind: job.kind, status: 'paused' });
          continue;
        }
        // Preserve operational details in the private retry record; HTTP callers
        // receive a code, never recipient addresses or raw Shopify payloads.
        await store.finish(job, error);
        results.push({ id: job.id, kind: job.kind, status: 'retry_or_failed', errorCode: error.code ?? 'JOB_FAILED' });
      }
    }
    return { claimed: results.length, results };
  };
}
