import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvoiceSnapshot, validateQuote, renderDocumentHtml, renderDocumentPdf } from '../server/domain/documents.js';

const seller = { name: 'Company UK Ltd', address: ['1 Example Street', 'London'], countryCode: 'GB', vatNumber: 'GB123456789' };
const settings = { seller, language: 'en-GB' };
const order = () => ({
  id: 'gid://shopify/Order/123', name: '#UK123', currency: 'GBP', issuedAt: '2026-11-24T03:00:00Z', taxesIncluded: false,
  customer: { name: 'Emma Example', email: 'emma@example.com', address: ['10 Customer Road', 'London'], vatNumber: 'GB987654321' },
  lineItems: [
    { id: 'line-1', title: 'Training rack', sku: 'RACK-01', quantity: 2, unitPriceMinor: 10000, discountMinor: 2000, taxMinor: 3600, taxRate: 0.2 },
    { id: 'line-2', title: 'Zero-rated item', quantity: 1, unitPriceMinor: 1000, taxMinor: 0, taxRate: 0 },
  ], shippingMinor: 500, shippingTaxMinor: 100, totalMinor: 23200,
});
const bag = (amount, currencyCode = 'GBP') => ({ presentmentMoney: { amount, currencyCode }, shopMoney: { amount: '999.99', currencyCode: 'USD' } });

test('invoice reconciles mixed VAT and allocated discounts in integer minor units', () => {
  const snapshot = createInvoiceSnapshot({ order: order(), settings, number: 'INV-1001' });
  assert.deepEqual(snapshot.totals, { subtotalMinor: 19000, shippingNetMinor: 500, shippingTaxMinor: 100, otherChargesMinor: 0, taxMinor: 3700, totalMinor: 23200 });
  assert.equal(snapshot.lines[0].discountMinor, 2000);
  assert.equal(snapshot.lines[0].netMinor, 18000);
  assert.equal(snapshot.lines[0].grossMinor, 21600);
});

test('tax-inclusive orders do not add VAT a second time', () => {
  const source = order();
  source.taxesIncluded = true;
  source.lineItems = [{ title: 'Rack', quantity: 1, unitPriceMinor: 12000, taxMinor: 2000, taxRate: 0.2 }];
  source.shippingMinor = 600; source.shippingTaxMinor = 100; source.totalMinor = 12600;
  const snapshot = createInvoiceSnapshot({ order: source, settings, number: 'INV-1002' });
  assert.equal(snapshot.totals.subtotalMinor, 10000);
  assert.equal(snapshot.totals.shippingNetMinor, 500);
  assert.equal(snapshot.totals.taxMinor, 2100);
  assert.equal(snapshot.totalMinor, 12600);
});

test('issued snapshot remains detached and immutable when order and entity change', () => {
  const source = order(); const entity = structuredClone(settings);
  const before = JSON.stringify(source);
  const snapshot = createInvoiceSnapshot({ order: source, settings: entity, number: 'INV-1003' });
  assert.equal(JSON.stringify(source), before);
  source.lineItems[0].title = 'Renamed product'; source.customer.name = 'Different customer'; entity.seller.name = 'Different company';
  assert.equal(snapshot.lines[0].title, 'Training rack');
  assert.equal(snapshot.customer.name, 'Emma Example');
  assert.equal(snapshot.seller.name, 'Company UK Ltd');
  assert.throws(() => { snapshot.totals.totalMinor = 0; }, TypeError);
  assert.throws(() => { snapshot.lines[0].taxes.push({}); }, TypeError);
});

test('Shopify GraphQL amounts use presentment currency and original quantities', () => {
  const source = {
    id: 'gid://shopify/Order/5', name: '#5', presentmentCurrencyCode: 'GBP', createdAt: '2026-11-24', taxesIncluded: true,
    customer: { displayName: 'not used' }, billingAddress: { name: 'Emma Example', address1: '10 Customer Road', city: 'London', countryCodeV2: 'GB' },
    lineItems: { nodes: [{ id: '1', title: 'Rack', quantity: 2, currentQuantity: 1, originalUnitPriceSet: bag('60.00'), originalTotalSet: bag('120.00'), discountAllocations: [{ allocatedAmountSet: bag('12.00') }], taxLines: [{ title: 'VAT', rate: 0.2, priceSet: bag('18.00') }] }], pageInfo: { hasNextPage: false } },
    shippingLines: { nodes: [{ originalPriceSet: bag('6.00'), discountAllocations: [], taxLines: [{ title: 'VAT', rate: 0.2, priceSet: bag('1.00') }] }] },
    totalTaxSet: bag('19.00'), originalTotalPriceSet: bag('114.00'), currentTotalPriceSet: bag('60.00'),
  };
  const snapshot = createInvoiceSnapshot({ order: source, settings, number: 'INV-5' });
  assert.equal(snapshot.totalMinor, 11400);
  assert.equal(snapshot.lines[0].quantity, 2);
  assert.equal(snapshot.lines[0].netMinor, 9000);
  assert.equal(snapshot.totals.taxMinor, 1900);
});

