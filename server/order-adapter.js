/** Strict adapters for Shopify's REST-shaped webhook payloads. These do not
 * call the legacy REST API. Unreconciled/edited orders need a complete GraphQL
 * refetch or finance review; they must not silently produce a guessed invoice.
 */

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'ORDER_DATA_INCOMPLETE'; error.status = 422;
  throw error;
}
const integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a non-negative safe integer`);
  return value;
};
const sum = (values, name) => integer(values.reduce((a, b) => a + b, 0), name ?? 'amount');
const clean = (value, size = 500) => String(value ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, size);

function currency(value) {
  const result = String(value ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) invalid('A currency code is required');
  return result;
}

function decimal(value, code, name, signed = false) {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) invalid(`${name} must be an exact decimal string`);
  const scale = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  if (fraction.slice(scale).replace(/0/g, '')) invalid(`${name} contains fractions smaller than a minor unit`);
  const big = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.slice(0, scale).padEnd(scale, '0') || '0');
  const amount = Number(negative ? -big : big);
  if (!Number.isSafeInteger(amount) || (!signed && amount < 0)) invalid(`${name} is outside the supported monetary range`);
  return amount;
}

function amount(set, scalar, code, shopCurrency, name, signed = false) {
  if (set != null) {
    const entry = [set.presentment_money, set.shop_money].find(money => money?.currency_code === code);
    if (!entry) invalid(`${name} does not contain ${code}; currencies cannot be mixed`);
    return decimal(entry.amount, code, name, signed);
  }
  if (code !== shopCurrency) invalid(`${name} is missing a money set for the presentment currency`);
  return decimal(scalar, code, name, signed);
}

function id(value, kind) {
  if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^(?:[1-9]\d*|gid:\/\/shopify\/[A-Za-z]+\/[1-9]\d*)$/.test(String(value ?? ''))) invalid(`${kind} ID is required and must not lose integer precision`);
  return String(value);
}

function date(value, name) {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(value) || Number.isNaN(Date.parse(value))) invalid(`${name} is required`);
  return String(value);
}

function array(value, name) {
  if (!Array.isArray(value)) invalid(`${name} must be present as an array`);
  return value;
}

function taxLines(lines, code, shopCurrency, name) {
  return array(lines, name).map(tax => {
    const rate = Number(tax.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) invalid(`${name} contains an invalid rate`);
    return { title: clean(tax.title ?? 'VAT', 100), rate, taxMinor: amount(tax.price_set, tax.price, code, shopCurrency, name) };
  });
}

function customer(payload) {
  const address = payload.billing_address;
  const source = payload.customer ?? {};
  const customerName = address?.company || address?.name || [address?.first_name, address?.last_name].filter(Boolean).join(' ') || [source.first_name, source.last_name].filter(Boolean).join(' ');
  if (!customerName) invalid('The order has no customer name or billing name');
  return {
    name: clean(customerName, 250), email: clean(payload.email ?? source.email, 254),
    address: address ? [address.address1, address.address2, [address.zip, address.city].filter(Boolean).join(' '), address.province, address.country].filter(Boolean).map(value => clean(value, 300)) : [],
    countryCode: clean(address?.country_code, 2).toUpperCase(), vatNumber: clean(source.vat_number ?? source.tax_number ?? address?.vat_number, 100),
  };
}

function unchanged(payload, code, shopCurrency, originalTotal, originalTax, originalSubtotal, originalDiscount) {
  for (const [name, setName, expected] of [
    ['current_total_price', 'current_total_price_set', originalTotal],
    ['current_total_tax', 'current_total_tax_set', originalTax],
    ['current_subtotal_price', 'current_subtotal_price_set', originalSubtotal],
    ['current_total_discounts', 'current_total_discounts_set', originalDiscount],
  ]) {
    if ((payload[name] != null || payload[setName] != null) && amount(payload[setName], payload[name], code, shopCurrency, name) !== expected) invalid('Order was modified; a current payload cannot reconstruct the original issued invoice');
  }
}

export function orderFromWebhook(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) invalid('An order webhook object is required');
  const orderId = id(payload.id, 'Order');
  if (payload.financial_status !== 'paid') invalid('Automatic paid invoices require a currently paid order');
  if (payload.cancelled_at || payload.edited === true || (Array.isArray(payload.refunds) && payload.refunds.length)) invalid('Cancelled, edited or already refunded orders require review before original invoice issuance');
  if (typeof payload.taxes_included !== 'boolean') invalid('taxes_included must be explicit');
  const shopCurrency = currency(payload.currency);
  const code = currency(payload.presentment_currency ?? shopCurrency);
  const sourceLines = array(payload.line_items, 'line_items');
  if (!sourceLines.length) invalid('At least one complete line item is required');
  const lineItems = sourceLines.map(line => {
    const lineId = id(line.id, 'Line item');
    const quantity = integer(line.quantity, 'quantity');
    if (!quantity) invalid('Line quantity must be positive');
    if (line.current_quantity != null && line.current_quantity !== quantity) invalid('Order line quantity was modified; original invoice needs review');
    const unitPriceMinor = amount(line.price_set, line.price, code, shopCurrency, 'line price');
    const discounts = array(line.discount_allocations, 'discount_allocations');
    const discountMinor = sum(discounts.map(discount => amount(discount.amount_set, discount.amount, code, shopCurrency, 'discount allocation')));
    const original = integer(unitPriceMinor * quantity, 'line original total');
    if (discountMinor > original) invalid('Line discount is greater than its original amount');
    const taxes = taxLines(line.tax_lines, code, shopCurrency, 'line tax_lines');
    const taxMinor = sum(taxes.map(tax => tax.taxMinor));
    const title = clean(line.title ?? line.name, 1000);
    if (!title) invalid('Line title is required');
    return { id: lineId, title, sku: clean(line.sku, 200), quantity, unitPriceMinor, discountMinor, taxMinor, taxes, ...(taxes.length === 1 ? { taxRate: taxes[0].rate } : {}) };
  });
  const sourceShipping = array(payload.shipping_lines, 'shipping_lines');
  let shippingMinor = 0; let shippingTaxMinor = 0;
  for (const line of sourceShipping) {
    const original = amount(line.price_set, line.price, code, shopCurrency, 'shipping price');
    const allocations = array(line.discount_allocations, 'shipping discount_allocations');
    const discounted = original - sum(allocations.map(discount => amount(discount.amount_set, discount.amount, code, shopCurrency, 'shipping discount')));
    if (discounted < 0) invalid('Shipping discount exceeds the shipping price');
    if ((line.discounted_price_set != null || line.discounted_price != null) && amount(line.discounted_price_set, line.discounted_price, code, shopCurrency, 'discounted shipping') !== discounted) invalid('Shipping discount allocations do not reconcile');
    shippingMinor += discounted;
    shippingTaxMinor += sum(taxLines(line.tax_lines, code, shopCurrency, 'shipping tax_lines').map(tax => tax.taxMinor));
  }
  integer(shippingMinor, 'shipping amount'); integer(shippingTaxMinor, 'shipping tax');
  const subtotal = sum(lineItems.map(line => line.unitPriceMinor * line.quantity - line.discountMinor));
  const totalTax = sum([...lineItems.map(line => line.taxMinor), shippingTaxMinor]);
  const totalDiscount = sum(lineItems.map(line => line.discountMinor));
  const expectedSubtotal = amount(payload.subtotal_price_set, payload.subtotal_price, code, shopCurrency, 'subtotal_price');
  const expectedTax = amount(payload.total_tax_set, payload.total_tax, code, shopCurrency, 'total_tax');
  const expectedDiscount = amount(payload.total_discounts_set, payload.total_discounts, code, shopCurrency, 'total_discounts');
  const totalMinor = amount(payload.total_price_set, payload.total_price, code, shopCurrency, 'total_price');
  if (subtotal !== expectedSubtotal || totalTax !== expectedTax || totalDiscount !== expectedDiscount || totalMinor !== subtotal + shippingMinor + (payload.taxes_included ? 0 : totalTax)) invalid('Order discounts, tax, shipping or total do not reconcile; additional charges must be normalized explicitly');
  unchanged(payload, code, shopCurrency, totalMinor, expectedTax, expectedSubtotal, expectedDiscount);
  return {
    id: orderId, name: clean(payload.name ?? `#${orderId}`, 200), currency: code, shopCurrency,
    issuedAt: date(payload.processed_at ?? payload.created_at, 'Order timestamp'), taxesIncluded: payload.taxes_included,
    customer: customer(payload), lineItems, shippingMinor, shippingTaxMinor, totalMinor,
    customerLocale: clean(payload.customer_locale ?? 'en', 30),
  };
}

