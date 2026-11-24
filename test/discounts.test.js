import test from 'node:test';
import assert from 'node:assert/strict';
import { publishBundle } from '../server/discounts.js';

const buy = { variantId: 'gid://shopify/ProductVariant/1', quantity: 1 };
const get = { variantId: 'gid://shopify/ProductVariant/2', quantity: 1 };
const definition = (overrides = {}) => ({ id: 'actual-set', name: 'Actual SKU set', type: 'manual', enabled: true, members: [buy, get], discount: 10, ...overrides });

function fixture({ plus = false, published = null, metafieldId = null } = {}) {
  const values = new Map(published ? [['discount-actual-set', published]] : []);
  const calls = []; const audits = [];
  const store = { get: async (_storeId, key) => values.get(key) || null, set: async (_storeId, key, value) => values.set(key, value), audit: async (...args) => audits.push(args) };
  const shopify = { async graphql(storeId, query, variables) {
    calls.push({ storeId, query, variables });
    if (query.includes('query Capability')) return { shop: { currencyCode:'GBP', plan: { shopifyPlus: plus } } };
    if (query.includes('query Configuration')) return { discountNode: { metafield: metafieldId ? { id: metafieldId } : null } };
    if (query.includes('discountAutomaticDeactivate')) return { discountAutomaticDeactivate: { automaticDiscountNode: { id: variables.id }, userErrors: [] } };
    const operation = ['discountAutomaticBxgyCreate', 'discountAutomaticBxgyUpdate', 'discountAutomaticAppCreate', 'discountAutomaticAppUpdate'].find((name) => query.includes(name));
    assert.ok(operation, 'only documented discount mutations are expected');
    return { [operation]: operation.includes('App') ? { automaticAppDiscount: { discountId: 'gid://shopify/DiscountAutomaticNode/100' }, userErrors: [] } : { automaticDiscountNode: { id: 'gid://shopify/DiscountAutomaticNode/200' }, userErrors: [] } };
  } };
  return { store, shopify, calls, values, audits, publish: (bundle = definition()) => publishBundle({ store, shopify, storeId: 'uk', bundle }) };
}

test('non-Plus precise bundles reject without creating a mutation or a false published record', async () => {
  const setup = fixture();
  await assert.rejects(setup.publish(), (error) => error.status === 422);
  assert.equal(setup.calls.length, 1); assert.match(setup.calls[0].query, /shopifyPlus/);
  assert.equal(setup.calls.some((call) => call.query.startsWith('mutation')), false);
  assert.equal(setup.values.size, 0); assert.equal(setup.audits.length, 0);
});

test('Plus precise bundles publish an app discount with its exact app-owned JSON configuration', async () => {
  const setup = fixture({ plus: true });
  const bundle = definition({ discountType: 'fixed', discountAmountMinor: 500, maxSets: 2 });
  const result = await setup.publish(bundle);
  assert.deepEqual(result, { id: 'gid://shopify/DiscountAutomaticNode/100', kind: 'function', status: 'published' });
  const call = setup.calls.find((entry) => entry.query.includes('discountAutomaticAppCreate'));
  assert.equal(call.storeId, 'uk'); assert.equal(call.variables.input.functionHandle, 'commerce-suite-bundle-discount');
  assert.deepEqual(call.variables.input.discountClasses, ['PRODUCT']);
  const [field] = call.variables.input.metafields;
  assert.equal(field.namespace, '$app:commerce-suite'); assert.equal(field.key, 'bundle'); assert.equal(field.type, 'json');
  assert.deepEqual(JSON.parse(field.value), {...bundle,currency:'GBP'});
  assert.equal(setup.values.get('discount-actual-set').id, result.id);
  assert.equal(setup.audits.length, 1);
});

test('Plus updates reuse the published discount and the existing configuration metafield', async () => {
  const published = { id: 'gid://shopify/DiscountAutomaticNode/100', kind: 'function', status: 'published' };
  const setup = fixture({ plus: true, published, metafieldId: 'gid://shopify/Metafield/50' });
  await setup.publish(definition({ discount: 15 }));
  const call = setup.calls.find((entry) => entry.query.includes('discountAutomaticAppUpdate'));
  assert.equal(call.variables.id, published.id);
  assert.equal(call.variables.input.metafields[0].id, 'gid://shopify/Metafield/50');
  assert.equal(JSON.parse(call.variables.input.metafields[0].value).discount, 15);
  assert.equal(setup.calls.some((entry) => entry.query.includes('discountAutomaticAppCreate')), false);
});

test('native BXGY updates and deactivation reuse their actual Shopify record', async () => {
  const published = { id: 'gid://shopify/DiscountAutomaticNode/200', kind: 'native-bxgy', status: 'published' };
  const setup = fixture({ published });
  const bundle = definition({ discountType: 'buy_x_get_y', buy, get, discount: 100 });
  const result = await setup.publish(bundle);
  assert.equal(result.kind, 'native-bxgy');
  const update = setup.calls.find((entry) => entry.query.includes('discountAutomaticBxgyUpdate'));
  assert.equal(update.variables.id, published.id);
  assert.equal(update.variables.input.customerGets.value.discountOnQuantity.effect.percentage, 1);
  assert.equal(setup.calls.some((entry) => entry.query.includes('query Capability')), false);
  const stopped = await setup.publish({ ...bundle, enabled: false });
  assert.equal(stopped.status, 'inactive'); assert.equal(stopped.id, result.id);
  assert.equal(setup.calls.filter((entry) => entry.query.includes('discountAutomaticDeactivate')).length, 1);
  assert.equal(setup.values.get('discount-actual-set').status, 'inactive');
});

test('switching a published bundle between incompatible discount kinds never creates a second active discount', async () => {
  const native = fixture({ plus: true, published: { id: 'gid://shopify/DiscountAutomaticNode/200', kind: 'native-bxgy', status: 'published' } });
  await assert.rejects(native.publish(), (error) => error.status === 409);
  assert.equal(native.calls.some((entry) => entry.query.startsWith('mutation')), false);
  assert.equal(native.values.get('discount-actual-set').kind, 'native-bxgy');
  const app = fixture({ plus: true, published: { id: 'gid://shopify/DiscountAutomaticNode/100', kind: 'function', status: 'published' } });
  await assert.rejects(app.publish(definition({ discountType: 'buy_x_get_y', buy, get })), (error) => error.status === 409);
  assert.equal(app.calls.length, 0);
  assert.equal(app.values.get('discount-actual-set').kind, 'function');
});
