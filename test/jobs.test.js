import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStore } from '../server/store.js';
import { createJobRunner, documentSettings } from '../server/jobs.js';
import { createInvoiceSnapshot } from '../server/domain/documents.js';

const variantId = 'gid://shopify/ProductVariant/123';
const inventory = (available = 1, active = true) => [{ isActive: active, available, quantities: [{ name: 'available', quantity: available }], location: { id: 'gid://shopify/Location/1', isActive: true, fulfillsOnlineOrders: true } }];
const product = (available = 1) => ({ id: variantId, variantId, inventoryItemId: 'gid://shopify/InventoryItem/1', name: 'Training rack', handle: 'rack', status: 'ACTIVE', tracked: true, inventoryLevels: inventory(available) });
const config = { mode: 'production', production: false, appUrl: 'https://app.example', authSecret: 'test-auth-secret-32-characters-minimum', resendApiKey: 'test-only-key', mailFrom: 'Example <mail@example.com>', stores: [{ id: 'uk', name: 'Example UK', domain: 'example.myshopify.com', country: 'GB', currency: 'GBP' }] };
const seller = { name: 'Example Ltd', countryCode: 'GB', address: ['1 Example Street'], vatNumber: 'GB123456789' };
const canonical = () => ({ id: '123', name: '#123', currency: 'GBP', issuedAt: '2026-11-24', taxesIncluded: false, customer: { name: 'Emma Example', email: 'emma@example.com' }, lineItems: [{ id: '11', title: 'Training rack', quantity: 1, unitPriceMinor: 10000, taxMinor: 2000, taxRate: 0.2 }], totalMinor: 12000 });
const paid = () => ({ id: 123, name: '#123', financial_status: 'paid', currency: 'GBP', presentment_currency: 'GBP', taxes_included: false, created_at: '2026-11-24T03:00:00Z', email: 'emma@example.com', customer: { first_name: 'Emma', last_name: 'Example' }, line_items: [{ id: 11, title: 'Training rack', quantity: 1, price: '100.00', discount_allocations: [], tax_lines: [{ title: 'VAT', rate: 0.2, price: '20.00' }] }], shipping_lines: [], subtotal_price: '100.00', total_discounts: '0.00', total_tax: '20.00', total_price: '120.00' });

async function fixture(t) {
  const store = await createStore({ production: false });
  await store.init({ skipLock: true }); t.after(() => store.close());
  await store.saveInstallation('uk', 'test-encrypted-token-not-used-by-mock', 'test-carrier');
  await store.set('uk', 'commerce-restock-uk', { automatic: true });
  const shopify = {
    syncProducts: async () => 0,
    contextualAvailability: async () => ({ id: variantId, availableForSale: true, product: { id: 'gid://shopify/Product/1', title: 'Training rack', handle: 'rack' } }),
    graphql: async () => ({ productVariant: { id: variantId, inventoryPolicy: 'DENY', product: { status: 'ACTIVE' }, inventoryItem: { id: 'gid://shopify/InventoryItem/1', tracked: true, inventoryLevels: { nodes: inventory(), pageInfo: { hasNextPage: false } } } } }),
  };
  return { store, shopify };
}

test('automation defaults off and never invents a legal entity', async t => {
  const { store } = await fixture(t);
  const settings = await documentSettings(store, 'uk');
  assert.equal(settings.automaticInvoices, false); assert.equal(settings.automaticEmail, false);
  assert.deepEqual(settings.seller, {});
});