test('incomplete GraphQL data, mismatched currency and totals are rejected', () => {
  const source = order();
  source.totalMinor = 1;
  assert.throws(() => createInvoiceSnapshot({ order: source, settings, number: 'INV-x' }), /do not reconcile/);
  source.lineItems = { nodes: order().lineItems, pageInfo: { hasNextPage: true } };
  assert.throws(() => createInvoiceSnapshot({ order: source, settings, number: 'INV-x' }), /All order line items/);
  source.lineItems = [{ title: 'Rack', quantity: 1, originalUnitPriceSet: bag('1.00', 'EUR'), taxLines: [] }];
  assert.throws(() => createInvoiceSnapshot({ order: source, settings, number: 'INV-x' }), /currency does not match/);
});

test('no full credit is inferred from an original order; canonical partial credit is negative', () => {
  assert.throws(() => createInvoiceSnapshot({ order: order(), settings, number: 'CN-1', type: 'credit' }), /credit requires/);
  const partial = { ...order(), refundId: 'refund-1', originalInvoiceNumber: 'INV-1001', lineItems: [{ title: 'One returned plate', quantity: 1, unitPriceMinor: 5000, taxMinor: 1000, taxRate: 0.2 }], shippingMinor: 0, shippingTaxMinor: 0, totalMinor: 6000 };
  const snapshot = createInvoiceSnapshot({ order: partial, settings, number: 'CN-1', type: 'credit' });
  assert.equal(snapshot.totalMinor, -6000);
  assert.equal(snapshot.lines[0].taxMinor, -1000);
  assert.equal(snapshot.sourceRefundId, 'refund-1');
  assert.equal(snapshot.originalInvoiceNumber, 'INV-1001');
});

test('Shopify partial refund uses refund lines and shipping, never full order totals', () => {
  const source = order();
  source.refund = { id: 'gid://shopify/Refund/1', createdAt: '2026-11-25', refundLineItems: { nodes: [{ id: 'r1', quantity: 1, lineItem: { title: 'Training rack', sku: 'RACK-01' }, subtotalSet: bag('90.00'), totalTaxSet: bag('18.00') }] }, refundShippingLines: { nodes: [{ subtotalAmountSet: bag('2.50'), taxAmountSet: bag('0.50') }] }, totalRefundedSet: bag('111.00') };
  const snapshot = createInvoiceSnapshot({ order: source, settings, number: 'CN-2', type: 'credit' });
  assert.equal(snapshot.totalMinor, -11100);
  assert.equal(snapshot.totals.subtotalMinor, -9000);
  assert.equal(snapshot.totals.shippingNetMinor, -250);
  assert.equal(snapshot.lines[0].quantity, 1);
});

test('inclusive refund subtotals reconcile to the actual partial payment amount', () => {
  const source = order(); source.taxesIncluded = true;
  source.refund = { id: 'refund-inclusive', refundLineItems: { nodes: [{ quantity: 1, lineItem: { title: 'Returned plate' }, subtotalSet: bag('12.00'), totalTaxSet: bag('2.00') }] }, totalRefundedSet: bag('12.00') };
  const snapshot = createInvoiceSnapshot({ order: source, settings, number: 'CN-inclusive', type: 'credit' });
  assert.equal(snapshot.totals.subtotalMinor, -1000);
  assert.equal(snapshot.totals.taxMinor, -200);
  assert.equal(snapshot.totalMinor, -1200);
  source.refund.totalRefundedSet = bag('11.00');
  assert.throws(() => createInvoiceSnapshot({ order: source, settings, number: 'CN-invalid', type: 'credit' }), /Refund total does not reconcile/);
});

