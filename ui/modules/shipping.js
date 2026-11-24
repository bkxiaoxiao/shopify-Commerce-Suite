const moduleState = new Map();

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

function defaultRules(store) {
  return [
    { id: 'main-standard', name: '英国本土 · 标准配送', area: 'main', countries: ['GB'], postcode: '英国本土邮编', condition: '重量 0–20 kg', kind: 'weight', min: 0, max: 20, price: 9.9, enabled: true, color: 'blue' },
    { id: 'main-heavy', name: '英国本土 · 大件配送', area: 'main', countries: ['GB'], postcode: '英国本土邮编', condition: '重量 20–100 kg', kind: 'weight', min: 20, max: 100, price: 29, enabled: true, color: 'purple' },
    { id: 'main-pallet', name: '英国本土 · 托盘配送', area: 'main', countries: ['GB'], postcode: '英国本土邮编', condition: '重量 100 kg 以上', kind: 'weight', min: 100, max: 99999, price: 59, enabled: true, color: 'purple' },
    { id: 'main-free', name: '英国本土 · 满额免运费', area: 'main', countries: ['GB'], postcode: '不含偏远地区', condition: '订单金额 ≥ 1,200', kind: 'threshold', threshold: 1200, price: 0, enabled: true, color: 'green' },
    { id: 'remote-highlands', name: '高地与岛屿 · 偏远附加费', area: 'remote', countries: ['GB'], postcode: 'IV · HS · KW · ZE', condition: '标准运费 + 偏远附加费', kind: 'remote', price: 24.9, enabled: true, color: 'orange' },
    { id: 'eu-germany', name: '德国 · 标准配送', area: 'eu', countries: ['DE'], postcode: '德国全境', condition: '重量 ≤ 30 kg', kind: 'eu', min: 0, max: 30, price: store === 'eu' ? 7.9 : 14.9, enabled: true, color: 'blue' },
    { id: 'eu-france', name: '法国与荷兰 · 标准配送', area: 'eu', countries: ['FR', 'NL'], postcode: '法国 · 荷兰', condition: '重量 ≤ 30 kg', kind: 'eu', min: 0, max: 30, price: store === 'eu' ? 9.9 : 17.9, enabled: true, color: 'blue' },
    { id: 'eu-other', name: '其他欧盟地区 · 大件配送', area: 'eu', countries: ['DE', 'FR', 'NL', 'IT', 'ES'], postcode: '已开通的欧盟国家', condition: '重量 30 kg 以上', kind: 'eu', min: 30, max: 99999, price: store === 'eu' ? 39 : 44, enabled: false, color: 'purple' },
  ];
}

function getState(ctx) {
  const key = ctx.store || 'uk';
  if (!moduleState.has(key)) moduleState.set(key, { tab: 'all', query: '', status: 'all' });
  return moduleState.get(key);
}

function getRules(ctx) {
  const value = ctx.read(`shipping-rules-${ctx.store}`, null);
  return Array.isArray(value) ? value : defaultRules(ctx.store);
}

const areaNames = { main: '英国本土', remote: '偏远地区', eu: '欧盟' };

