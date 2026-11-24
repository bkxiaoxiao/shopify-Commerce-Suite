/** Pure restock decisions. Callers persist subscriptions, verify webhooks, detect
 * stock transitions and execute jobs idempotently. Never treats a requested
 * restock notice as general newsletter permission. Unknown sellability fails
 * closed; canonical data must explicitly identify publication and online stock.
 */
import { createHash } from 'node:crypto';

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'VALIDATION_ERROR'; error.status = 400;
  throw error;
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plain = (value, limit = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
const list = value => Array.isArray(value) ? value : value?.nodes ?? value?.edges?.map(edge => edge.node) ?? [];

function variantId(value) {
  const id = String(value ?? '');
  if (/^[1-9]\d*$/.test(id)) return `gid://shopify/ProductVariant/${id}`;
  if (/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(id)) return id;
  invalid('variantId must be a Shopify ProductVariant ID');
}

function marketId(value) {
  const id = String(typeof value === 'object' ? value?.id ?? value?.code ?? value?.countryCode ?? '' : value ?? '').trim();
  if (!id || id.length > 100 || !/^(?:[a-z0-9_-]{2,64}|gid:\/\/shopify\/Market\/[1-9]\d*)$/i.test(id)) invalid('A valid market identifier is required');
  return id.startsWith('gid:') ? id : id.toUpperCase();
}

export function validateSubscription({ email, variantId: id, market, language = 'en', marketingConsent = false } = {}) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email.trim()) || /[\u0000-\u001f\u007f]/.test(email)) invalid('A valid email address is required');
  if (typeof marketingConsent !== 'boolean') invalid('marketingConsent must be a boolean');
  let canonicalLanguage;
  try { canonicalLanguage = Intl.getCanonicalLocales(language)[0]; } catch { invalid('language must be a BCP 47 language tag'); }
  if (!canonicalLanguage) invalid('language is required');
  return { email: email.trim().toLowerCase(), variantId: variantId(id), market: marketId(market), language: canonicalLanguage, marketingConsent };
}

function matchesMarket(values, market) {
  return list(values).some(value => {
    try { return marketId(value) === market; } catch { return false; }
  });
}

export function isSellable({ variant, inventoryLevels = [], market } = {}) {
  if (!variant || typeof variant !== 'object') return false;
  let id; let requestedMarket;
  try { id = variantId(variant.id); requestedMarket = marketId(market); } catch { return false; }
  const product = variant.product ?? {};
  if (variant.active === false || variant.published === false || product.published === false || variant.availableForSale === false) return false;
  if (product.status && product.status.toUpperCase() !== 'ACTIVE') return false;
  if (variant.status && variant.status.toUpperCase() !== 'ACTIVE') return false;
  if (market && typeof market === 'object' && (market.enabled === false || market.published === false || market.availableForSale === false)) return false;
  const published = variant.published === true || product.published === true || Boolean(product.publishedAt) || Boolean(variant.publishedAt);
  if (!published) return false;
  const publishedMarkets = variant.publishedMarkets ?? variant.markets ?? product.publishedMarkets ?? product.markets;
  // An explicit contextual availability result may replace a list of markets.
  const contextual = variant.contextualAvailability?.[requestedMarket] === true || (typeof market === 'object' && market?.published === true && market?.availableForSale === true);
  if (!matchesMarket(publishedMarkets, requestedMarket) && !contextual) return false;
  if (variant.inventoryTracked === false || variant.inventoryItem?.tracked === false) return false;
  const itemId = variant.inventoryItemId ?? variant.inventoryItem?.id;
  return list(inventoryLevels).some(level => {
    if (!level || level.isActive !== true) return false;
    if (level.variantId) { try { if (variantId(level.variantId) !== id) return false; } catch { return false; } }
    const levelItem = level.inventoryItemId ?? level.item?.id;
    if (itemId && levelItem && itemId !== levelItem) return false;
    const location = level.location ?? {};
    if (location.isActive !== true || location.fulfillsOnlineOrders !== true) return false;
    if (location.markets && !matchesMarket(location.markets, requestedMarket)) return false;
    if (level.markets && !matchesMarket(level.markets, requestedMarket)) return false;
    const available = level.available ?? list(level.quantities).find(quantity => quantity.name === 'available')?.quantity;
    return Number.isSafeInteger(available) && available > 0;
  });
}

