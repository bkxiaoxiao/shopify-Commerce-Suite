/**
 * Financial document domain. No persistence or network calls.
 *
 * Canonical orders use integer minor units, never decimal prices:
 * { id, name, currency, issuedAt, taxesIncluded, customer, lineItems: [
 *   { id, title, sku, quantity, unitPriceMinor, discountMinor, taxMinor, taxRate }
 * ], shippingMinor, shippingTaxMinor, totalMinor? }
 * Shopify GraphQL orders with MoneyBag fields and nodes/edges are also accepted.
 * A credit needs an explicit `order.refund` (GraphQL Refund) or `order.refundId`
 * plus canonical amounts for that refund. A whole order is never silently
 * converted into a full credit. Returned snapshots are detached and frozen.
 */

const TYPES = new Set(['invoice', 'credit', 'quote']);
const TEXT = {
  en: { invoice: 'INVOICE', credit: 'CREDIT NOTE', quote: 'QUOTATION', from: 'From', bill: 'Bill to', number: 'Number', issued: 'Issue date', supply: 'Supply date', reference: 'Order / reference', original: 'Original invoice', description: 'Description', quantity: 'Qty', net: 'Net amount', vat: 'VAT', subtotal: 'Items, excluding VAT', shipping: 'Delivery, excluding VAT', total: 'Total', taxGbp: 'VAT total in GBP', valid: 'Valid until' },
  de: { invoice: 'RECHNUNG', credit: 'GUTSCHRIFT', quote: 'ANGEBOT', from: 'Von', bill: 'Rechnung an', number: 'Nummer', issued: 'Ausstellungsdatum', supply: 'Leistungsdatum', reference: 'Bestellung / Referenz', original: 'Ursprüngliche Rechnung', description: 'Beschreibung', quantity: 'Menge', net: 'Nettobetrag', vat: 'MwSt.', subtotal: 'Artikel ohne MwSt.', shipping: 'Versand ohne MwSt.', total: 'Gesamt', taxGbp: 'MwSt. gesamt in GBP', valid: 'Gültig bis' },
  fr: { invoice: 'FACTURE', credit: 'AVOIR', quote: 'DEVIS', from: 'Émetteur', bill: 'Facturé à', number: 'Numéro', issued: "Date d’émission", supply: 'Date de livraison', reference: 'Commande / référence', original: 'Facture initiale', description: 'Description', quantity: 'Qté', net: 'Montant HT', vat: 'TVA', subtotal: 'Articles HT', shipping: 'Livraison HT', total: 'Total', taxGbp: 'TVA totale en GBP', valid: "Valable jusqu’au" },
};

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'VALIDATION_ERROR';
  error.status = 400;
  throw error;
}

const text = (value, max = 1000) => String(value ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max).trim();
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const list = value => Array.isArray(value) ? value : value?.nodes ?? value?.edges?.map(edge => edge.node) ?? [];

function integer(value, name, { signed = false } = {}) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) invalid(`${name} must be a ${signed ? '' : 'non-negative '}safe integer in minor units`);
  return value;
}

function sum(values, name = 'amount') {
  return integer(values.reduce((total, value) => total + value, 0), name, { signed: true });
}

function currencyCode(value) {
  const currency = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) invalid('currency must be an ISO 4217 currency code');
  return currency;
}

function precision(currency) {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
}

function moneyMinor(value, currency, name) {
  if (value == null) invalid(`${name} is required`);
  const candidates = value.presentmentMoney || value.shopMoney ? [value.presentmentMoney, value.shopMoney].filter(Boolean) : [value];
  const money = candidates.find(candidate => candidate.currencyCode === currency);
  if (!money) invalid(`${name} currency does not match ${currency}`);
  if (!/^-?\d+(\.\d+)?$/.test(String(money.amount))) invalid(`${name} must contain a decimal money amount`);
  const raw = String(money.amount);
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = raw.replace(/^-/, '').split('.');
  const digits = precision(currency);
  if (fraction.slice(digits).replace(/0/g, '')) invalid(`${name} has sub-minor-unit precision`);
  const amount = BigInt(whole) * 10n ** BigInt(digits) + BigInt((fraction.slice(0, digits).padEnd(digits, '0')) || '0');
  return integer(Number(negative ? -amount : amount), name, { signed: true });
}

