import test from 'node:test';
import assert from 'node:assert/strict';
import { validateShippingRules, quoteShipping } from '../server/domain/shipping.js';

const rule = (overrides = {}) => ({ id: 'standard', name: 'Standard', kind: 'weight', area: 'main', countries: ['GB'], min: 0, max: 20, price: 9.9, enabled: true, ...overrides });
const heavy = rule({ id: 'heavy', name: 'Heavy', min: 20, max: 100, price: 29 });
const free = rule({ id: 'free', name: 'Free', kind: 'threshold', max: undefined, threshold: 1200, price: 0 });
const remote = rule({ id: 'remote', name: 'Remote surcharge', kind: 'remote', area: 'remote', max: undefined, price: 24.9 });
function quote(rules, overrides = {}) {
  return quoteShipping({ rules, destination: { country: 'GB', postal_code: 'SW1A 1AA' }, items: [{ grams: 15000, quantity: 1, price: 29900, variant_id: 'v1' }], currency: 'GBP', ...overrides });
}

test('UI major-unit prices convert exactly to Shopify minor-unit strings', () => {
  assert.deepEqual(quote([rule()]).rates[0], { service_name: 'Standard', service_code: 'rate-standard', total_price: '990', currency: 'GBP', description: 'Standard' });
  assert.equal(quote([rule({ price: 0.29 })]).rates[0].total_price, '29');
});

test('weight intervals include the upper boundary exactly once', () => {
  assert.equal(quote([rule(), heavy], { items: [{ grams: 20000, quantity: 1, price: 10000 }] }).rates[0].service_code, 'rate-standard');
  assert.equal(quote([rule(), heavy], { items: [{ grams: 20001, quantity: 1, price: 10000 }] }).rates[0].service_code, 'rate-heavy');
});

test('free shipping needs a valid base weight quote and a known cart amount', () => {
  assert.equal(quote([rule(), free], { items: [{ grams: 10000, quantity: 1, price: 120000 }] }).rates[0].total_price, '0');
  assert.equal(quote([rule(), free], { items: [{ grams: 10000, quantity: 1, price: 119999 }] }).rates[0].total_price, '990');
  assert.deepEqual(quote([rule(), free], { items: [{ grams: 20001, quantity: 1, price: 120000 }] }), { rates: [] });
  assert.equal(quote([rule(), free], { items: [{ grams: 10000, quantity: 1 }] }).rates[0].total_price, '990');
});

test('missing/zero weights and overweight carts never become free', () => {
  for (const grams of [undefined, 0, -1]) assert.deepEqual(quote([rule(), free], { items: [{ grams, quantity: 1, price: 999999 }] }), { rates: [] });
  assert.deepEqual(quote([rule()], { items: [{ grams: 10001, quantity: 2, price: 100 }] }), { rates: [] });
});

test('remote UK addresses add a surcharge and do not inherit mainland free shipping', () => {
  assert.equal(quote([rule(), free, remote], { destination: { country: ' gb ', postal_code: 'iv1 1aa' }, items: [{ grams: 10000, quantity: 1, price: 150000 }] }).rates[0].total_price, '3480');
  assert.deepEqual(quote([rule(), { ...remote, enabled: false }], { destination: { country: 'GB', postal_code: 'IV1 1AA' } }), { rates: [] });
});

test('an explicit postcode block takes precedence over free or ordinary rates', () => {
  const blocked = { id: 'restricted', name: 'Restricted', kind: 'blocked', countries: ['GB'], postcodes: ['SW1A *'], enabled: true };
  assert.deepEqual(quote([free, rule(), blocked]), { rates: [] });
});

test('UK wildcard district boundaries and excluded postcodes are preserved', () => {
  const scoped = rule({ postcodes: ['E1 *'], excludePostcodes: ['E1 1AA'] });
  assert.equal(quote([scoped], { destination: { country: 'GB', postal_code: ' e1 2aa ' } }).rates.length, 1);
  assert.deepEqual(quote([scoped], { destination: { country: 'GB', postal_code: 'E10 1AA' } }), { rates: [] });
  assert.deepEqual(quote([scoped], { destination: { country: 'GB', postal_code: 'E1 1AA' } }), { rates: [] });
});

test('EU postal ranges retain leading zeros and never cross country boundaries', () => {
  const italy = rule({ countries: ['IT'], area: 'eu', kind: 'eu', postcodes: ['00100-00999'], priceMinor: 1290 });
  assert.equal(quote([italy], { destination: { country: 'IT', postal_code: '00118' }, currency: 'EUR' }).rates[0].total_price, '1290');
  assert.deepEqual(quote([italy], { destination: { country: 'DE', postal_code: '00118' }, currency: 'EUR' }), { rates: [] });
});

test('a product-scoped rule cannot quote only one part of a mixed cart', () => {
  const scoped = rule({ variantIds: ['v1'] });
  assert.equal(quote([scoped]).rates.length, 1);
  assert.deepEqual(quote([scoped], { items: [{ variant_id: 'v1', grams: 1000, quantity: 1, price: 100 }, { variant_id: 'v2', grams: 1000, quantity: 1, price: 100 }] }), { rates: [] });
});

test('a product-specific block only blocks carts containing that product', () => {
  const blocked = { id: 'restricted', name: 'Restricted product', kind: 'blocked', countries: ['GB'], variantIds: ['v2'] };
  assert.equal(quote([rule(), blocked]).rates.length, 1);
  assert.deepEqual(quote([rule(), blocked], { items: [{ variant_id: 'v1', grams: 1000, quantity: 1, price: 100 }, { variant_id: 'v2', grams: 1000, quantity: 1, price: 100 }] }), { rates: [] });
});

test('paused and currency-specific rules cannot leak into another market quote', () => {
  assert.deepEqual(quote([rule({ enabled: false })]), { rates: [] });
  assert.deepEqual(quote([rule({ currency: 'EUR' })]), { rates: [] });
});

test('invalid rules and cart inputs produce actionable 400 errors', () => {
  const bad = (callback) => assert.throws(callback, (error) => error.status === 400);
  bad(() => validateShippingRules([rule(), rule()]));
  bad(() => validateShippingRules([rule({ price: -1 })]));
  bad(() => validateShippingRules([rule({ max: 0 })]));
  bad(() => validateShippingRules([rule({ postcodes: ['E*1'] })]));
  bad(() => quote([rule()], { items: [{ grams: 1000, quantity: 1.2, price: 100 }] }));
  bad(() => quote([rule()], { destination: { country: 'GB', postal_code: '10115' } }));
  bad(() => quote([rule()], { items: [{ grams: 1000, quantity: 1, price: 1.2 }] }));
});
