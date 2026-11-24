const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const list = (value) => Array.isArray(value) ? value : [];
const apiRoot = (ctx) => `/api/stores/${encodeURIComponent(ctx.store)}`;
const stateKey = (ctx, prefix) => `${prefix}-${ctx.store}`;
const data = (ctx) => ctx.runtime.data || {};
const products = (ctx) => list(data(ctx).products);
const money = (ctx, amount, currency = ctx.runtime.currentStore?.currency || 'GBP') => new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Number(amount || 0) / 100);
const when = (value) => { const timestamp = typeof value === 'object' && value ? value.at || value.updatedAt || value.createdAt : value; return timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '尚未同步'; };
const notice = (ctx) => `<div class="info-note" style="margin-bottom:20px">${ctx.icon('info', 17)}<span>${data(ctx).connection?.connected ? `Shopify 已授权 · 最近同步：${escape(when(data(ctx).connection.lastSync))}` : '尚未连接 Shopify。可以保存配置；商品与库存数据将在授权并同步后显示；付款订单由 Shopify Webhook 接收。'} 配置按店铺独立保存。</span></div>`;
const heading = (title, description, actions = '') => `<div class="page-heading"><div><h1>${title}</h1><p class="page-description">${description}</p></div><div class="page-actions">${actions}</div></div>`;
const empty = (message, span = 1) => `<tr><td colspan="${span}"><div class="empty-state">${message}</div></td></tr>`;
const table = (headers, rows) => `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
const button = (action, label, disabled = false, className = '') => `<button class="button ${className}" ${disabled ? 'disabled' : ''} data-production="${action}">${label}</button>`;
const field = (name, label, value = '', attributes = '') => `<label class="field">${label}<input class="input" name="${name}" value="${escape(value)}" ${attributes}></label>`;

function counts(ctx) {
  const jobs = list(data(ctx).jobs);
  return { products: products(ctx).length, documents: list(data(ctx).documents).length, subscriptions: list(data(ctx).subscriptions).filter((entry) => entry.active !== false).length, pending: jobs.filter((job) => ['queued', 'pending', 'running', 'processing', 'retry'].includes(job.status)).length, failed: jobs.filter((job) => job.status === 'failed').length };
}

function overview(ctx, analytics = false) {
  const count = counts(ctx);
  const metrics = data(ctx).metrics || {};
  const cards = [['已同步商品', count.products, '来自最近一次 Shopify 同步'], ['已生成单据', count.documents, '已保存的真实单据'], ['有效补货订阅', count.subscriptions, '当前店铺的订阅记录'], ['待处理任务', count.pending, `${count.failed} 个任务失败`]];
  const jobs = list(data(ctx).jobs).slice(0, 8);
  const orders = list(data(ctx).orders || metrics.recentOrders);
  return heading(analytics ? '效果分析' : '运营总览', `${escape(ctx.runtime.currentStore?.name || '当前店铺')} · ${analytics ? '仅显示已记录的数据，成交归因等待真实事件同步。' : '查看商品同步、单据、补货订阅与后台任务。'}`, button('refresh', '刷新数据')) + notice(ctx)
    + `<section class="metric-grid">${cards.map(([label, value, caption]) => `<div class="metric-card"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-change">${caption}</div></div>`).join('')}</section>`
    + (analytics ? `<section class="card mb-16"><div class="card-head"><h2>订单归因</h2></div><div class="card-body">${Number.isSafeInteger(metrics.associatedSalesMinor) ? `<p>已记录关联销售额：<strong>${money(ctx, metrics.associatedSalesMinor)}</strong></p>` : '<p class="muted">尚无可验证的成交归因数据。配置保存、组件展示、邮件任务创建均不等于已完成购买。</p>'}</div></section>` : `<div class="module-grid">${[['shipping', '运费管理', '配置地区、邮编与重量费率'], ['bundles', '搭配销售', '基于真实 SKU 配置搭配组合'], ['documents', '发票与单据', '创建报价并下载真实 PDF'], ['restock', '补货提醒', '管理订阅名单和通知任务']].map(([page, title, description]) => `<section class="card module-card"><h3 class="module-title">${title}</h3><p class="module-description">${description}</p>${button(`navigate:${page}`, '打开模块')}</section>`).join('')}</div>`)
    + `<section class="card mb-16"><div class="card-head"><h2>最近后台任务</h2></div>${table(['任务', '状态', '时间'], jobs.length ? jobs.map((job) => `<tr><td>${escape(job.type || job.kind || job.id)}</td><td>${escape(job.status || '等待处理')}</td><td>${escape(when(job.updated_at || job.updatedAt || job.created_at || job.createdAt))}</td></tr>`).join('') : empty('暂无后台任务', 3))}</section>`
    + `<section class="card"><div class="card-head"><h2>最近订单</h2></div>${table(['订单', '金额', '时间'], orders.length ? orders.slice(0, 10).map((order) => `<tr><td>${escape(order.name || order.number || order.id)}</td><td>${money(ctx, order.totalMinor, order.currency)}</td><td>${escape(when(order.createdAt || order.created_at))}</td></tr>`).join('') : empty('等待 Shopify 付款订单事件，暂无可展示的真实订单', 3))}</section>`;
}

function shipping(ctx) {
  const rules = list(ctx.read(stateKey(ctx, 'shipping-rules'), []));
  return heading('运费管理', '配置国家、邮编和重量费率；通过真实报价接口验证。', button('new-rule', '新建规则', false, 'button-primary') + button('test-shipping', '运费试算') + button('register-carrier', '注册结账运费', !data(ctx).connection?.connected)) + notice(ctx)
    + `<section class="card">${table(['规则名称', '目的地', '类型 / 重量', '费用', '状态', '操作'], rules.length ? rules.map((rule) => `<tr><td>${escape(rule.name)}</td><td>${escape(list(rule.countries).join(', '))}<small style="display:block">${escape(list(rule.postcodes).join(', ') || '按国家覆盖')}</small></td><td>${escape(rule.kind)}${rule.max !== undefined ? ` · (${rule.min || 0}, ${rule.max}] kg` : ''}</td><td>${ctx.money(rule.price ?? Number(rule.priceMinor || 0) / 100)}</td><td>${rule.enabled !== false ? '已启用配置' : '已暂停'}</td><td><div class="row-actions">${button(`edit-rule:${rule.id}`, '编辑')}${button(`toggle-rule:${rule.id}`, rule.enabled !== false ? '暂停' : '启用')}</div></td></tr>`).join('') : empty('尚无配送规则。请新建规则，并在试算通过后注册结账运费。', 6))}</section><p class="app-footnote">结账实时运费依赖店铺 CCS 资格。规则保存与 CarrierService 注册分别执行。</p>`;
}

function bundles(ctx) {
  const definitions = list(ctx.read(stateKey(ctx, 'commerce-bundles'), []));
  const catalog = products(ctx);
  const name = (variant) => catalog.find((product) => String(product.variantId || product.id) === variant)?.name || catalog.find((product) => String(product.variantId || product.id) === variant)?.title || variant;
  return heading('搭配销售', '使用当前店铺已同步的实际 SKU 建立组合。', button('new-bundle', '创建 SKU 组合', !catalog.length, 'button-primary')) + notice(ctx)
    + (!catalog.length ? '<div class="info-note mb-16">暂无真实商品。请在设置中连接 Shopify 并同步商品后创建组合。</div>' : '')
    + `<section class="card">${table(['组合', '成员 SKU', '优惠配置', '状态', '操作'], definitions.length ? definitions.map((bundle) => `<tr><td>${escape(bundle.name)}</td><td>${list(bundle.members).map((member) => `${escape(name(member.variantId))} × ${member.quantity || 1}`).join('<br>')}</td><td>${bundle.discountType === 'fixed' ? money(ctx, bundle.discountAmountMinor) : `${bundle.discount || 0}%`}${bundle.discountType === 'buy_x_get_y' ? '（配件折扣）' : ''}</td><td>${bundle.enabled !== false ? '已保存配置' : '已暂停'}<small style="display:block">${escape((()=>{const status=ctx.read(`discount-${bundle.id}`,null);return status?.status==='published'?`已发布 · ${status.kind==='function'?'Plus 整组优惠':'原生买 X 享 Y'}`:status?.status==='inactive'?'结账优惠已停用':'结账优惠尚未发布';})())}</small></td><td>${button(`toggle-bundle:${bundle.id}`, bundle.enabled !== false ? '暂停配置' : '启用配置')}${button(`publish-bundle:${bundle.id}`, bundle.enabled !== false ? '发布结账优惠' : '同步停用优惠')}</td></tr>`).join('') : empty('尚未创建商品组合。', 5))}</section><div class="info-note mt-16">保存后点击“发布结账优惠”。整组折扣适用于 Shopify Plus；普通套餐可选择买 X 享 Y。发布后请用完整组合、缺件和额外商品购物车验证。</div>`;
}

function documents(ctx) {
  const documents = list(data(ctx).documents);
  return heading('发票与单据', '查看已生成的单据；创建报价、下载 PDF 或创建邮件发送任务。', button('new-quote', '新建报价单', false, 'button-primary')) + notice(ctx)
    + `<section class="card">${table(['编号', '类型', '客户', '金额', '开具时间', '操作'], documents.length ? documents.map((document) => {
      const snapshot = document.snapshot || document;
      return `<tr><td>${escape(snapshot.number || document.id)}</td><td>${escape({ invoice: '发票', quote: '报价', credit: '贷项通知单' }[snapshot.type] || snapshot.type)}</td><td>${escape(snapshot.customer?.name || snapshot.customer?.email || '—')}</td><td>${money(ctx, snapshot.totalMinor ?? snapshot.totals?.totalMinor, snapshot.currency)}</td><td>${escape(when(snapshot.issuedAt))}</td><td><div class="row-actions">${button(`pdf:${document.id}`, '下载 PDF')}${button(`send-document:${document.id}`, '发送邮件')}</div></td></tr>`;
    }).join('') : empty('尚无真实单据。可以创建报价单，或连接店铺后接收付款订单事件。', 6))}</section>`;
}

function restock(ctx) {
  const subscriptions = list(data(ctx).subscriptions);
  const jobs = list(data(ctx).jobs);
  return heading('补货提醒', '管理实际变体订阅；库存由 Shopify 同步，发送结果由任务状态确认。', button('new-subscription', '登记到货提醒', !products(ctx).length, 'button-primary') + button('refresh', '刷新状态') + button('toggle-restock', ctx.read(stateKey(ctx,'commerce-restock'),{automatic:false}).automatic === true ? '暂停自动通知' : '开启自动通知')) + notice(ctx)
    + `<section class="card mb-16"><div class="card-head"><h2>补货订阅</h2></div>${table(['邮箱', '商品变体', '市场', '状态'], subscriptions.length ? subscriptions.map((subscription) => `<tr><td>${escape(subscription.email)}</td><td>${escape(subscription.variant_id || subscription.variantId)}</td><td>${escape(subscription.market || '—')}</td><td>${subscription.active === false ? '已停用' : '有效订阅'}</td></tr>`).join('') : empty('暂无到货提醒订阅。', 4))}</section>`
    + `<section class="card"><div class="card-head"><h2>后台任务与通知状态</h2></div>${table(['任务', '状态', '最近处理', '操作'], jobs.length ? jobs.map((job) => `<tr><td>${escape(job.type || job.kind || job.id)}</td><td>${escape(job.status || '等待处理')}</td><td>${escape(when(job.updated_at || job.updatedAt || job.created_at))}</td><td>${job.status === 'failed' ? button(`retry:${job.id}`, '重试任务') : '—'}</td></tr>`).join('') : empty('暂无通知任务；登记订阅不会立即伪称已经发信。', 4))}</section>`;
}

function settings(ctx) {
  const connection = data(ctx).connection || {};
  const store = ctx.runtime.currentStore || {};
  const documentConfig = ctx.read(stateKey(ctx, 'commerce-documents'), { settings: {} });
  const settings = documentConfig.settings || {};
  const seller = settings.seller || {};
  const sender = ctx.read(stateKey(ctx, 'sender'), { name: '', sender: '' });
  return heading('设置与集成', '管理真实店铺授权、同步及开票信息。') + notice(ctx)
    + `<section class="card mb-16"><div class="settings-section"><h3>${escape(store.name || '当前店铺')}</h3><p>${escape(store.domain || '尚未配置店铺域名')} · ${escape(store.currency || '')}</p><div class="settings-row"><div><strong>Shopify 授权</strong><small>${connection.connected ? '已连接' : '未连接'} · 最近同步：${escape(when(connection.lastSync))}</small></div><div class="row-actions">${button('connect', connection.connected ? '重新授权' : '连接 Shopify', !store.domain)}${button('sync', '同步商品', !connection.connected)}</div></div></div></section>`
    + `<form id="production-settings" class="card"><div class="settings-section"><h3>开票主体与发件人</h3><p>先保存真实主体信息；发件域名和邮件服务仍须在部署环境配置并验证。</p><div class="form-grid">${field('entity', '公司开票主体', seller.name || '', 'required')}${field('vat', 'VAT 注册号', seller.vatNumber || '')}${field('countryCode', '开票主体国家代码', seller.countryCode || store.country || '', 'required minlength="2" maxlength="2"')}${field('sender', '主体/发件邮箱', seller.email || sender.sender || '', 'type="email"')}<label class="field">开票主体地址（每行一段）<textarea class="input" name="address" rows="3" required>${escape(list(seller.address).join('\n'))}</textarea></label><label class="field">单据语言<select class="select" name="language">${[['en','English'],['de','Deutsch'],['fr','Français']].map(([value,label])=>`<option value="${value}" ${settings.language===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="inline-check"><input type="checkbox" name="automaticInvoices" ${settings.automaticInvoices?'checked':''}> 付款后自动生成发票</label><label class="inline-check"><input type="checkbox" name="automaticCreditNotes" ${settings.automaticCreditNotes?'checked':''}> 退款后自动生成贷项通知单</label><label class="inline-check"><input type="checkbox" name="automaticEmail" ${settings.automaticEmail?'checked':''}> 自动创建发票邮件任务</label></div></div><div class="settings-save"><button class="button button-primary" type="submit">保存设置到云端</button></div></form><section class="card mt-16"><div class="settings-section"><h3>其他集成</h3><p>Google Drive、Dropbox、Mailchimp、评价组件和外部收款尚未接入；不会用界面开关伪称授权成功。</p><button class="button" disabled>等待配置集成</button></div></section>`;
}

export function renderProductionPage(ctx, page) {
  if (!ctx.store) return heading('尚未配置店铺', '请在服务端配置允许管理的 Shopify 店铺后重新加载。');
  return ({ overview: () => overview(ctx), analytics: () => overview(ctx, true), shipping: () => shipping(ctx), bundles: () => bundles(ctx), documents: () => documents(ctx), restock: () => restock(ctx), settings: () => settings(ctx), storefront: () => heading('店铺前台组件', '前台组件必须安装到真实 Shopify 主题后验收。') + notice(ctx) + '<section class="card"><div class="empty-state">请先同步商品并完成主题扩展安装；当前不会显示虚构商品或模拟结账。</div></section>' }[page] || (() => overview(ctx)))();
}

async function refresh(ctx) { await ctx.runtime.hydrate(ctx.store); ctx.navigate(location.hash.slice(1) || 'overview'); }
async function saveState(ctx, key, value) { ctx.persist(key, value); await ctx.flush(); }
function actionError(ctx, error) { if (!error.notified) ctx.toast(error.message || '操作失败，请重试'); }
function modalForm(ctx, title, html, onSave) { ctx.openModal(title, `<form id="modal-form">${html}</form>`, async (form) => { if (!form.reportValidity()) return false; await onSave(new FormData(form), form); }); }

function ruleEditor(ctx, previous) {
  const original = previous || {};
  modalForm(ctx, previous ? '编辑配送规则' : '新建配送规则', field('name', '规则名称', original.name || '', 'required maxlength="100"')
    + `<div class="form-grid">${field('countries', '目的地国家代码（用逗号分隔）', list(original.countries).join(',') || ctx.runtime.currentStore?.country || 'GB', 'required')}
    <label class="field">规则类型<select class="select" name="kind">${[['weight', '重量区间固定价'], ['flat', '固定运费'], ['threshold', '满额免运费'], ['remote', '偏远附加费'], ['blocked', '禁运地区']].map(([value, label]) => `<option value="${value}" ${original.kind === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    ${field('min', '重量下限 / kg（不含）', original.min || 0, 'type="number" min="0" step="0.001" required')}${field('max', '重量上限 / kg（含）', original.max ?? 30, 'type="number" min="0.001" step="0.001" required')}${field('price', '运费 / 店铺币种', original.price ?? Number(original.priceMinor || 0) / 100, 'type="number" min="0" step="0.01" required')}${field('threshold', '满额门槛（仅满额规则）', original.threshold ?? Number(original.thresholdMinor || 0) / 100, 'type="number" min="0" step="0.01"')}</div>`
    + field('postcodes', '匹配邮编（逗号分隔，可用 E1 * / IV*；留空覆盖国家）', list(original.postcodes).join(', '))
    + field('excludePostcodes', '排除邮编（逗号分隔）', list(original.excludePostcodes).join(', '))
    + '<p class="modal-description">满额规则只有在基础重量费率覆盖购物车时才生效。英国偏远地区需配置附加费或独立费率。</p>', async (form) => {
      const kind = String(form.get('kind'));
      const parsePatterns = (name) => String(form.get(name) || '').split(',').map((value) => value.trim()).filter(Boolean);
      const rule = { ...original, id: original.id || `rule-${crypto.randomUUID()}`, name: String(form.get('name')).trim(), countries: String(form.get('countries')).toUpperCase().split(',').map((value) => value.trim()).filter(Boolean), kind, area: kind === 'remote' ? 'remote' : ctx.runtime.currentStore?.country === 'GB' ? 'main' : 'eu', price: kind === 'threshold' || kind === 'blocked' ? 0 : Number(form.get('price')), enabled: original.enabled !== false, postcodes: parsePatterns('postcodes'), excludePostcodes: parsePatterns('excludePostcodes') };
      delete rule.priceMinor; delete rule.thresholdMinor;
      if (['weight', 'flat'].includes(kind)) { rule.min = Number(form.get('min')); rule.max = Number(form.get('max')); }
      else { delete rule.min; delete rule.max; }
      if (kind === 'threshold') rule.threshold = Number(form.get('threshold'));
      const rules = list(ctx.read(stateKey(ctx, 'shipping-rules'), []));
      await saveState(ctx, stateKey(ctx, 'shipping-rules'), previous ? rules.map((entry) => entry.id === rule.id ? rule : entry) : [...rules, rule]);
      ctx.navigate('shipping'); ctx.toast('配送规则已保存到云端');
    });
}

function newBundle(ctx) {
  const catalog = products(ctx).filter((product) => product.variantId);
  if (catalog.length < 2) return ctx.toast('请先同步至少两个可用的真实商品变体');
  modalForm(ctx, '创建实际 SKU 组合', field('name', '组合名称', '', 'required maxlength="100"')
    + `<label class="field">组合 SKU（至少选择两种）<select class="select" name="variants" multiple size="6" required>${catalog.map((product) => `<option value="${escape(product.variantId)}">${escape(product.name || product.title)} · ${escape(product.sku || product.variantId)}</option>`).join('')}</select></label>`
    + `<div class="form-grid"><label class="field">优惠方式<select class="select" name="discountType"><option value="percentage">整组折扣（精确生效需 Functions/Plus）</option><option value="fixed">整组固定金额减免（Plus Functions）</option><option value="buy_x_get_y">购买首个 SKU，第二个 SKU 享折扣（仅两种）</option></select></label>${field('discount', '折扣百分比', 10, 'type="number" min="0" max="100" step="0.01" required')}${field('fixedAmount', '每组固定减免额（仅固定金额）', 0, 'type="number" min="0" step="0.01"')}</div><p class="modal-description">此处保存组合配置；结账优惠须通过后端真实发布并验证。</p>`, async (form) => {
      const selected = [...new Set(form.getAll('variants'))].map((variant) => catalog.find((product) => product.variantId === variant)).filter(Boolean);
      if (selected.length < 2) throw new Error('请选择至少两种不同的 SKU');
      const type = String(form.get('discountType'));
      if (type === 'buy_x_get_y' && selected.length !== 2) throw new Error('原生买 X 送 Y 配置只能选择两个 SKU');
      const members = selected.map((product) => ({ variantId: product.variantId, productId: String(product.productId || product.id), quantity: 1 }));
      const definition = { id: `bundle-${crypto.randomUUID()}`, name: String(form.get('name')).trim(), type: 'manual', members, products: [...new Set(members.map((member) => member.productId))], discountType: type, discount: Number(form.get('discount')), enabled: true };
      if (type !== 'buy_x_get_y') definition.currency = ctx.runtime.currentStore?.currency;
      if (type === 'fixed') definition.discountAmountMinor = Math.round(Number(form.get('fixedAmount')) * 100);
      if (type === 'buy_x_get_y') { definition.buy = members[0]; definition.get = members[1]; }
      await saveState(ctx, stateKey(ctx, 'commerce-bundles'), [...list(ctx.read(stateKey(ctx, 'commerce-bundles'), [])), definition]);
      ctx.navigate('bundles'); ctx.toast('SKU 组合配置已保存到云端');
    });
}

export function bindProductionPage(ctx, page) {
  document.querySelectorAll('[data-production]').forEach((element) => element.addEventListener('click', async () => {
    const [action, ...parts] = element.dataset.production.split(':'); const identity = parts.join(':');
    try {
      if (action === 'navigate') return ctx.navigate(identity);
      if (action === 'refresh') return await refresh(ctx);
      if (action === 'new-rule' || action === 'edit-rule') return ruleEditor(ctx, action === 'edit-rule' ? list(ctx.read(stateKey(ctx, 'shipping-rules'), [])).find((rule) => rule.id === identity) : null);
      if (action === 'toggle-rule' || action === 'toggle-bundle') {
        const key = stateKey(ctx, action === 'toggle-rule' ? 'shipping-rules' : 'commerce-bundles');
        await saveState(ctx, key, list(ctx.read(key, [])).map((entry) => entry.id === identity ? { ...entry, enabled: entry.enabled === false } : entry));
        ctx.navigate(page); return ctx.toast('配置已保存到云端');
      }
      if (action === 'test-shipping') return modalForm(ctx, '真实运费接口试算', `<div class="form-grid">${field('country', '国家代码', ctx.runtime.currentStore?.country || 'GB', 'required')}${field('postcode', '目的地邮编', '', 'required')}${field('weight', '总重量 / kg', 15, 'type="number" min="0.001" step="0.001" required')}${field('amount', '商品总额 / 店铺币种', 299, 'type="number" min="0" step="0.01" required')}</div><div id="live-shipping-result" class="info-note">试算将调用服务端规则引擎。</div>`, async (form) => {
        const result = await ctx.api(`${apiRoot(ctx)}/shipping/test`, { method: 'POST', body: { destination: { country: String(form.get('country')).toUpperCase(), postal_code: String(form.get('postcode')) }, items: [{ grams: Math.round(Number(form.get('weight')) * 1000), quantity: 1, price: Math.round(Number(form.get('amount')) * 100) }], currency: ctx.runtime.currentStore?.currency || 'GBP' } });
        ctx.openModal('运费试算结果', list(result.rates).length ? list(result.rates).map((rate) => `<p>${escape(rate.service_name)}：<strong>${money(ctx, Number(rate.total_price), rate.currency)}</strong></p>`).join('') : '<p>没有可用运费。请检查邮编、重量区间、禁运和偏远规则。</p>');
      });
      if (action === 'register-carrier') { await ctx.api(`${apiRoot(ctx)}/carrier`, { method: 'POST', body: {} }); await refresh(ctx); return ctx.toast('CarrierService 注册请求已成功完成，请在 Shopify 配送区域核验'); }
      if (action === 'new-bundle') return newBundle(ctx);
      if (action === 'toggle-restock') { const key=stateKey(ctx,'commerce-restock'); const automatic=ctx.read(key,{automatic:false}).automatic!==true; await saveState(ctx,key,{automatic}); ctx.navigate('restock'); return ctx.toast(automatic?'自动补货通知配置已开启；后台将核验库存与邮件服务':'自动补货通知已暂停'); }
      if (action === 'publish-bundle') { await ctx.api(`${apiRoot(ctx)}/bundles/${encodeURIComponent(identity)}/discount`, { method: 'POST', body: {} }); await refresh(ctx); return ctx.toast('结账优惠发布/停用请求已完成，请在 Shopify 后台核验'); }
      if (action === 'new-quote') return modalForm(ctx, '创建真实报价单', `<div class="form-grid">${field('customer', '客户名称', '', 'required')}${field('email', '客户邮箱', '', 'type="email" required')}${field('title', '商品或服务名称', '', 'required')}${field('quantity', '数量', 1, 'type="number" min="1" step="1" required')}${field('price', '未税单价 / 店铺币种', '', 'type="number" min="0" step="0.01" required')}${field('vat', 'VAT 税率 / %', 0, 'type="number" min="0" max="100" step="0.01" required')}</div><p class="modal-description">将创建真实报价文档；税率由你确认，系统不会据此申报税款。</p>`, async (form) => {
        await ctx.api(`${apiRoot(ctx)}/quotes`, { method: 'POST', body: { customer: { name: String(form.get('customer')), email: String(form.get('email')) }, currency: ctx.runtime.currentStore?.currency || 'GBP', lineItems: [{ title: String(form.get('title')), quantity: Number(form.get('quantity')), unitPriceMinor: Math.round(Number(form.get('price')) * 100), taxRate: Number(form.get('vat')) / 100 }] } });
        await refresh(ctx); ctx.toast('报价单已创建，可以下载 PDF');
      });
      if (action === 'pdf') {
        const blob = await ctx.api(`${apiRoot(ctx)}/documents/${encodeURIComponent(identity)}.pdf`, { responseType: 'blob' });
        const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `document-${identity}.pdf`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); return ctx.toast('PDF 已下载');
      }
      if (action === 'send-document') {
        const document = list(data(ctx).documents).find((entry) => entry.id === identity);
        return modalForm(ctx, '创建单据邮件任务', field('to', '收件人邮箱', document?.snapshot?.customer?.email || '', 'type="email" required') + '<p class="modal-description">确认后交给后台邮件任务处理；任务创建不代表已送达。</p>', async (form) => { const result = await ctx.api(`${apiRoot(ctx)}/documents/${encodeURIComponent(identity)}/send`, { method: 'POST', body: { to: String(form.get('to')) } }); await refresh(ctx); ctx.toast(`邮件任务已创建：${result.jobId}`); });
      }
      if (action === 'new-subscription') return modalForm(ctx, '登记到货提醒', field('email', '订阅者邮箱', '', 'type="email" required') + `<label class="field">商品变体<select class="select" name="variantId" required>${products(ctx).filter((product) => product.variantId).map((product) => `<option value="${escape(product.variantId)}">${escape(product.name || product.title)} · ${escape(product.sku || '')}</option>`).join('')}</select></label><div class="form-grid">${field('market', '市场 / 国家代码', ctx.runtime.currentStore?.country || 'GB', 'required')}<label class="field">通知语言<select class="select" name="language"><option value="en">English</option><option value="de">Deutsch</option><option value="fr">Français</option></select></label></div><label class="inline-check"><input type="checkbox" name="marketingConsent">已另行取得营销邮件同意（可选）</label>`, async (form) => { await ctx.api(`${apiRoot(ctx)}/subscriptions`, { method: 'POST', body: { email: String(form.get('email')), variantId: String(form.get('variantId')), market: String(form.get('market')), language: String(form.get('language')), marketingConsent: form.has('marketingConsent') } }); await refresh(ctx); ctx.toast('到货提醒订阅已登记'); });
      if (action === 'retry') { const result = await ctx.api(`${apiRoot(ctx)}/jobs/${encodeURIComponent(identity)}/retry`, { method: 'POST', body: {} }); await refresh(ctx); return ctx.toast(`重试任务已提交${result.jobId ? `：${result.jobId}` : ''}`); }
      if (action === 'sync') { const result = await ctx.api(`${apiRoot(ctx)}/sync`, { method: 'POST', body: {} }); await refresh(ctx); return ctx.toast(`同步任务已创建：${result.jobId}，请刷新查看状态`); }
      if (action === 'connect') {
        const result = await ctx.api(`${apiRoot(ctx)}/connect`, { method: 'POST', body: {} });
        const url = new URL(result.url);
        if (url.origin !== location.origin || url.pathname !== '/auth/start') throw new Error('服务器返回了无效的 Shopify 授权启动地址');
        window.open(url.href, '_top');
      }
    } catch (error) { actionError(ctx, error); }
  }));
  document.querySelector('#production-settings')?.addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
    const fields = new FormData(form); const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try {
      const key = stateKey(ctx, 'commerce-documents');
      const current = ctx.read(key, { settings: {}, entries: [] });
      const settings = { seller: { name: String(fields.get('entity')).trim(), address: String(fields.get('address')).split('\n').map((line) => line.trim()).filter(Boolean), countryCode: String(fields.get('countryCode')).trim().toUpperCase(), vatNumber: String(fields.get('vat')).trim(), email: String(fields.get('sender')).trim() }, language: String(fields.get('language')), automaticInvoices: fields.has('automaticInvoices'), automaticCreditNotes: fields.has('automaticCreditNotes'), automaticEmail: fields.has('automaticEmail') };
      ctx.persist(key, { settings });
      await ctx.flush(); ctx.toast('店铺设置已保存到云端');
    } catch (error) { actionError(ctx, error); } finally { submit.disabled = false; }
  });
}