function ruleRows(ctx, rules, state) {
  const filtered = rules.filter((rule) => (state.tab === 'all' || rule.area === state.tab)
    && (state.status === 'all' || rule.enabled === (state.status === 'active'))
    && `${rule.name} ${rule.postcode} ${rule.condition}`.toLowerCase().includes(state.query.toLowerCase()));
  if (!filtered.length) return '<tr><td colspan="6"><div class="empty-state shipping-empty">没有找到匹配的规则<span>试试其他关键词或配送区域</span></div></td></tr>';
  return filtered.map((rule) => `<tr>
    <td><div class="shipping-rule-name"><span class="shipping-rule-icon shipping-icon-${escapeHtml(rule.color || 'blue')}">${ctx.icon(rule.kind === 'remote' ? 'mapPin' : 'truck', 17)}</span><div><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(rule.id.startsWith('custom-') ? '自定义配送规则' : '已发布 · v1.2')}</small></div></div></td>
    <td><span class="shipping-area-label">${areaNames[rule.area] || '自定义'}</span><small class="shipping-cell-meta">${escapeHtml(rule.postcode)}</small></td>
    <td><span class="shipping-condition">${escapeHtml(rule.condition)}</span></td>
    <td><strong class="shipping-rate">${rule.kind === 'remote' ? '+ ' : ''}${ctx.money(rule.price)}</strong></td>
    <td><button class="shipping-switch ${rule.enabled ? 'is-on' : ''}" type="button" role="switch" aria-checked="${rule.enabled}" aria-label="${escapeHtml(rule.name)}${rule.enabled ? '已启用，点击暂停' : '已暂停，点击启用'}" data-ship-toggle="${escapeHtml(rule.id)}"><span></span></button><span class="shipping-status-label">${rule.enabled ? '已启用' : '已暂停'}</span></td>
    <td><button class="shipping-more" type="button" data-ship-copy="${escapeHtml(rule.id)}" aria-label="复制${escapeHtml(rule.name)}" title="复制规则">${ctx.icon('copy', 16)}</button></td>
  </tr>`).join('');
}