test('paid and refund deliveries create one immutable source document each', async t => {
  const { store, shopify } = await fixture(t);
  await store.set('uk', 'commerce-documents-uk', { settings: { seller, automaticInvoices: true, automaticCreditNotes: true, automaticEmail: false } });
  const runner = createJobRunner({ config, store, shopify, fetchImpl: () => { throw new Error('No email expected'); } });
  await store.enqueue('uk', 'webhook', { topic: 'orders/paid', data: paid() }, 'paid-a');
  await store.enqueue('uk', 'webhook', { topic: 'orders/paid', data: paid() }, 'paid-b');
  let result = await runner(5); assert.equal(result.results.filter(value => value.status === 'done').length, 2);
  let docs = await store.list('documents', 'uk'); assert.equal(docs.length, 1); const original = structuredClone(docs[0].snapshot);
  const data = { id: 55, order_id: 123, created_at: '2026-11-25', refund_line_items: [{ line_item_id: 11, quantity: 1, subtotal: '50.00', total_tax: '10.00' }], refund_shipping_lines: [], order_adjustments: [], transactions: [{ kind: 'refund', status: 'success', currency: 'GBP', amount: '60.00' }] };
  await store.enqueue('uk', 'webhook', { topic: 'refunds/create', data }, 'refund-a');
  await store.enqueue('uk', 'webhook', { topic: 'refunds/create', data }, 'refund-b');
  result = await runner(5); assert.ok(result.results.every(value => value.status === 'done'));
  docs = await store.list('documents', 'uk'); assert.equal(docs.length, 2);
  assert.deepEqual(docs.find(row => row.snapshot.type === 'invoice').snapshot, original);
  const credit = docs.find(row => row.snapshot.type === 'credit').snapshot;
  assert.equal(credit.totalMinor, -6000); assert.equal(credit.originalInvoiceNumber, original.number);
});

test('mail retries reuse the exact message and provider key after a post-send failure', async t => {
  const { store, shopify } = await fixture(t);
  const document = await store.createDocument('uk', 'invoice:123', 'invoice', number => createInvoiceSnapshot({ order: canonical(), settings: { seller }, number }));
  await store.enqueue('uk', 'document-email', { documentId: document.id, to: 'emma@example.com' }, 'document-mail-stable');
  const requests = [];
  const fetchImpl = async (url, options) => { requests.push({ url, key: options.headers['Idempotency-Key'], body: options.body }); return { ok: true, json: async () => ({ id: 'provider-request-1' }) }; };
  const audit = store.audit.bind(store); let crash = true;
  store.audit = async (...args) => { if (args[1] === 'document.email_accepted' && crash) { crash = false; throw new Error('Simulated process failure after provider acceptance'); } return audit(...args); };
  const runner = createJobRunner({ config, store, shopify, fetchImpl });
  assert.equal((await runner()).results[0].status, 'retry_or_failed');
  const startedAt = (await store.pool.query("SELECT payload->>'deliveryStartedAt' AS started_at FROM jobs WHERE id='document-mail-stable'")).rows[0].started_at;
  assert.ok(Number.isFinite(Date.parse(startedAt)));
  await store.pool.query("UPDATE jobs SET run_at=now() WHERE id='document-mail-stable'");
  assert.equal((await runner()).results[0].status, 'done');
  assert.equal((await store.pool.query("SELECT payload->>'deliveryStartedAt' AS started_at FROM jobs WHERE id='document-mail-stable'")).rows[0].started_at, startedAt);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].key, requests[1].key);
  assert.equal(createHash('sha256').update(requests[0].body).digest('hex'), createHash('sha256').update(requests[1].body).digest('hex'), 'Persisted mail body must remain byte-identical after JSONB storage');
  const attachment = JSON.parse(requests[0].body).attachments[0];
  assert.equal(Buffer.from(attachment.content, 'base64').subarray(0, 5).toString(), '%PDF-');
});

test('unknown or inactive live inventory never sends restock email', async t => {
  const { store, shopify } = await fixture(t); let sent = 0;
  await store.upsert('products', 'uk', variantId, product());
  const row = await store.subscribe('uk', { email: 'emma@example.com', variantId, market: 'GB', language: 'en', marketingConsent: false });
  for (const active of [false, undefined]) {
    shopify.graphql = async () => ({ productVariant: { id: variantId, product: { status: 'ACTIVE' }, inventoryItem: { id: 'gid://shopify/InventoryItem/1', tracked: true, inventoryLevels: { nodes: inventory(10, active), pageInfo: { hasNextPage: false } } } } });
    // inventory's default parameter would turn undefined into true, so explicitly remove it.
    if (active === undefined) shopify.graphql = async () => ({ productVariant: { id: variantId, product: { status: 'ACTIVE' }, inventoryItem: { id: 'gid://shopify/InventoryItem/1', tracked: true, inventoryLevels: { nodes: [{ ...inventory()[0], isActive: undefined }], pageInfo: { hasNextPage: false } } } } });
    await store.enqueue('uk', 'restock-email', { subscriptionId: row.id, variantId, market: 'GB', cycleId: `cycle-${String(active)}` }, `mail-${String(active)}`);
    const result = await createJobRunner({ config, store, shopify, fetchImpl: async () => { sent++; throw new Error('Must not send'); } })();
    assert.equal(result.results[0].result.skipped, 'not_currently_sellable');
  }
  assert.equal(sent, 0);
});