function date(value, name, required = true) {
  if (!value && !required) return null;
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(String(value)) || Number.isNaN(Date.parse(value))) invalid(`${name} must be an ISO date`);
  const result = String(value).slice(0, 10);
  if (new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) invalid(`${name} is not a valid date`);
  return result;
}

function party(input = {}) {
  const address = input.address ?? input;
  const addressLines = typeof address === 'string' ? address.split(/\r?\n/) : Array.isArray(address) ? address : [address.address1, address.address2, [address.zip ?? address.postalCode, address.city].filter(Boolean).join(' '), address.province, address.country];
  return {
    name: text([input.legalName, input.companyName, input.company, input.name, input.displayName, [input.firstName, input.lastName].filter(Boolean).join(' ')].find(value => text(value)), 250),
    email: text(input.email ?? input.defaultEmailAddress?.emailAddress, 254),
    address: addressLines.filter(Boolean).map(line => text(line, 300)),
    countryCode: text(input.countryCode ?? address.countryCodeV2 ?? address.countryCode, 2).toUpperCase(),
    vatNumber: text(input.vatNumber ?? input.taxNumber ?? '', 100),
  };
}

function taxRate(value) {
  if (value == null || value === '') return null;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) invalid('taxRate must be a decimal between 0 and 1');
  return rate;
}

function quoteTax(base, rate, included) {
  // Integer arithmetic with a bounded decimal rate: no floating point prices.
  const units = BigInt(Math.round(rate * 1_000_000));
  const denominator = 1_000_000n + (included ? units : 0n);
  return Number((BigInt(base) * units + denominator / 2n) / denominator);
}

function normalizeLine(line, index, { currency, taxesIncluded, quote = false }) {
  const quantity = integer(line.quantity, `lineItems[${index}].quantity`);
  if (quantity < 1) invalid('line item quantity must be at least one');
  const title = text(line.title ?? line.description ?? line.name, 1000);
  if (!title) invalid('line item title is required');
  const graphql = line.originalUnitPriceSet != null || line.originalTotalSet != null;
  const unitPriceMinor = integer(graphql ? moneyMinor(line.originalUnitPriceSet, currency, 'originalUnitPriceSet') : line.unitPriceMinor, 'unitPriceMinor');
  const originalMinor = integer(graphql && line.originalTotalSet ? moneyMinor(line.originalTotalSet, currency, 'originalTotalSet') : line.lineTotalMinor ?? unitPriceMinor * quantity, 'line original amount');
  if (quote && line.lineTotalMinor != null && originalMinor !== unitPriceMinor * quantity) invalid('Quote lineTotalMinor must equal unitPriceMinor multiplied by quantity');
  const discountMinor = graphql ? sum(list(line.discountAllocations).map(discount => moneyMinor(discount.allocatedAmountSet, currency, 'discount allocation'))) : integer(line.discountMinor ?? 0, 'discountMinor');
  if (discountMinor < 0 || discountMinor > originalMinor) invalid('line discount must not exceed the line amount');
  const afterDiscount = originalMinor - discountMinor;
  const rate = taxRate(line.taxRate);
  let taxes;
  if (graphql) {
    if (!Array.isArray(line.taxLines)) invalid('Shopify lineItems must include taxLines');
    taxes = line.taxLines.map(tax => ({ title: text(tax.title ?? 'VAT', 100), rate: taxRate(tax.rate), taxMinor: integer(moneyMinor(tax.priceSet, currency, 'tax line'), 'tax line') }));
  } else if (Array.isArray(line.taxes)) {
    taxes = line.taxes.map(tax => ({ title: text(tax.title ?? 'VAT', 100), rate: taxRate(tax.rate), taxMinor: integer(tax.taxMinor, 'tax line') }));
    if (line.taxMinor != null && integer(line.taxMinor, 'taxMinor') !== sum(taxes.map(tax => tax.taxMinor))) invalid('Line tax breakdown does not reconcile');
  } else {
    if (line.taxMinor == null && rate > 0 && !quote) invalid('taxMinor is required for a taxed invoice line');
    const amount = line.taxMinor == null && rate != null && quote ? quoteTax(afterDiscount, rate, taxesIncluded) : integer(line.taxMinor ?? 0, 'taxMinor');
    taxes = amount || rate != null ? [{ title: text(line.taxTitle ?? 'VAT', 100), rate, taxMinor: amount }] : [];
  }
  const taxMinor = integer(sum(taxes.map(tax => tax.taxMinor)), 'line tax');
  const netMinor = afterDiscount - (taxesIncluded ? taxMinor : 0);
  if (netMinor < 0) invalid('tax must not exceed the tax-inclusive line amount');
  return { id: text(line.id ?? index + 1, 150), title, sku: text(line.sku, 200), quantity, unitPriceMinor, discountMinor, netMinor, taxMinor, grossMinor: integer(netMinor + taxMinor, 'line gross'), taxes };
}