export function renderShipping(ctx) {
  const state = getState(ctx);
  const rules = getRules(ctx);
  return `<style>
  .shipping-page{display:grid;gap:24px}.shipping-heading{display:flex;align-items:center;justify-content:space-between;gap:24px}.shipping-heading h1{font-size:27px;letter-spacing:-.8px;margin:0 0 8px}.shipping-heading p{margin:0;color:var(--muted,#758078);font-size:14px}.shipping-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.shipping-stat{padding:21px 23px;display:flex;align-items:center;justify-content:space-between}.shipping-stat-label{font-size:13px;color:var(--muted,#758078)}.shipping-stat-value{font-size:29px;letter-spacing:-.8px;line-height:1.2;margin-top:8px;font-weight:650}.shipping-stat-note{font-size:12px;color:#8b948f;margin-top:7px}.shipping-stat-note em{font-style:normal;color:#218566}.shipping-stat-symbol{height:43px;width:43px;border-radius:13px;background:#f0f6f3;color:#3a8b6c;display:flex;align-items:center;justify-content:center}.shipping-main-grid{display:grid;grid-template-columns:minmax(0,1fr) 326px;gap:22px;align-items:start}.shipping-rules-card{overflow:hidden}.shipping-rules-top{padding:22px 22px 0}.shipping-rules-topline{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:19px}.shipping-rules-topline h2,.shipping-simulator h2{font-size:16px;margin:0;font-weight:650}.shipping-rules-count{font-size:12px;color:#8b948f;font-weight:400;margin-left:8px}.shipping-tabs{display:flex;gap:23px;border-bottom:1px solid #edf0ee;overflow:auto}.shipping-tab{padding:0 0 12px;border:0;border-bottom:2px solid transparent;white-space:nowrap;background:transparent;color:#7c8781;font-size:13px;cursor:pointer;font-weight:500}.shipping-tab.active{border-bottom-color:#25876b;color:#1e735b}.shipping-rule-filters{display:flex;gap:10px;padding:17px 22px}.shipping-search{flex:1;min-width:100px;position:relative}.shipping-search>svg{position:absolute;left:12px;top:11px;color:#929b95}.shipping-search input{padding-left:37px!important;width:100%;font-size:13px}.shipping-status-select{max-width:116px;font-size:13px!important}.shipping-rule-table{width:100%;border-collapse:collapse;font-size:12px}.shipping-rule-table th{text-align:left;color:#838b86;background:#fafbfa;font-size:11px;font-weight:500;padding:12px 14px;white-space:nowrap;border-top:1px solid #edf0ee;border-bottom:1px solid #edf0ee}.shipping-rule-table th:first-child,.shipping-rule-table td:first-child{padding-left:22px}.shipping-rule-table td{padding:17px 14px;border-bottom:1px solid #f0f2f0;vertical-align:middle}.shipping-rule-table tr:last-child td{border-bottom:0}.shipping-rule-table tbody tr:hover{background:#fcfdfc}.shipping-rule-name{display:flex;gap:10px;align-items:center;min-width:177px}.shipping-rule-name strong{font-size:12px;font-weight:550;display:block;white-space:nowrap}.shipping-rule-name small{font-size:10px;display:block;color:#939c95;margin-top:5px}.shipping-rule-icon{display:flex;align-items:center;justify-content:center;height:34px;min-width:34px;border-radius:9px}.shipping-icon-blue{background:#eef4fb;color:#6a8fb3}.shipping-icon-purple{background:#f4effa;color:#9b7bb6}.shipping-icon-orange{background:#fff3e9;color:#bf9569}.shipping-icon-green{background:#eaf5ee;color:#599b74}.shipping-cell-meta{display:block;font-size:10px;color:#949c96;margin-top:5px;max-width:120px}.shipping-area-label{white-space:nowrap}.shipping-condition{font-size:11px;color:#7a847e}.shipping-rate{font-variant-numeric:tabular-nums;font-size:13px;font-weight:550;white-space:nowrap}.shipping-switch{position:relative;display:inline-flex;align-items:center;border:none;background:#d9dedb;height:18px;width:31px;padding:2px;border-radius:12px;cursor:pointer;vertical-align:middle}.shipping-switch span{height:14px;width:14px;background:white;border-radius:50%;box-shadow:0 1px 3px #0001;transform:translateX(0);transition:transform .18s}.shipping-switch.is-on{background:#35886c}.shipping-switch.is-on span{transform:translateX(13px)}.shipping-status-label{font-size:10px;color:#8a948d;margin-left:5px;white-space:nowrap}.shipping-more{border:0;background:transparent;color:#9aa29c;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:5px;border-radius:6px}.shipping-more:hover{background:#edf4ef;color:#25876b}.shipping-table-footer{display:flex;align-items:center;justify-content:space-between;border-top:1px solid #edf0ee;padding:16px 22px;font-size:11px;color:#8d978f}.shipping-table-footer strong{color:#5d7566;font-weight:500}.shipping-side-stack{display:grid;gap:17px}.shipping-simulator{padding:23px}.shipping-simulator-title{display:flex;gap:9px;align-items:center;color:#2e765c}.shipping-simulator-title h2{color:var(--text,#29332d)}.shipping-simulator>p{font-size:12px;line-height:1.7;color:#8b958e;margin:9px 0 21px}.shipping-simulator label{font-size:12px;color:#5e6e63;display:block;margin-bottom:7px}.shipping-simulator .field{margin-bottom:15px}.shipping-simulator input,.shipping-simulator select{font-size:13px;width:100%;box-sizing:border-box}.shipping-simulator .form-grid{gap:12px}.shipping-simulator .button-primary{width:100%;justify-content:center;margin-top:3px}.shipping-result{margin-top:21px;padding-top:19px;border-top:1px solid #eaf0eb}.shipping-result-head{display:flex;align-items:center;justify-content:space-between;font-size:12px;margin-bottom:16px}.shipping-result-head>span{display:flex;gap:5px;align-items:center;color:#3b8968}.shipping-result-line{display:flex;justify-content:space-between;font-size:12px;color:#8a958d;margin-top:11px;gap:10px}.shipping-result-line b{color:#53665a;font-weight:500}.shipping-result-total{display:flex;justify-content:space-between;align-items:center;border-top:1px dashed #dce8df;margin-top:17px;padding-top:17px;font-size:12px;color:#65766a}.shipping-result-total strong{font-size:27px;font-weight:650;color:#2d7358;letter-spacing:-.8px}.shipping-result-note{font-size:10px;color:#92a098;margin:11px 0 0;line-height:1.7}.shipping-result-error{font-size:12px;line-height:1.7;color:#a27148;padding:15px;background:#fff8ef;border-radius:9px}.shipping-note{padding:19px 21px;display:flex;gap:10px;background:#f4f8f5!important;border-color:#e4ece6!important}.shipping-note>svg{min-width:17px;color:#73917e;margin-top:2px}.shipping-note h3{margin:0 0 6px;font-size:12px;font-weight:600;color:#587360}.shipping-note p{font-size:11px;line-height:1.8;margin:0;color:#8a9c8f}.shipping-note button{background:none;border:0;padding:0;color:#43815d;font-size:11px;cursor:pointer;margin-top:9px}.shipping-empty{padding:45px 10px;text-align:center;color:#6f7b73}.shipping-empty span{display:block;margin-top:7px;font-size:12px;color:#929c95}.shipping-form-note{font-size:12px;line-height:1.7;color:#819087;margin-bottom:18px}.shipping-inline-error{color:#ac684b;font-size:12px;margin-top:9px}.shipping-stats .card{box-shadow:none}@media(min-width:1600px){.shipping-main-grid{grid-template-columns:minmax(0,1fr) 350px}.shipping-rule-table{font-size:13px}.shipping-rule-name strong{font-size:13px}.shipping-condition{font-size:12px}}@media(max-width:1250px){.shipping-main-grid{grid-template-columns:minmax(0,1fr)}.shipping-side-stack{grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start}.shipping-stat{padding:18px}.shipping-stat-value{font-size:25px}.shipping-rule-table{min-width:730px}}@media(max-width:700px){.shipping-heading{align-items:flex-start}.shipping-heading h1{font-size:23px}.shipping-heading p{font-size:12px;max-width:210px;line-height:1.7}.shipping-heading>.button{font-size:12px;white-space:nowrap}.shipping-stats{gap:10px}.shipping-stat{padding:15px 13px}.shipping-stat-value{font-size:22px}.shipping-stat-symbol{display:none}.shipping-stat-label{font-size:11px}.shipping-stat-note{font-size:10px}.shipping-side-stack{grid-template-columns:1fr}.shipping-tabs{gap:20px}.shipping-rules-top{padding-left:16px;padding-right:16px}.shipping-rule-filters{padding-left:16px;padding-right:16px}}
  </style>
  <div class="shipping-page" id="shipping-page">
    <div class="shipping-heading"><div><h1>运费管理</h1><p>让每一个邮编，都有恰到好处的配送方案。</p></div><button class="button button-primary" id="ship-create">${ctx.icon('plus', 16)} 新建配送规则</button></div>
    <div class="shipping-stats">
      <div class="card shipping-stat"><div><div class="shipping-stat-label">已启用的配送规则</div><div class="shipping-stat-value" id="ship-active-count">${rules.filter((rule) => rule.enabled).length}<span style="font-size:13px;color:#96a097;font-weight:400;margin-left:7px">/ ${rules.length}</span></div><div class="shipping-stat-note">覆盖英国与 ${ctx.store === 'eu' ? '5' : '3'} 个欧盟市场</div></div><span class="shipping-stat-symbol">${ctx.icon('truck', 21)}</span></div>
      <div class="card shipping-stat"><div><div class="shipping-stat-label">过去 30 天报价</div><div class="shipping-stat-value">${ctx.store === 'eu' ? '8,426' : '12,846'}</div><div class="shipping-stat-note"><em>+ 12.8%</em> 较上一个周期</div></div><span class="shipping-stat-symbol">${ctx.icon('globe', 21)}</span></div>
      <div class="card shipping-stat"><div><div class="shipping-stat-label">运费规则匹配率</div><div class="shipping-stat-value">99.6<span style="font-size:18px">%</span></div><div class="shipping-stat-note">有 1 个区域需要检查</div></div><span class="shipping-stat-symbol">${ctx.icon('check', 21)}</span></div>
    </div>
    <div class="shipping-main-grid">
      <div class="card shipping-rules-card">
        <div class="shipping-rules-top"><div class="shipping-rules-topline"><h2>配送规则<span class="shipping-rules-count" id="ship-rule-count">${rules.length} 条规则</span></h2><span class="badge badge-success">已发布 v1.2</span></div>
          <div class="shipping-tabs" role="tablist" aria-label="配送区域">${[['all', '全部区域'], ['main', '英国本土'], ['remote', '偏远地区'], ['eu', '欧盟']].map(([key, label]) => `<button type="button" class="shipping-tab ${state.tab === key ? 'active' : ''}" role="tab" aria-selected="${state.tab === key}" data-ship-tab="${key}">${label}</button>`).join('')}</div>
        </div>
        <div class="shipping-rule-filters"><div class="shipping-search">${ctx.icon('search', 16)}<input class="input" id="ship-search" value="${escapeHtml(state.query)}" placeholder="搜索规则、地区或邮编" aria-label="搜索配送规则"></div><select class="select shipping-status-select" id="ship-status" aria-label="规则状态"><option value="all" ${state.status === 'all' ? 'selected' : ''}>全部状态</option><option value="active" ${state.status === 'active' ? 'selected' : ''}>已启用</option><option value="paused" ${state.status === 'paused' ? 'selected' : ''}>已暂停</option></select></div>
        <div class="table-wrap"><table class="shipping-rule-table"><thead><tr><th>规则名称</th><th>配送地区</th><th>触发条件</th><th>配送费用</th><th>状态</th><th></th></tr></thead><tbody id="ship-rows">${ruleRows(ctx, rules, state)}</tbody></table></div>
        <div class="shipping-table-footer"><span id="ship-visible-count">共 ${rules.length} 条配送规则</span><strong>规则按优先级自动匹配</strong></div>
      </div>
      <div class="shipping-side-stack">
        <div class="card shipping-simulator"><div class="shipping-simulator-title">${ctx.icon('play', 18)}<h2>运费模拟器</h2></div><p>用一个购物车，快速检查配送规则。</p>
          <form id="ship-sim-form"><div class="field"><label for="ship-country">目的地国家</label><select class="select" id="ship-country" name="country"><option value="GB" ${ctx.store !== 'eu' ? 'selected' : ''}>英国 United Kingdom</option><option value="DE" ${ctx.store === 'eu' ? 'selected' : ''}>德国 Germany</option><option value="FR">法国 France</option><option value="NL">荷兰 Netherlands</option><option value="IT">意大利 Italy</option><option value="ES">西班牙 Spain</option></select></div>
          <div class="field"><label for="ship-postcode">邮政编码</label><input class="input" id="ship-postcode" name="postcode" value="${ctx.store === 'eu' ? '10115' : 'SW1A 1AA'}" placeholder="例如 SW1A 1AA" required></div>
          <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr"><div class="field"><label for="ship-weight">总重量 / kg</label><input class="input" id="ship-weight" name="weight" type="number" min="0.01" step="0.01" value="15" required></div><div class="field"><label for="ship-amount">订单金额 / ${ctx.store === 'eu' ? 'EUR' : 'GBP'}</label><input class="input" id="ship-amount" name="amount" type="number" min="0" step="0.01" value="299" required></div></div>
          <button class="button button-primary" type="submit">${ctx.icon('play', 15)} 模拟配送费用</button></form>
          <div class="shipping-result" id="ship-result" aria-live="polite">${defaultResult(ctx)}</div>
        </div>
        <div class="card shipping-note">${ctx.icon('mapPin', 17)}<div><h3>一个配送区域需要留意</h3><p>意大利与西班牙的 30 kg 以上配送规则已暂停，部分大件商品可能无法获得报价。</p><button type="button" id="ship-view-gap">查看相关规则</button></div></div>
      </div>
    </div>
  </div>`;
}