export function buildRestockJobs({ subscriptions = [], variant, inventoryLevels = [], market, restockCycleId } = {}) {
  if (typeof restockCycleId !== 'string' || !restockCycleId.trim() || restockCycleId.length > 200) invalid('An explicit restockCycleId is required');
  if (!isSellable({ variant, inventoryLevels, market })) return [];
  const id = variantId(variant.id); const requestedMarket = marketId(market);
  const unique = new Map();
  for (const source of subscriptions) {
    if (!source || source.unsubscribedAt || source.suppressed === true || source.restockConsent === false) continue;
    if (source.status != null && !['active', 'subscribed', 'waiting', 'confirmed'].includes(String(source.status).toLowerCase())) continue;
    if (source.lastNotifiedCycleId === restockCycleId || list(source.notifiedCycleIds).includes(restockCycleId)) continue;
    let subscription;
    try { subscription = validateSubscription(source); } catch { continue; }
    if (subscription.variantId !== id || subscription.market !== requestedMarket) continue;
    const shopId = String(source.shopId ?? source.shop ?? '');
    const key = JSON.stringify([shopId, subscription.email, id, requestedMarket, restockCycleId]);
    const jobId = `restock_${createHash('sha256').update(key).digest('hex')}`;
    const job = { id: jobId, type: 'restock', subscriptionId: String(source.id ?? ''), shopId, ...subscription, restockCycleId };
    // Stable duplicate selection also makes results independent of input order.
    if (!unique.has(jobId) || job.subscriptionId.localeCompare(unique.get(jobId).subscriptionId) < 0) unique.set(jobId, job);
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function https(value, name) {
  let url;
  try { url = new URL(value); } catch { invalid(`${name} must be an absolute HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password) invalid(`${name} must be an absolute HTTPS URL`);
  return url.toString();
}

const COPY = {
  en: { subject: 'Back in stock', title: 'It is back in stock', description: 'The product you asked about is available again.', action: 'View product', availability: 'Availability is checked at checkout. This notice does not reserve stock.', reason: 'You received this email because you requested a stock notification for this product.', unsubscribe: 'Cancel this product notification' },
  de: { subject: 'Wieder auf Lager', title: 'Wieder auf Lager', description: 'Das von Ihnen angefragte Produkt ist wieder verfügbar.', action: 'Produkt ansehen', availability: 'Die Verfügbarkeit wird beim Kauf geprüft. Diese Nachricht reserviert keinen Bestand.', reason: 'Sie erhalten diese E-Mail, weil Sie eine Benachrichtigung für dieses Produkt angefordert haben.', unsubscribe: 'Benachrichtigung für dieses Produkt abbestellen' },
  fr: { subject: 'De nouveau en stock', title: 'De nouveau en stock', description: 'Le produit que vous attendiez est à nouveau disponible.', action: 'Voir le produit', availability: 'La disponibilité est vérifiée au paiement. Ce message ne réserve aucun stock.', reason: 'Vous recevez cet e-mail car vous avez demandé une alerte pour ce produit.', unsubscribe: 'Annuler cette alerte produit' },
};

export function renderRestockEmail({ subscription, product = {}, shop = {}, unsubscribeUrl } = {}) {
  const validated = validateSubscription(subscription);
  const t = COPY[validated.language.split('-')[0]] ?? COPY.en;
  const name = plain(product.title ?? product.name, 500);
  if (!name) invalid('Product title is required');
  const shopName = plain(shop.name, 250);
  if (!shopName) invalid('Shop name is required');
  const unsub = https(unsubscribeUrl, 'unsubscribeUrl');
  let productUrl = product.url ?? product.onlineStoreUrl;
  if (!productUrl && product.handle && shop.domain) {
    const domain = https(String(shop.domain).includes('://') ? shop.domain : `https://${shop.domain}`, 'shop.domain');
    productUrl = new URL(`/products/${encodeURIComponent(product.handle)}`, domain).toString();
  }
  const destination = new URL(https(productUrl, 'product.url'));
  destination.searchParams.set('variant', validated.variantId.split('/').at(-1));
  const imageUrl = product.imageUrl ? https(product.imageUrl, 'product.imageUrl') : null;
  const variantTitle = plain(product.variantTitle, 250);
  const subject = `${t.subject}: ${name}`;
  const html = `<!doctype html><html lang="${escape(validated.language)}"><head><meta charset="utf-8"></head><body style="margin:0;background:#f1f5f1;font:15px/1.6 Arial,sans-serif;color:#214635"><main style="max-width:560px;margin:24px auto;padding:32px;background:#fff"><strong>${escape(shopName)}</strong><h1>${escape(t.title)}</h1><p>${escape(t.description)}</p>${imageUrl ? `<img src="${escape(imageUrl)}" alt="${escape(name)}" style="width:100%;max-width:300px;height:auto">` : ''}<h2>${escape(name)}</h2>${variantTitle ? `<p>${escape(variantTitle)}</p>` : ''}<p><a href="${escape(destination.toString())}" style="display:inline-block;padding:12px 22px;background:#325d47;color:white;text-decoration:none;border-radius:5px">${escape(t.action)}</a></p><p style="font-size:12px;color:#687c6e">${escape(t.availability)}</p><hr style="border:0;border-top:1px solid #e1e8e1"><p style="font-size:12px;color:#687c6e">${escape(t.reason)}</p><a href="${escape(unsub)}" style="font-size:12px;color:#526c5b">${escape(t.unsubscribe)}</a></main></body></html>`;
  const message = [shopName, t.title, name, variantTitle, t.description, destination.toString(), t.availability, t.reason, `${t.unsubscribe}: ${unsub}`].filter(Boolean).join('\n\n');
  return { subject, html, text: message };
}
