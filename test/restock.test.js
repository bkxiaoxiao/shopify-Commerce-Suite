import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSubscription, isSellable, buildRestockJobs, renderRestockEmail } from '../server/domain/restock.js';

const variant = { id: 'gid://shopify/ProductVariant/123', inventoryItemId: 'gid://shopify/InventoryItem/456', published: true, markets: ['GB', 'DE'], product: { status: 'ACTIVE' }, inventoryPolicy: 'DENY' };
const level = () => ({ inventoryItemId: variant.inventoryItemId, available: 10, isActive: true, location: { id: 'gid://shopify/Location/1', isActive: true, fulfillsOnlineOrders: true, markets: ['GB', 'DE'] } });
const subscription = () => ({ id: 'sub-1', shopId: 'example.myshopify.com', email: 'Emma@Example.com', variantId: variant.id, market: 'GB', language: 'en-GB', status: 'active', marketingConsent: false });

test('subscription normalizes IDs and does not silently opt a customer into marketing', () => {
  const result = validateSubscription({ email: ' Emma@Example.com ', variantId: '123', market: 'gb', language: 'de-de' });
  assert.deepEqual(result, { email: 'emma@example.com', variantId: variant.id, market: 'GB', language: 'de-DE', marketingConsent: false });
  assert.throws(() => validateSubscription({ ...result, marketingConsent: 'true' }), /boolean/);
  assert.throws(() => validateSubscription({ ...result, email: 'x@example.com\r\nBcc:y@example.com' }), /email/);
  assert.throws(() => validateSubscription({ ...result, variantId: 'bench' }), /ProductVariant ID/);
  assert.throws(() => validateSubscription({ ...result, market: '' }), /market/);
  assert.throws(() => validateSubscription({ ...result, language: '<script>' }), /language/);
});

test('sellability uses explicitly published market and online available stock', () => {
  assert.equal(isSellable({ variant, inventoryLevels: [level()], market: 'GB' }), true);
  assert.equal(isSellable({ variant, inventoryLevels: [level()], market: 'FR' }), false);
  assert.equal(isSellable({ variant: { ...variant, published: false }, inventoryLevels: [level()], market: 'GB' }), false);
  assert.equal(isSellable({ variant: { ...variant, product: { status: 'ARCHIVED' } }, inventoryLevels: [level()], market: 'GB' }), false);
  assert.equal(isSellable({ variant: { ...variant, markets: undefined }, inventoryLevels: [level()], market: 'GB' }), false);
  assert.equal(isSellable({ variant: { ...variant, markets: undefined, contextualAvailability: { GB: true } }, inventoryLevels: [level()], market: 'GB' }), true);
});

test('inactive inventory or locations and non-online stock cannot trigger a notice', () => {
  for (const inventory of [
    { ...level(), isActive: false },
    { ...level(), isActive: undefined },
    { ...level(), location: { ...level().location, isActive: false } },
    { ...level(), location: { ...level().location, fulfillsOnlineOrders: false } },
    { ...level(), location: { isActive: true } },
    { ...level(), available: 0, onHand: 100 },
    { ...level(), available: -1 },
    { ...level(), available: '10' },
    { ...level(), inventoryItemId: 'gid://shopify/InventoryItem/999' },
    { ...level(), variantId: 'gid://shopify/ProductVariant/999' },
  ]) assert.equal(isSellable({ variant, inventoryLevels: [inventory], market: 'GB' }), false);
});

test('GraphQL quantity states and per-location market restrictions are respected', () => {
  const graphqlLevel = { ...level(), available: undefined, quantities: [{ name: 'on_hand', quantity: 20 }, { name: 'available', quantity: 3 }] };
  assert.equal(isSellable({ variant, inventoryLevels: { nodes: [graphqlLevel] }, market: 'GB' }), true);
  assert.equal(isSellable({ variant, inventoryLevels: [{ ...graphqlLevel, location: { ...level().location, markets: ['DE'] } }], market: 'GB' }), false);
  assert.equal(isSellable({ variant, inventoryLevels: [{ ...graphqlLevel, markets: ['DE'] }], market: 'GB' }), false);
});

test('allowing overselling does not create false replenishment events at zero stock', () => {
  assert.equal(isSellable({ variant: { ...variant, inventoryPolicy: 'CONTINUE', availableForSale: true }, inventoryLevels: [{ ...level(), available: 0 }], market: 'GB' }), false);
  assert.equal(isSellable({ variant: { ...variant, inventoryItem: { tracked: false } }, inventoryLevels: [level()], market: 'GB' }), false);
});

