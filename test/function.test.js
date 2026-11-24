import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cartLinesDiscountsGenerateRun as run } from '../extensions/commerce-suite-bundle-discount/src/cart_lines_discounts_generate_run.js';

const gid = value => `gid://shopify/ProductVariant/${value}`;
const line = (id, variant, quantity, amount, currencyCode = 'GBP') => ({ id, quantity, cost: { amountPerQuantity: { amount, currencyCode } }, merchandise: { __typename: 'ProductVariant', id: gid(variant) } });
const bundle = overrides => ({ id: 'bundle-1', name: 'Equipment combination', enabled: true, discountType: 'percentage', discountBps: 1000, currency: 'GBP', markets: ['GB'], members: [{ variantId: gid(1), quantity: 1 }, { variantId: gid(2), quantity: 1 }], ...overrides });
const input = (overrides = {}, lines = [line('a', 1, 1, '100.00'), line('b', 2, 1, '25.00')]) => ({ cart: { lines }, localization: { country: { isoCode: 'GB' } }, discount: { discountClasses: ['PRODUCT'], metafield: { jsonValue: bundle(overrides) } } });
const candidates = result => result.operations[0]?.productDiscountsAdd.candidates || [];
const cents = amount => { const [whole, fraction = ''] = amount.split('.'); return Number(whole) * 100 + Number(fraction.padEnd(2, '0')); };

test('percentage discount targets all and only complete configured members', () => {
  const source = input({}, [line('a', 1, 1, '100.00'), line('b', 2, 1, '25.00'), line('c', 3, 5, '90.00')]);
  const before = JSON.stringify(source);
  assert.deepEqual(run(source), { operations: [{ productDiscountsAdd: {
    candidates: [{ message: 'Equipment combination', targets: [{ cartLine: { id: 'a', quantity: 1 } }, { cartLine: { id: 'b', quantity: 1 } }], value: { percentage: { value: '10.00' } } }], selectionStrategy: 'ALL',
  } }] });
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(run(input({}, [line('a', 1, 10, '100.00')])), { operations: [] });
});

test('member quantities and maxSets prevent extra units from receiving the bundle discount', () => {
  const config = { members: [{ variantId: gid(1), quantity: 2 }, { variantId: gid(2), quantity: 1 }], maxSets: 1 };
  const result = run(input(config, [line('a', 1, 9, '10.00'), line('b', 2, 3, '5.00')]));
  assert.deepEqual(candidates(result)[0].targets, [{ cartLine: { id: 'a', quantity: 2 } }, { cartLine: { id: 'b', quantity: 1 } }]);
  delete config.maxSets;
  const allSets = run(input(config, [line('a', 1, 9, '10.00'), line('b', 2, 3, '5.00')]));
  assert.deepEqual(candidates(allSets)[0].targets, [{ cartLine: { id: 'a', quantity: 6 } }, { cartLine: { id: 'b', quantity: 3 } }]);
});

test('fixed discount apportions complete-set totals exactly across split cart lines', () => {
  const source = input({ discountType: 'fixed', discountAmountMinor: 100, members: [{ variantId: gid(1), quantity: 2 }, { variantId: gid(2), quantity: 1 }] }, [line('a1', 1, 1, '0.50'), line('a2', 1, 4, '1.25'), line('b', 2, 2, '2.00')]);
  const result = candidates(run(source));
  const byId = Object.fromEntries(result.map(value => [value.targets[0].cartLine.id, value]));
  assert.deepEqual(Object.fromEntries(Object.entries(byId).map(([id, value]) => [id, cents(value.value.fixedAmount.amount)])), { b: 97, a2: 91, a1: 12 });
  assert.deepEqual(byId.a2.targets[0].cartLine, { id: 'a2', quantity: 3 });
  assert.equal(result.reduce((sum, value) => sum + cents(value.value.fixedAmount.amount), 0), 200);
  assert.ok(result.every(value => value.value.fixedAmount.appliesToEachItem === false));
});

test('one-cent ties are deterministic and discounts cannot exceed the eligible subtotal', () => {
  const tiny = input({ discountType: 'fixed', discountAmountMinor: 1 }, [line('b', 2, 1, '0.01'), line('a', 1, 1, '0.01')]);
  assert.deepEqual(candidates(run(tiny)).map(value => ({ id: value.targets[0].cartLine.id, amount: value.value.fixedAmount.amount })), [{ id: 'a', amount: '0.01' }]);
  const capped = input({ discountType: 'fixed', discountAmountMinor: 10000 }, [line('a', 1, 1, '0.01'), line('b', 2, 1, '0.02')]);
  assert.equal(candidates(run(capped)).reduce((sum, value) => sum + cents(value.value.fixedAmount.amount), 0), 3);
});