function normalizeOrder(order, type) {
  const currency = currencyCode(order.currency ?? order.presentmentCurrencyCode ?? order.currencyCode);
  const taxesIncluded = order.taxesIncluded === true;
  if (type === 'credit' && order.refund) return normalizeRefund(order, currency);
  if (type === 'credit' && !order.refundId && !order.sourceRefundId) invalid('A credit requires refundId and amounts for that refund, or an explicit Shopify refund');
  const rawLines = list(order.lineItems ?? order.items);
  if (!rawLines.length) invalid('At least one line item is required');
  if (order.lineItems?.pageInfo?.hasNextPage) invalid('All order line items must be fetched before issuing a document');
  const lines = rawLines.map((line, index) => normalizeLine(line, index, { currency, taxesIncluded, quote: type === 'quote' }));
  let shippingMinor = order.shippingMinor;
  let shippingTaxMinor = order.shippingTaxMinor;
  if (shippingMinor == null && order.shippingLines != null) {
    const shippingLines = list(order.shippingLines);
    shippingMinor = sum(shippingLines.map(line => {
      const original = moneyMinor(line.originalPriceSet ?? line.discountedPriceSet, currency, 'shipping price');
      return line.originalPriceSet ? original - sum(list(line.discountAllocations).map(discount => moneyMinor(discount.allocatedAmountSet, currency, 'shipping discount'))) : original;
    }));
    shippingTaxMinor = sum(shippingLines.flatMap(line => list(line.taxLines)).map(tax => moneyMinor(tax.priceSet, currency, 'shipping tax')));
  }
  if (shippingMinor == null && order.totalShippingPriceSet) {
    shippingMinor = moneyMinor(order.totalShippingPriceSet, currency, 'shipping total');
    if (shippingMinor > 0 && shippingTaxMinor == null) invalid('shippingTaxMinor or shippingLines with taxLines is required');
  }
  shippingMinor = integer(shippingMinor ?? 0, 'shippingMinor');
  shippingTaxMinor = integer(shippingTaxMinor ?? 0, 'shippingTaxMinor');
  const shippingNetMinor = shippingMinor - (taxesIncluded ? shippingTaxMinor : 0);
  if (shippingNetMinor < 0) invalid('Shipping tax exceeds the shipping amount');
  const subtotalMinor = sum(lines.map(line => line.netMinor));
  const taxMinor = sum([...lines.map(line => line.taxMinor), shippingTaxMinor]);
  const otherChargesMinor = integer(order.otherChargesMinor ?? 0, 'otherChargesMinor');
  const totalMinor = sum([subtotalMinor, shippingNetMinor, taxMinor, otherChargesMinor]);
  const expected = order.totalMinor ?? (order.originalTotalPriceSet ? moneyMinor(order.originalTotalPriceSet, currency, 'originalTotalPriceSet') : order.totalPriceSet ? moneyMinor(order.totalPriceSet, currency, 'totalPriceSet') : null);
  if (expected != null && integer(expected, 'totalMinor') !== totalMinor) invalid('Order totals do not reconcile; fetch all discounts, taxes, shipping and additional charges');
  if (order.totalTaxSet && moneyMinor(order.totalTaxSet, currency, 'totalTaxSet') !== taxMinor) invalid('Order tax totals do not reconcile');
  return { currency, taxesIncluded, lines, subtotalMinor, shippingNetMinor, shippingTaxMinor, otherChargesMinor, taxMinor, totalMinor, sourceRefundId: text(order.refundId ?? order.sourceRefundId, 150) || null };
}

