/** Cloud transport/cache; without runtime-config.js the original offline UI works. */
export function createRuntime(config = globalThis.window?.__CLOUD_RUNTIME__, dependencies = {}) {
  const cloud = Boolean(config && ['production', 'demo'].includes(config.mode));
  const fetcher = dependencies.fetch || globalThis.fetch?.bind(globalThis);
  const browser = dependencies.window || globalThis.window;
  let storage = dependencies.storage;
  if (!cloud && !storage) { try { storage = browser?.localStorage; } catch { /* optional offline storage */ } }
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const listeners = new Set();
  const caches = new Map();
  const confirmed = new Map();
  const epochs = new Map();
  let stores = cloud ? [...(config.stores || [])] : [
    { id: 'uk', name: '英国旗舰店', country: 'GB', currency: 'GBP' },
    { id: 'eu', name: '欧洲旗舰店', country: 'DE', currency: 'EUR' },
  ];
  let mode = cloud ? config.mode : 'offline';
  let selected = stores[0]?.id || null;
  if (cloud && browser?.location?.search) {
    const shop = new URLSearchParams(browser.location.search).get('shop')?.toLowerCase();
    const requested = stores.find((store) => String(store.domain || '').toLowerCase() === shop);
    if (requested) selected = requested.id;
  }
  let data = { state: {}, metrics: {}, products: [], documents: [], subscriptions: [], jobs: [], connection: { connected: false, lastSync: null } };
  let tail = Promise.resolve();
  let pending = 0;
  let lastFailure = null;
  let sequence = 0;
  let authenticated = !cloud;
  if (!cloud) {
    try { const previous = storage?.getItem('cs-store'); if (stores.some((store) => store.id === previous)) selected = previous; } catch { /* private browser storage */ }
  }
  const emit = (type, details = {}) => listeners.forEach((listener) => listener({ type, pending, ...details }));

  async function api(path, options = {}) {
    if (!cloud) throw Object.assign(new Error('此功能需要连接应用服务器'), { status: 503 });
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.startsWith('//') || path.includes('\\')) throw new Error('Only same-origin API paths are allowed');
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    let body = options.body;
    if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof FormData)) {
      headers.set('Content-Type', 'application/json'); body = JSON.stringify(body);
    }
    if (typeof browser?.shopify?.idToken === 'function') headers.set('Authorization', `Bearer ${await browser.shopify.idToken()}`);
    const response = await fetcher(path, { ...options, body, headers, credentials: 'same-origin' });
    let payload;
    if (options.responseType === 'blob' && response.ok) return response.blob();
    if (response.status !== 204) {
      const contentType = response.headers.get('content-type') || '';
      payload = contentType.includes('application/json') ? await response.json() : null;
    }
    if (!response.ok) {
      const message = response.status === 409 ? '此配置已被其他会话修改，已重新加载。请检查后再保存。'
        : typeof payload?.error === 'string' ? payload.error : typeof payload?.message === 'string' ? payload.message : `请求失败（${response.status}）`;
      const error = Object.assign(new Error(message), { status: response.status });
      if (response.status === 401) { authenticated = false; emit('unauthorized'); }
      throw error;
    }
    return payload;
  }

  async function load(storeId) {
    const payload = await api(`/api/bootstrap${storeId ? `?store=${encodeURIComponent(storeId)}` : ''}`);
    if (!payload || typeof payload !== 'object') throw new Error('服务器返回了无效的初始化数据');
    if (Array.isArray(payload.stores)) stores = payload.stores;
    if (['production', 'demo'].includes(payload.mode)) mode = payload.mode;
    const target = storeId || stores[0]?.id || null;
    const entries = new Map();
    for (const identity of confirmed.keys()) if (identity.startsWith(`${target}\0`)) confirmed.delete(identity);
    for (const [key, entry] of Object.entries(payload.state || {})) {
      if (!entry || !Object.hasOwn(entry, 'value')) continue;
      const normalized = { value: clone(entry.value), revision: entry.revision ?? 0, sequence: 0 };
      entries.set(key, normalized);
      confirmed.set(`${target}\0${key}`, { value: clone(entry.value), revision: normalized.revision });
    }
    caches.set(target, entries);
    if (target === selected || selected === null) { selected = target; data = payload; }
    authenticated = true;
    return payload;
  }

  function emptyProductionValue(key, fallback) {
    if (/^shipping-rules-/.test(key) || /^commerce-bundles-/.test(key) || /^demo-(?:cart|restock)-/.test(key)) return [];
    if (/^commerce-documents-/.test(key)) return { settings: { seller: { name: '', address: [], countryCode: '', vatNumber: '', email: '' }, language: 'en', automaticInvoices: false, automaticCreditNotes: false, automaticEmail: false } };
    if (/^commerce-restock-/.test(key)) return { automatic: false, selected: null, items: [], frontendSubscribers: [] };
    if (/^sender-/.test(key)) return { sender: '', name: '', auto: false };
    if (/^(?:entity|vat)-/.test(key)) return '';
    if (/^(?:integration|enabled|auto-invoice|auto-restock|failure-alert)-/.test(key)) return false;
    if (/^commerce-storefront-bundle-/.test(key)) return null;
    return clone(fallback);
  }

  function read(key, fallback = null) {
    if (!cloud) {
      try { const value = storage?.getItem(`cs-${key}`); return value == null ? clone(fallback) : JSON.parse(value); } catch { return clone(fallback); }
    }
    const entry = caches.get(selected)?.get(key);
    if (entry) return clone(entry.value);
    return mode === 'production' ? emptyProductionValue(key, fallback) : clone(fallback);
  }

  function persist(key, value) {
    if (!cloud) { storage?.setItem(`cs-${key}`, JSON.stringify(value)); return value; }
    if (!selected) throw new Error('请先配置或选择店铺');
    const storeId = selected;
    const identity = `${storeId}\0${key}`;
    const epoch = epochs.get(storeId) || 0;
    const ownSequence = ++sequence;
    const snapshot = clone(value);
    const cache = caches.get(storeId) || new Map();
    caches.set(storeId, cache);
    cache.set(key, { value: clone(snapshot), revision: confirmed.get(identity)?.revision || 0, sequence: ownSequence });
    pending += 1; emit('saving');
    tail = tail.then(async () => {
      if ((epochs.get(storeId) || 0) !== epoch) return;
      try {
        const response = await api(`/api/state/${encodeURIComponent(storeId)}/${encodeURIComponent(key)}`, {
          method: 'PUT', body: { value: snapshot, revision: confirmed.get(identity)?.revision ?? 0 },
        });
        if (!Number.isSafeInteger(response?.revision)) throw new Error('服务器未确认配置版本');
        confirmed.set(identity, { value: clone(snapshot), revision: response.revision });
        if (cache.get(key)?.sequence === ownSequence) cache.set(key, { value: clone(snapshot), revision: response.revision, sequence: ownSequence });
      } catch (error) {
        epochs.set(storeId, epoch + 1);
        lastFailure = error;
        error.notified = true;
        // Remove optimistic state before reloading. Do not retain unconfirmed
        // edits if the network is also unavailable during the rollback fetch.
        const rollback = new Map();
        for (const [savedKey] of cache) {
          const previous = confirmed.get(`${storeId}\0${savedKey}`);
          if (previous) rollback.set(savedKey, { ...clone(previous), sequence: 0 });
        }
        caches.set(storeId, rollback);
        try { await load(storeId); } catch { /* confirmed cache is the fallback */ }
        emit('save-error', { error }); emit('reload');
      }
    }).finally(() => { pending -= 1; emit(pending ? 'saving' : lastFailure ? 'error' : 'saved'); });
    return value;
  }

  async function flush() {
    await tail;
    if (lastFailure) { const error = lastFailure; lastFailure = null; throw error; }
  }

  async function hydrate(storeId = selected) {
    if (!cloud) { selected = storeId; try { storage?.setItem('cs-store', storeId); } catch { /* optional preference */ } return data; }
    await flush();
    const previous = selected;
    selected = storeId;
    try { return await load(storeId); } catch (error) { selected = previous; throw error; }
  }

  return {
    get enabled() { return cloud; }, get mode() { return mode; }, get production() { return mode === 'production'; },
    get stores() { return stores; }, get store() { return selected; }, get data() { return data; },
    get pending() { return pending; }, get authenticated() { return authenticated; },
    get currentStore() { return stores.find((store) => store.id === selected) || null; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    api, read, persist, flush, hydrate,
    async init() { if (cloud) await load(selected); return data; },
    async login(password) { await api('/api/login', { method: 'POST', body: { password } }); return load(selected); },
    async logout() { await flush(); await api('/api/logout', { method: 'POST', body: {} }); caches.clear(); confirmed.clear(); authenticated = false; emit('unauthorized'); },
  };
}

export const runtime = createRuntime();
