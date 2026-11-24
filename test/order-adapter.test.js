import test from 'node:test';
import assert from 'node:assert/strict';
import { orderFromWebhook, creditFromWebhook } from '../server/order-adapter.js';
import { createInvoiceSnapshot } from '../server/domain/documents.js';

const settings = { seller: { name: 'Example UK Ltd', countryCode: 'GB', address: ['1 Street, London'], vatNumber: 'GB123456789' } };
const payload = () => ({
  id: 123, name: '#UK123', financial_status: 'paid', currency: 'GBP', presentment_currency: 'GBP', taxes_included: false,
  created_at: '2026-11-24T03:00:00Z', processed_at: '2026-11-24T03:01:00Z', refunds: [],
  email: 'emma@example.com', customer: { first_name: 'Emma', last_name: 'Example' },
  billing_address: { name: 'Emma Example', address1: '1 Customer Street', zip: 'SW1A 1AA', city: 'London', country: 'United Kingdom', country_code: 'GB' },
  line_items: [{ id: 11, title: 'Training rack', sku: 'RACK-1', quantity: 2, current_quantity: 2, price: '100.00', discount_allocations: [{ amount: '20.00' }], tax_lines: [{ title: 'VAT', rate: 0.2, price: '36.00' }] }],
  shipping_lines: [{ price: '10.00', discounted_price: '5.00', discount_allocations: [{ amount: '5.00' }], tax_lines: [{ title: 'VAT', rate: 0.2, price: '1.00' }] }],
  subtotal_price: '180.00', total_discounts: '20.00', total_tax: '37.00', total_price: '222.00',
  current_subtotal_price: '180.00', current_total_discounts: '20.00', current_total_tax: '37.00', current_total_price: '222.00',
});
const invoice = () => createInvoiceSnapshot({ order: orderFromWebhook(payload()), settings, number: 'INV-123' });
const refund = () => ({ id: 55, order_id: 123, created_at: '2026-11-25T02:00:00Z', refund_line_items: [{ line_item_id: 11, quantity: 1, subtotal: '90.00', total_tax: '18.00' }], refund_shipping_lines: [], order_adjustments: [], transactions: [{ kind: 'refund', status: 'success', amount: '108.00', currency: 'GBP' }] });
const set = (gbp, eur) => ({ shop_money: { amount: gbp, currency_code: 'GBP' }, presentment_money: { amount: eur, currency_code: 'EUR' } });

test('paid REST-shaped webhook becomes an integer canonical order without mutating input', () => {
  const source = payload(); const before = structuredClone(source);
  const order = orderFromWebhook(source);
  assert.deepEqual(source, before);
  assert.equal(order.lineItems[0].unitPriceMinor, 10000);
  assert.equal(order.lineItems[0].discountMinor, 2000);
  assert.equal(order.shippingMinor, 500);
  assert.equal(order.shippingTaxMinor, 100);
  assert.equal(order.totalMinor, 22200);
  assert.equal(order.customer.name, 'Emma Example');
  const result = createInvoiceSnapshot({ order, settings, number: 'INV-123' });
  assert.equal(result.totalMinor, 22200);
  assert.equal(result.totals.taxMinor, 3700);
});

test('tax-inclusive REST webhook preserves actual charged total', () => {
  const source = payload();
  source.taxes_included = true;
  source.total_price = source.current_total_price = '185.00';
  const snapshot = createInvoiceSnapshot({ order: orderFromWebhook(source), settings, number: 'INV-inclusive' });
  assert.equal(snapshot.totalMinor, 18500);
  assert.equal(snapshot.totals.subtotalMinor, 14400);
  assert.equal(snapshot.totals.shippingNetMinor, 400);
  assert.equal(snapshot.totals.taxMinor, 3700);
});

test('missing taxes, discount allocations and monetary fractions fail without guessing', () => {
  for (const mutate of [
    source => { delete source.taxes_included; },
    source => { delete source.line_items[0].tax_lines; },
    source => { delete source.line_items[0].discount_allocations; },
    source => { source.line_items[0].price = '100.001'; },
    source => { source.line_items[0].price = 100.01; },
    source => { source.total_tax = '1.00'; },
    source => { source.shipping_lines[0].discounted_price = '4.00'; },
  ]) {
    const source = payload(); mutate(source);
    assert.throws(() => orderFromWebhook(source), error => error.code === 'ORDER_DATA_INCOMPLETE');
  }
});

test('already modified, refunded, cancelled and unpaid payloads cannot become original invoices', () => {
  for (const mutate of [
    source => { source.current_total_price = '100.00'; },
    source => { source.line_items[0].current_quantity = 1; },
    source => { source.refunds = [{ id: 1 }]; },
    source => { source.cancelled_at = '2026-11-24'; },
    source => { source.financial_status = 'partially_paid'; },
    source => { source.edited = true; },
  ]) {
    const source = payload(); mutate(source);
    assert.throws(() => orderFromWebhook(source), error => error.status === 422);
  }
});

