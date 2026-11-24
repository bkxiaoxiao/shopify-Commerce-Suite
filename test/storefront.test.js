import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const directory = new URL('../extensions/commerce-suite/', import.meta.url);
const source = await readFile(new URL('assets/commerce-suite.js', directory), 'utf8');
const definitions = new Map();
const context = vm.createContext({
  URL, Intl, AbortController, HTMLElement: class {},
  window: { location: { origin: 'https://store.example' } },
  customElements: { get: key => definitions.get(key), define: (key, value) => definitions.set(key, value) },
});
vm.runInContext(source, context);
const helpers = context.CommerceSuiteStorefront;
const plain = value => JSON.parse(JSON.stringify(value));

test('theme asset registers isolated elements once and never inserts response HTML', () => {
  assert.equal(definitions.size, 2);
  vm.runInContext(source, context);
  assert.equal(definitions.size, 2);
  assert.doesNotMatch(source, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write\s*\(/);
  assert.match(source, /\.textContent\s*=/);
});

test('variant IDs remain precise and cart requests contain no forged prices or discounts', () => {
  assert.equal(helpers.variantId('gid://shopify/ProductVariant/123'), '123');
  assert.equal(helpers.variantId('900719925474099300'), '900719925474099300');
  for (const value of ['0', '-1', '<script>', 'gid://shopify/Product/123', Number.MAX_SAFE_INTEGER + 1]) assert.equal(helpers.variantId(value), null);
  const items = plain(helpers.buildCartItems([
    { variantId: 'gid://shopify/ProductVariant/123', quantity: 1, price: 0, discount: 100 },
    { variantId: '123', quantity: 2 }, { variantId: '456', quantity: 1 },
  ], 'bundle-1'));
  assert.deepEqual(items, [
    { id: '123', quantity: 3, properties: { _commerce_bundle: 'bundle-1' } },
    { id: '456', quantity: 1, properties: { _commerce_bundle: 'bundle-1' } },
  ]);
  assert.throws(() => helpers.buildCartItems([], 'bundle-1'));
  assert.throws(() => helpers.buildCartItems([{ variantId: '123', quantity: -1 }], 'bundle-1'));
  assert.throws(() => helpers.buildCartItems([{ variantId: '123', quantity: 1000 }], 'bundle-1'));
});

test('proxy paths and image URLs cannot become script or off-site form endpoints', () => {
  for (const value of ['https://attacker.example', '//attacker.example', '/apps/commerce-suite?secret=1', 'javascript:alert(1)']) {
    assert.equal(helpers.safePath(value), '/apps/commerce-suite');
  }
  assert.equal(helpers.shopRoot('/de/'), '/de/');
  assert.equal(helpers.shopRoot('/'), '/');
  assert.equal(helpers.imageUrl('//cdn.shopify.com/image.jpg', 'https://store.example'), 'https://cdn.shopify.com/image.jpg');
  for (const value of ['javascript:alert(1)', 'data:image/svg+xml,<svg>', 'http://unsafe.example/a', 'https://user:pass@cdn.example/a']) {
    assert.equal(helpers.imageUrl(value, 'https://store.example'), null);
  }
  assert.equal(helpers.formatMoney(1290, 'EUR', 'de-DE').includes('12,90'), true);
  assert.equal(helpers.formatMoney(1.2, 'GBP', 'en-GB'), '');
});

test('product form lookup skips unrelated quick-add forms and respects an explicit matching form', () => {
  const variants = [{ id: '123' }, { id: '456' }];
  const form = value => ({ matches: selector => selector === 'form', querySelector: () => ({ value }) });
  const unrelated = form('999'), actual = form('456'), explicit = form('123');
  const document = {
    querySelectorAll: () => [unrelated, actual],
    querySelector: selector => selector === '#preferred' ? explicit : unrelated,
  };
  assert.equal(helpers.findProductForm({ dataset: {} }, variants, document), actual);
  assert.equal(helpers.findProductForm({ dataset: { formSelector: '#preferred' } }, variants, document), explicit);
  assert.equal(helpers.findProductForm({ dataset: { formSelector: '#wrong' } }, variants, document), actual);
});

test('variant selection follows real form changes, newly changed URLs and explicit variant events', () => {
  const variants = [{ id: '123', available: true }, { id: '456', available: false }];
  const input = { variants, formValue: '123', urlValue: '123', previousUrlValue: '123', fallback: '123' };
  assert.equal(helpers.selectVariant(input).id, '123');
  assert.equal(helpers.selectVariant({ ...input, formValue: '456' }).id, '456');
  assert.equal(helpers.selectVariant({ ...input, urlValue: '456' }).id, '456');
  assert.equal(helpers.selectVariant({ ...input, eventValue: '456' }).id, '456');
  assert.equal(helpers.selectVariant({ ...input, eventValue: 'unrelated', urlValue: '999' }).id, '123');
});

test('a missing configured variant is never replaced with another variant of that product', async () => {
  const Block = definitions.get('commerce-suite-bundles');
  const block = Object.create(Block.prototype); block.rootPath = '/de/';
  context.fetch = async () => ({ ok: true, json: async () => ({ title: 'Rack', variants: [{ id: 123, available: false, price: 100 }, { id: 456, available: true, price: 200 }] }) });
  assert.equal(await block.hydrate({ variantId: '123', handle: 'rack', quantity: 2 }), null);
  const card = await block.hydrate({ variantId: '456', handle: 'rack', quantity: 2 });
  assert.equal(card.selected.id, '456');
  assert.equal(card.quantity, 2);
  block.mainCard = { checked: true, selected: { id: '789' }, quantity: 3 };
  block.cards = [card];
  assert.deepEqual(plain(block.selections()), [{ variantId: '789', quantity: 3 }, { variantId: '456', quantity: 2 }]);
});

test('late recommendations for the previous main variant cannot overwrite the new selection', async () => {
  const Block = definitions.get('commerce-suite-bundles');
  const block = Object.create(Block.prototype);
  const requests = []; const rendered = [];
  context.fetch = url => new Promise(resolve => requests.push({ url: String(url), resolve }));
  Object.assign(block, { alive: true, abort: new AbortController(), variant: { id: '111', available: true }, proxyPath: '/apps/commerce-suite', dataset: { productId: '10', country: 'GB', currency: 'GBP', limit: '3' } });
  block.status = () => {};
  block.hydrate = async source => ({ source, selected: { id: source.variantId }, quantity: source.quantity, checked: true });
  block.render = () => rendered.push(block.cards[0].source.variantId);
  const oldRequest = block.load();
  block.variant = { id: '222', available: true };
  const newRequest = block.load();
  assert.match(requests[0].url, /variant_id=111/);
  assert.match(requests[1].url, /variant_id=222/);
  const response = id => ({ ok: true, json: async () => ({ mainQuantity: 2, products: [{ variantId: id, productId: '20', handle: 'rack', currency: 'GBP', quantity: 3, bundleId: 'bundle-1' }] }) });
  requests[1].resolve(response('444')); await newRequest;
  requests[0].resolve(response('333')); await oldRequest;
  assert.deepEqual(rendered, ['444']);
  assert.equal(block.mainQuantity, 2);
});

test('different variants of the same product remain valid bundle members and deduplicate by variant ID', async () => {
  const Block = definitions.get('commerce-suite-bundles');
  const block = Object.create(Block.prototype);
  Object.assign(block, { alive: true, abort: new AbortController(), variant: { id: '111', available: true }, proxyPath: '/apps/commerce-suite', dataset: { productId: '10', country: 'GB', currency: 'GBP', limit: '6' } });
  const products = ['111', '222', '333', '333'].map(id => ({ variantId: `gid://shopify/ProductVariant/${id}`, productId: 'gid://shopify/Product/10', handle: 'rack', currency: 'GBP', quantity: 1 }));
  context.fetch = async () => ({ ok: true, json: async () => ({ products }) });
  block.status = () => {};
  block.hydrate = async source => ({ source, selected: { id: helpers.variantId(source.variantId) }, quantity: 1, checked: true });
  block.render = () => {};
  await block.load();
  assert.deepEqual(plain(block.cards.map(card => card.selected.id)), ['222', '333']);
});

test('Liquid blocks have valid unique schema settings, safe JSON text, and no implicit email GET', async () => {
  for (const name of ['bundles', 'restock']) {
    const liquid = await readFile(new URL(`blocks/${name}.liquid`, directory), 'utf8');
    const schema = JSON.parse(liquid.match(/\{% schema %\}([\s\S]*?)\{% endschema %\}/)[1]);
    assert.equal(schema.target, 'section');
    assert.equal(schema.javascript, 'commerce-suite.js');
    assert.equal(new Set(schema.settings.map(value => value.id)).size, schema.settings.length);
    assert.equal(schema.settings.find(value => value.id === 'proxy_path').default, '/apps/commerce-suite');
    if (name === 'restock') {
      assert.match(liquid, /<form[^>]+method="post"/);
      assert.doesNotMatch(liquid, /name="marketingConsent"[^>]*checked/);
      assert.equal(schema.settings.find(value => value.id === 'show_marketing_option').default, false);
    }
  }
  const snippet = await readFile(new URL('snippets/product-data.liquid', directory), 'utf8');
  assert.match(snippet, /replace: '<', '\\u003c'/);
  const locales = await Promise.all(['en.default', 'de', 'fr'].map(async language => JSON.parse(await readFile(new URL(`locales/${language}.json`, directory), 'utf8'))));
  const paths = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) => typeof child === 'object' ? paths(child, `${prefix}${key}.`) : `${prefix}${key}`).sort();
  assert.deepEqual(paths(locales[0]), paths(locales[1]));
  assert.deepEqual(paths(locales[0]), paths(locales[2]));
});