function normalizeRefund(order, currency) {
  const refund = order.refund;
  if (!refund.id) invalid('Shopify refund.id is required');
  if (refund.refundLineItems?.pageInfo?.hasNextPage || refund.refundShippingLines?.pageInfo?.hasNextPage) invalid('All refund lines must be fetched');
  const lines = list(refund.refundLineItems).map((entry, index) => {
    const netMinor = integer(moneyMinor(entry.subtotalSet, currency, 'refund subtotal'), 'refund subtotal');
    const taxMinor = integer(moneyMinor(entry.totalTaxSet, currency, 'refund tax'), 'refund tax');
    const quantity = integer(entry.quantity, 'refund quantity');
    if (!quantity) invalid('Refund quantity must be at least one');
    return { id: text(entry.id ?? index + 1, 150), title: text(entry.lineItem?.title ?? entry.lineItem?.name ?? 'Refund', 1000), sku: text(entry.lineItem?.sku, 200), quantity, unitPriceMinor: Math.round(netMinor / quantity), discountMinor: 0, netMinor, taxMinor, grossMinor: netMinor + taxMinor, taxes: taxMinor ? [{ title: 'VAT', rate: null, taxMinor }] : [] };
  });
  const shipping = list(refund.refundShippingLines);
  let shippingNetMinor = sum(shipping.map(line => moneyMinor(line.subtotalAmountSet, currency, 'shipping refund')));
  const shippingTaxMinor = sum(shipping.map(line => moneyMinor(line.taxAmountSet, currency, 'shipping refund tax')));
  let subtotalMinor = sum(lines.map(line => line.netMinor));
  const taxMinor = sum([...lines.map(line => line.taxMinor), shippingTaxMinor]);
  const expectedTotal = refund.totalRefundedSet ? integer(moneyMinor(refund.totalRefundedSet, currency, 'totalRefundedSet'), 'totalRefundedSet') : null;
  // Preserve the explicitly refunded amount. Some normalized sources expose
  // inclusive subtotals; identify that representation by its reconciled total
  // rather than assuming every tax-inclusive order uses the same API shape.
  const includesTax = refund.subtotalsIncludeTax === true || (refund.subtotalsIncludeTax == null && order.taxesIncluded === true && taxMinor > 0 && expectedTotal === subtotalMinor + shippingNetMinor);
  if (includesTax) {
    for (const line of lines) {
      line.netMinor = integer(line.netMinor - line.taxMinor, 'refunded net amount');
      line.unitPriceMinor = Math.round(line.netMinor / line.quantity);
      line.grossMinor = line.netMinor + line.taxMinor;
    }
    subtotalMinor = sum(lines.map(line => line.netMinor));
    shippingNetMinor = integer(shippingNetMinor - shippingTaxMinor, 'shipping refund net amount');
  }
  const totalMinor = sum([subtotalMinor, shippingNetMinor, taxMinor]);
  if (!lines.length && !shipping.length) invalid('Refund must contain explicit refunded line or shipping amounts');
  if (expectedTotal != null && expectedTotal !== totalMinor) invalid('Refund total does not reconcile; normalize refund adjustments, duties or failed payment transactions explicitly');
  return { currency, taxesIncluded: false, lines, subtotalMinor, shippingNetMinor, shippingTaxMinor, otherChargesMinor: 0, taxMinor, totalMinor, sourceRefundId: text(refund.id, 150) };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Validate and detach a canonical quote. Prices are integer minor units. */
export function validateQuote(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Quote must be an object');
  const cloned = structuredClone(input);
  const normalized = normalizeOrder(cloned, 'quote');
  const customer = party(cloned.customer);
  if (!customer.name) invalid('Quote customer name is required');
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(customer.email) || /[\r\n]/.test(customer.email)) invalid('Quote customer email is invalid');
  if (cloned.validUntil) date(cloned.validUntil, 'validUntil');
  return { ...cloned, currency: normalized.currency, customer, lineItems: list(cloned.lineItems ?? cloned.items).map((line, index) => ({ ...line, taxMinor: normalized.lines[index].taxMinor })), totalMinor: normalized.totalMinor };
}