test('jobs are stable across retries and input ordering and deduplicate email per cycle', () => {
  const first = subscription();
  const duplicate = { ...first, id: 'sub-2', email: 'emma@example.com' };
  const another = { ...first, id: 'sub-3', email: 'other@example.com' };
  const args = { variant, inventoryLevels: [level()], market: 'GB', restockCycleId: 'cycle-2026-11-24' };
  const jobs = buildRestockJobs({ ...args, subscriptions: [first, duplicate, another] });
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs, buildRestockJobs({ ...args, subscriptions: [another, duplicate, first] }));
  assert.equal(jobs.find(job => job.email === 'emma@example.com').subscriptionId, 'sub-1');
  assert.equal(jobs[0].marketingConsent, false);
  assert.notEqual(jobs[0].id, buildRestockJobs({ ...args, restockCycleId: 'later-cycle', subscriptions: [first, another] })[0].id);
});

test('only active matching variant/market subscribers enter the current cycle', () => {
  const subscriptions = [
    subscription(),
    { ...subscription(), id: 'unsub', email: 'unsub@example.com', status: 'unsubscribed' },
    { ...subscription(), id: 'time-unsub', email: 'time@example.com', unsubscribedAt: '2026-11-24' },
    { ...subscription(), id: 'suppressed', email: 'bounce@example.com', suppressed: true },
    { ...subscription(), id: 'wrong-market', email: 'de@example.com', market: 'DE' },
    { ...subscription(), id: 'wrong-variant', email: 'other@example.com', variantId: '124' },
    { ...subscription(), id: 'already', email: 'already@example.com', lastNotifiedCycleId: 'cycle-1' },
    { ...subscription(), id: 'no-consent', email: 'no@example.com', restockConsent: false },
    { ...subscription(), id: 'confirmation', email: 'pending@example.com', status: 'pending_confirmation' },
    { ...subscription(), id: 'pending', email: 'pending2@example.com', status: 'pending' },
    { ...subscription(), id: 'upper-unsub', email: 'upper@example.com', status: 'UNSUBSCRIBED' },
  ];
  const jobs = buildRestockJobs({ subscriptions, variant, inventoryLevels: [level()], market: 'GB', restockCycleId: 'cycle-1' });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].email, 'emma@example.com');
  assert.deepEqual(buildRestockJobs({ subscriptions, variant, inventoryLevels: [], market: 'GB', restockCycleId: 'cycle-1' }), []);
  assert.throws(() => buildRestockJobs({ subscriptions, variant, inventoryLevels: [level()], market: 'GB' }), /restockCycleId/);
});

test('notification HTML escapes user content, includes correct variant and separate unsubscribe', () => {
  const message = renderRestockEmail({ subscription: subscription(), product: { title: 'Rack <script>alert(1)</script>', variantTitle: 'Black & grey', url: 'https://shop.example/products/rack?source=notice', imageUrl: 'https://cdn.example/rack.png' }, shop: { name: 'Example <Company>' }, unsubscribeUrl: 'https://app.example/unsubscribe?token=a&scope=restock' });
  assert.doesNotMatch(message.html, /<script>|<Company>/);
  assert.match(message.html, /&lt;script&gt;/);
  assert.match(message.html, /variant=123/);
  assert.match(message.html, /scope=restock/);
  assert.match(message.text, /does not reserve stock/);
  assert.match(message.text, /requested a stock notification/);
  assert.doesNotMatch(message.html, /tracking|newsletter/i);
  assert.ok(message.subject.startsWith('Back in stock:'));
});

test('email renderer rejects active content URLs and authenticated URL credentials', () => {
  const args = { subscription: subscription(), product: { title: 'Rack', url: 'https://shop.example/products/rack' }, shop: { name: 'Example Shop' }, unsubscribeUrl: 'https://app.example/unsubscribe?token=x' };
  assert.throws(() => renderRestockEmail({ ...args, product: { title: 'Rack', url: 'javascript:alert(1)' } }), /HTTPS/);
  assert.throws(() => renderRestockEmail({ ...args, unsubscribeUrl: 'data:text/html,test' }), /HTTPS/);
  assert.throws(() => renderRestockEmail({ ...args, product: { ...args.product, imageUrl: 'https://user:password@example.com/image.png' } }), /HTTPS/);
});

test('German language and shop-domain product URLs are generated without headline injection', () => {
  const message = renderRestockEmail({ subscription: { ...subscription(), language: 'de-DE' }, product: { title: 'Trainingsbank\r\nBcc: malicious@example.com', handle: 'training-bench' }, shop: { name: 'Example GmbH', domain: 'shop.example' }, unsubscribeUrl: 'https://app.example/unsubscribe?token=x' });
  assert.match(message.subject, /^Wieder auf Lager:/);
  assert.doesNotMatch(message.subject, /[\r\n]/);
  assert.match(message.text, /https:\/\/shop\.example\/products\/training-bench\?variant=123/);
  assert.match(message.html, /lang="de-DE"/);
});
