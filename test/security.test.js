import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { loadConfig } from '../server/config.js';
import {
  authenticate, authorizeStore, assertOrigin, cookies, safeEqual,
  seal, sessionCookie, signToken, unseal, verifyOAuthHmac,
  verifyShopifyJwt, verifyToken, verifyWebhook,
} from '../server/security.js';

const AUTH_SECRET = randomBytes(48).toString('base64url');
const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const API_SECRET = randomBytes(32).toString('base64url');
const OTHER_API_SECRET = randomBytes(32).toString('base64url');
const uk = 'company-uk.myshopify.com';
const eu = 'company-eu.myshopify.com';
const stores = [
  { id: 'uk', name: 'Company UK', domain: uk, country: 'GB', currency: 'GBP' },
  { id: 'eu', name: 'Company EU', domain: eu, country: 'DE', currency: 'EUR' },
];
const productionEnv = overrides => ({
  APP_MODE: 'production', APP_URL: 'https://app.example.com',
  AUTH_SECRET, ENCRYPTION_KEY,
  DATABASE_URL: 'postgresql://test:test@localhost/test_database',
  STORES_JSON: JSON.stringify(stores),
  SHOPIFY_SHOPS_ALLOWLIST: `${uk},${eu}`,
  SHOPIFY_API_KEY: 'shared-client', SHOPIFY_API_SECRET: API_SECRET,
  SHOPIFY_ADMIN_USER_IDS: '42,99',
  ...overrides,
});
const status = code => error => error.status === code;

