import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBundles, getRecommendations, calculateBundleOffer, nativeDiscountInput } from '../server/domain/bundles.js';

const bundle = (overrides = {}) => ({ id: 'set', name: 'Training set', type: 'manual', products: ['rack', 'bench', 'plates'], discount: 10, enabled: true, ...overrides });
const lines = [{ variantId: 'rack', quantity: 1, unitPrice: 99900 }, { variantId: 'bench', quantity: 1, unitPrice: 24900 }, { variantId: 'plates', quantity: 1, unitPrice: 12900 }];
const offer = (definition = bundle(), cart = lines) => calculateBundleOffer({ bundle: definition, lines: cart, currency: 'GBP' });

test('every distinct member is required and extra copies of another item cannot substitute', () => {
  assert.equal(offer().discountMinor, 13770);
  const missing = offer(bundle(), [{ ...lines[0], quantity: 3 }, lines[1]]);
  assert.equal(missing.eligible, false);
  assert.equal(missing.discountMinor, 0);
  assert.equal(missing.totalMinor, 324600);
});

test('extra products and incomplete extra sets retain their undiscounted price', () => {
  const result = offer(bundle(), [{ ...lines[0], quantity: 2 }, ...lines.slice(1), { variantId: 'mat', quantity: 2, unitPrice: 7900 }]);
  assert.equal(result.sets, 1);
  assert.equal(result.lines[0].discountedQuantity, 1);
  assert.equal(result.lines[3].discountMinor, 0);
  assert.equal(result.discountMinor, 13770);
  assert.equal(result.totalMinor, 239630);
});

test('complete repeated sets and configured member quantities are counted correctly', () => {
  const definition = bundle({ members: [{ variantId: 'rack', quantity: 1 }, { variantId: 'plates', quantity: 2 }] });
  const result = offer(definition, [{ variantId: 'rack', quantity: 4, unitPrice: 1000 }, { variantId: 'plates', quantity: 5, unitPrice: 100 }]);
  assert.equal(result.sets, 2);
  assert.equal(result.discountMinor, 240);
  assert.equal(result.lines[0].discountedQuantity, 2);
  assert.equal(result.lines[1].discountedQuantity, 4);
});

test('pausing the bundle immediately removes its computed discount', () => {
  const result = offer(bundle({ enabled: false }));
  assert.equal(result.sets, 0);
  assert.equal(result.discountMinor, 0);
  assert.equal(result.totalMinor, 137700);
  assert.deepEqual(nativeDiscountInput(bundle({ enabled: false })), { supported: true, action: 'deactivate', input: null });
});

test('integer rounding conserves every minor unit and never produces negative lines', () => {
  const result = offer(bundle({ products: ['a', 'b', 'c'], discount: 50 }), ['a', 'b', 'c'].map((variantId) => ({ variantId, quantity: 1, unitPrice: 1 })));
  assert.equal(result.discountMinor, 2);
  assert.equal(result.totalMinor, 1);
  assert.equal(result.lines.reduce((sum, line) => sum + line.discountMinor, 0), result.discountMinor);
  assert.ok(result.lines.every((line) => line.totalMinor >= 0));
  const fixed = offer(bundle({ discountType: 'fixed', discountAmountMinor: 999999 }));
  assert.equal(fixed.discountMinor, fixed.subtotalMinor);
  assert.equal(fixed.totalMinor, 0);
});

test('split lines for a variant are counted once and the incomplete remainder is untouched', () => {
  const result = offer(bundle({ products: ['a', 'b'], discount: 10 }), [
    { variantId: 'a', quantity: 1, unitPrice: 200 },
    { variantId: 'a', quantity: 1, unitPrice: 100 },
    { variantId: 'b', quantity: 1, unitPrice: 100 },
  ]);
  assert.equal(result.sets, 1);
  assert.equal(result.discountMinor, 20);
  assert.equal(result.lines[0].discountMinor, 0);
});

test('member-gated discounts are not silently approximated as basic quantity discounts', () => {
  const result = nativeDiscountInput(bundle());
  assert.equal(result.supported, false);
  assert.match(result.reason, /requires Functions\/Plus/);
});