test('initial positive inventory does not notify; a durable zero-to-positive crossing does', async t => {
  const { store, shopify } = await fixture(t);
  await store.subscribe('uk', { email: 'emma@example.com', variantId, market: 'GB', language: 'en', marketingConsent: false });
  let available = 5;
  shopify.syncProducts = async () => { await store.upsert('products', 'uk', variantId, product(available)); return 1; };
  const runner = createJobRunner({ config, store, shopify, fetchImpl: () => { throw new Error('Separate delivery job is not run in this test'); } });
  await store.enqueue('uk', 'sync', { resource: 'products' }, 'sync-initial'); await runner(1);
  assert.equal((await store.list('jobs', 'uk')).filter(row => row.kind === 'restock-scan').length, 0);
  available = 0; await store.enqueue('uk', 'sync', { resource: 'products' }, 'sync-zero'); await runner(1);
  available = 3; await store.enqueue('uk', 'sync', { resource: 'products' }, 'sync-positive'); await runner(1);
  let rows = await store.list('jobs', 'uk'); assert.equal(rows.filter(row => row.kind === 'restock-scan').length, 1);
  await runner(1);
  rows = await store.list('jobs', 'uk'); assert.equal(rows.filter(row => row.kind === 'restock-email').length, 1);
});

test('missing provider configuration fails a mail job instead of recording a fake send', async t => {
  const { store, shopify } = await fixture(t);
  const doc = await store.createDocument('uk', 'invoice:123', 'invoice', number => createInvoiceSnapshot({ order: canonical(), settings: { seller }, number }));
  await store.enqueue('uk', 'document-email', { documentId: doc.id, to: 'emma@example.com' }, 'mail-without-provider');
  let sent = 0;
  const result = await createJobRunner({ config: { ...config, resendApiKey: undefined }, store, shopify, fetchImpl: async () => { sent++; } })();
  assert.equal(result.results[0].status, 'retry_or_failed'); assert.equal(sent, 0);
  assert.equal((await store.pool.query("SELECT count(*)::int AS count FROM audit_log WHERE action='document.email_accepted'")).rows[0].count, 0);
});

test('pausing restock preserves its pending work without spending retry attempts', async t => {
  const { store, shopify } = await fixture(t);
  await store.set('uk', 'commerce-restock-uk', { automatic: false });
  await store.upsert('products', 'uk', variantId, product());
  await store.enqueue('uk', 'restock-scan', { variantId, cycleId: 'paused-cycle' }, 'paused-scan');
  let checked = false;
  shopify.contextualAvailability = async () => { checked = true; throw new Error('Should not call Shopify while paused'); };
  const result = await createJobRunner({ config, store, shopify })();
  assert.equal(result.results[0].status, 'paused'); assert.equal(checked, false);
  const job = (await store.pool.query("SELECT status,attempts FROM jobs WHERE id='paused-scan'")).rows[0];
  assert.equal(job.status, 'pending'); assert.equal(job.attempts, 0);
});

test('a mail attempt older than the safe provider window never calls the provider again', async t => {
  const { store, shopify } = await fixture(t);
  const doc = await store.createDocument('uk', 'invoice:123', 'invoice', number => createInvoiceSnapshot({ order: canonical(), settings: { seller }, number }));
  const startedAt = new Date(Date.now() - 24 * 3600000).toISOString();
  await store.enqueue('uk', 'document-email', { documentId: doc.id, to: 'emma@example.com', deliveryStartedAt: startedAt, message: { from: config.mailFrom, to: ['emma@example.com'], subject: 'Previously attempted invoice', text: 'An actual prior delivery attempt is recorded.' } }, 'expired-delivery-window');
  let requests = 0;
  const result = await createJobRunner({ config, store, shopify, fetchImpl: async () => { requests++; return { ok: true, json: async () => ({ id: 'must-not-be-called' }) }; } })();
  assert.equal(requests, 0);
  assert.equal(result.results[0].errorCode, 'DELIVERY_WINDOW_EXPIRED');
  assert.equal((await store.pool.query("SELECT payload->>'deliveryStartedAt' AS started_at FROM jobs WHERE id='expired-delivery-window'")).rows[0].started_at, startedAt);
});