function defaultResult(ctx) {
  const name = ctx.store === 'eu' ? '德国 · 标准配送' : '英国本土 · 标准配送';
  const price = ctx.store === 'eu' ? 7.9 : 9.9;
  return `<div class="shipping-result-head"><strong>模拟结果</strong><span>${ctx.icon('check', 13)} 匹配成功</span></div><div class="shipping-result-line"><span>命中规则</span><b>${name}</b></div><div class="shipping-result-line"><span>基础运费</span><b>${ctx.money(price)}</b></div><div class="shipping-result-line"><span>偏远附加费</span><b>${ctx.money(0)}</b></div><div class="shipping-result-total"><span>预计配送费用</span><strong>${ctx.money(price)}</strong></div><p class="shipping-result-note">根据当前已启用规则计算 · 仅用于配置预览</p>`;
}

export function bindShipping(ctx) {
  const root = document.getElementById('shipping-page');
  if (!root) return;
  const state = getState(ctx);
  let rules = getRules(ctx);
  const persist = () => ctx.persist(`shipping-rules-${ctx.store}`, rules);
  const refresh = () => {
    root.querySelector('#ship-rows').innerHTML = ruleRows(ctx, rules, state);
    root.querySelector('#ship-active-count').innerHTML = `${rules.filter((rule) => rule.enabled).length}<span style="font-size:13px;color:#96a097;font-weight:400;margin-left:7px">/ ${rules.length}</span>`;
    root.querySelector('#ship-rule-count').textContent = `${rules.length} 条规则`;
    const visible = root.querySelectorAll('#ship-rows [data-ship-toggle]').length;
    root.querySelector('#ship-visible-count').textContent = `显示 ${visible} / ${rules.length} 条配送规则`;
    root.querySelectorAll('[data-ship-tab]').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.shipTab === state.tab);
      tab.setAttribute('aria-selected', String(tab.dataset.shipTab === state.tab));
    });
  };

  root.querySelector('#ship-search').addEventListener('input', (event) => { state.query = event.target.value; refresh(); });
  root.querySelector('#ship-status').addEventListener('change', (event) => { state.status = event.target.value; refresh(); });
  root.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-ship-tab]');
    if (tab) { state.tab = tab.dataset.shipTab; refresh(); }
    const toggle = event.target.closest('[data-ship-toggle]');
    if (toggle) {
      const rule = rules.find((item) => item.id === toggle.dataset.shipToggle);
      if (rule) { rule.enabled = !rule.enabled; persist(); refresh(); ctx.toast(`${rule.name}${rule.enabled ? '已启用' : '已暂停'}`); }
    }
    const copy = event.target.closest('[data-ship-copy]');
    if (copy) {
      const rule = rules.find((item) => item.id === copy.dataset.shipCopy);
      if (rule) { rules.push({ ...rule, id: `custom-${Date.now()}`, name: `${rule.name} · 副本`, enabled: false }); persist(); refresh(); ctx.toast('已复制规则，副本默认暂停'); }
    }
  });
  root.querySelector('#ship-view-gap').addEventListener('click', () => {
    state.tab = 'eu'; state.query = ''; state.status = 'paused';
    root.querySelector('#ship-search').value = '';
    root.querySelector('#ship-status').value = 'paused';
    refresh();
    root.querySelector('.shipping-rules-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  root.querySelector('#ship-country').addEventListener('change', (event) => {
    root.querySelector('#ship-postcode').value = ({ GB: 'SW1A 1AA', DE: '10115', FR: '75001', NL: '1012 JS', IT: '00118', ES: '28001' })[event.target.value];
  });
  root.querySelector('#ship-sim-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const country = String(data.get('country'));
    const postcode = String(data.get('postcode')).replace(/\s/g, '').toUpperCase();
    const weight = Number(data.get('weight'));
    const amount = Number(data.get('amount'));
    const result = root.querySelector('#ship-result');
    if (!postcode || !Number.isFinite(weight) || weight <= 0 || !Number.isFinite(amount) || amount < 0) {
      result.innerHTML = '<div class="shipping-result-error">请填写有效邮编、大于 0 的重量和订单金额。</div>';
      return;
    }
    if ((country === 'GB' && !/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(postcode)) || (['DE', 'FR', 'IT', 'ES'].includes(country) && !/^\d{5}$/.test(postcode)) || (country === 'NL' && !/^\d{4}[A-Z]{2}$/.test(postcode))) {
      result.innerHTML = '<div class="shipping-result-error">邮编格式与所选国家不匹配，请检查后重试。</div>';
      return;
    }
    const active = rules.filter((rule) => rule.enabled);
    const isRemote = country === 'GB' && /^(IV|HS|KW|ZE|GY|JE)/.test(postcode);
    let rule;
    let surcharge = 0;
    if (country === 'GB') {
      if (!isRemote) rule = active.find((item) => item.kind === 'threshold' && item.area === 'main' && amount >= item.threshold);
      if (!rule) rule = active.find((item) => item.area === 'main' && ['weight', 'flat'].includes(item.kind) && weight > (item.min || 0) && weight <= item.max);
      if (isRemote) surcharge = active.find((item) => item.kind === 'remote')?.price ?? 0;
    } else {
      rule = active.find((item) => item.area === 'eu' && item.countries.includes(country) && weight > (item.min || 0) && weight <= item.max);
    }
    if (!rule) {
      result.innerHTML = '<div class="shipping-result-head"><strong>模拟结果</strong><span style="color:#af8054">未匹配到规则</span></div><div class="shipping-result-error">当前地区或重量区间没有已启用的配送规则。可以新建规则，或启用对应的大件配送规则。</div>';
      return;
    }
    result.innerHTML = `<div class="shipping-result-head"><strong>模拟结果</strong><span>${ctx.icon('check', 13)} 匹配成功</span></div><div class="shipping-result-line"><span>命中规则</span><b>${escapeHtml(rule.name)}</b></div><div class="shipping-result-line"><span>基础运费</span><b>${ctx.money(rule.price)}</b></div><div class="shipping-result-line"><span>${isRemote ? '偏远地区附加费' : '偏远附加费'}</span><b>${ctx.money(surcharge)}</b></div><div class="shipping-result-total"><span>预计配送费用</span><strong>${ctx.money(rule.price + surcharge)}</strong></div><p class="shipping-result-note">${escapeHtml(postcode)} · ${weight} kg · 根据当前已启用规则计算</p>`;
  });

  root.querySelector('#ship-create').addEventListener('click', () => {
    ctx.openModal('新建配送规则', `<form id="modal-form"><p class="shipping-form-note">为指定目的地创建一条配送规则，保存后即可在模拟器中查看效果。</p><div class="field"><label for="new-ship-name">规则名称</label><input id="new-ship-name" class="input" name="name" placeholder="例如 比利时 · 标准配送" maxlength="60" required></div><div class="form-grid"><div class="field"><label for="new-ship-country">目的地国家</label><select id="new-ship-country" class="select" name="country"><option value="GB">英国</option><option value="DE">德国</option><option value="FR">法国</option><option value="NL">荷兰</option><option value="IT">意大利</option><option value="ES">西班牙</option></select></div><div class="field"><label for="new-ship-max">最大重量 / kg</label><input id="new-ship-max" class="input" name="max" type="number" min="0.1" step="0.1" value="30" required></div></div><div class="field"><label for="new-ship-price">固定配送费用 / ${ctx.store === 'eu' ? 'EUR' : 'GBP'}</label><input id="new-ship-price" class="input" name="price" type="number" min="0" step="0.01" placeholder="0.00" required></div><label style="display:flex;align-items:center;gap:8px;margin-top:18px;font-size:13px"><input type="checkbox" name="enabled" checked> 保存后启用此规则</label><div id="new-ship-error" class="shipping-inline-error" role="alert"></div></form>`, (form) => {
      const data = new FormData(form);
      const name = String(data.get('name') || '').trim();
      const max = Number(data.get('max'));
      const price = Number(data.get('price'));
      if (!name || !Number.isFinite(max) || max <= 0 || !Number.isFinite(price) || price < 0) {
        form.querySelector('#new-ship-error').textContent = '请填写规则名称、有效重量和配送费用。';
        return false;
      }
      const country = String(data.get('country'));
      rules.unshift({ id: `custom-${Date.now()}`, name, area: country === 'GB' ? 'main' : 'eu', countries: [country], postcode: ({ GB: '英国本土邮编', DE: '德国全境', FR: '法国全境', NL: '荷兰全境', IT: '意大利全境', ES: '西班牙全境' })[country], condition: `重量 ≤ ${max} kg`, kind: country === 'GB' ? 'flat' : 'eu', min: 0, max, price, enabled: data.has('enabled'), color: 'green' });
      persist(); state.tab = 'all'; state.status = 'all'; state.query = '';
      root.querySelector('#ship-search').value = '';
      root.querySelector('#ship-status').value = 'all';
      refresh(); ctx.toast('配送规则已保存');
      return true;
    });
  });
}
