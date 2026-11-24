const documentViews = new Map();
const documentEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const documentKey = (ctx) => `commerce-documents-${ctx.store}`;
const documentView = (ctx) => {
  if (!documentViews.has(ctx.store)) documentViews.set(ctx.store, {tab:'all', query:'', selected:new Set()});
  return documentViews.get(ctx.store);
};
function documentState(ctx) {
  const eu = ctx.store === 'eu';
  const prefix = eu ? 'EU' : 'UK';
  return ctx.read(documentKey(ctx), {
    settings:{trigger:'paid', invoices:true, creditNotes:true, language:eu?'de':'en', archive:true},
    entries:[
      {id:'1048', number:'INV-2026-1048', order:`#${prefix}1048`, type:'invoice', customer:'Emma Wilson', email:'emma.w@example.com', amount:1199, status:'sent', date:'2026-11-23', time:'10:24', product:'M1 PRO 家庭训练组合'},
      {id:'1047', number:'INV-2026-1047', order:`#${prefix}1047`, type:'invoice', customer:'Oliver Bennett', email:'oliver.b@example.com', amount:349, status:'sent', date:'2026-11-23', time:'09:42', product:'可调节训练凳'},
      {id:'1046', number:'QUO-2026-0086', order:'报价单', type:'quote', customer:'Studio Form Ltd.', email:'hello@studioform.example', amount:2498, status:'unpaid', date:'2026-11-22', time:'16:30', product:'工作室器械采购组合'},
      {id:'1045', number:'INV-2026-1045', order:`#${prefix}1045`, type:'invoice', customer:'Charlotte Lewis', email:'charlotte.l@example.com', amount:189, status:'sent', date:'2026-11-22', time:'15:18', product:'奥林匹克杠铃片套装'},
      {id:'1044', number:'CN-2026-0024', order:`#${prefix}1039`, type:'credit', customer:'James Harrison', email:'james.h@example.com', amount:-89, status:'issued', date:'2026-11-22', time:'13:56', product:'橡胶地垫 部分退款'},
      {id:'1043', number:'INV-2026-1043', order:`#${prefix}1043`, type:'invoice', customer:'Amelia Clarke', email:'amelia.c@example.com', amount:1088, status:'sent', date:'2026-11-22', time:'11:07', product:'M1 PRO 多功能训练架'},
      {id:'1042', number:'QUO-2026-0085', order:'报价单', type:'quote', customer:'Peak Performance', email:'orders@peak.example', amount:1598, status:'draft', date:'2026-11-21', time:'17:22', product:'私人训练工作室套装'},
      {id:'1041', number:'INV-2026-1041', order:`#${prefix}1041`, type:'invoice', customer:'Noah Richardson', email:'noah.r@example.com', amount:159, status:'sent', date:'2026-11-21', time:'14:03', product:'训练配件套装'}
    ]
  });
}
const documentType = {invoice:'发票',credit:'贷项通知单',quote:'报价单'};
function documentStatus(status) {
  const map={sent:['已发送','success'],issued:['已开具','success'],unpaid:['待付款','warning'],draft:['草稿','neutral']};
  const [label,tone]=map[status]||map.draft;
  return `<span class="badge badge-${tone}">${label}</span>`;
}
function filteredDocuments(ctx) {
  const view=documentView(ctx);
  return documentState(ctx).entries.filter((item)=>(view.tab==='all'||item.type===view.tab)&&(!view.query||[item.number,item.order,item.customer,item.email].join(' ').toLowerCase().includes(view.query.toLowerCase())));
}
function documentRows(ctx) {
  const view=documentView(ctx);
  const rows=filteredDocuments(ctx);
  if(!rows.length) return `<tr><td colspan="7"><div class="empty-state">${ctx.icon('search',24)}<strong>没有匹配的单据</strong><span class="muted">试试其他单号、客户或单据类型。</span></div></td></tr>`;
  return rows.map(item=>`<tr>
    <td><input type="checkbox" class="document-row-check" data-id="${item.id}" aria-label="选择 ${item.number}" ${view.selected.has(item.id)?'checked':''}></td>
    <td><button class="document-link" data-preview="${item.id}">${item.number}</button><span class="document-secondary">${item.order} · ${documentType[item.type]}</span></td>
    <td><strong class="document-customer">${documentEscape(item.customer)}</strong><span class="document-secondary">${documentEscape(item.email)}</span></td>
    <td>${item.date.slice(5).replace('-','月')}日<span class="document-secondary">${item.time}</span></td>
    <td class="document-amount ${item.amount<0?'document-negative':''}">${ctx.money(item.amount)}</td>
    <td>${documentStatus(item.status)}</td>
    <td><div class="document-row-actions"><button class="document-icon-button" data-preview="${item.id}" title="预览单据" aria-label="预览 ${item.number}">${ctx.icon('eye',17)}</button><button class="document-icon-button" data-download="${item.id}" title="下载 HTML 单据" aria-label="下载 ${item.number}">${ctx.icon('download',17)}</button></div></td>
  </tr>`).join('');
}
function documentPreview(ctx,item) {
  const eu=ctx.store==='eu';
  const net=Math.round(item.amount/(eu?1.19:1.2)*100)/100;
  const tax=Math.round((item.amount-net)*100)/100;
  const label=item.type==='credit'?'CREDIT NOTE':item.type==='quote'?'QUOTATION':'INVOICE';
  return `<div class="document-paper">
    <div class="document-paper-top"><div><span class="document-paper-brand">NORTHLINE<span> / </span></span><p>Home training, thoughtfully made.</p></div><span class="document-paper-kind">${label}</span></div>
    <div class="document-paper-rule"></div>
    <div class="document-paper-details"><div><small>FROM</small><strong>Northline ${eu?'Europe GmbH':'Fitness UK Ltd.'}</strong><span>${eu?'Friedrichstraße 123, 10117 Berlin':'24 Great Portland Street, London W1W 8QX'}</span><span>${eu?'Germany':'United Kingdom'}</span><span>VAT ${eu?'DE123456789':'GB 123 4567 89'}</span></div><div><small>${item.type==='credit'?'CREDIT NOTE':'INVOICE'} DETAILS</small><span>Number <b>${item.number}</b></span><span>Issue date <b>${item.date}</b></span><span>Order <b>${item.order}</b></span><span>Currency <b>${eu?'EUR':'GBP'}</b></span></div></div>
    <div class="document-paper-bill"><small>BILL TO</small><strong>${documentEscape(item.customer)}</strong><span>${documentEscape(item.email)}</span><span>${eu?'Berlin, Germany':'London, United Kingdom'}</span></div>
    <table class="document-paper-table"><thead><tr><th>Description</th><th>Qty</th><th>Net amount</th></tr></thead><tbody><tr><td>${documentEscape(item.product)}<small>SKU NL-${item.id}-A</small></td><td>1</td><td>${ctx.money(net)}</td></tr></tbody></table>
    <div class="document-paper-totals"><div><span>Subtotal</span><b>${ctx.money(net)}</b></div><div><span>Delivery</span><b>${ctx.money(0)}</b></div><div><span>VAT (${eu?'19':'20'}%)</span><b>${ctx.money(tax)}</b></div><div class="document-paper-total"><span>Total ${item.type==='credit'?'credit':'amount'}</span><b>${ctx.money(item.amount)}</b></div></div>
    <p class="document-paper-note">Thank you for choosing Northline.<br>Questions about this document? accounts@northline.example</p>
    <div class="document-paper-footer">演示单据 · 税号及客户均为虚构数据 · 不可用于真实财务记账</div>
  </div>`;
}
function downloadDocuments(ctx,entries) {
  if(!entries.length){ctx.toast('请先选择需要下载的单据');return;}
  const styles=document.querySelector('#documents-page style')?.textContent||'';
  const html=`<!DOCTYPE html><html lang="zh-CN"><meta charset="UTF-8"><title>Northline 单据</title><style>body{font-family:Arial,"PingFang SC",sans-serif;color:#17342d;background:#eef2ef;padding:32px}.document-paper{max-width:760px;margin:0 auto 32px;background:white;padding:48px;page-break-after:always}${styles}</style><body>${entries.map(item=>documentPreview(ctx,item)).join('')}</body></html>`;
  const blob=new Blob([html],{type:'text/html;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=entries.length===1?`${entries[0].number}.html`:'Northline-documents.html';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
  ctx.toast(`已下载 ${entries.length} 份 HTML 演示单据`);
}
function updateDocumentTable(ctx) {
  const root=document.getElementById('documents-page');if(!root)return;
  root.querySelector('tbody').innerHTML=documentRows(ctx);
  root.querySelector('[data-document-count]').textContent=`共 ${filteredDocuments(ctx).length} 份单据`;
  const selected=documentView(ctx).selected.size;
  root.querySelector('[data-selection-count]').textContent=selected?`已选择 ${selected} 份`:'选择单据进行批量操作';
  root.querySelector('[data-bulk-download]').disabled=!selected;
  root.querySelector('[data-bulk-send]').disabled=!selected;
  const all=root.querySelector('[data-select-all]');
  const filtered=filteredDocuments(ctx);all.checked=filtered.length>0&&filtered.every(item=>documentView(ctx).selected.has(item.id));
  root.querySelectorAll('[data-document-tab]').forEach(button=>button.classList.toggle('active',button.dataset.documentTab===documentView(ctx).tab));
}

export function renderDocuments(ctx) {
  const state=documentState(ctx),view=documentView(ctx);
  const tabs=[['all','全部单据'],['invoice','发票'],['credit','贷项通知单'],['quote','报价单']];
  return `<section id="documents-page">
  <style>
  #documents-page .document-metrics{grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:24px}#documents-page .document-metric-icon{width:36px;height:36px;border-radius:10px;background:#f1f6f3;display:flex;align-items:center;justify-content:center;color:#39735d;margin-bottom:16px}#documents-page .document-link{font:inherit;font-size:14px;font-weight:650;color:#244c3e;border:0;padding:0;background:none;cursor:pointer;text-align:left}#documents-page .document-secondary{display:block;color:#87918b;font-size:12px;margin-top:5px}#documents-page .document-customer{font-size:14px;font-weight:500}#documents-page .document-amount{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}#documents-page .document-negative{color:#76847d}#documents-page .document-row-actions{display:flex;gap:5px}#documents-page .document-icon-button{border:0;background:transparent;color:#78877f;border-radius:6px;width:30px;height:30px;display:grid;place-items:center;cursor:pointer}#documents-page .document-icon-button:hover{background:#edf4ef;color:#235941}#documents-page .document-toolbar{display:flex;justify-content:space-between;align-items:center;padding:18px 22px;gap:12px;border-top:1px solid #edf0ed}#documents-page .document-search{display:flex;align-items:center;gap:9px;border:1px solid #e1e7e2;border-radius:8px;padding:8px 11px;max-width:340px;width:100%;color:#8a958e}#documents-page .document-search input{border:0;outline:0;background:transparent;width:100%;font:inherit;font-size:14px}#documents-page .document-bottom{display:flex;justify-content:space-between;align-items:center;padding:16px 22px;border-top:1px solid #edf0ed;font-size:13px;color:#7e8d84;gap:12px}#documents-page .document-bulk{display:flex;align-items:center;gap:10px}#documents-page .document-context{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:17px 20px;margin-top:20px;background:#f0f6f2;border:1px solid #dce9e0;border-radius:12px;color:#476653;font-size:14px}#documents-page .document-context>div{display:flex;align-items:center;gap:10px}#documents-page input[type=checkbox]{accent-color:#39745d;width:15px;height:15px}#documents-page .data-table td{padding-top:17px;padding-bottom:17px}#documents-page .document-page-button{border:1px solid #e1e7e2;border-radius:6px;background:white;color:#56665b;padding:5px 11px;cursor:pointer}.document-paper{background:#fff;color:#26372e;padding:30px 28px;font-family:Arial,"PingFang SC",sans-serif}.document-paper-top{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.document-paper-brand{font-size:25px;font-weight:800;letter-spacing:2px}.document-paper-brand span{color:#67947e}.document-paper-top p{font-size:10px;color:#86938a;margin:9px 0}.document-paper-kind{font-size:13px;letter-spacing:3px;margin-top:8px;color:#7c8d82}.document-paper-rule{height:3px;background:#315d48;margin:22px 0 28px}.document-paper-details{display:grid;grid-template-columns:1.1fr 1fr;gap:24px;font-size:11px;line-height:1.8}.document-paper-details>div{display:flex;flex-direction:column}.document-paper small{font-size:9px;letter-spacing:1.3px;color:#8b978f;margin-bottom:9px;display:block}.document-paper-details strong{font-size:12px}.document-paper-details div:nth-child(2)>span{display:flex;justify-content:space-between;gap:8px}.document-paper-details b{font-weight:500}.document-paper-bill{display:flex;flex-direction:column;font-size:11px;line-height:1.9;margin:28px 0}.document-paper-table{width:100%;border-collapse:collapse;font-size:11px}.document-paper-table th{text-align:left;background:#f2f5f1;color:#63766a;font-weight:500;padding:10px}.document-paper-table th:last-child,.document-paper-table td:last-child{text-align:right}.document-paper-table td{padding:18px 10px;border-bottom:1px solid #e7ede7}.document-paper-table small{font-size:8px;margin:7px 0 0;letter-spacing:.3px}.document-paper-totals{margin:20px 0 24px auto;width:240px;font-size:11px}.document-paper-totals>div{display:flex;justify-content:space-between;padding:7px 0;color:#78867d}.document-paper-totals b{color:#344e3d;font-weight:500}.document-paper-totals .document-paper-total{border-top:1px solid #dce5dd;margin-top:10px;padding-top:15px;font-size:15px;color:#244e37}.document-paper-total b{font-weight:700}.document-paper-note{font-size:10px;line-height:1.8;color:#829086;margin-top:35px}.document-paper-footer{font-size:9px;color:#98a197;border-top:1px solid #e9eee9;margin-top:22px;padding-top:14px}.document-preview-note{font-size:12px;color:#8c968e;margin:0 0 10px}.document-settings-group{padding:16px 0;border-top:1px solid #edf0ed}.document-settings-line{display:flex;align-items:center;gap:10px;font-size:14px}.document-field-help{font-size:12px;line-height:1.7;color:#839087;margin:7px 0 0}.document-quote-total{padding:14px 16px;background:#f2f7f3;border-radius:8px;color:#496650;font-size:13px;margin-top:16px}@media(max-width:760px){#documents-page .document-metrics{grid-template-columns:1fr}#documents-page .document-toolbar,#documents-page .document-bottom,#documents-page .document-context{align-items:stretch;flex-direction:column}#documents-page .document-search{max-width:none}.document-paper{padding:20px 8px}.document-paper-details{gap:12px}.document-paper-brand{font-size:20px}}
  </style>
  <div class="page-heading"><div><h1>发票与单据</h1><p class="page-description">让每笔订单，都有清晰完整的凭证。</p></div><div class="page-actions"><button class="button" data-document-settings>${ctx.icon('settings',16)} 自动化设置</button><button class="button button-primary" data-new-quote>${ctx.icon('plus',17)} 新建报价</button></div></div>
  <div class="metric-grid document-metrics"><div class="metric-card"><div class="stat-label">本月已开具单据</div><div class="stat-value">1,284 <span style="font-size:14px;font-weight:400;color:#8a948d">份</span></div><div class="stat-change">较上月增长 18.6%</div></div><div class="metric-card"><div class="stat-label">自动发送成功率</div><div class="stat-value">99.8<span style="font-size:23px">%</span></div><div class="muted" style="font-size:13px">${state.settings.invoices?'订单付款后自动发送':'自动发送已暂停'}</div></div><div class="metric-card"><div class="stat-label">待收款报价</div><div class="stat-value">${ctx.money(state.entries.filter(item=>item.type==='quote'&&item.status!=='sent').reduce((sum,item)=>sum+item.amount,0))}</div><div class="muted" style="font-size:13px">${state.entries.filter(item=>item.type==='quote').length} 份报价等待客户确认</div></div></div>
  <div class="card"><div class="card-head"><div class="tabs">${tabs.map(([id,label])=>`<button class="tab ${view.tab===id?'active':''}" data-document-tab="${id}">${label}<span class="document-tab-count">${id==='all'?state.entries.length:state.entries.filter(item=>item.type===id).length}</span></button>`).join('')}</div></div>
    <div class="document-toolbar"><label class="document-search">${ctx.icon('search',17)}<input id="document-search" placeholder="搜索单据号、订单或客户" aria-label="搜索单据" value="${documentEscape(view.query)}"></label><div class="document-bulk"><span data-selection-count class="muted" style="font-size:12px">选择单据进行批量操作</span><button class="button button-small" data-bulk-download disabled>${ctx.icon('download',15)} 下载选中</button><button class="button button-small" data-bulk-send disabled>${ctx.icon('mail',15)} 模拟发送</button></div></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th style="width:40px"><input type="checkbox" data-select-all aria-label="选择全部可见单据"></th><th>单据 / 关联订单</th><th>客户</th><th>开具时间</th><th style="text-align:right">金额</th><th>状态</th><th style="width:90px">操作</th></tr></thead><tbody>${documentRows(ctx)}</tbody></table></div>
    <div class="document-bottom"><span data-document-count>共 ${filteredDocuments(ctx).length} 份单据</span><span>显示全部演示记录</span></div>
  </div>
  <div class="document-context"><div>${ctx.icon('check',18)}<span>自动化已就绪 · ${ctx.store==='eu'?'欧盟':'英国'}主体模板 · ${state.settings.archive?'云端归档已开启':'云端归档已暂停'}</span></div><button class="button button-small" data-document-template>${ctx.icon('eye',15)} 查看发票模板</button></div>
  </section>`;
}

export function bindDocuments(ctx) {
  const root=document.getElementById('documents-page');if(!root)return;
  const preview=(id)=>{const item=documentState(ctx).entries.find(item=>item.id===id);if(!item)return;ctx.openModal(`${documentType[item.type]}预览`, `<div class="document-preview-note">${item.number} · 可下载 HTML 演示单据</div>${documentPreview(ctx,item)}`);};
  root.addEventListener('input',(event)=>{if(event.target.id==='document-search'){documentView(ctx).query=event.target.value;updateDocumentTable(ctx);}});
  root.addEventListener('change',(event)=>{
    const view=documentView(ctx);
    if(event.target.matches('.document-row-check')){event.target.checked?view.selected.add(event.target.dataset.id):view.selected.delete(event.target.dataset.id);updateDocumentTable(ctx);}
    if(event.target.matches('[data-select-all]')){filteredDocuments(ctx).forEach(item=>event.target.checked?view.selected.add(item.id):view.selected.delete(item.id));updateDocumentTable(ctx);}
  });
  root.addEventListener('click',(event)=>{
    const tab=event.target.closest('[data-document-tab]');if(tab){documentView(ctx).tab=tab.dataset.documentTab;updateDocumentTable(ctx);return;}
    const eye=event.target.closest('[data-preview]');if(eye){preview(eye.dataset.preview);return;}
    const download=event.target.closest('[data-download]');if(download){downloadDocuments(ctx,documentState(ctx).entries.filter(item=>item.id===download.dataset.download));return;}
    if(event.target.closest('[data-bulk-download]')){downloadDocuments(ctx,documentState(ctx).entries.filter(item=>documentView(ctx).selected.has(item.id)));return;}
    if(event.target.closest('[data-bulk-send]')){const state=documentState(ctx);let count=0;state.entries.forEach(item=>{if(documentView(ctx).selected.has(item.id)){item.status='sent';count++;}});ctx.persist(documentKey(ctx),state);updateDocumentTable(ctx);ctx.toast(`已模拟发送 ${count} 份单据，未发送真实邮件`);return;}
    if(event.target.closest('[data-document-template]')){preview(documentState(ctx).entries.find(item=>item.type==='invoice').id);return;}
    if(event.target.closest('[data-new-quote]')){
      ctx.openModal('新建报价单',`<form id="modal-form"><div class="form-grid"><label class="field">客户名称<input class="input" name="customer" required placeholder="例如 Studio Form Ltd."></label><label class="field">客户邮箱<input class="input" name="email" type="email" required placeholder="hello@example.com"></label><label class="field">报价内容<input class="input" name="product" required placeholder="例如 家庭训练器械组合"></label><label class="field">含税报价金额<input class="input" name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00"></label><label class="field">到期日<input class="input" name="due" type="date" value="2026-12-07" required></label></div><div class="document-quote-total">报价将保存为本地草稿。此原型不会创建真实订单或向客户发信。</div></form>`,(form)=>{const f=new FormData(form),amount=Number(f.get('amount'));if(!form.reportValidity()||amount<=0)return false;const state=documentState(ctx);const id=`quote-${Date.now()}`;state.entries.unshift({id,number:`QUO-2026-${String(state.entries.filter(item=>item.type==='quote').length+87).padStart(4,'0')}`,order:'报价单',type:'quote',customer:f.get('customer'),email:f.get('email'),product:f.get('product'),amount,status:'draft',date:'2026-11-23',time:'刚刚',due:f.get('due')});ctx.persist(documentKey(ctx),state);documentView(ctx).tab='quote';documentView(ctx).query='';ctx.closeModal();ctx.navigate('documents');ctx.toast('报价草稿已保存到当前浏览器');});return;
    }
    if(event.target.closest('[data-document-settings]')){
      const settings=documentState(ctx).settings;
      ctx.openModal('单据自动化设置',`<form id="modal-form"><label class="field">自动生成与发送时机<select class="select" name="trigger"><option value="paid" ${settings.trigger==='paid'?'selected':''}>订单付款后</option><option value="created" ${settings.trigger==='created'?'selected':''}>订单创建后</option><option value="fulfilled" ${settings.trigger==='fulfilled'?'selected':''}>订单履约后</option></select></label><div class="document-settings-group"><label class="document-settings-line"><input type="checkbox" name="invoices" ${settings.invoices?'checked':''}> 自动生成并发送发票</label><p class="document-field-help">使用当前店铺的主体、编号规则和语言模板。</p></div><div class="document-settings-group"><label class="document-settings-line"><input type="checkbox" name="creditNotes" ${settings.creditNotes?'checked':''}> 退款时自动生成贷项通知单</label><p class="document-field-help">保留原始发票，关联记录退款和税额调整。</p></div><div class="document-settings-group"><label class="document-settings-line"><input type="checkbox" name="archive" ${settings.archive?'checked':''}> 生成后自动归档</label><p class="document-field-help">原型仅保存此设置，不会连接真实云盘。</p></div><label class="field">默认单据语言<select class="select" name="language"><option value="en" ${settings.language==='en'?'selected':''}>English</option><option value="de" ${settings.language==='de'?'selected':''}>Deutsch</option><option value="fr" ${settings.language==='fr'?'selected':''}>Français</option></select></label></form>`,form=>{const f=new FormData(form),state=documentState(ctx);state.settings={trigger:f.get('trigger'),invoices:f.has('invoices'),creditNotes:f.has('creditNotes'),archive:f.has('archive'),language:f.get('language')};ctx.persist(documentKey(ctx),state);ctx.closeModal();ctx.navigate('documents');ctx.toast('单据自动化设置已保存');});
    }
  });
  updateDocumentTable(ctx);
}
