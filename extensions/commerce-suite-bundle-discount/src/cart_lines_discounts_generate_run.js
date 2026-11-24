/** Shopify Function source: synchronous, no Node imports, BigInt or network.
 * Prices come only from Function input, and eligibility only from the trusted
 * discount metafield. Browser _commerce_bundle attributes are not consulted.
 * First supported currencies are GBP/EUR; other precision rules fail closed.
 */
const MAX = Math.floor(Number.MAX_SAFE_INTEGER / 2);
const VARIANT = /^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/;
const empty = () => ({ operations: [] });
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum && value <= MAX;

function minor(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const pieces = value.split('.');
  const result = Number(pieces[0]) * 100 + Number((pieces[1] || '').padEnd(2, '0'));
  return integer(result) ? result : null;
}
function money(value) { return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`; }
function bps(bundle) {
  if (bundle.discountBps !== undefined) return integer(bundle.discountBps, 1) && bundle.discountBps <= 10000 ? bundle.discountBps : null;
  if (typeof bundle.discount !== 'number' || !Number.isFinite(bundle.discount) || !/^\d+(?:\.\d{1,2})?$/.test(String(bundle.discount))) return null;
  const value = minor(String(bundle.discount));
  return value > 0 && value <= 10000 ? value : null;
}

// Exact quotient/remainder for a*b/divisor when 0<=a,b<=divisor<=MAX.
// Doubling/remainder steps keep every intermediate a safe integer, even when
// the mathematical product would exceed JavaScript's integer precision.
function multiplyDivide(a, b, divisor) {
  let quotient = 0, remainder = 0;
  let currentQuotient = a === divisor ? 1 : 0;
  let currentRemainder = a === divisor ? 0 : a;
  while (b > 0) {
    if (b % 2 === 1) {
      quotient += currentQuotient;
      remainder += currentRemainder;
      if (remainder >= divisor) { quotient++; remainder -= divisor; }
    }
    b = Math.floor(b / 2);
    if (b) {
      currentQuotient *= 2;
      currentRemainder *= 2;
      if (currentRemainder >= divisor) { currentQuotient++; currentRemainder -= divisor; }
    }
  }
  return { quotient, remainder };
}

function configuration(input) {
  const bundle = input?.discount?.metafield?.jsonValue;
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.enabled === false || (bundle.enabled !== undefined && typeof bundle.enabled !== 'boolean')) return null;
  if (!['percentage', 'fixed'].includes(bundle.discountType) || !['GBP', 'EUR'].includes(bundle.currency)) return null;
  if (!Array.isArray(bundle.members) || bundle.members.length < 2 || bundle.members.length > 50) return null;
  const distinct = new Set();
  for (const member of bundle.members) {
    if (!member || !VARIANT.test(member.variantId || '') || distinct.has(member.variantId) || !integer(member.quantity ?? 1, 1)) return null;
    distinct.add(member.variantId);
  }
  if (bundle.maxSets !== undefined && !integer(bundle.maxSets, 1)) return null;
  if (bundle.markets !== undefined && (!Array.isArray(bundle.markets) || bundle.markets.some(value => typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)))) return null;
  if (bundle.markets?.length && !bundle.markets.includes(input?.localization?.country?.isoCode)) return null;
  if (bundle.discountType === 'percentage' ? bps(bundle) === null : !integer(bundle.discountAmountMinor, 1)) return null;
  return bundle;
}

/** @param {object} input @returns {{operations: object[]}} */
export function cartLinesDiscountsGenerateRun(input) {
  const bundle = configuration(input);
  if (!bundle || !Array.isArray(input?.discount?.discountClasses) || !input.discount.discountClasses.includes('PRODUCT')) return empty();
  const cart = input?.cart?.lines;
  if (!Array.isArray(cart) || cart.length > 1000) return empty();
  const byVariant = new Map();
  const lineIds = new Set();
  for (const line of cart) {
    if (!line || typeof line.id !== 'string' || !line.id || lineIds.has(line.id) || !integer(line.quantity, 1)) return empty();
    lineIds.add(line.id);
    if (line.merchandise?.__typename !== 'ProductVariant') continue;
    const variant = line.merchandise.id;
    if (!VARIANT.test(variant || '')) return empty();
    const amount = minor(line.cost?.amountPerQuantity?.amount);
    if (amount === null || line.cost.amountPerQuantity.currencyCode !== bundle.currency) return empty();
    const record = { id: line.id, quantity: line.quantity, unitMinor: amount };
    if (!byVariant.has(variant)) byVariant.set(variant, []);
    byVariant.get(variant).push(record);
  }
  let sets = bundle.maxSets ?? MAX;
  for (const member of bundle.members) {
    const available = (byVariant.get(member.variantId) || []).reduce((sum, line) => sum + line.quantity, 0);
    if (!integer(available)) return empty();
    sets = Math.min(sets, Math.floor(available / (member.quantity ?? 1)));
  }
  if (!sets) return empty();
  const eligible = [];
  for (const member of bundle.members) {
    let needed = (member.quantity ?? 1) * sets;
    if (!integer(needed, 1)) return empty();
    const lines = byVariant.get(member.variantId).slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const line of lines) {
      const quantity = Math.min(line.quantity, needed);
      if (quantity) {
        const subtotal = line.unitMinor * quantity;
        if (!integer(subtotal)) return empty();
        eligible.push({ id: line.id, quantity, subtotal });
        needed -= quantity;
      }
      if (!needed) break;
    }
  }
  const subtotal = eligible.reduce((sum, line) => sum + line.subtotal, 0);
  if (!integer(subtotal, 1)) return empty();
  const message = String(bundle.name || 'Bundle offer').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100);
  let candidates;
  if (bundle.discountType === 'percentage') {
    candidates = [{
      message,
      targets: eligible.filter(line => line.subtotal > 0).map(line => ({ cartLine: { id: line.id, quantity: line.quantity } })),
      value: { percentage: { value: money(bps(bundle)) } },
    }];
  } else {
    const requested = bundle.discountAmountMinor * sets;
    if (!integer(requested, 1)) return empty();
    const discount = Math.min(requested, subtotal);
    const shares = eligible.map(line => {
      const ratio = multiplyDivide(discount, line.subtotal, subtotal);
      return { ...line, amount: ratio.quotient, remainder: ratio.remainder };
    });
    let leftover = discount - shares.reduce((sum, line) => sum + line.amount, 0);
    shares.sort((a, b) => b.remainder - a.remainder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const share of shares) { if (!leftover) break; if (share.amount < share.subtotal) { share.amount++; leftover--; } }
    if (leftover) return empty();
    candidates = shares.filter(share => share.amount > 0).map(share => ({
      message,
      targets: [{ cartLine: { id: share.id, quantity: share.quantity } }],
      value: { fixedAmount: { amount: money(share.amount), appliesToEachItem: false } },
    }));
  }
  if (!candidates.length) return empty();
  return { operations: [{ productDiscountsAdd: { candidates, selectionStrategy: 'ALL' } }] };
}
