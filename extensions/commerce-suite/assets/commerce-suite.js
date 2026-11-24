/* Shopify theme asset: no API secrets, HTML interpolation, or price overrides. */
(() => {
  'use strict';
  if (globalThis.CommerceSuiteStorefront) return;

  function variantId(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
    const match = String(value ?? '').match(/^(?:gid:\/\/shopify\/ProductVariant\/)?([1-9]\d*)$/);
    return match ? match[1] : null;
  }
  function safePath(value, fallback = '/apps/commerce-suite') {
    const path = String(value || fallback);
    return /^\/(?!\/)[a-zA-Z0-9/_-]+\/?$/.test(path) ? path.replace(/\/$/, '') : fallback;
  }
  function shopRoot(value) { return `${safePath(value, '/').replace(/\/$/, '')}/`; }
  function imageUrl(value, origin) {
    try { const url = new URL(String(value || ''), origin); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
    catch { return null; }
  }
  function formatMoney(amount, currency, locale) {
    if (!Number.isSafeInteger(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency || '')) return '';
    try {
      const formatter = new Intl.NumberFormat(locale || 'en', { style: 'currency', currency });
      return formatter.format(amount / 10 ** formatter.resolvedOptions().maximumFractionDigits);
    } catch { return ''; }
  }
  function buildCartItems(items, bundleId) {
    const group = /^[a-zA-Z0-9:_-]{1,128}$/.test(String(bundleId || '')) ? String(bundleId) : 'commerce-suite';
    const merged = new Map();
    for (const item of items) {
      const id = variantId(item.variantId ?? item.id);
      const quantity = item.quantity ?? 1;
      if (!id || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new Error('Invalid cart selection');
      const existing = merged.get(id);
      const total = (existing?.quantity || 0) + quantity;
      if (total > 999) throw new Error('Invalid cart selection');
      merged.set(id, { id, quantity: total, properties: { _commerce_bundle: group } });
    }
    if (!merged.size) throw new Error('Choose at least one item');
    return [...merged.values()];
  }
  function findProductForm(root, variants, doc = document) {
    const known = new Set(variants.map(value => variantId(value.id)));
    const selector = root.dataset.formSelector;
    if (selector) {
      try {
        const selected = doc.querySelector(selector);
        if (selected?.matches('form') && known.has(variantId(selected.querySelector('[name="id"]')?.value))) return selected;
      } catch { /* An invalid optional merchant selector cannot break the page. */ }
    }
    return [...doc.querySelectorAll('form[action*="/cart/add"]')].find(form => known.has(variantId(form.querySelector('[name="id"]')?.value))) || null;
  }
  function selectVariant({ variants, formValue, urlValue, previousUrlValue, eventValue, fallback }) {
    const known = new Map(variants.map(value => [variantId(value.id), value]));
    const valid = value => known.get(variantId(value));
    return valid(eventValue) || (urlValue !== previousUrlValue && valid(urlValue)) || valid(formValue) || valid(urlValue) || valid(fallback) || variants[0] || null;
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }
  async function readJson(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const result = await response.json();
    if (!response.ok) throw new Error('Request could not be completed');
    return result;
  }

  class ProductBlock extends HTMLElement {
    connectedCallback() {
      if (this.started) return;
      this.started = true;
      this.alive = true;
      this.variant = null;
      this.abort = new AbortController();
      try { this.product = JSON.parse(this.querySelector('[data-commerce-product]')?.textContent || 'null'); }
      catch { this.product = null; }
      if (!this.product || !Array.isArray(this.product.variants) || !this.product.variants.length) return;
      this.rootPath = shopRoot(this.dataset.rootUrl);
      this.proxyPath = safePath(this.dataset.proxyPath);
      this.listener = event => this.syncVariant(event);
      this.events = ['change', 'variant:change', 'variant:changed', 'product:variant-change', 'product:variant-changed'];
      this.events.forEach(name => document.addEventListener(name, this.listener));
      window.addEventListener('popstate', this.listener);
      // Some themes change a hidden input's value/history without a DOM event.
      this.poller = window.setInterval(() => { if (document.visibilityState !== 'hidden') this.syncVariant(); }, 750);
      this.start();
      this.syncVariant();
    }
    disconnectedCallback() {
      this.alive = false;
      this.started = false;
      this.abort?.abort();
      this.events?.forEach(name => document.removeEventListener(name, this.listener));
      window.removeEventListener('popstate', this.listener);
      window.clearInterval(this.poller);
    }
    label(name, fallback) { return this.dataset[`label${name}`] || fallback; }
    status(text, error = false) {
      const target = this.querySelector('[data-commerce-status]');
      if (target) { target.textContent = text; target.setAttribute('role', error ? 'alert' : 'status'); }
    }
    syncVariant(event) {
      this.productForm = findProductForm(this, this.product.variants);
      const urlValue = new URL(window.location.href).searchParams.get('variant');
      const detail = event?.detail;
      const eventValue = detail?.variant?.id ?? detail?.data?.variant?.id ?? detail?.productVariant?.id;
      const selected = selectVariant({ variants: this.product.variants, formValue: this.productForm?.querySelector('[name="id"]')?.value, urlValue, previousUrlValue: this.previousUrlValue, eventValue, fallback: this.dataset.variantId });
      this.previousUrlValue = urlValue;
      if (selected && selected.id !== this.variant?.id) { this.variant = selected; this.onVariant(selected); }
    }
  }

  class BundleBlock extends ProductBlock {
    start() {
      this.cards = [];
      this.addButton = this.querySelector('[data-commerce-add]');
      this.addButton.onclick = () => this.add();
    }
    onVariant() {
      this.cards = [];
      this.mainCard = null;
      this.querySelector('[data-commerce-list]').replaceChildren();
      this.querySelector('[data-commerce-actions]').hidden = true;
      this.hidden = !this.variant.available;
      this.load();
    }
    async hydrate(source, signal) {
      const handle = String(source.handle || '');
      if (!/^[a-z0-9][a-z0-9-]{0,254}$/i.test(handle)) return null;
      const details = await readJson(`${this.rootPath}products/${encodeURIComponent(handle)}.js`, { signal });
      if (details.requires_selling_plan) return null;
      // A configured bundle member is an exact variant; substitutes may not
      // qualify for its platform discount, even when the product is the same.
      const matching = (details.variants || []).find(value => variantId(value.id) === variantId(source.variantId));
      const quantity = source.quantity ?? 1;
      if (!matching || matching.available !== true || !Number.isSafeInteger(matching.price) || matching.price < 0 || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) return null;
      const selected = { id: variantId(matching.id), title: String(matching.title || ''), priceMinor: matching.price, available: true };
      return { source, handle, title: String(details.title || source.name || ''), variants: [selected], selected, quantity, checked: true, image: details.featured_image || source.image };
    }
    async load() {
      this.requestAbort?.abort();
      const controller = new AbortController();
      this.requestAbort = controller;
      const cancel = () => controller.abort();
      this.abort.signal.addEventListener('abort', cancel, { once: true });
      const generation = this.generation = (this.generation || 0) + 1;
      const requestedVariant = this.variant?.id;
      if (!this.variant?.available) { this.abort.signal.removeEventListener('abort', cancel); return; }
      this.status(this.label('Loading', 'Loading recommendations…'));
      try {
        const url = new URL(`${this.proxyPath}/recommendations`, window.location.origin);
        url.searchParams.set('product_id', this.dataset.productId);
        url.searchParams.set('variant_id', requestedVariant);
        url.searchParams.set('country', this.dataset.country);
        const result = await readJson(url, { signal: controller.signal });
        const seen = new Set();
        const products = (Array.isArray(result.products) ? result.products : []).filter(value => {
          const id = variantId(value?.variantId);
          if (!value || !id || value.currency !== this.dataset.currency || seen.has(id) || id === variantId(requestedVariant)) return false;
          seen.add(id); return true;
        }).slice(0, Math.max(1, Math.min(6, Number(this.dataset.limit) || 3)));
        const hydrated = await Promise.allSettled(products.map(value => this.hydrate(value, controller.signal)));
        if (!this.alive || generation !== this.generation || requestedVariant !== this.variant?.id) return;
        this.cards = hydrated.filter(value => value.status === 'fulfilled' && value.value).map(value => value.value);
        this.mainQuantity = result.mainQuantity ?? this.cards[0]?.source.mainQuantity ?? 1;
        if (!Number.isInteger(this.mainQuantity) || this.mainQuantity < 1 || this.mainQuantity > 999) throw new Error('Invalid main product quantity');
        this.bundleId = result.bundleId || this.cards[0]?.source.bundleId || `recommendation:${this.dataset.productId}`;
        if (!this.cards.length) { this.status(this.label('Empty', 'No recommendations are available right now.')); return; }
        this.status('');
        this.render();
      } catch (error) {
        if (this.alive && generation === this.generation && error.name !== 'AbortError') this.status(this.label('Error', 'Please try again in a moment.'), true);
      } finally { this.abort.signal.removeEventListener('abort', cancel); }
    }
    renderCard(card, main = false) {
      const row = node('div', 'commerce-suite__item');
      const check = node('input'); check.type = 'checkbox'; check.checked = card.checked;
      check.setAttribute('aria-label', card.title);
      check.onchange = () => { card.checked = check.checked; this.updateTotal(); };
      const picture = node('span');
      const image = imageUrl(card.image, window.location.origin);
      if (image) { const img = node('img', 'commerce-suite__image'); img.src = image; img.alt = card.title; img.loading = 'lazy'; img.width = 64; img.height = 64; picture.append(img); }
      const body = node('div', 'commerce-suite__item-content');
      const title = node('a', 'commerce-suite__item-name', card.title);
      title.href = `${this.rootPath}products/${encodeURIComponent(card.handle)}?variant=${encodeURIComponent(card.selected.id)}`;
      body.append(title);
      if (card.quantity > 1) body.append(node('span', '', `× ${card.quantity}`));
      if (main) body.append(node('span', 'commerce-suite__item-main', this.label('Main', 'Current product')));
      if (card.variants.length > 1 && !main) {
        const select = node('select'); select.setAttribute('aria-label', `${card.title} — ${this.label('Variant', 'Option')}`);
        card.variants.forEach(value => { const option = node('option', '', value.title); option.value = value.id; option.selected = value.id === card.selected.id; select.append(option); });
        select.onchange = () => { card.selected = card.variants.find(value => value.id === select.value) || card.selected; title.href = `${this.rootPath}products/${encodeURIComponent(card.handle)}?variant=${encodeURIComponent(card.selected.id)}`; price.textContent = formatMoney(card.selected.priceMinor, this.dataset.currency, this.dataset.locale); this.updateTotal(); };
        body.append(select);
      } else if (card.selected.title && card.selected.title !== 'Default Title') body.append(node('span', '', card.selected.title));
      const price = node('span', 'commerce-suite__price', formatMoney(card.selected.priceMinor * card.quantity, this.dataset.currency, this.dataset.locale));
      body.append(price); row.append(check, picture, body);
      return row;
    }
    render() {
      if (!this.variant) return;
      const list = this.querySelector('[data-commerce-list]');
      this.mainCard = { title: this.product.title, handle: this.product.handle, image: this.product.image, variants: this.product.variants, selected: this.variant, quantity: this.mainQuantity, checked: this.mainCard?.checked ?? true };
      list.replaceChildren(this.renderCard(this.mainCard, true), ...this.cards.map(card => this.renderCard(card)));
      this.querySelector('[data-commerce-actions]').hidden = !this.variant.available;
      this.hidden = !this.variant.available;
      this.updateTotal();
    }
    selections() { return [this.mainCard, ...this.cards].filter(card => card?.checked).map(card => ({ variantId: card.selected.id, quantity: card.quantity })); }
    updateTotal() {
      const selected = [this.mainCard, ...this.cards].filter(card => card?.checked);
      const total = selected.reduce((amount, card) => amount + card.selected.priceMinor * card.quantity, 0);
      this.querySelector('[data-commerce-total]').textContent = formatMoney(total, this.dataset.currency, this.dataset.locale);
      this.addButton.disabled = !selected.length || this.busy || this.dataset.designMode === 'true';
    }
    async add() {
      if (this.busy || !this.variant?.available) return;
      this.busy = true; this.updateTotal();
      try {
        const items = buildCartItems(this.selections(), this.bundleId);
        const result = await readJson(`${this.rootPath}cart/add.js`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ items }), signal: this.abort.signal });
        if (!this.alive) return;
        this.status(this.label('Added', 'Selected items were added to your cart.'));
        document.dispatchEvent(new CustomEvent('commerce-suite:cart-added', { detail: { items: result.items || [] } }));
        if (this.dataset.redirect !== 'false') window.location.assign(`${this.rootPath}cart`);
      } catch (error) { if (this.alive && error.name !== 'AbortError') this.status(this.label('Error', 'Please try again in a moment.'), true); }
      finally { this.busy = false; if (this.alive) this.updateTotal(); }
    }
  }

  class RestockBlock extends ProductBlock {
    start() { this.form = this.querySelector('[data-commerce-subscribe]'); this.form.onsubmit = event => { event.preventDefault(); this.subscribe(); }; }
    onVariant(value) {
      const editor = this.dataset.designMode === 'true';
      this.hidden = value.available && !editor;
      this.form.hidden = value.available;
      this.querySelector('[data-commerce-variant]').textContent = `${this.product.title}${value.title === 'Default Title' ? '' : ` · ${value.title}`}`;
      this.form.querySelector('button').disabled = editor || this.busy;
      this.status(value.available ? this.label('Available', 'This option is available now.') : editor ? this.label('Preview', 'Preview only. Open the storefront to test signup.') : '');
    }
    async subscribe() {
      if (this.busy || !this.variant || this.variant.available || this.dataset.designMode === 'true' || !this.form.reportValidity()) return;
      const requested = this.variant;
      const email = this.form.querySelector('[name="email"]').value.trim();
      const marketingConsent = this.form.querySelector('[name="marketingConsent"]')?.checked === true;
      this.busy = true; this.form.querySelector('button').disabled = true;
      try {
        await readJson(`${this.proxyPath}/subscriptions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email, variantId: `gid://shopify/ProductVariant/${variantId(requested.id)}`, market: this.dataset.country, language: this.dataset.locale || 'en', marketingConsent }), signal: this.abort.signal });
        if (!this.alive) return;
        this.form.reset();
        this.status(`${this.label('Subscribed', 'Your notification request is saved.')} ${requested.title === 'Default Title' ? '' : requested.title}`.trim());
      } catch (error) { if (this.alive && error.name !== 'AbortError') this.status(this.label('Error', 'Please try again in a moment.'), true); }
      finally { this.busy = false; if (this.alive) this.form.querySelector('button').disabled = this.dataset.designMode === 'true'; }
    }
  }

  globalThis.CommerceSuiteStorefront = Object.freeze({ variantId, safePath, shopRoot, imageUrl, formatMoney, buildCartItems, findProductForm, selectVariant });
  if (!customElements.get('commerce-suite-bundles')) customElements.define('commerce-suite-bundles', BundleBlock);
  if (!customElements.get('commerce-suite-restock')) customElements.define('commerce-suite-restock', RestockBlock);
})();