export function createInvoiceSnapshot({ order, settings = {}, number, type = 'invoice' } = {}) {
  if (!TYPES.has(type)) invalid('Document type must be invoice, credit or quote');
  if (!order || typeof order !== 'object') invalid('order is required');
  if (typeof number !== 'string' || number.length > 100) invalid('A document number of at most 100 characters is required');
  const documentNumber = text(number, 100);
  if (!documentNumber || /[\r\n]/.test(documentNumber)) invalid('A document number is required');
  const normalized = normalizeOrder(order, type);
  const seller = party(settings.seller ?? settings.legalEntity ?? settings);
  if (!seller.name) invalid('settings.seller.name is required');
  const customer = party(order.billingAddress ? { ...order.customer, ...order.billingAddress, email: order.email ?? order.customer?.email, vatNumber: order.customer?.vatNumber } : order.customer);
  if (!customer.name) invalid('Customer name or billing address name is required');
  const issuedAt = date(settings.issuedAt ?? order.issuedAt ?? order.refund?.createdAt ?? order.processedAt ?? order.createdAt, 'issuedAt');
  const language = text(settings.language ?? order.customerLocale ?? 'en', 30);
  try { Intl.getCanonicalLocales(language); } catch { invalid('Invalid document language'); }
  const sign = type === 'credit' ? -1 : 1;
  const warnings = [];
  const vatInGbpMinor = settings.vatInGbpMinor ?? order.vatInGbpMinor;
  if (vatInGbpMinor != null) integer(vatInGbpMinor, 'vatInGbpMinor');
  if (settings.ukVatSupply === true && normalized.currency !== 'GBP' && normalized.taxMinor > 0 && vatInGbpMinor == null) invalid('UK VAT supplies invoiced in foreign currency need vatInGbpMinor and a recorded conversion basis');
  if (settings.ukVatSupply === true && normalized.currency !== 'GBP' && normalized.taxMinor > 0 && !settings.vatConversion?.source) invalid('VAT GBP conversion source is required');
  if (seller.countryCode === 'GB' && normalized.currency !== 'GBP' && normalized.taxMinor > 0 && vatInGbpMinor == null) warnings.push('REVIEW_UK_VAT_GBP_REQUIREMENT');
  const totals = Object.fromEntries(['subtotalMinor', 'shippingNetMinor', 'shippingTaxMinor', 'otherChargesMinor', 'taxMinor', 'totalMinor'].map(key => [key, integer(normalized[key] * sign, key, { signed: true })]));
  const lines = normalized.lines.map(line => ({ ...line, ...Object.fromEntries(['unitPriceMinor', 'discountMinor', 'netMinor', 'taxMinor', 'grossMinor'].map(key => [key, line[key] * sign])), taxes: line.taxes.map(tax => ({ ...tax, taxMinor: tax.taxMinor * sign })) }));
  const snapshot = {
    version: 1, type, number: documentNumber, orderId: text(order.id, 150), orderReference: text(order.name ?? order.reference ?? order.id, 200),
    sourceRefundId: normalized.sourceRefundId, originalInvoiceNumber: text(settings.originalInvoiceNumber ?? order.originalInvoiceNumber, 100) || null,
    currency: normalized.currency, shopCurrency: currencyCode(order.shopCurrency ?? order.currencyCode ?? normalized.currency), language, issuedAt, supplyDate: date(order.supplyDate ?? settings.supplyDate, 'supplyDate', false), validUntil: date(order.validUntil, 'validUntil', false),
    seller, customer, taxesIncluded: normalized.taxesIncluded, lines, totals,
    totalMinor: totals.totalMinor, vatInGbpMinor: vatInGbpMinor == null ? null : vatInGbpMinor * sign,
    vatConversion: settings.vatConversion ? { source: text(settings.vatConversion.source, 200), date: date(settings.vatConversion.date, 'vatConversion.date', false), rate: text(settings.vatConversion.rate, 80) } : null,
    note: text(order.note ?? settings.note, 4000), footer: text(settings.footer, 2000), warnings,
  };
  return freeze(structuredClone(snapshot));
}

