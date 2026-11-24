import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createApplication } from '../server/application.js';
import { loadConfig } from '../server/config.js';
import { createStore } from '../server/store.js';

const count = async (store, sql, parameters = []) => Number((await store.pool.query(sql, parameters)).rows[0].count);

test('HTTP application enforces authentication, tenant boundaries and actual persisted workflows', { timeout: 45000 }, async (t) => {
  const apiSecret = randomBytes(32).toString('base64url');
  const password = randomBytes(24).toString('base64url');
  const taskSecret = randomBytes(32).toString('base64url');
  const stores = [
    { id: 'uk', name: 'Actual UK fixture', domain: 'actual-uk.myshopify.com', country: 'GB', currency: 'GBP' },
    { id: 'eu', name: 'Actual EU fixture', domain: 'actual-eu.myshopify.com', country: 'DE', currency: 'EUR' },
  ];
  const config = loadConfig({
    APP_MODE: 'production', APP_URL: 'https://application.integration.invalid',
    AUTH_SECRET: randomBytes(48).toString('base64url'), ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    DATABASE_URL: 'postgresql://fixture:fixture@localhost/integration_fixture',
    ADMIN_PASSWORD: password, INTERNAL_TASK_SECRET: taskSecret,
    STORES_JSON: JSON.stringify(stores), SHOPIFY_API_KEY: 'integration-client', SHOPIFY_API_SECRET: apiSecret, SHOPIFY_ADMIN_USER_IDS: '42',
  });
  // Production HTTP/auth behavior uses an explicitly injected PGlite store;
  // createStore(production) is separately tested to require PostgreSQL.
  const store = await createStore(loadConfig({ APP_MODE: 'demo' }));
  await store.init({ skipLock: true });
  let workerCalls = 0;
  const availability = new Map();
  const shopify = {
    findShop: (domain) => config.stores.find((entry) => entry.domain === domain),
    credentials: (domain) => config.credentialsFor(domain),
    begin: async (id) => ({ cookie: 'cs_oauth=fixture; HttpOnly; Path=/auth', url: `https://${stores.find((entry) => entry.id === id).domain}/admin/oauth/authorize` }),
    contextualAvailability: async (_storeId, variantId, country) => availability.get(`${variantId}:${country}`) || null,
  };
  const server = createApplication({ config, store, shopify, runJobs: async (limit) => { workerCalls++; return { processed: 0, limit }; } });
  t.after(async () => {
    if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await store.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function request(path, { method = 'GET', body, headers = {}, authenticated = true, origin = config.appUrl } = {}) {
    const finalHeaders = { ...headers };
    if (method !== 'GET' && method !== 'HEAD' && origin) finalHeaders.Origin = origin;
    if (authenticated && cookie && !finalHeaders.Authorization) finalHeaders.Cookie = cookie;
    if (body !== undefined && typeof body !== 'string') { finalHeaders['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    return fetch(`${base}${path}`, { method, headers: finalHeaders, body });
  }
  function jwt(shop = stores[0].domain, sub = '42') {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ aud: 'integration-client', dest: `https://${shop}`, iss: `https://${shop}/admin`, sub, iat: now - 1, nbf: now - 1, exp: now + 120 })).toString('base64url');
    const signed = `${header}.${payload}`;
    return `${signed}.${createHmac('sha256', apiSecret).update(signed).digest('base64url')}`;
  }

  await t.test('static app assets load and production exposes no standalone prototype', async () => {
    const index = await request('/', { authenticated: false });
    assert.equal(index.status, 200);
    assert.match(await index.text(), /runtime-config\.js/);
    for (const path of ['/app.js', '/runtime.js', '/production.js', '/styles.css']) assert.equal((await request(path, { authenticated: false })).status, 200, `${path} loads`);
    assert.equal((await request('/standalone.html', { authenticated: false })).status, 404);
    assert.equal((await request('/runtime-config.js', { authenticated: false })).status, 200);
  });

  await t.test('production requires login and rejects wrong origins before changing data', async () => {
    assert.equal((await request('/api/bootstrap', { authenticated: false })).status, 401);
    assert.equal((await request('/api/login', { method: 'POST', authenticated: false, origin: 'https://unexpected.invalid', body: { password } })).status, 403);
    assert.equal((await request('/api/login', { method: 'POST', authenticated: false, body: { password: 'incorrect-password' } })).status, 401);
    const login = await request('/api/login', { method: 'POST', authenticated: false, body: { password } });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Lax/);
    cookie = setCookie.split(';')[0];
    const rejected = await request('/api/state/uk/shipping-rules-uk', { method: 'PUT', origin: 'https://unexpected.invalid', body: { value: [], revision: 0 } });
    assert.equal(rejected.status, 403);
    assert.equal(await store.get('uk', 'shipping-rules-uk'), null);
  });

  await t.test('empty bootstrap contains real empty collections and no fabricated results', async () => {
    const response = await request('/api/bootstrap?store=uk');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, 'production');
    for (const field of ['products', 'documents', 'subscriptions', 'jobs']) assert.deepEqual(body[field], []);
    assert.deepEqual(body.state, {});
    assert.equal(body.connection.connected, false);
    assert.equal(body.metrics.invoiceCount, 0);
    assert.equal(body.metrics.associatedSalesMinor, null);
    assert.equal(body.metrics.shippingSuccessRate, null);
    assert.equal(body.stores.length, 2);
  });

  await t.test('Shopify JWT is restricted to its own store and approved staff', async () => {
    const headers = { Authorization: `Bearer ${jwt()}` };
    const own = await request('/api/bootstrap?store=uk', { headers, authenticated: false });
    assert.equal(own.status, 200);
    assert.deepEqual((await own.json()).stores.map((entry) => entry.id), ['uk']);
    assert.equal((await request('/api/bootstrap?store=eu', { headers, authenticated: false })).status, 403);
    assert.equal((await request('/api/state/eu/shipping-rules-eu', { method: 'PUT', headers, authenticated: false, body: { value: [], revision: 0 } })).status, 403);
    assert.equal((await request('/api/bootstrap?store=uk', { headers: { Authorization: `Bearer ${jwt(stores[0].domain, 'unapproved-user')}` }, authenticated: false })).status, 403);
  });

  await t.test('OAuth establishes its state cookie only after a single-use top-level handoff', async () => {
    const connect = await request('/api/stores/eu/connect', { method: 'POST', body: {} });
    assert.equal(connect.status, 200);
    assert.equal(connect.headers.get('set-cookie'), null, 'iframe API responses must not depend on setting a third-party OAuth cookie');
    const handoff = new URL((await connect.json()).url);
    assert.equal(handoff.origin, config.appUrl); assert.equal(handoff.pathname, '/auth/start');
    assert.ok(handoff.searchParams.get('token'));
    const path = `${handoff.pathname}${handoff.search}`;
    const started = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(started.status, 303);
    assert.match(started.headers.get('set-cookie'), /^cs_oauth=/);
    assert.equal(new URL(started.headers.get('location')).hostname, stores[1].domain);
    assert.equal((await fetch(`${base}${path}`, { redirect: 'manual' })).status, 401, 'handoff replay is rejected');
    assert.equal((await request('/auth/start', { authenticated: false })).status, 401);
    assert.equal((await request('/auth/start?token=invalid', { authenticated: false })).status, 401);
  });

  await t.test('state writes use CAS including initial revision, isolate stores and validate domains', async () => {
    const path = '/api/state/uk/shipping-rules-uk';
    const initial = [{ id: 'gb-standard', name: 'GB standard', kind: 'weight', area: 'main', countries: ['GB'], min: 0, max: 20, price: 9.9, enabled: true }];
    const create = await request(path, { method: 'PUT', body: { value: initial, revision: 0 } });
    assert.equal(create.status, 200); assert.equal((await create.json()).revision, 1);
    assert.equal((await request(path, { method: 'PUT', body: { value: [], revision: 0 } })).status, 409);
    const update = await request(path, { method: 'PUT', body: { value: initial, revision: 1 } });
    assert.equal(update.status, 200); assert.equal((await update.json()).revision, 2);
    assert.equal(await store.get('eu', 'shipping-rules-eu'), null);
    assert.equal((await request('/api/state/eu/capabilities-eu', { method: 'PUT', body: { revision: 7, value: { plan: 'unknown', carrierAccess: false } } })).status, 409);
    assert.equal((await request(path, { method: 'PUT', body: { revision: 2, value: [{ ...initial[0], price: -10 }] } })).status, 400);
    const testRate = await request('/api/stores/uk/shipping/test', { method: 'POST', body: { destination: { country: 'GB', postal_code: 'SW1A 1AA' }, items: [{ grams: 1000, quantity: 1, price: 20000 }], currency: 'GBP' } });
    assert.equal(testRate.status, 200); assert.equal((await testRate.json()).rates[0].total_price, '990');
  });

  let documentId;
  await t.test('quote creation is persisted/idempotent and returns a real PDF with an embedded Chinese font', async () => {
    const settings = { seller: { name: '测试公司有限公司', address: ['伦敦测试地址', 'United Kingdom'], countryCode: 'GB', vatNumber: 'GB123456789', email: 'seller@example.com' }, language: 'zh-CN', automaticInvoices: false, automaticEmail: false };
    assert.equal((await request('/api/state/uk/commerce-documents-uk', { method: 'PUT', body: { revision: 0, value: { settings } } })).status, 200);
    const input = { customer: { name: '客户测试', email: 'customer@example.com' }, currency: 'GBP', lineItems: [{ title: '训练架 <script>alert(1)</script>', quantity: 2, unitPriceMinor: 10000, taxRate: 0.2 }] };
    const headers = { 'Idempotency-Key': 'quote-integration-fixture' };
    const created = await request('/api/stores/uk/quotes', { method: 'POST', body: input, headers });
    assert.equal(created.status, 201);
    const first = (await created.json()).document;
    documentId = first.id;
    assert.equal(first.snapshot.totalMinor, 24000);
    const retried = await request('/api/stores/uk/quotes', { method: 'POST', body: input, headers });
    assert.equal(retried.status, 201); assert.equal((await retried.json()).document.id, documentId);
    assert.equal(await count(store, 'SELECT count(*) FROM documents WHERE shop_id=$1', ['uk']), 1);
    const html = await request(`/api/stores/uk/documents/${documentId}.html`);
    assert.equal(html.status, 200);
    const markup = await html.text(); assert.ok(markup.includes('客户测试')); assert.ok(markup.includes('&lt;script&gt;')); assert.ok(!markup.includes('<script>alert'));
    const pdf = await request(`/api/stores/uk/documents/${documentId}.pdf`);
    assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(bytes.length > 10000); assert.match(bytes.toString('latin1'), /\/FontFile2\b/); assert.match(bytes.toString('latin1'), /NotoSansSC/);
    assert.equal((await request(`/api/stores/eu/documents/${documentId}.pdf`)).status, 404);
  });

  await t.test('missing mail configuration returns 412 and never claims delivery or enqueues mail', async () => {
    const before = await count(store, "SELECT count(*) FROM jobs WHERE kind='document-email'");
    const response = await request(`/api/stores/uk/documents/${documentId}/send`, { method: 'POST', body: { to: 'customer@example.com' } });
    assert.equal(response.status, 412);
    assert.equal(await count(store, "SELECT count(*) FROM jobs WHERE kind='document-email'"), before);
  });

  await t.test('signed webhooks acknowledge queued work without running it and deduplicate retries', async () => {
    const payload = JSON.stringify({ id: 123, email: 'event@example.com', total_price: '100.00' });
    const signature = createHmac('sha256', apiSecret).update(payload).digest('base64');
    const headers = { 'Content-Type': 'application/json', 'X-Shopify-Shop-Domain': stores[0].domain, 'X-Shopify-Topic': 'orders/paid', 'X-Shopify-Event-Id': 'event-integration-fixture', 'X-Shopify-Hmac-Sha256': signature };
    const started = performance.now();
    const first = await request('/webhooks', { method: 'POST', body: payload, headers, authenticated: false, origin: null });
    assert.equal(first.status, 200); assert.deepEqual(await first.json(), { received: true, duplicate: false });
    assert.ok(performance.now() - started < 2000, 'webhook acknowledges durable queue work promptly');
    assert.equal(workerCalls, 0, 'worker must not run inside the webhook request');
    const duplicate = await request('/webhooks', { method: 'POST', body: payload, headers, authenticated: false, origin: null });
    assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).duplicate, true);
    assert.equal(await count(store, "SELECT count(*) FROM jobs WHERE kind='webhook'"), 1);
    const unsigned = { ...headers }; delete unsigned['X-Shopify-Hmac-Sha256'];
    assert.equal((await request('/webhooks', { method: 'POST', body: payload, headers: unsigned, authenticated: false, origin: null })).status, 401);
    assert.equal((await request('/webhooks', { method: 'POST', body: JSON.stringify({ id: 999 }), headers, authenticated: false, origin: null })).status, 401);
    assert.equal(await count(store, 'SELECT count(*) FROM webhook_receipts'), 1);
  });

  await t.test('public recommendations preserve exact variant quantities and expose no private catalog/config fields', async () => {
    const sourceProduct = 'gid://shopify/Product/100'; const accessoryProduct = 'gid://shopify/Product/200';
    const variant = (number) => `gid://shopify/ProductVariant/${number}`;
    for (const number of [1, 2, 3, 4]) await store.upsert('products', 'uk', variant(number), {
      id: variant(number), variantId: variant(number), productId: number < 3 ? sourceProduct : accessoryProduct,
      name: number < 3 ? 'Training rack' : 'Bench', handle: number < 3 ? 'training-rack' : 'training-bench', variantTitle: number % 2 ? 'Red' : 'Blue',
      status: 'ACTIVE', inventoryQuantity: 20, priceMinor: 99999, currency: 'GBP', published: false,
      image: 'https://cdn.shopify.com/fixture.png', inventoryItemId: `private-item-${number}`,
      inventoryLevels: [{ location: { id: 'private-warehouse' }, available: 20 }], senderEmail: 'private-sender@example.com',
    });
    const red = { id: 'red-set', name: 'Red set', type: 'manual', enabled: true, products: [sourceProduct, accessoryProduct], members: [{ variantId: variant(1), quantity: 2 }, { variantId: variant(3), quantity: 3 }], discount: 10 };
    const blue = { id: 'blue-set', name: 'Blue set', type: 'manual', enabled: true, products: [sourceProduct, accessoryProduct], members: [{ variantId: variant(2), quantity: 1 }, { variantId: variant(4), quantity: 4 }], discount: 10 };
    await store.set('uk', 'commerce-bundles-uk', [red, blue]);
    await store.saveInstallation('uk', 'encrypted-fixture', 'carrier-fixture');
    availability.set(`${variant(3)}:GB`, { id: variant(3), availableForSale: true, price: { amount: '77.77', currencyCode: 'GBP' } });
    availability.set(`${variant(4)}:GB`, { id: variant(4), availableForSale: true, price: { amount: '88.88', currencyCode: 'GBP' } });
    availability.set(`${variant(3)}:DE`, { id: variant(3), availableForSale: true, price: { amount: '66.66', currencyCode: 'EUR' } });
    async function recommendations(query = {}) {
      const params = new URLSearchParams({ shop: stores[0].domain, timestamp: String(Math.floor(Date.now() / 1000)), product_id: '100', country: 'GB', ...query });
      const message = [...params].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('');
      params.set('signature', createHmac('sha256', apiSecret).update(message).digest('hex'));
      const response = await request(`/proxy/recommendations?${params}`, { authenticated: false });
      assert.equal(response.status, 200); return response.json();
    }
    const redResult = await recommendations({ variant_id: '1' });
    assert.equal(redResult.bundleId, red.id); assert.equal(redResult.mainQuantity, 2);
    assert.deepEqual(redResult.products.map((product) => product.variantId), [variant(3)]);
    assert.equal(redResult.products[0].quantity, 3); assert.equal(redResult.products[0].priceMinor, 7777);
    const publicBody = JSON.stringify(redResult);
    for (const privateField of ['inventoryLevels', 'inventoryItemId', 'senderEmail', 'private-warehouse', 'private-sender@example.com']) assert.equal(publicBody.includes(privateField), false, 'public response must not expose internal catalog/config data');
    const blueResult = await recommendations({ variant_id: '2' });
    assert.deepEqual(blueResult.products.map((product) => product.variantId), [variant(4)]);
    assert.equal(blueResult.products[0].quantity, 4);
    const european = await recommendations({ variant_id: '1', country: 'DE' });
    assert.equal(european.products[0].currency, 'EUR'); assert.equal(european.products[0].priceMinor, 6666);
    assert.deepEqual((await recommendations()).products, [], 'multiple source variants require an explicit choice');
    assert.deepEqual((await recommendations({ variant_id: '3' })).products, [], 'a variant from another product is not substituted');
    availability.set(`${variant(3)}:GB`, { id: variant(3), availableForSale: false, price: { amount: '77.77', currencyCode: 'GBP' } });
    assert.deepEqual((await recommendations({ variant_id: '1' })).products, [], 'unavailable configured variants do not fall back to a sibling SKU');
  });

  await t.test('invalid public proxy signatures and missing worker secrets are rejected', async () => {
    const params = new URLSearchParams({ shop: stores[0].domain, timestamp: String(Math.floor(Date.now() / 1000)), signature: 'invalid' });
    assert.equal((await request(`/proxy/recommendations?${params}`, { authenticated: false })).status, 401);
    assert.equal((await request('/internal/jobs/run', { method: 'POST', body: {}, authenticated: false, origin: null })).status, 401);
    assert.equal(workerCalls, 0);
    const response = await request('/internal/jobs/run', { method: 'POST', body: {}, authenticated: false, origin: null, headers: { 'X-Internal-Task-Secret': taskSecret } });
    assert.equal(response.status, 200); assert.equal(workerCalls, 1);
  });
});