test('market/currency restrictions and scheduling are checked before pricing', () => {
  const definition = bundle({ markets: ['GB'], currency: 'GBP', startsAt: '2026-11-24T00:00:00Z', endsAt: '2026-11-25T00:00:00Z' });
  const calculate = (extra) => calculateBundleOffer({ bundle: definition, lines, currency: 'GBP', market: 'GB', now: Date.parse('2026-11-24T12:00:00Z'), ...extra });
  assert.equal(calculate({}).discountMinor, 13770);
  assert.equal(calculate({ market: undefined }).discountMinor, 0);
  assert.equal(calculate({ market: 'DE' }).discountMinor, 0);
  assert.equal(calculate({ currency: 'EUR' }).discountMinor, 0);
  assert.equal(calculate({ now: Date.parse('2026-11-25T00:00:00Z') }).discountMinor, 0);
});

test('an exact native BXGY uses variant GIDs and discounts only the get item', () => {
  const buy = { variantId: 'gid://shopify/ProductVariant/1', quantity: 1 };
  const get = { variantId: 'gid://shopify/ProductVariant/2', quantity: 1 };
  const definition = bundle({ discountType: 'buy_x_get_y', buy, get, discount: 100, maxSets: 1, startsAt: '2026-11-24T00:00:00Z' });
  const result = calculateBundleOffer({ bundle: definition, currency: 'GBP', lines: [{ ...buy, unitPrice: 1000 }, { ...get, unitPrice: 100, quantity: 2 }] });
  assert.equal(result.discountMinor, 100);
  assert.equal(result.lines[0].discountMinor, 0);
  assert.equal(result.lines[1].discountedQuantity, 1);
  const native = nativeDiscountInput(definition);
  assert.equal(native.supported, true);
  assert.equal(native.mutation, 'discountAutomaticBxgyCreate');
  assert.deepEqual(native.input.customerBuys.items, { products: { productVariantsToAdd: [buy.variantId] } });
  assert.equal(native.input.customerGets.value.discountOnQuantity.effect.percentage, 1);
  assert.equal(native.input.usesPerOrderLimit, '1');
  assert.equal(nativeDiscountInput({ ...definition, markets: ['GB'] }).supported, false);
});

test('recommendations prefer manual candidates, deduplicate, and filter paused/market/stock states', () => {
  const catalog = [
    { id: 'rack', status: 'ACTIVE', availableForSale: true },
    { id: 'bench', status: 'ACTIVE', availableForSale: true, markets: ['GB'] },
    { id: 'plates', status: 'ACTIVE', inventoryQuantity: 0 },
    { id: 'mat', status: 'ACTIVE', availableForSale: true },
    { id: 'draft', status: 'DRAFT', availableForSale: true },
  ];
  const definitions = [bundle(), bundle({ id: 'global', type: 'global', products: ['bench', 'mat', 'draft'] }), bundle({ id: 'paused', enabled: false, products: ['rack', 'mat'] })];
  const result = getRecommendations({ bundles: definitions, products: catalog, productId: 'rack', market: 'GB' });
  assert.deepEqual(result.map((product) => product.id), ['bench', 'mat']);
  assert.equal(result[0].recommendationType, 'manual');
  assert.deepEqual(getRecommendations({ bundles: definitions, products: catalog, productId: 'rack', market: 'DE' }).map((product) => product.id), ['mat']);
});

test('invalid bundles, unsafe prices, and fractional quantities fail as 400 errors', () => {
  const bad = (callback) => assert.throws(callback, (error) => error.status === 400);
  bad(() => validateBundles([bundle({ discount: 101 })]));
  bad(() => validateBundles([bundle({ products: ['rack', 'rack'] })]));
  bad(() => validateBundles([bundle(), bundle()]));
  bad(() => offer(bundle(), [{ variantId: 'rack', quantity: 1.5, unitPrice: 100 }]));
  bad(() => offer(bundle(), [{ variantId: 'rack', quantity: 2, unitPrice: Number.MAX_SAFE_INTEGER }]));
});