function labels(snapshot) { return TEXT[snapshot.language?.split('-')[0]] ?? TEXT.en; }
function money(value, snapshot, currency = snapshot.currency) { return new Intl.NumberFormat(snapshot.language ?? 'en', { style: 'currency', currency }).format(value / 10 ** precision(currency)); }
function rateLabel(line) { return [...new Set(line.taxes.map(tax => tax.rate == null ? '—' : `${Number((tax.rate * 100).toFixed(4))}%`))].join(' / ') || '—'; }
function partyHtml(value) { return `<strong>${escape(value.name)}</strong>${value.address.map(line => `<div>${escape(line)}</div>`).join('')}${value.email ? `<div>${escape(value.email)}</div>` : ''}${value.vatNumber ? `<div>VAT: ${escape(value.vatNumber)}</div>` : ''}`; }

export function renderDocumentHtml(snapshot) {
  const t = labels(snapshot);
  const row = (label, amount, currency) => `<div class="amount"><span>${escape(label)}</span><strong>${escape(money(amount, snapshot, currency))}</strong></div>`;
  return `<!doctype html><html lang="${escape(snapshot.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(t[snapshot.type])} ${escape(snapshot.number)}</title><style>body{font:14px/1.5 Arial,sans-serif;color:#19372c;max-width:850px;margin:40px auto;padding:24px}h1{font-size:28px;letter-spacing:2px;border-bottom:3px solid #325d47;padding-bottom:18px}.parties{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin:30px 0}small{color:#617769}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:12px 8px;border-bottom:1px solid #dfe7e1;text-align:left}th{background:#f0f5f1}td:last-child,th:last-child{text-align:right}.totals{max-width:360px;margin:24px 0 24px auto}.amount{display:flex;justify-content:space-between;gap:16px;padding:5px 0}.amount:last-child{border-top:2px solid #dfe7e1;margin-top:8px;padding-top:12px}footer{border-top:1px solid #dfe7e1;margin-top:36px;padding-top:18px;color:#617769;font-size:12px}.note{white-space:pre-wrap}@media print{body{margin:0;max-width:none}tr{break-inside:avoid}}@media(max-width:580px){body{padding:12px}.parties{grid-template-columns:1fr}table{font-size:12px}th,td{padding:8px 3px}}</style></head><body><h1>${escape(t[snapshot.type])}</h1><div><strong>${escape(t.number)}:</strong> ${escape(snapshot.number)}</div><div>${escape(t.issued)}: ${escape(snapshot.issuedAt)}</div>${snapshot.supplyDate ? `<div>${escape(t.supply)}: ${escape(snapshot.supplyDate)}</div>` : ''}<div>${escape(t.reference)}: ${escape(snapshot.orderReference)}</div>${snapshot.originalInvoiceNumber ? `<div>${escape(t.original)}: ${escape(snapshot.originalInvoiceNumber)}</div>` : ''}${snapshot.validUntil ? `<div>${escape(t.valid)}: ${escape(snapshot.validUntil)}</div>` : ''}<section class="parties"><div><small>${escape(t.from)}</small><br>${partyHtml(snapshot.seller)}</div><div><small>${escape(t.bill)}</small><br>${partyHtml(snapshot.customer)}</div></section><table><thead><tr><th>${escape(t.description)}</th><th>${escape(t.quantity)}</th><th>${escape(t.vat)}</th><th>${escape(t.net)}</th></tr></thead><tbody>${snapshot.lines.map(line => `<tr><td>${escape(line.title)}${line.sku ? `<br><small>${escape(line.sku)}</small>` : ''}</td><td>${line.quantity}</td><td>${escape(rateLabel(line))}</td><td>${escape(money(line.netMinor, snapshot))}</td></tr>`).join('')}</tbody></table><section class="totals">${row(t.subtotal, snapshot.totals.subtotalMinor)}${row(t.shipping, snapshot.totals.shippingNetMinor)}${row(t.vat, snapshot.totals.taxMinor)}${snapshot.totals.otherChargesMinor ? row('Other charges', snapshot.totals.otherChargesMinor) : ''}${snapshot.vatInGbpMinor != null ? row(t.taxGbp, snapshot.vatInGbpMinor, 'GBP') : ''}${row(t.total, snapshot.totals.totalMinor)}</section>${snapshot.note ? `<p class="note">${escape(snapshot.note)}</p>` : ''}${snapshot.footer ? `<footer class="note">${escape(snapshot.footer)}</footer>` : ''}</body></html>`;
}