test('presentment currency uses matching money sets and never scalar shop-currency prices', () => {
  const source = payload();
  source.presentment_currency = 'EUR';
  source.line_items[0].price_set = set('100.00', '110.00');
  source.line_items[0].discount_allocations[0].amount_set = set('20.00', '22.00');
  source.line_items[0].tax_lines[0].price_set = set('36.00', '39.60');
  source.shipping_lines[0].price_set = set('10.00', '11.00');
  source.shipping_lines[0].discounted_price_set = set('5.00', '5.50');
  source.shipping_lines[0].discount_allocations[0].amount_set = set('5.00', '5.50');
  source.shipping_lines[0].tax_lines[0].price_set = set('1.00', '1.10');
  for (const [name, gbp, eur] of [['subtotal_price', '180.00', '198.00'], ['total_discounts', '20.00', '22.00'], ['total_tax', '37.00', '40.70'], ['total_price', '222.00', '244.20']]) {
    source[`${name}_set`] = set(gbp, eur);
    source[`current_${name}_set`] = set(gbp, eur);
  }
  const order = orderFromWebhook(source);
  assert.equal(order.currency, 'EUR'); assert.equal(order.shopCurrency, 'GBP'); assert.equal(order.totalMinor, 24420);
  delete source.line_items[0].price_set;
  assert.throws(() => orderFromWebhook(source), /presentment currency/);
});

test('partial credit uses actual refund amounts and original invoice identity', () => {
  const original = invoice(); const source = refund(); const before = structuredClone(source);
  const credit = creditFromWebhook(source, original);
  assert.deepEqual(source, before);
  assert.equal(credit.refundId, '55'); assert.equal(credit.originalInvoiceNumber, 'INV-123');
  assert.equal(credit.lineItems[0].quantity, 1); assert.equal(credit.lineItems[0].title, 'Training rack');
  const snapshot = createInvoiceSnapshot({ order: credit, settings: { seller: original.seller }, number: 'CN-55', type: 'credit' });
  assert.equal(snapshot.totalMinor, -10800);
  assert.equal(snapshot.totals.taxMinor, -1800);
  assert.equal(snapshot.originalInvoiceNumber, 'INV-123');
});

test('full credit includes refunded shipping with its actual tax', () => {
  const source = refund();
  source.refund_line_items[0] = { line_item_id: 11, quantity: 2, subtotal: '180.00', total_tax: '36.00' };
  source.refund_shipping_lines = [{ subtotal_amount: '5.00', tax_amount: '1.00' }];
  source.transactions[0].amount = '222.00';
  const credit = creditFromWebhook(source, invoice());
  const snapshot = createInvoiceSnapshot({ order: credit, settings, number: 'CN-full', type: 'credit' });
  assert.equal(snapshot.totalMinor, -22200); assert.equal(snapshot.totals.shippingNetMinor, -500);
});

test('legacy negative shipping adjustment is normalized once and shipping-only credits work', () => {
  const source = refund(); source.refund_line_items = []; source.transactions[0].amount = '6.00';
  source.order_adjustments = [{ kind: 'shipping_refund', amount: '-5.00', tax_amount: '-1.00' }];
  const credit = creditFromWebhook(source, invoice());
  assert.equal(credit.shippingMinor, 500); assert.equal(credit.shippingTaxMinor, 100);
  const snapshot = createInvoiceSnapshot({ order: credit, settings, number: 'CN-shipping', type: 'credit' });
  assert.equal(snapshot.totalMinor, -600);
});

test('refunds with a failed transaction, unknown line, wrong order, discrepancy or excess quantity fail', () => {
  for (const mutate of [
    source => { source.transactions[0].status = 'pending'; },
    source => { source.transactions[0].amount = '10.00'; },
    source => { source.order_id = 999; },
    source => { source.refund_line_items[0].line_item_id = 999; },
    source => { source.refund_line_items[0].quantity = 3; },
    source => { source.order_adjustments = [{ kind: 'refund_discrepancy', amount: '-1.00', tax_amount: '0.00' }]; },
  ]) {
    const source = refund(); mutate(source);
    assert.throws(() => creditFromWebhook(source, invoice()), error => error.code === 'ORDER_DATA_INCOMPLETE');
  }
});

test('non-divisible refund totals remain exact for multiple units', () => {
  const source = payload(); source.line_items[0].quantity = source.line_items[0].current_quantity = 3;
  source.subtotal_price = source.current_subtotal_price = '280.00';
  source.total_price = source.current_total_price = '322.00';
  const original = createInvoiceSnapshot({ order: orderFromWebhook(source), settings, number: 'INV-3' });
  const partial = refund(); partial.refund_line_items[0] = { line_item_id: 11, quantity: 3, subtotal: '100.00', total_tax: '20.00' }; partial.transactions[0].amount = '120.00';
  const snapshot = createInvoiceSnapshot({ order: creditFromWebhook(partial, original), settings, number: 'CN-3', type: 'credit' });
  assert.equal(snapshot.lines[0].quantity, 3); assert.equal(snapshot.lines[0].netMinor, -10000); assert.equal(snapshot.totalMinor, -12000);
});

test('inclusive refund source is reconciled against successful refund payment', () => {
  const source = payload(); source.taxes_included = true; source.total_price = source.current_total_price = '185.00';
  const original = createInvoiceSnapshot({ order: orderFromWebhook(source), settings, number: 'INV-inc' });
  const partial = refund(); partial.refund_line_items[0].subtotal = '90.00'; partial.refund_line_items[0].total_tax = '18.00'; partial.transactions[0].amount = '90.00';
  const snapshot = createInvoiceSnapshot({ order: creditFromWebhook(partial, original), settings, number: 'CN-inc', type: 'credit' });
  assert.equal(snapshot.lines[0].netMinor, -7200); assert.equal(snapshot.totals.taxMinor, -1800); assert.equal(snapshot.totalMinor, -9000);
});