test('large integer allocations match an independent exact rational reference', () => {
  const cases = [
    [1234567891, 987654321, 987654321],
    [999999999999, 1234567890123, 987654321987],
    [45035996273600, 9191919191919, 23456789012345],
  ];
  for (const [left, right, amount] of cases) {
    const asMoney = value => `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
    const result = candidates(run(input({ discountType: 'fixed', discountAmountMinor: amount }, [line('a', 1, 1, asMoney(left)), line('b', 2, 1, asMoney(right))])));
    const total = BigInt(left) + BigInt(right);
    const reference = [{ id: 'a', value: BigInt(left) }, { id: 'b', value: BigInt(right) }].map(value => ({ ...value, share: BigInt(amount) * value.value / total, remainder: BigInt(amount) * value.value % total }));
    let remaining = BigInt(amount) - reference.reduce((sum, value) => sum + value.share, 0n);
    reference.sort((a, b) => a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1);
    for (const item of reference) { if (remaining) { item.share++; remaining--; } }
    const expected = Object.fromEntries(reference.filter(value => value.share > 0n).map(value => [value.id, Number(value.share)]));
    const actual = Object.fromEntries(result.map(value => [value.targets[0].cartLine.id, cents(value.value.fixedAmount.amount)]));
    assert.deepEqual(actual, expected);
  }
});

test('invalid, disabled, duplicate-member and unsupported configurations fail closed', () => {
  const invalid = [
    { enabled: false }, { enabled: 'yes' }, { discountType: 'cheapest_free' }, { currency: 'JPY' }, { currency: 'INVALID' },
    { members: [] }, { members: [{ variantId: gid(1), quantity: 1 }] },
    { members: [{ variantId: gid(1), quantity: 1 }, { variantId: gid(1), quantity: 1 }] },
    { members: [{ variantId: gid(1), quantity: 0 }, { variantId: gid(2), quantity: 1 }] },
    { members: [{ variantId: '1', quantity: 1 }, { variantId: gid(2), quantity: 1 }] },
    { maxSets: 0 }, { maxSets: 1.2 }, { discountBps: 10001 }, { discountBps: 0 },
    { discountType: 'fixed', discountAmountMinor: -1 }, { markets: 'GB' }, { markets: ['gb'] },
  ];
  for (const config of invalid) assert.deepEqual(run(input(config)), { operations: [] });
  assert.deepEqual(run({}), { operations: [] });
  assert.deepEqual(run(input({ discountBps: undefined, discount: 12.34 })).operations[0].productDiscountsAdd.candidates[0].value, { percentage: { value: '12.34' } });
});

test('country, currency, invalid prices and incomplete quantities never receive a fallback item discount', () => {
  const wrongMarket = input(); wrongMarket.localization.country.isoCode = 'DE';
  assert.deepEqual(run(wrongMarket), { operations: [] });
  assert.deepEqual(run(input({}, [line('a', 1, 1, '100.00', 'EUR'), line('b', 2, 1, '25.00')])), { operations: [] });
  for (const price of ['-1.00', '1.001', 'Infinity', '9007199254740991.00']) {
    assert.deepEqual(run(input({}, [line('a', 1, 1, price), line('b', 2, 1, '25.00')])), { operations: [] });
  }
  const noClass = input(); noClass.discount.discountClasses = ['SHIPPING'];
  assert.deepEqual(run(noClass), { operations: [] });
  const forged = input({}, [line('a', 1, 2, '100.00')]); forged.cart.lines[0].attribute = { value: 'bundle-1' };
  assert.deepEqual(run(forged), { operations: [] });
  assert.deepEqual(run(input({}, [line('a', 1, 1.2, '100.00'), line('b', 2, 1, '25.00')])), { operations: [] });
  const euros = input({ currency: 'EUR', markets: ['DE'] }, [line('a', 1, 1, '100.00', 'EUR'), line('b', 2, 1, '25.00', 'EUR')]); euros.localization.country.isoCode = 'DE';
  assert.equal(candidates(run(euros)).length, 1);
});

test('Function manifest/query use the current target and trusted app-owned metafield', async () => {
  const base = new URL('../extensions/commerce-suite-bundle-discount/', import.meta.url);
  const manifest = await readFile(new URL('shopify.extension.toml', base), 'utf8');
  const query = await readFile(new URL('src/cart_lines_discounts_generate_run.graphql', base), 'utf8');
  const source = await readFile(new URL('src/cart_lines_discounts_generate_run.js', base), 'utf8');
  assert.match(manifest, /api_version = "2026-10"/);
  assert.match(manifest, /target = "cart\.lines\.discounts\.generate\.run"/);
  assert.match(query, /metafield\(namespace: "\$app:commerce-suite", key: "bundle"\)/);
  assert.match(query, /jsonValue/);
  assert.doesNotMatch(query, /_commerce_bundle/);
  assert.doesNotMatch(source, /from ['"]node:|\bBigInt\s*\(|\bfetch\s*\(|\bprocess\./);
});