test('quotes calculate only explicitly requested VAT and reject major-unit prices', () => {
  const input = { currency: 'EUR', customer: { name: 'Studio GmbH', email: 'studio@example.com' }, lineItems: [{ title: 'Rack', quantity: 3, unitPriceMinor: 1999, taxRate: 0.19 }], validUntil: '2026-12-31' };
  const quote = validateQuote(input);
  assert.equal(quote.lineItems[0].taxMinor, 1139);
  assert.equal(quote.totalMinor, 7136);
  assert.equal(input.lineItems[0].taxMinor, undefined);
  const snapshot = createInvoiceSnapshot({ order: { ...quote, issuedAt: '2026-11-24' }, settings, number: 'QUO-1', type: 'quote' });
  assert.equal(snapshot.type, 'quote');
  assert.equal(snapshot.totalMinor, 7136);
  assert.throws(() => validateQuote({ ...input, lineItems: [{ title: 'Rack', quantity: 1, unitPriceMinor: 19.99 }] }), /safe integer/);
  assert.throws(() => validateQuote({ ...input, customer: { name: 'x', email: 'test@example.com\r\nBcc:x@y.com' } }), /email/);
});

test('unsafe amounts and invalid dates cannot enter a financial snapshot', () => {
  const source = order(); source.lineItems[0].unitPriceMinor = Number.MAX_SAFE_INTEGER;
  assert.throws(() => createInvoiceSnapshot({ order: source, settings, number: 'INV-x' }), /safe integer/);
  assert.throws(() => createInvoiceSnapshot({ order: { ...order(), issuedAt: '2026-02-30' }, settings, number: 'INV-x' }), /valid date/);
  assert.throws(() => createInvoiceSnapshot({ order: order(), settings, number: 'INV-x\r\nother' }), /document number/);
  assert.throws(() => createInvoiceSnapshot({ order: { ...order(), currency: 'GBPX' }, settings, number: 'INV-x' }), /currency/);
});

test('UK foreign-currency VAT supply requires GBP amount and recorded conversion basis', () => {
  const source = { ...order(), currency: 'EUR' };
  assert.throws(() => createInvoiceSnapshot({ order: source, settings: { ...settings, ukVatSupply: true }, number: 'INV-x' }), /vatInGbpMinor/);
  const snapshot = createInvoiceSnapshot({ order: source, settings: { ...settings, ukVatSupply: true, vatInGbpMinor: 3100, vatConversion: { source: 'Finance-approved exchange table', date: '2026-11-24', rate: '0.83783784' } }, number: 'INV-x' });
  assert.equal(snapshot.vatInGbpMinor, 3100);
  assert.equal(snapshot.vatConversion.source, 'Finance-approved exchange table');
  assert.match(renderDocumentHtml(snapshot), /VAT total in GBP/);
});

test('HTML escapes all user text and preserves VAT/currency details', () => {
  const source = order(); source.customer.name = '<script>alert(1)</script>'; source.lineItems[0].title = 'Rack <img src=x onerror=alert(1)>'; source.note = '</p><script>alert(2)</script>';
  const snapshot = createInvoiceSnapshot({ order: source, settings, number: 'INV-&1' });
  const html = renderDocumentHtml(snapshot);
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /INV-&amp;1/);
  assert.match(html, /20%/);
  assert.match(html, /232\.00/);
});

test('PDF renderer emits an actual multi-page PDF document', async () => {
  const source = order();
  source.lineItems = Array.from({ length: 80 }, (_, index) => ({ title: `Training equipment item ${index + 1}`, quantity: 1, unitPriceMinor: 100, taxMinor: 20, taxRate: 0.2 }));
  source.shippingMinor = 0; source.shippingTaxMinor = 0; source.totalMinor = 9600;
  const snapshot = createInvoiceSnapshot({ order: source, settings, number: 'INV-PDF' });
  const pdf = await renderDocumentPdf(snapshot);
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.match(pdf.toString('latin1'), /%%EOF/);
  assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length > 1);
  assert.doesNotMatch(pdf.subarray(0, 100).toString(), /<!doctype html>/i);
});

test('PDF does not silently render missing Unicode glyphs with the default font', async () => {
  const source = order(); source.lineItems[0].title = '训练架';
  const snapshot = createInvoiceSnapshot({ order: source, settings, number: 'INV-Unicode' });
  await assert.rejects(renderDocumentPdf(snapshot), error => error.code === 'PDF_FONT_REQUIRED' && error.status === 422);
});
