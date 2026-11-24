/**
 * Pure CarrierService rule evaluation. UI prices/thresholds are major currency
 * units and min/max are kilograms. Prefer priceMinor/thresholdMinor in APIs.
 * Bands are (min, max], matching the existing editor. A threshold can replace
 * a covered base quote, but never make an uncovered/overweight cart free.
 */
const KINDS = new Set(['weight', 'flat', 'eu', 'threshold', 'remote', 'blocked']);
const DEFAULT_REMOTE_PREFIXES = ['IV', 'HS', 'KW', 'ZE'];
const MAX_RULES = 1000;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 180) throw invalid(`${field} must be a non-empty string`);
}

function finite(value, field, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw invalid(`${field} must be a finite number >= ${minimum}`);
}

function minor(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${field} must be a non-negative safe integer`);
  return value;
}

function decimal(value, field) {
  finite(value, field);
  if (!/^\d+(?:\.\d{1,3})?$/.test(String(value))) throw invalid(`${field} has unsupported precision`);
}

function currencyDigits(currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw invalid('currency must be an uppercase ISO currency code');
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
}

function toMinor(value, digits, field) {
  decimal(value, field);
  const [whole, fraction = ''] = String(value).split('.');
  if (fraction.length > digits) throw invalid(`${field} has more decimals than the currency allows`);
  const amount = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, '0') || '0');
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid(`${field} exceeds the supported amount`);
  return Number(amount);
}

function price(rule, digits) {
  return rule.priceMinor !== undefined ? minor(rule.priceMinor, 'priceMinor') : toMinor(rule.price, digits, 'price');
}

function compactPostcode(value) {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeDestination(destination) {
  if (!object(destination)) throw invalid('destination is required');
  const country = typeof destination.country === 'string' ? destination.country.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(country)) throw invalid('destination.country must be a two-letter country code');
  if (typeof destination.postal_code !== 'string' || !destination.postal_code.trim() || destination.postal_code.length > 20) throw invalid('destination.postal_code is required');
  const postcode = compactPostcode(destination.postal_code);
  const formats = {
    GB: /^(?:[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}|GIR0AA)$/,
    DE: /^\d{5}$/, FR: /^\d{5}$/, IT: /^\d{5}$/, ES: /^\d{5}$/,
    NL: /^\d{4}[A-Z]{2}$/, BE: /^\d{4}$/, AT: /^\d{4}$/, LU: /^\d{4}$/,
    PT: /^\d{4}-?\d{3}$/, IE: /^[A-Z0-9]{7}$/, DK: /^\d{4}$/,
    SE: /^\d{5}$/, FI: /^\d{5}$/, PL: /^\d{2}-?\d{3}$/,
  };
  if (!(formats[country] || /^[A-Z0-9][A-Z0-9-]{1,15}$/).test(postcode)) throw invalid('postal code does not match destination country');
  return { country, postcode, formattedPostcode: country === 'GB' ? `${postcode.slice(0, -3)} ${postcode.slice(-3)}` : postcode };
}

function validatePatterns(patterns, field) {
  if (!Array.isArray(patterns) || patterns.length > 1000) throw invalid(`${field} must be an array of postal patterns`);
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern.trim() || pattern.length > 40) throw invalid(`${field} contains an invalid postal pattern`);
    const normalized = pattern.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9\s-]*\*?$/.test(normalized)) throw invalid(`${field} only supports exact postcodes, trailing wildcards, and numeric ranges`);
    if (/^\d+-\d+$/.test(normalized)) {
      const [from, to] = normalized.split('-');
      if (from.length !== to.length || Number(from) > Number(to)) throw invalid(`${field} contains an invalid numeric postal range`);
    }
  }
}

function patternMatches(pattern, destination) {
  const value = pattern.trim().toUpperCase().replace(/\s+/g, ' ');
  if (value.endsWith('*')) {
    const prefix = value.slice(0, -1);
    // Preserve UK district boundaries: E1 * must not match E10 1AA.
    return (prefix.includes(' ') ? destination.formattedPostcode : destination.postcode).startsWith(prefix);
  }
  if (/^\d+-\d+$/.test(value)) {
    const [from, to] = value.split('-');
    return /^\d+$/.test(destination.postcode) && destination.postcode.length === from.length
      && destination.postcode >= from && destination.postcode <= to;
  }
  return destination.postcode === compactPostcode(value);
}

function postcodeMatches(rule, destination, remoteDefaults = false) {
  if (!rule.countries.some((country) => country.toUpperCase() === destination.country)) return false;
  if (rule.excludePostcodes?.some((pattern) => patternMatches(pattern, destination))) return false;
  const patterns = [
    ...(rule.postcodes || []),
    ...(rule.postcodePrefixes || []).map((prefix) => `${prefix}*`),
  ];
  if (!patterns.length && remoteDefaults && destination.country === 'GB') return DEFAULT_REMOTE_PREFIXES.some((prefix) => destination.postcode.startsWith(prefix));
  return !patterns.length || patterns.some((pattern) => patternMatches(pattern, destination));
}

function coversItems(rule, items) {
  if (!rule.productIds?.length && !rule.variantIds?.length) return true;
  // A partial product-group quote would undercharge a mixed cart. Such carts
  // deliberately receive no quote until every item is covered by this rule.
  return items.every((item) => rule.variantIds?.map(String).includes(String(item.variant_id))
    || rule.productIds?.map(String).includes(String(item.product_id)));
}

export function validateShippingRules(rules) {
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw invalid(`shipping rules must be an array with at most ${MAX_RULES} entries`);
  const ids = new Set();
  for (const rule of rules) {
    if (!object(rule)) throw invalid('each shipping rule must be an object');
    identifier(rule.id, 'rule.id');
    identifier(rule.name, 'rule.name');
    if (ids.has(rule.id)) throw invalid(`duplicate shipping rule id: ${rule.id}`);
    ids.add(rule.id);
    if (!KINDS.has(rule.kind)) throw invalid(`unsupported shipping rule kind: ${rule.kind}`);
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') throw invalid('rule.enabled must be boolean');
    if (!Array.isArray(rule.countries) || !rule.countries.length || rule.countries.some((country) => typeof country !== 'string' || !/^[A-Z]{2}$/i.test(country))) throw invalid('rule.countries must contain two-letter country codes');
    if (rule.currency !== undefined) currencyDigits(rule.currency);
    if (rule.priceMinor !== undefined) minor(rule.priceMinor, 'rule.priceMinor');
    else if (rule.kind !== 'blocked') decimal(rule.price, 'rule.price');
    if (rule.min !== undefined) finite(rule.min, 'rule.min');
    if (rule.max !== undefined) {
      finite(rule.max, 'rule.max');
      if (rule.max <= (rule.min || 0)) throw invalid('rule.max must be greater than rule.min');
    } else if (['weight', 'eu'].includes(rule.kind)) throw invalid('weight-based rules require an explicit maximum weight');
    if (rule.kind === 'threshold') {
      if (rule.thresholdMinor !== undefined) minor(rule.thresholdMinor, 'rule.thresholdMinor');
      else decimal(rule.threshold, 'rule.threshold');
    }
    if (rule.priority !== undefined && (!Number.isSafeInteger(rule.priority) || rule.priority < 0)) throw invalid('rule.priority must be a non-negative integer');
    if (rule.allowRemote !== undefined && typeof rule.allowRemote !== 'boolean') throw invalid('rule.allowRemote must be boolean');
    if (rule.serviceCode !== undefined) identifier(rule.serviceCode, 'rule.serviceCode');
    for (const field of ['postcodes', 'excludePostcodes']) if (rule[field] !== undefined) validatePatterns(rule[field], field);
    if (rule.postcodePrefixes !== undefined) {
      if (!Array.isArray(rule.postcodePrefixes) || rule.postcodePrefixes.some((prefix) => typeof prefix !== 'string' || !/^[A-Z0-9][A-Z0-9 ]{0,15}$/i.test(prefix))) throw invalid('postcodePrefixes must contain postal prefixes without wildcards');
    }
    for (const field of ['productIds', 'variantIds']) {
      if (rule[field] !== undefined && (!Array.isArray(rule[field]) || !rule[field].length || rule[field].some((id) => !['number', 'string'].includes(typeof id) || !String(id).trim()))) throw invalid(`${field} must contain product identifiers`);
    }
  }
  return rules;
}

export function quoteShipping({ rules, destination, items, currency }) {
  validateShippingRules(rules);
  const digits = currencyDigits(currency);
  const address = normalizeDestination(destination);
  if (!Array.isArray(items) || items.length > 1000) throw invalid('items must be an array of at most 1000 cart lines');
  const physicalItems = items.filter((item) => item?.requires_shipping !== false);
  if (!physicalItems.length) return { rates: [] };
  const active = rules.filter((rule) => rule.enabled !== false && (!rule.currency || rule.currency === currency))
    .sort((left, right) => (left.priority || 0) - (right.priority || 0));
  if (active.some((rule) => rule.kind === 'blocked' && postcodeMatches(rule, address)
    && ((!rule.productIds?.length && !rule.variantIds?.length) || physicalItems.some((item) => coversItems(rule, [item]))))) return { rates: [] };
  let grams = 0;
  let subtotal = 0;
  let knownSubtotal = true;
  for (const item of physicalItems) {
    if (!object(item) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) throw invalid('item.quantity must be a positive integer');
    // Missing/zero weight must not slip through a free shipping threshold.
    if (!Number.isSafeInteger(item.grams) || item.grams <= 0) return { rates: [] };
    grams += item.grams * item.quantity;
    if (!Number.isSafeInteger(grams)) throw invalid('cart weight exceeds the supported range');
    if (item.price === undefined || item.price === null) knownSubtotal = false;
    else {
      minor(item.price, 'item.price');
      subtotal += item.price * item.quantity;
      if (!Number.isSafeInteger(subtotal)) throw invalid('cart amount exceeds the supported range');
    }
  }
  const isRemote = address.country === 'GB' && (
    DEFAULT_REMOTE_PREFIXES.some((prefix) => address.postcode.startsWith(prefix))
    || rules.some((rule) => rule.kind === 'remote' && postcodeMatches(rule, address, true))
  );
  const weightMatches = (rule) => grams > (rule.min || 0) * 1000 && (rule.max === undefined || grams <= rule.max * 1000);
  const eligible = (rule) => postcodeMatches(rule, address) && coversItems(rule, physicalItems) && weightMatches(rule);
  const base = active.find((rule) => ['weight', 'flat', 'eu'].includes(rule.kind) && eligible(rule));
  if (!base) return { rates: [] };
  const remote = isRemote && base.area !== 'remote'
    ? active.find((rule) => rule.kind === 'remote' && postcodeMatches(rule, address, true) && coversItems(rule, physicalItems) && weightMatches(rule)) : null;
  // A paused/unconfigured remote surcharge must not turn a remote address into
  // mainland delivery. Configure an explicit remote base rate to opt out.
  if (isRemote && base.area !== 'remote' && !remote) return { rates: [] };
  const threshold = knownSubtotal ? active.find((rule) => rule.kind === 'threshold' && eligible(rule)
    && (!isRemote || rule.allowRemote === true || rule.area === 'remote')
    && subtotal >= (rule.thresholdMinor !== undefined ? rule.thresholdMinor : toMinor(rule.threshold, digits, 'threshold'))) : null;
  const selected = threshold || base;
  const total = price(selected, digits) + (remote ? price(remote, digits) : 0);
  if (!Number.isSafeInteger(total)) throw invalid('shipping price exceeds the supported range');
  return { rates: [{
    service_name: selected.name,
    service_code: selected.serviceCode || `rate-${selected.id}`,
    total_price: String(total),
    currency,
    description: [selected.description || selected.name, remote?.name].filter(Boolean).join(' + '),
  }] };
}