function sameOrder(refundOrderId, snapshotOrderId) {
  return String(refundOrderId).split('/').at(-1) === String(snapshotOrderId).split('/').at(-1);
}

export function creditFromWebhook(refund, originalSnapshot) {
  if (!refund || typeof refund !== 'object' || Array.isArray(refund)) invalid('A refund webhook object is required');
  if (!originalSnapshot || originalSnapshot.type !== 'invoice' || !originalSnapshot.number || !Array.isArray(originalSnapshot.lines)) invalid('The original immutable invoice snapshot is required');
  const refundId = id(refund.id, 'Refund');
  const orderId = id(refund.order_id, 'Refund order');
  if (!sameOrder(orderId, originalSnapshot.orderId)) invalid('Refund does not belong to the original invoice order');
  const code = currency(originalSnapshot.currency);
  const shopCurrency = currency(originalSnapshot.shopCurrency ?? code);
  // REST scalar refund amounts use the transaction currency. They can only be
  // accepted when it matches the original invoice; sets handle currency pairs.
  const transactions = array(refund.transactions, 'refund transactions');
  const payments = transactions.filter(transaction => transaction.kind === 'refund');
  if (!payments.length || payments.some(transaction => transaction.status !== 'success')) invalid('Refund transactions must be successful before automatic credit issuance');
  const expected = sum(payments.map(transaction => {
    if (transaction.currency !== code) invalid('Refund transaction currency differs from the original invoice');
    return amount(transaction.amount_set, transaction.amount, code, transaction.currency, 'refund transaction');
  }));
  const quantities = new Map();
  const lineItems = array(refund.refund_line_items, 'refund_line_items').map(line => {
    const lineId = id(line.line_item_id ?? line.line_item?.id, 'Refund line item');
    const original = originalSnapshot.lines.find(item => String(item.id).split('/').at(-1) === lineId.split('/').at(-1));
    if (!original) invalid('Refund line is absent from the original invoice');
    const quantity = integer(line.quantity, 'refund quantity');
    quantities.set(lineId, (quantities.get(lineId) ?? 0) + quantity);
    if (!quantity || quantities.get(lineId) > original.quantity) invalid('Refund quantity exceeds the original invoiced quantity');
    const net = amount(line.subtotal_set, line.subtotal, code, shopCurrency, 'refund line subtotal');
    const taxMinor = amount(line.total_tax_set, line.total_tax, code, shopCurrency, 'refund line tax');
    return { id: lineId, title: original.title, sku: original.sku, quantity, unitPriceMinor: Math.round(net / quantity), lineTotalMinor: net, discountMinor: 0, taxMinor, ...(original.taxes?.length === 1 ? { taxRate: original.taxes[0].rate, taxTitle: original.taxes[0].title } : {}) };
  });
  let shippingMinor = 0; let shippingTaxMinor = 0;
  if (refund.refund_shipping_lines != null) {
    for (const line of array(refund.refund_shipping_lines, 'refund_shipping_lines')) {
      shippingMinor += amount(line.subtotal_amount_set, line.subtotal_amount, code, shopCurrency, 'shipping refund subtotal');
      shippingTaxMinor += amount(line.tax_amount_set, line.tax_amount, code, shopCurrency, 'shipping refund tax');
    }
  }
  let legacyShipping = 0; let legacyTax = 0;
  for (const adjustment of array(refund.order_adjustments, 'order_adjustments')) {
    const adjustedAmount = amount(adjustment.amount_set, adjustment.amount, code, shopCurrency, 'refund adjustment', true);
    const adjustedTax = amount(adjustment.tax_amount_set, adjustment.tax_amount, code, shopCurrency, 'refund adjustment tax', true);
    if (adjustment.kind !== 'shipping_refund' && (adjustedAmount || adjustedTax)) invalid('Refund discrepancies or other adjustments need explicit finance normalization');
    if (adjustment.kind === 'shipping_refund') {
      if (adjustedAmount && adjustedTax && Math.sign(adjustedAmount) !== Math.sign(adjustedTax)) invalid('Shipping refund adjustment signs do not reconcile');
      legacyShipping += Math.abs(adjustedAmount); legacyTax += Math.abs(adjustedTax);
    }
  }
  if (legacyShipping || legacyTax) {
    if (shippingMinor || shippingTaxMinor) {
      if (shippingMinor !== legacyShipping || shippingTaxMinor !== legacyTax) invalid('Legacy and current shipping refund data do not reconcile');
    } else { shippingMinor = legacyShipping; shippingTaxMinor = legacyTax; }
  }
  if (Array.isArray(refund.refund_duties) && refund.refund_duties.length) invalid('Refunded duties need explicit finance normalization');
  if (!lineItems.length && !shippingMinor && !shippingTaxMinor) invalid('Refund has no explicit refunded line or shipping amounts');
  let subtotal = sum(lineItems.map(line => line.lineTotalMinor));
  const taxMinor = sum([...lineItems.map(line => line.taxMinor), shippingTaxMinor]);
  if (originalSnapshot.taxesIncluded && taxMinor > 0 && expected === subtotal + shippingMinor) {
    for (const line of lineItems) {
      line.lineTotalMinor = integer(line.lineTotalMinor - line.taxMinor, 'refunded net line amount');
      line.unitPriceMinor = Math.round(line.lineTotalMinor / line.quantity);
    }
    subtotal = sum(lineItems.map(line => line.lineTotalMinor));
    shippingMinor = integer(shippingMinor - shippingTaxMinor, 'refunded net shipping amount');
  }
  if (subtotal + shippingMinor + taxMinor !== expected) invalid('Refund line, tax, shipping and successful transaction totals do not reconcile');
  if (expected > originalSnapshot.totals.totalMinor) invalid('Refund exceeds the original invoice amount');
  // The document domain permits a shipping-only credit when at least one
  // explicit zero-valued explanatory line is supplied.
  if (!lineItems.length) lineItems.push({ id: `shipping-refund-${refundId}`, title: 'Delivery refund', sku: '', quantity: 1, unitPriceMinor: 0, lineTotalMinor: 0, discountMinor: 0, taxMinor: 0, taxRate: 0 });
  return {
    id: originalSnapshot.orderId, name: originalSnapshot.orderReference, refundId, originalInvoiceNumber: originalSnapshot.number,
    currency: code, shopCurrency, taxesIncluded: false, issuedAt: date(refund.processed_at ?? refund.created_at, 'Refund timestamp'),
    customer: structuredClone(originalSnapshot.customer), lineItems, shippingMinor, shippingTaxMinor, totalMinor: expected,
  };
}
