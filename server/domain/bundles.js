/** Pure recommendation/offer logic. Every amount is an integer minor unit. */
const TYPES = new Set(['manual', 'auto', 'global']);
const DISCOUNT_TYPES = new Set(['percentage', 'fixed', 'buy_x_get_y', 'none']);
const VARIANT_GID = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 180) throw invalid(`${field} must be a non-empty string`);
  return value;
}
function integer(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw invalid(`${field} must be a safe integer >= ${minimum}`);
  return value;
}
function safe(value, field = 'amount') {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) throw invalid(`${field} exceeds the supported range`);
  return Number(value);
}
function basisPoints(bundle) {
  if (bundle.discountBps !== undefined) {
    integer(bundle.discountBps, 'discountBps');
    if (bundle.discountBps > 10000) throw invalid('discountBps must not exceed 10000');
    return bundle.discountBps;
  }
  const percentage = bundle.discount ?? 0;
  if (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 100 || !/^\d+(?:\.\d{1,2})?$/.test(String(percentage))) throw invalid('discount must be a percentage from 0 to 100 with at most two decimals');
  const [whole, fraction = ''] = String(percentage).split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
function discountType(bundle) { return bundle.discountType || 'percentage'; }

function members(bundle) {
  if (discountType(bundle) === 'buy_x_get_y') return [bundle.buy, bundle.get];
  if (bundle.members !== undefined) return bundle.members;
  // UI demo product keys are accepted as local member keys. An API adapter must
  // resolve them to actual variant IDs before a Shopify cart is priced.
  return bundle.products?.map((variantId) => ({ variantId, quantity: 1 }));
}

function validateMember(member) {
  if (!isObject(member)) throw invalid('bundle members must be objects');
  id(member.variantId, 'member.variantId');
  integer(member.quantity ?? 1, 'member.quantity', 1);
  if (member.productId !== undefined) id(member.productId, 'member.productId');
}

export function validateBundles(bundles) {
  if (!Array.isArray(bundles) || bundles.length > 1000) throw invalid('bundles must be an array with at most 1000 entries');
  const ids = new Set();
  for (const bundle of bundles) {
    if (!isObject(bundle)) throw invalid('each bundle must be an object');
    id(bundle.id, 'bundle.id'); id(bundle.name, 'bundle.name');
    if (ids.has(bundle.id)) throw invalid(`duplicate bundle id: ${bundle.id}`);
    ids.add(bundle.id);
    if (bundle.enabled !== undefined && typeof bundle.enabled !== 'boolean') throw invalid('bundle.enabled must be boolean');
    if (bundle.type !== undefined && !TYPES.has(bundle.type)) throw invalid('bundle.type must be manual, auto, or global');
    if (!DISCOUNT_TYPES.has(discountType(bundle))) throw invalid('unsupported bundle discountType');
    const required = members(bundle);
    if (!Array.isArray(required) || required.length < 2 || required.length > 50) throw invalid('a bundle requires 2 to 50 distinct members');
    required.forEach(validateMember);
    if (new Set(required.map((member) => member.variantId)).size !== required.length) throw invalid('bundle member variant IDs must be distinct');
    if (bundle.products !== undefined && (!Array.isArray(bundle.products) || bundle.products.some((productId) => typeof productId !== 'string' || !productId.trim()))) throw invalid('bundle.products must contain product identifiers');
    if (['percentage', 'buy_x_get_y'].includes(discountType(bundle))) basisPoints(bundle);
    if (discountType(bundle) === 'fixed') integer(bundle.discountAmountMinor, 'discountAmountMinor');
    if (bundle.maxSets !== undefined) integer(bundle.maxSets, 'maxSets', 1);
    if (bundle.currency !== undefined && (typeof bundle.currency !== 'string' || !/^[A-Z]{3}$/.test(bundle.currency))) throw invalid('bundle.currency must be an uppercase ISO currency code');
    if (bundle.markets !== undefined && (!Array.isArray(bundle.markets) || bundle.markets.some((market) => typeof market !== 'string' || !market.trim()))) throw invalid('bundle.markets must contain market identifiers');
    for (const field of ['startsAt', 'endsAt']) {
      if (bundle[field] !== undefined && bundle[field] !== null && (typeof bundle[field] !== 'string' || !Number.isFinite(Date.parse(bundle[field])))) throw invalid(`${field} must be a valid date`);
    }
    if (bundle.startsAt && bundle.endsAt && Date.parse(bundle.endsAt) <= Date.parse(bundle.startsAt)) throw invalid('endsAt must be after startsAt');
  }
  return bundles;
}

function marketMatches(markets, market) {
  return !markets?.length || (typeof market === 'string' && markets.some((value) => value.toUpperCase() === market.toUpperCase()));
}

function isInSchedule(bundle, now) {
  return (!bundle.startsAt || Date.parse(bundle.startsAt) <= now)
    && (!bundle.endsAt || Date.parse(bundle.endsAt) > now);
}

function isSellable(product, market) {
  if (!isObject(product) || product.availableForSale === false || product.available === false || product.published === false) return false;
  if (product.status && product.status.toUpperCase() !== 'ACTIVE') return false;
  if (!marketMatches(product.markets, market)) return false;
  if (product.inventoryPolicy !== 'CONTINUE' && Number.isFinite(product.inventoryQuantity) && product.inventoryQuantity <= 0) return false;
  const variants = Array.isArray(product.variants) ? product.variants : product.variants?.nodes;
  if (variants?.length && !variants.some((variant) => variant.availableForSale !== false
    && (variant.inventoryPolicy === 'CONTINUE' || !Number.isFinite(variant.inventoryQuantity) || variant.inventoryQuantity > 0))) return false;
  return true;
}

/** Recommendations use persisted/manual/co-purchase candidates, never fake AI. */
export function getRecommendations({ bundles, products, productId, market, limit = 6, now = Date.now() }) {
  validateBundles(bundles);
  id(productId, 'productId'); integer(limit, 'limit');
  if (limit > 50) throw invalid('limit must not exceed 50');
  if (!Array.isArray(products) && !isObject(products)) throw invalid('products must be an array or keyed catalog');
  const catalog = Array.isArray(products) ? products : Object.entries(products).map(([key, product]) => {
    if (!isObject(product)) throw invalid('catalog products must be objects');
    return { ...product, id: product.id || key };
  });
  if (catalog.some((product) => !isObject(product) || typeof product.id !== 'string'
    || (product.markets !== undefined && (!Array.isArray(product.markets) || product.markets.some((value) => typeof value !== 'string'))))) throw invalid('catalog products must contain string IDs and valid markets');
  const byId = new Map(catalog.map((product) => [String(product.id), product]));
  const candidates = new Map();
  for (const bundle of bundles) {
    if (bundle.enabled === false || !marketMatches(bundle.markets, market) || !isInSchedule(bundle, now)) continue;
    const productIds = bundle.products || members(bundle).map((member) => member.productId || member.variantId);
    if (bundle.type !== 'global' && !productIds.includes(productId)) continue;
    const rank = { manual: 300, auto: 200, global: 100 }[bundle.type || 'manual'];
    for (const candidateId of productIds) {
      if (candidateId === productId) continue;
      const product = byId.get(String(candidateId));
      if (!isSellable(product, market)) continue;
      const current = candidates.get(String(candidateId));
      if (!current || rank > current.score) candidates.set(String(candidateId), {
        ...product, bundleId: bundle.id, recommendationType: bundle.type || 'manual', score: rank,
      });
    }
  }
  return [...candidates.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}

/** Calculate a preview from trusted server-loaded prices, never browser prices. */
export function calculateBundleOffer({ bundle, lines, currency, market, now = Date.now() }) {
  validateBundles([bundle]);
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw invalid('currency must be an uppercase ISO currency code');
  if (!Array.isArray(lines) || lines.length > 1000) throw invalid('lines must contain at most 1000 cart lines');
  const cart = lines.map((line) => {
    if (!isObject(line)) throw invalid('cart lines must be objects');
    id(line.variantId, 'line.variantId');
    integer(line.quantity, 'line.quantity', 1); integer(line.unitPrice, 'line.unitPrice');
    const subtotalMinor = safe(BigInt(line.quantity) * BigInt(line.unitPrice));
    return { ...line, subtotalMinor, discountedQuantity: 0, discountMinor: 0, totalMinor: subtotalMinor };
  });
  const subtotal = cart.reduce((sum, line) => sum + BigInt(line.subtotalMinor), 0n);
  const totals = new Map();
  for (const line of cart) totals.set(line.variantId, safe(BigInt(totals.get(line.variantId) || 0) + BigInt(line.quantity), 'quantity'));
  const required = members(bundle);
  let sets = bundle.enabled === false || (bundle.currency && bundle.currency !== currency)
    || !marketMatches(bundle.markets, market) || !isInSchedule(bundle, now)
    ? 0 : Math.min(...required.map((member) => Math.floor((totals.get(member.variantId) || 0) / (member.quantity ?? 1))));
  sets = Math.min(sets, bundle.maxSets ?? Number.MAX_SAFE_INTEGER);
  const selected = new Map(required.map((member) => [member.variantId, (member.quantity ?? 1) * sets]));
  // Buy X get Y discounts only Y; the prerequisite units retain their price.
  if (discountType(bundle) === 'buy_x_get_y') selected.delete(bundle.buy.variantId);
  const order = cart.map((_, index) => index).sort((left, right) => cart[left].unitPrice - cart[right].unitPrice || left - right);
  let discountable = 0n;
  for (const index of order) {
    const line = cart[index];
    const quantity = Math.min(selected.get(line.variantId) || 0, line.quantity);
    line.discountedQuantity = quantity;
    selected.set(line.variantId, (selected.get(line.variantId) || 0) - quantity);
    discountable += BigInt(quantity) * BigInt(line.unitPrice);
  }
  let discount = 0n;
  if (sets && ['percentage', 'buy_x_get_y'].includes(discountType(bundle))) discount = (discountable * BigInt(basisPoints(bundle)) + 5000n) / 10000n;
  if (sets && discountType(bundle) === 'fixed') discount = BigInt(bundle.discountAmountMinor) * BigInt(sets);
  if (discount > discountable) discount = discountable;
  // Largest-remainder allocation conserves every penny and never discounts
  // extra units or unrelated products. Stable line ordering resolves ties.
  if (discount && discountable) {
    const allocations = cart.map((line, index) => {
      const value = BigInt(line.discountedQuantity) * BigInt(line.unitPrice);
      return { index, amount: value * discount / discountable, remainder: value * discount % discountable, value };
    });
    let remaining = discount - allocations.reduce((sum, allocation) => sum + allocation.amount, 0n);
    const ranked = [...allocations].sort((left, right) => left.remainder === right.remainder ? left.index - right.index : left.remainder > right.remainder ? -1 : 1);
    for (const allocation of ranked) if (remaining > 0n && allocation.amount < allocation.value) { allocation.amount += 1n; remaining -= 1n; }
    for (const allocation of allocations) {
      cart[allocation.index].discountMinor = safe(allocation.amount);
      cart[allocation.index].totalMinor -= safe(allocation.amount);
    }
  }
  return {
    bundleId: bundle.id, currency, eligible: sets > 0, sets,
    subtotalMinor: safe(subtotal), eligibleSubtotalMinor: safe(discountable),
    discountMinor: safe(discount), totalMinor: safe(subtotal - discount), lines: cart,
  };
}

/**
 * Only an exact one-variant buy group + one-variant get group is translated.
 * A basic discount with min quantity is NOT equivalent to requiring A AND B.
 * The caller must execute the returned mutation and check Shopify userErrors.
 */
export function nativeDiscountInput(bundle) {
  validateBundles([bundle]);
  if (bundle.enabled === false) return { supported: true, action: 'deactivate', input: null };
  const unsupported = (reason) => ({ supported: false, reason: `${reason}; requires Functions/Plus` });
  if (discountType(bundle) !== 'buy_x_get_y') return unsupported('Discounts requiring every distinct bundle member cannot be represented by a native basic discount');
  if (bundle.markets?.length) return unsupported('Native BXGY cannot enforce this bundle market restriction');
  if (bundle.currency) return unsupported('Native BXGY cannot enforce this bundle currency restriction');
  if (![bundle.buy.variantId, bundle.get.variantId].every((value) => VARIANT_GID.test(value))) return unsupported('Resolve local product keys to actual Shopify ProductVariant IDs first');
  const startsAt = bundle.startsAt || new Date().toISOString();
  const input = {
    title: bundle.name, startsAt, endsAt: bundle.endsAt || null,
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
    customerBuys: {
      items: { products: { productVariantsToAdd: [bundle.buy.variantId] } },
      value: { quantity: String(bundle.buy.quantity ?? 1) },
    },
    customerGets: {
      items: { products: { productVariantsToAdd: [bundle.get.variantId] } },
      value: { discountOnQuantity: { quantity: String(bundle.get.quantity ?? 1), effect: { percentage: basisPoints(bundle) / 10000 } } },
      appliesOnOneTimePurchase: true, appliesOnSubscription: false,
    },
  };
  if (bundle.maxSets !== undefined) input.usesPerOrderLimit = String(bundle.maxSets);
  return { supported: true, action: 'upsert', mutation: 'discountAutomaticBxgyCreate', input };
}