/** Generate a real PDF Buffer. Optional font Buffer/path supports additional scripts. */
export async function renderDocumentPdf(snapshot, { font } = {}) {
  if (!font) {
    const corpus = [snapshot.number, snapshot.orderReference, snapshot.originalInvoiceNumber, snapshot.seller.name, ...snapshot.seller.address, snapshot.customer.name, ...snapshot.customer.address, ...snapshot.lines.flatMap(line => [line.title, line.sku]), snapshot.note, snapshot.footer].filter(Boolean).join('');
    if (/[^\u0000-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018\u2019\u201a\u201c\u201d\u201e\u2020\u2021\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/u.test(corpus)) {
      const error = new Error('A configured Unicode PDF font is required for the document content');
      error.code = 'PDF_FONT_REQUIRED'; error.status = 422; throw error;
    }
  }
  const { default: PDFDocument } = await import('pdfkit');
  const t = labels(snapshot);
  const issuedDate = new Date(`${snapshot.issuedAt}T00:00:00Z`);
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: `${t[snapshot.type]} ${snapshot.number}`, Author: snapshot.seller.name, CreationDate: issuedDate, ModDate: issuedDate } });
  const chunks = [];
  const complete = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  try {
    if (font) doc.font(font);
    else doc.font('Helvetica');
    const write = (value, options = {}) => doc.text(String(value ?? '').replace(/[\u202f\u00a0]/g, ' '), options);
    doc.fontSize(24); write(t[snapshot.type]); doc.moveDown(0.6); doc.fontSize(10);
    write(`${t.number}: ${snapshot.number}`); write(`${t.issued}: ${snapshot.issuedAt}`);
    if (snapshot.supplyDate) write(`${t.supply}: ${snapshot.supplyDate}`);
    write(`${t.reference}: ${snapshot.orderReference}`);
    if (snapshot.originalInvoiceNumber) write(`${t.original}: ${snapshot.originalInvoiceNumber}`);
    if (snapshot.validUntil) write(`${t.valid}: ${snapshot.validUntil}`);
    for (const [label, value] of [[t.from, snapshot.seller], [t.bill, snapshot.customer]]) {
      doc.moveDown(); doc.fontSize(11); write(label); doc.fontSize(10); write(value.name);
      value.address.forEach(line => write(line)); if (value.email) write(value.email); if (value.vatNumber) write(`VAT: ${value.vatNumber}`);
    }
    doc.moveDown();
    for (const line of snapshot.lines) {
      doc.fontSize(10); write(`${line.title}${line.sku ? ` [${line.sku}]` : ''}`);
      doc.fontSize(9); write(`${t.quantity}: ${line.quantity}    ${t.vat}: ${rateLabel(line)}    ${t.net}: ${money(line.netMinor, snapshot)}`); doc.moveDown(0.6);
    }
    doc.moveDown(); doc.fontSize(11);
    for (const [label, amount, currency] of [[t.subtotal, snapshot.totals.subtotalMinor], [t.shipping, snapshot.totals.shippingNetMinor], [t.vat, snapshot.totals.taxMinor], ...(snapshot.totals.otherChargesMinor ? [['Other charges', snapshot.totals.otherChargesMinor]] : []), ...(snapshot.vatInGbpMinor != null ? [[t.taxGbp, snapshot.vatInGbpMinor, 'GBP']] : []), [t.total, snapshot.totals.totalMinor]]) write(`${label}: ${money(amount, snapshot, currency)}`);
    if (snapshot.note) { doc.moveDown(); doc.fontSize(10); write(snapshot.note); }
    if (snapshot.footer) { doc.moveDown(); doc.fontSize(8); write(snapshot.footer); }
    doc.end();
  } catch (error) { doc.destroy(error); }
  return complete;
}