function jwt(payloadChanges = {}, { secret = API_SECRET, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', ...header })).toString('base64url');
  const payload = {
    aud: 'shared-client', dest: `https://${uk}`, iss: `https://${uk}/admin`,
    sub: '42', exp: now + 300, nbf: now - 10, iat: now - 10,
    ...payloadChanges,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signed = `${encodedHeader}.${encodedPayload}`;
  return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
}

test('production refuses missing security, database, URL and actual-store configuration', () => {
  for (const key of ['AUTH_SECRET', 'ENCRYPTION_KEY', 'DATABASE_URL', 'APP_URL', 'STORES_JSON']) {
    const env = productionEnv(); delete env[key];
    assert.throws(() => loadConfig(env), undefined, `missing ${key} must reject production`);
  }
  assert.throws(() => loadConfig(productionEnv({ AUTH_SECRET: 'too-short' })), /AUTH_SECRET/);
  assert.throws(() => loadConfig(productionEnv({ ENCRYPTION_KEY: randomBytes(31).toString('base64') })), /ENCRYPTION_KEY/);
  assert.throws(() => loadConfig(productionEnv({ ADMIN_PASSWORD: 'too-short' })), /ADMIN_PASSWORD/);
  assert.throws(() => loadConfig(productionEnv({ SHOPIFY_ADMIN_USER_IDS: '', ADMIN_PASSWORD: '' })));
  assert.throws(() => loadConfig(productionEnv({ ADMIN_PASSWORD: '', SHOPIFY_ADMIN_USER_IDS: '' })), /administrator login/);
});

test('production rejects malformed key encoding, non-PostgreSQL persistence and non-origin URLs', () => {
  assert.throws(() => loadConfig(productionEnv({ ENCRYPTION_KEY: `${ENCRYPTION_KEY}!!` })), /ENCRYPTION_KEY/);
  for (const database of ['sqlite:local.db', 'file:///tmp/app.db', 'https://db.example.com']) {
    assert.throws(() => loadConfig(productionEnv({ DATABASE_URL: database })), /DATABASE_URL|PostgreSQL|postgres/i);
  }
  for (const appUrl of ['http://app.example.com', 'https://user:password@app.example.com', 'https://app.example.com/path', 'https://app.example.com/?query=1', 'https://app.example.com/#fragment']) {
    assert.throws(() => loadConfig(productionEnv({ APP_URL: appUrl })), /APP_URL|origin|HTTPS/i);
  }
});

test('production store identities stay inside the allowlist and reject duplicate IDs/domains', () => {
  assert.throws(() => loadConfig(productionEnv({ SHOPIFY_SHOPS_ALLOWLIST: uk })), /outside/);
  assert.throws(() => loadConfig(productionEnv({ STORES_JSON: JSON.stringify([stores[0], stores[0]]) })), /unique/);
  assert.throws(() => loadConfig(productionEnv({ STORES_JSON: JSON.stringify([stores[0], { ...stores[1], domain: uk }]) })), /unique/);
  assert.throws(() => loadConfig(productionEnv({ STORES_JSON: JSON.stringify([{ ...stores[0], domain: 'attacker.example.com' }]) })), /myshopify/);
  const config = loadConfig(productionEnv());
  assert.equal(config.mode, 'production');
  assert.equal(config.appUrl, 'https://app.example.com');
  assert.deepEqual(config.stores, stores);
});

test('AES-GCM round-trips a token and rejects wrong key or tampering of any authenticated part', () => {
  const value = { accessToken: 'fixture-offline-token', shop: uk, scopes: ['read_orders'] };
  const encrypted = seal(value, ENCRYPTION_KEY);
  assert.deepEqual(unseal(encrypted, ENCRYPTION_KEY), value);
  assert.notEqual(seal(value, ENCRYPTION_KEY), encrypted, 'encryption must use a fresh IV');
  assert.ok(!encrypted.includes(value.accessToken));
  assert.throws(() => unseal(encrypted, randomBytes(32).toString('base64')));
  for (let part = 0; part < 3; part++) {
    const segments = encrypted.split('.');
    const bytes = Buffer.from(segments[part], 'base64url'); bytes[0] ^= 1;
    segments[part] = bytes.toString('base64url');
    assert.throws(() => unseal(segments.join('.'), ENCRYPTION_KEY), undefined, `tampered encrypted segment ${part} must reject`);
  }
});

test('session tokens enforce signature, expiry and admin role without trusting cookie text', () => {
  const config = loadConfig(productionEnv());
  const token = signToken({ role: 'admin' }, AUTH_SECRET, 300);
  assert.equal(verifyToken(token, AUTH_SECRET).role, 'admin');
  assert.throws(() => verifyToken(token, randomBytes(32).toString('base64url')), status(401));
  assert.throws(() => verifyToken(`${token}.extra`, AUTH_SECRET), status(401));
  const [data, signature] = token.split('.');
  const forgedData = Buffer.from(JSON.stringify({ role: 'admin', exp: 9999999999 })).toString('base64url');
  assert.throws(() => verifyToken(`${forgedData}.${signature}`, AUTH_SECRET), status(401));
  assert.throws(() => verifyToken(signToken({ role: 'admin' }, AUTH_SECRET, -1), AUTH_SECRET), status(401));
  assert.throws(() => verifyToken('', AUTH_SECRET), status(401));
  assert.ok(data.length > 0);
  assert.equal(authenticate({ headers: { cookie: `other=1; cs_session=${token}` } }, config).role, 'admin');
  assert.throws(() => authenticate({ headers: { cookie: `cs_session=${signToken({ role: 'guest' }, AUTH_SECRET)}` } }, config), status(403));
  assert.deepEqual(cookies({ headers: { cookie: 'key=value=with=equals; next=two' } }), { key: 'value=with=equals', next: 'two' });
  assert.match(sessionCookie('fixture', true), /HttpOnly; Path=\/; SameSite=Lax; Max-Age=28800; Secure$/);
  assert.match(sessionCookie('', true, true), /Max-Age=0; Secure$/);
});

test('Shopify session JWT verifies expected audience, signature, issuer, algorithm and lifetime', () => {
  const config = loadConfig(productionEnv());
  assert.deepEqual(verifyShopifyJwt(jwt(), config), { role: 'shopify-admin', shop: uk, userId: '42' });
  const invalid = [
    jwt({ aud: 'other-app' }),
    jwt({}, { secret: OTHER_API_SECRET }),
    jwt({ iss: `https://${eu}/admin` }),
    jwt({}, { header: { alg: 'none' } }),
    jwt({}, { header: { alg: 'RS256' } }),
    jwt({ exp: Math.floor(Date.now() / 1000) - 1 }),
    jwt({ nbf: Math.floor(Date.now() / 1000) + 3600 }),
    jwt({ exp: 'not-a-timestamp' }),
    'not-a-jwt',
  ];
  for (const token of invalid) assert.throws(() => verifyShopifyJwt(token, config), status(401));
});

test('Shopify destination must be an allowlisted HTTPS origin and staff must be explicitly authorized', () => {
  const config = loadConfig(productionEnv());
  const destinations = [
    'https://untrusted.myshopify.com', `http://${uk}`, `https://${uk}/path`,
    `https://${uk}?query=1`, `https://${uk}#fragment`, `https://user:password@${uk}`, `https://${uk}:8443`,
  ];
  for (const dest of destinations) {
    assert.throws(() => verifyShopifyJwt(jwt({ dest, iss: `${new URL(dest).origin}/admin` }), config), status(401));
  }
  assert.throws(() => verifyShopifyJwt(jwt({ sub: '777' }), config), status(403));
  assert.throws(() => verifyShopifyJwt(jwt(), loadConfig(productionEnv({ SHOPIFY_ADMIN_USER_IDS: '', ADMIN_PASSWORD: 'fixture-preview-password' }))), status(403));
  assert.throws(() => authorizeStore({ shop: uk }, 'eu', config), status(403));
  assert.throws(() => authorizeStore({ role: 'admin' }, 'missing', config), status(403));
  assert.equal(authorizeStore({ shop: uk }, 'uk', config).domain, uk);
});

test('each Shopify app identity verifies only its matching store credentials', () => {
  const credentials = {
    [uk]: { apiKey: 'uk-client', apiSecret: API_SECRET },
    [eu]: { apiKey: 'eu-client', apiSecret: OTHER_API_SECRET },
  };
  const config = loadConfig(productionEnv({ SHOPIFY_SHOP_CREDENTIALS: JSON.stringify(credentials) }));
  assert.equal(verifyShopifyJwt(jwt({ aud: 'uk-client' }), config).shop, uk);
  assert.equal(verifyShopifyJwt(jwt({ aud: 'eu-client', dest: `https://${eu}`, iss: `https://${eu}/admin` }, { secret: OTHER_API_SECRET }), config).shop, eu);
  assert.throws(() => verifyShopifyJwt(jwt({ aud: 'uk-client', dest: `https://${eu}`, iss: `https://${eu}/admin` }), config), status(401));
});

test('raw webhook HMAC is byte-exact and cannot be verified after JSON normalization', () => {
  const raw = Buffer.from('{ "id": 123, "message": "café" }\n', 'utf8');
  const signature = createHmac('sha256', API_SECRET).update(raw).digest('base64');
  assert.equal(verifyWebhook(raw, signature, API_SECRET), true);
  assert.equal(verifyWebhook(Buffer.from(JSON.stringify(JSON.parse(raw))), signature, API_SECRET), false);
  assert.equal(verifyWebhook(Buffer.concat([raw, Buffer.from(' ')]), signature, API_SECRET), false);
  assert.equal(verifyWebhook(raw, signature, OTHER_API_SECRET), false);
  assert.equal(verifyWebhook(raw, '', API_SECRET), false);
  assert.equal(verifyWebhook(raw, signature, ''), false);
  assert.equal(safeEqual('', ''), false);
});

test('OAuth HMAC excludes signature fields and origin checks protect cookie mutations', () => {
  const params = new URLSearchParams({ shop: uk, code: 'fixture-code', timestamp: '12345', signature: 'ignored' });
  const canonical = [...params.entries()].filter(([key]) => key !== 'signature').sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, value]) => `${key}=${value}`).join('&');
  params.set('hmac', createHmac('sha256', API_SECRET).update(canonical).digest('hex'));
  assert.equal(verifyOAuthHmac(params, API_SECRET), true);
  params.set('code', 'changed-code');
  assert.equal(verifyOAuthHmac(params, API_SECRET), false);
  const config = loadConfig(productionEnv());
  assert.doesNotThrow(() => assertOrigin({ method: 'GET', headers: {} }, config));
  assert.doesNotThrow(() => assertOrigin({ method: 'POST', headers: { origin: config.appUrl } }, config));
  assert.throws(() => assertOrigin({ method: 'POST', headers: { origin: 'https://other.example.com' } }, config), status(403));
  assert.throws(() => assertOrigin({ method: 'POST', headers: {} }, config), status(403));
});
