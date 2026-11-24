import { renderShipping, bindShipping } from './modules/shipping.js';
import { renderBundles, bindBundles, renderStorefront, bindStorefront } from './modules/bundles.js';
import { renderDocuments, bindDocuments } from './modules/documents.js';
import { renderRestock, bindRestock } from './modules/restock.js';
import { runtime } from './runtime.js';
import { renderProductionPage, bindProductionPage } from './production.js';

const paths={
 home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
 truck:'<path d="M3 5h11v12H3zM14 9h4l3 4v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',
 box:'<path d="m12 3 9 5-9 5-9-5zM3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/>',
 file:'<path d="M14 3H5v18h14V8zM14 3v6h5M8 13h8M8 17h5"/>',
 bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"/>',
 chart:'<path d="M4 3v17h17M8 15v-4M13 15V7M18 15V4"/>',
 settings:'<path d="m9 3-.6 2.3-2 .9-2.2-.7L2.7 8l1.6 1.8V12l-1.6 1.8 1.5 2.6 2.2-.7 2 .9L9 19h3l.6-2.4 2-.9 2.2.7 1.5-2.6-1.6-1.8V9.8L18.3 8l-1.5-2.5-2.2.7-2-.9L12 3z"/><circle cx="10.5" cy="11" r="3"/>',
 search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
 chevronDown:'<path d="m7 10 5 5 5-5"/>',chevronRight:'<path d="m10 7 5 5-5 5"/>',chevronLeft:'<path d="m14 7-5 5 5 5"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',check:'<path d="m5 12 4 4L19 6"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',
 eye:'<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
 globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/>',
 help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.3 1.7c-1.1.8-1.8 1.1-1.8 2.3M12 16.5h.01"/>',
 download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
 calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v5M17 3v5M3 11h18M7 15h2M13 15h3"/>',
 arrowUpRight:'<path d="M6 18 18 6M6 6h12v12"/>',trend:'<path d="m3 16 6-6 4 4 8-9M15 5h6v6"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 shield:'<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z"/><path d="m8 12 3 3 5-6"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
 mail:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 5 10 8L22 5"/>',
 more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
 filter:'<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
 mapPin:'<path d="M19 10c0 5-7 12-7 12S5 15 5 10a7 7 0 0 1 14 0z"/><circle cx="12" cy="10" r="2"/>',
 play:'<path d="m8 4 12 8-12 8z"/>',sparkles:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4M18 4h4"/>',
 cart:'<path d="M2 3h3l3 13h11l3-10H6M9 21h.01M18 21h.01"/>',percent:'<path d="m5 19 14-14"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
 send:'<path d="m22 2-7 20-4-9-9-4zM22 2 11 13"/>',menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
 link:'<path d="m10 13 4-4M8 15l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0M13 9l2-2a4 4 0 0 1 5 5l-5 5a4 4 0 0 1-5 0"/>',
 refresh:'<path d="M20 8a8 8 0 0 0-14-3L3 8M3 3v5h5M4 16a8 8 0 0 0 14 3l3-3M21 21v-5h-5"/>',
 lock:'<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 15v3"/>',
 users:'<circle cx="9" cy="7" r="4"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M17 4a4 4 0 0 1 0 8M20 21v-3a7 7 0 0 0-3-5"/>'
};
export const icon=(name,size=18)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.box}</svg>`;
const $=(s,root=document)=>root.querySelector(s);
const $$=(s,root=document)=>[...root.querySelectorAll(s)];
const pages={overview:'运营总览',shipping:'运费管理',bundles:'搭配销售',documents:'发票与单据',restock:'补货提醒',analytics:'效果分析',settings:'设置与集成',storefront:'店铺前台预览'};
let store=runtime.store || '';
let page=Object.hasOwn(pages,location.hash.slice(1))?location.hash.slice(1):'overview';
let range='30';
let chartTab='sales';
let settingsTab='store';
let toastTimer;
const fmt=(value)=>new Intl.NumberFormat(store==='uk'?'en-GB':'de-DE',{style:'currency',currency:runtime.currentStore?.currency || (store==='uk'?'GBP':'EUR'),minimumFractionDigits:2}).format(value);
const read=(key,fallback=null)=>runtime.read(key,fallback);
const persist=(key,value)=>runtime.persist(key,value);
const esc=(str)=>String(str).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const badge=(text,tone='success')=>`<span class="badge badge-${tone}">${text}</span>`;
const toggle=(key,enabled,label)=>`<button class="toggle" role="switch" aria-label="${label}" aria-checked="${enabled}" data-toggle="${key}"><span></span></button>`;
function localToast(message){const region=$('#toast-region');region.innerHTML=`<div class="toast">${icon('check',16)}${esc(message)}</div>`;clearTimeout(toastTimer);toastTimer=setTimeout(()=>region.innerHTML='',3300);}
function localCloseModal(){const modal=$('#app-modal');if(modal.open)modal.close();}
function localOpenModal(title,html,onSave){const modal=$('#app-modal');modal.innerHTML=`<div class="modal-header"><h2 id="modal-title">${esc(title)}</h2><button class="icon-button" data-modal-close aria-label="关闭弹窗">${icon('close')}</button></div><div class="modal-body">${html}</div><div class="modal-footer"><button class="button" data-modal-close>${onSave?'取消':'关闭'}</button>${onSave?'<button class="button button-primary" id="modal-save">保存设置</button>':''}</div>`;$$('[data-modal-close]',modal).forEach(x=>x.onclick=closeModal);modal.onclick=e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}};const form=$('form',modal);if(onSave){const save=async()=>{if(form&&!form.reportValidity())return;try{const r=await onSave(form||$('.modal-body',modal));if(r!==false)closeModal();}catch(err){console.error(err);toast('请检查输入后重试');}};$('#modal-save',modal).onclick=save;if(form)form.onsubmit=e=>{e.preventDefault();save();};}else if(form)form.onsubmit=e=>e.preventDefault();if(!modal.open)modal.showModal();}
const ctx=()=>({icon,toast,openModal,closeModal,store,money:fmt,persist,read,navigate,runtime,api:runtime.api,flush:runtime.flush});

function offlineShell(){
 const nav=(key,name,count)=>`<button class="nav-link ${page===key?'active':''}" data-nav="${key}" ${page===key?'aria-current="page"':''}>${icon({overview:'home',shipping:'truck',bundles:'box',documents:'file',restock:'bell',analytics:'chart',settings:'settings'}[key],18)}<span>${name}</span>${count?`<span class="nav-count">${count}</span>`:''}</button>`;
 $('#app').innerHTML=`<div class="app-layout"><aside class="sidebar" aria-label="应用导航"><a href="#overview" class="brand" aria-label="Commerce Suite 首页"><span class="brand-mark"><span></span><span></span><span></span><span></span></span><span><span class="brand-title">Commerce Suite</span><span class="brand-sub" style="display:block">商店运营工作台</span></span></a><nav><div class="nav-section"><div class="nav-label">工作空间</div>${nav('overview','运营总览')}${nav('shipping','运费管理')}${nav('bundles','搭配销售')}${nav('documents','发票与单据')}${nav('restock','补货提醒','3')}</div><div class="nav-section" style="margin-top:16px"><div class="nav-label">管理</div>${nav('analytics','效果分析')}${nav('settings','设置与集成')}</div></nav><div class="sidebar-footer"><div class="workspace-card"><div class="workspace-title"><span class="connection-dot"></span> 2 个店铺已就绪</div><p>统一管理，独立运行</p></div><button class="sidebar-help" id="sidebar-help">${icon('help',16)}<span>使用指南</span><span>V 0.1</span></button></div></aside><div class="main-shell"><header class="topbar"><div class="topbar-left"><button class="icon-button mobile-menu" aria-label="打开导航" id="mobile-menu">${icon('menu')}</button><button class="store-switcher" id="store-switcher" aria-haspopup="true" aria-expanded="false"><span class="store-flag">${store==='uk'?'🇬🇧':'🇪🇺'}</span><span>${store==='uk'?'英国旗舰店':'欧洲旗舰店'}</span>${icon('chevronDown',14)}</button><div class="topbar-divider"></div><span class="demo-chip">交互原型 · 演示数据</span></div><div class="topbar-right"><button class="search-trigger" id="global-search">${icon('search',16)}<span>搜索功能、规则、单据</span><kbd>⌘ K</kbd></button><button class="icon-button help-button" id="topbar-help" aria-label="帮助中心">${icon('help',18)}</button><button class="icon-button notification-button" id="notifications" aria-label="通知，2条未读">${icon('bell',18)}<span class="notification-dot"></span></button><div class="topbar-divider"></div><button class="avatar" id="profile" aria-label="当前用户 Jack">JK</button></div></header><main id="page-content" class="page-content" tabindex="-1"></main></div></div>`;
 $$('[data-nav]').forEach(el=>el.onclick=()=>navigate(el.dataset.nav));
 $('.brand').onclick=e=>{e.preventDefault();navigate('overview');};
 $('#store-switcher').onclick=storePopover;
 $('#global-search').onclick=searchModal;
 $('#notifications').onclick=notifications;
 $('#topbar-help').onclick=help;
 $('#sidebar-help').onclick=help;
 $('#profile').onclick=()=>openModal('工作空间成员',`<div class="row" style="gap:17px"><span class="avatar" style="width:48px;height:48px;font-size:16px">JK</span><div><h3>Jack</h3><p class="muted">工作空间管理员</p></div></div><hr><p class="modal-description">可管理英国与欧洲旗舰店的全部模块。当前为交互演示，所有修改仅保存在此浏览器。</p>`);
 $('#mobile-menu').onclick=()=>$('.sidebar').classList.toggle('open');
 renderPage();
}
function navigate(next){if(!Object.hasOwn(pages,next))next='overview';page=next;if(location.hash!==`#${next}`)history.pushState({},'',`#${next}`);shell();window.scrollTo({top:0,behavior:'instant'});}
window.addEventListener('popstate',()=>{page=Object.hasOwn(pages,location.hash.slice(1))?location.hash.slice(1):'overview';shell();});
function offlineRenderPage(){const content=$('#page-content');const c=ctx();const renderers={overview:renderOverview,shipping:renderShipping,bundles:renderBundles,documents:renderDocuments,restock:renderRestock,analytics:renderAnalytics,settings:renderSettings,storefront:renderStorefront};content.innerHTML=renderers[page](c);const binders={overview:bindOverview,shipping:bindShipping,bundles:bindBundles,documents:bindDocuments,restock:bindRestock,analytics:bindAnalytics,settings:bindSettings,storefront:bindStorefront};binders[page]?.(c);document.title=`${pages[page]} · Commerce Suite`;}
function offlineStorePopover(){const exists=$('.store-popover');if(exists){exists.remove();$('#store-switcher').setAttribute('aria-expanded','false');return;}$('#store-switcher').setAttribute('aria-expanded','true');const pop=document.createElement('div');pop.className='store-popover';pop.innerHTML=['uk','eu'].map(s=>`<button class="store-option" data-store="${s}"><span class="country">${s==='uk'?'🇬🇧':'🇪🇺'}</span><span>${s==='uk'?'英国旗舰店':'欧洲旗舰店'}<small>${s==='uk'?'United Kingdom · GBP':'European Union · EUR'}</small></span>${s===store?icon('check',16):''}</button>`).join('');document.body.appendChild(pop);$$('[data-store]',pop).forEach(el=>el.onclick=()=>{store=el.dataset.store;localStorage.setItem('cs-store',store);pop.remove();shell();toast(`已切换至${store==='uk'?'英国':'欧洲'}旗舰店`);});setTimeout(()=>document.addEventListener('click',function dismiss(e){if(!pop.contains(e.target)&&!$('#store-switcher')?.contains(e.target)){pop.remove();$('#store-switcher')?.setAttribute('aria-expanded','false');document.removeEventListener('click',dismiss);}}),0);}
function searchModal(){openModal('快速查找',`<div class="search-field" style="width:100%">${icon('search')}<input id="command-search" placeholder="输入功能名称，例如：运费、发票…" autofocus></div><div class="command-list" id="command-list">${Object.entries(pages).map(([key,label])=>`<button class="command-item" data-command="${key}">${icon({overview:'home',shipping:'truck',bundles:'box',documents:'file',restock:'bell',analytics:'chart',settings:'settings',storefront:'eye'}[key])}${label}<small>打开页面</small></button>`).join('')}</div>`);$$('[data-command]').forEach(x=>x.onclick=()=>{closeModal();navigate(x.dataset.command);});$('#command-search').oninput=e=>$$('[data-command]').forEach(x=>x.hidden=!x.textContent.includes(e.target.value));$('#command-search').focus();}
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();searchModal();}});
function offlineHelp(){openModal('欢迎使用 Commerce Suite',`<p class="modal-description">一处管理运费、搭配销售、发票与补货提醒。你可以通过左侧导航切换模块，也可以使用 ⌘ K 快速查找。</p><div class="info-note">${icon('info',17)}<span>当前是可交互界面原型，使用演示数据。创建规则、报价和开关设置只保存在本地浏览器；未连接真实店铺，也不会发送真实邮件。</span></div><div class="command-list"><button class="command-item" data-help-nav="shipping">${icon('truck')}试算一笔配送运费</button><button class="command-item" data-help-nav="bundles">${icon('box')}调整一组搭配优惠</button><button class="command-item" data-help-nav="documents">${icon('file')}预览一张 VAT 发票</button><button class="command-item" data-help-nav="storefront">${icon('eye')}查看顾客端整体效果</button></div>`);$$('[data-help-nav]').forEach(x=>x.onclick=()=>{closeModal();navigate(x.dataset.helpNav);});}
function offlineNotifications(){openModal('工作空间通知',`<div class="notification-entry"><span class="activity-icon orange">${icon('truck',17)}</span><div><strong>有一项配送规则需要检查</strong><p>部分偏远邮编尚未设置重量超过 100 kg 的费率。</p><small>今天 11:18 · 英国旗舰店</small><button class="text-button" data-notification-nav="shipping" style="margin-top:8px">查看运费规则</button></div></div><div class="notification-entry"><span class="activity-icon blue">${icon('file',17)}</span><div><strong>2 份报价等待客户付款</strong><p>可以查看报价明细，并调整付款提醒设置。</p><small>今天 10:42 · 英国旗舰店</small><button class="text-button" data-notification-nav="documents" style="margin-top:8px">查看报价单据</button></div></div>`);$$('[data-notification-nav]').forEach(x=>x.onclick=()=>{closeModal();navigate(x.dataset.notificationNav);});}

function spark(seed=0){const shapes=['2,25 12,22 19,24 28,16 36,19 45,10 54,12 63,5 76,2','2,25 12,21 22,23 31,16 41,17 48,10 61,13 68,6 76,4','2,24 10,23 17,17 26,20 35,12 46,14 56,9 67,10 76,3','2,25 13,26 22,21 34,23 45,15 54,17 65,8 76,5'];return `<svg class="metric-spark" viewBox="0 0 80 30" aria-hidden="true"><polyline points="${shapes[seed%4]}" fill="none" stroke="#95bba3" stroke-width="1.5" stroke-linejoin="round"/></svg>`;}
function metric(label,value,change,seed=0,unit=''){return `<div class="metric-card"><div class="stat-label">${label}${icon('info',12)}</div><div class="stat-value">${value}${unit?`<span class="stat-unit">${unit}</span>`:''}</div><div class="stat-change"><span class="positive">${icon('trend',12)} ${change}</span><span>较上一周期</span></div>${spark(seed)}</div>`;}
function salesValue(){return store==='uk'?24680:31842;}
function chartMarkup(){
 const values=range==='7'?[50,63,49,83,71,108,128]:range==='90'?[38,51,48,58,55,75,64,92,89,112,101,136,130,151]:[32,44,39,62,53,79,66,76,105,94,114,103,141,128];
 const width=760,height=210,pad={l:48,r:15,t:15,b:32};const max=160;const x=i=>pad.l+i*(width-pad.l-pad.r)/(values.length-1);const y=v=>pad.t+(max-v)*(height-pad.t-pad.b)/max;
 const smooth=(pts)=>pts.map((p,i)=>i===0?`M${p[0]},${p[1]}`:`C${(pts[i-1][0]+p[0])/2},${pts[i-1][1]} ${(pts[i-1][0]+p[0])/2},${p[1]} ${p[0]},${p[1]}`).join(' ');
 const line=smooth(values.map((v,i)=>[x(i),y(v)]));const prev=smooth(values.map((v,i)=>[x(i),y(v*.72+(i%3)*5)]));const area=`${line} L${x(values.length-1)},${height-pad.b} L${pad.l},${height-pad.b} Z`;
 const labels=range==='7'?['11月17日','11月18日','11月19日','11月20日','11月21日','11月22日','11月23日']:range==='90'?['8月26日','9月10日','9月25日','10月10日','10月25日','11月9日','11月23日']:['10月25日','10月30日','11月4日','11月9日','11月14日','11月19日','11月23日'];
 return `<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${chartTab==='sales'?'关联销售额':chartTab==='orders'?'订单数量':'转化率'}趋势对比图"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#8bbca0" stop-opacity=".2"/><stop offset="100%" stop-color="#d4eadb" stop-opacity=".015"/></linearGradient></defs>${[0,40,80,120,160].map(v=>`<line x1="${pad.l}" y1="${y(v)}" x2="${width-pad.r}" y2="${y(v)}" stroke="#f0f3f0" stroke-dasharray="3 4"/><text x="${pad.l-12}" y="${y(v)+3}" text-anchor="end" fill="#a8b1aa" font-size="9">${chartTab==='sales'?(v===0?'0':`${Math.round(v/40)}k`):chartTab==='orders'?v:`${Math.round(v/10)}%`}</text>`).join('')}<path d="${area}" fill="url(#chart-fill)"/><path d="${prev}" fill="none" stroke="#d5ddd7" stroke-width="1.5" stroke-dasharray="4 5"/><path d="${line}" fill="none" stroke="#4c8d6a" stroke-width="2.25"/><circle cx="${x(values.length-1)}" cy="${y(values.at(-1))}" r="4" fill="#fff" stroke="#4c8d6a" stroke-width="2"/>${labels.map((l,i)=>`<text x="${pad.l+i*(width-pad.l-pad.r)/6}" y="${height-6}" text-anchor="${i===0?'start':i===6?'end':'middle'}" fill="#a5afa7" font-size="9">${l}</text>`).join('')}</svg><div class="chart-tooltip"></div></div>`;
}
function rangeControls(){return `<div class="range-controls"><div class="segmented" aria-label="统计周期">${['7','30','90'].map(n=>`<button data-range="${n}" class="${range===n?'active':''}">近 ${n} 天</button>`).join('')}</div><button class="date-range" id="date-range">${icon('calendar',13)}${range==='7'?'11月17日':range==='90'?'8月26日':'10月25日'} – 11月23日${icon('chevronDown',12)}</button></div>`;}
function chartCard(){return `<section class="card"><div class="card-head"><div><h2>业务表现</h2><p>每一个运营动作，都有迹可循</p></div><button class="icon-button" id="chart-options" aria-label="图表说明">${icon('more',18)}</button></div><div class="chart-tabs">${[['sales','关联销售额'],['orders','订单量'],['conversion','转化率']].map(([key,label])=>`<button class="chart-tab ${chartTab===key?'active':''}" data-chart-tab="${key}">${label}</button>`).join('')}</div><div class="chart-legend"><span class="legend-item"><span class="legend-line"></span>当前周期</span><span class="legend-item"><span class="legend-line previous"></span>上一周期</span></div>${chartMarkup()}<div class="chart-summary"><span>日均关联销售额 <strong>${fmt((salesValue()/(+range)).toFixed(2))}</strong></span><span>关联订单 <strong>${store==='uk'?'186':'243'} 笔</strong></span></div></section>`;}
function renderOverview(){const factor=range==='7'?.28:range==='90'?2.85:1;return `<div class="page-heading"><div><h1>运营总览</h1><p class="page-description">早上好，Jack。一起看看店铺今天的表现。</p></div><div class="page-actions"><button class="button" id="export-overview">${icon('download',14)}导出报表</button><button class="button button-primary" data-go="storefront">${icon('eye',15)}店铺前台预览</button></div></div><div class="overview-meta"><span class="overview-meta-left"><span class="connection-dot"></span>所有模块运行正常<span style="color:#d3dad5">|</span>数据更新于 11:32</span>${rangeControls()}</div><section class="metric-grid">${metric('应用关联销售额',fmt(salesValue()*factor),'18.6%',0)}${metric('搭配购买转化率','12.8%','2.4%',1)}${metric('运费报价成功率','99.8%','0.3%',2)}${metric('自动化节省工时',(32.5*factor).toFixed(1),'8.2%',3,'小时')}</section><div class="overview-chart-grid">${chartCard()}<section class="card activity-card"><div class="card-head"><div><h2>最近动态</h2><p>自动化正在为你工作</p></div><span class="badge badge-neutral">实时</span></div><div class="activity-list"><div class="activity"><span class="activity-icon">${icon('truck',15)}</span><div><div class="activity-title">订单 <strong>#UK-2086</strong><br>已应用英国本土配送规则</div><div class="activity-time">2 分钟前</div></div></div><div class="activity"><span class="activity-icon blue">${icon('file',15)}</span><div><div class="activity-title">发票 <strong>INV-2026-1082</strong><br>已生成并归档至 Google Drive</div><div class="activity-time">8 分钟前</div></div></div><div class="activity"><span class="activity-icon orange">${icon('bell',15)}</span><div><div class="activity-title"><strong>24 位顾客</strong>收到补货提醒<br>橡胶杠铃片 20 kg 已重新到货</div><div class="activity-time">16 分钟前</div></div></div><div class="activity"><span class="activity-icon violet">${icon('box',15)}</span><div><div class="activity-title">训练架入门组合带来<br><strong>${fmt(1289)}</strong> 关联销售额</div><div class="activity-time">32 分钟前</div></div></div></div><div class="card-footer"><span>今天已完成 128 项自动任务</span>${icon('check',13)}</div></section></div><div class="section-heading"><h2>你的运营工具<span class="muted">四个模块，协同运行</span></h2><button class="text-button" data-go="settings">管理模块 ${icon('settings',13)}</button></div><div class="module-grid">${[
 ['shipping','truck','运费管理','按地区与邮编，精确计算每一笔运费','24','条已发布规则',''],
 ['bundles','box','搭配销售','让合适的商品，一起出现在顾客面前','12','组商品搭配','violet'],
 ['documents','file','发票与单据','从开票到归档，自动完成日常单据','1,082','份已生成单据','blue'],
 ['restock','bell','补货提醒','商品重新到货，及时找回潜在顾客','326','位等待中的顾客','orange']
 ].map(([key,ic,title,desc,n,unit,tone])=>`<section class="card module-card"><div class="module-card-top"><span class="module-icon ${tone}">${icon(ic,19)}</span>${toggle(key,read(`enabled-${store}-${key}`,true),`${title}模块开关`)}</div><h3 class="module-title">${title}</h3><p class="module-description">${desc}</p><div class="module-data"><span><strong>${n}</strong> ${unit}</span><button data-go="${key}">管理${icon('chevronRight',12)}</button></div></section>`).join('')}</div><div class="attention-bar">${icon('info',16)}<span><strong>有 3 项待处理事项</strong>：1 项配送规则待完善，2 份报价等待付款。</span><button class="text-button" id="attention-details">查看待办</button></div><section class="card"><div class="card-head"><div><h2>近期关联订单</h2><p>查看搭配推荐与补货提醒带来的成交</p></div><button class="text-button" data-go="analytics">查看全部</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>订单</th><th>商品</th><th>来源</th><th>订单金额</th><th>单据状态</th><th>时间</th></tr></thead><tbody>${[
 ['2086','M1 PRO 多功能训练架','深蹲架 + 训练凳 + 杠铃片','rack','搭配购买',1289,'11:28'],['2085','橡胶杠铃片套装','20 kg · 黑色','plates','补货提醒',189,'11:14'],['2082','专业可调节训练凳','黑色 · 标准版','bench','搭配购买',249,'10:52']
 ].map(([id,title,detail,img,source,amount,time])=>`<tr><td><button class="text-button" data-order="${id}">#${store==='uk'?'UK':'EU'}-${id}</button></td><td><div class="recent-order-product"><img class="product-thumb" src="./assets/${img}.svg" alt=""><div><div class="product-name">${title}</div><div class="product-detail">${detail}</div></div></div></td><td>${badge(source,source==='搭配购买'?'neutral':'info')}</td><td>${fmt(amount)}</td><td>${badge('已开票')}</td><td class="muted">今天 ${time}</td></tr>`).join('')}</tbody></table></div></section><div class="app-footnote">${icon('shield',11)}你的店铺数据与配置按店铺独立管理</div>`;}
function bindRanges(){ $$('[data-range]').forEach(x=>x.onclick=()=>{range=x.dataset.range;renderPage();});$('#date-range')?.addEventListener('click',()=>openModal('统计周期',`<form id="modal-form"><p class="modal-description">选择此界面中的统计时间范围。</p><label class="field">查看周期<select class="select" name="range"><option value="7" ${range==='7'?'selected':''}>最近 7 天</option><option value="30" ${range==='30'?'selected':''}>最近 30 天</option><option value="90" ${range==='90'?'selected':''}>最近 90 天</option></select></label></form>`,form=>{range=new FormData(form).get('range');renderPage();toast('统计周期已更新');})); }
function bindChart(){ $$('[data-chart-tab]').forEach(x=>x.onclick=()=>{chartTab=x.dataset.chartTab;renderPage();});const wrap=$('.chart-wrap');if(wrap){wrap.onpointermove=e=>{const box=wrap.getBoundingClientRect();const ratio=Math.max(0,Math.min(1,(e.clientX-box.left)/box.width));const day=Math.max(1,Math.round(ratio*(+range)));const tooltip=$('.chart-tooltip',wrap);tooltip.innerHTML=`${day===+range?'11月23日':`周期第 ${day} 天`}<strong>${chartTab==='sales'?fmt(Math.round(370+ratio*1370)):chartTab==='orders'?`${Math.round(4+ratio*11)} 笔`:`${(8+ratio*6).toFixed(1)}%`}</strong>`;tooltip.style.display='block';tooltip.style.left=`${Math.max(55,Math.min(box.width-125,e.clientX-box.left-30))}px`;};wrap.onpointerleave=()=>$('.chart-tooltip',wrap).style.display='none';}$('#chart-options')?.addEventListener('click',()=>openModal('图表与归因口径','<p class="modal-description">关联销售额表示经搭配组件或补货提醒触达后产生的订单金额。演示图表用于说明信息层级，不代表店铺实际业绩，也不等同于增量收入。</p><p class="muted">正式接入后将根据真实订单同步，扣除取消与退款，并支持设置归因窗口。</p>')); }
function bindOverview(){bindRanges();bindChart();$$('[data-go]').forEach(x=>x.onclick=()=>navigate(x.dataset.go));$$('[data-toggle]').forEach(x=>x.onclick=()=>{const value=x.getAttribute('aria-checked')!=='true';x.setAttribute('aria-checked',value);persist(`enabled-${store}-${x.dataset.toggle}`,value);toast(`${pages[x.dataset.toggle]}已${value?'启用':'暂停'}（本地演示）`);});$('#export-overview').onclick=()=>downloadCsv('运营总览', [['指标','数值','币种'],['应用关联销售额',salesValue(),store==='uk'?'GBP':'EUR'],['搭配购买转化率','12.8%',''],['运费报价成功率','99.8%',''],['自动化节省工时','32.5','小时']]);$('#attention-details').onclick=notifications;$$('[data-order]').forEach(x=>x.onclick=()=>navigate('documents'));}
function downloadCsv(name,rows){const csv='\uFEFF'+rows.map(row=>row.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));const a=document.createElement('a');a.href=url;a.download=`${name}-演示数据.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('报表已导出（演示数据）');}

function renderAnalytics(){return `<div class="page-heading"><div><h1>效果分析</h1><p class="page-description">从触达到成交，了解每个模块带来的业务表现。</p></div><button class="button" id="analytics-export">${icon('download',14)}导出分析报表</button></div><div class="overview-meta"><span class="overview-meta-left">${icon('chart',13)}当前店铺 · ${store==='uk'?'英国旗舰店':'欧洲旗舰店'}</span>${rangeControls()}</div><div class="metric-grid">${metric('应用关联销售额',fmt(salesValue()),'18.6%',0)}${metric('关联订单数','186','14.2%',1)}${metric('搭配购买客单价',fmt(284.6),'9.3%',2)}${metric('补货提醒转化率','8.6%','1.2%',3)}</div><div class="analytics-grid">${chartCard()}<section class="card"><div class="card-head"><div><h2>关联销售额来源</h2><p>本周期贡献占比</p></div></div><div class="card-body" style="padding-top:14px"><div class="bar-item"><div class="bar-label"><span>搭配推荐</span><strong>74.8%</strong></div><div class="bar-track"><div class="bar-fill" style="width:74.8%"></div></div></div><div class="bar-item"><div class="bar-label"><span>补货提醒</span><strong>25.2%</strong></div><div class="bar-track"><div class="bar-fill" style="width:25.2%;background:#93accc"></div></div></div><hr><p class="muted" style="font-size:11px;line-height:1.8">关联销售额按订单归因统计，销售贡献与真实增量分别呈现。</p></div></section></div><div class="grid-2"><section class="card"><div class="card-head"><h2>搭配购买漏斗</h2>${badge('当前周期','neutral')}</div><div class="card-body">${[['组件曝光','12,480',100],['查看搭配','3,286',66],['加入购物车','1,596',39],['完成购买','186',15]].map(([label,n,w])=>`<div class="bar-item"><div class="bar-label"><span>${label}</span><strong>${n}</strong></div><div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div></div>`).join('')}</div></section><section class="card"><div class="card-head"><h2>运营自动化</h2></div><div class="table-wrap"><table class="data-table"><thead><tr><th>自动化任务</th><th>已完成</th><th>成功率</th></tr></thead><tbody><tr><td>结账运费报价</td><td>4,812 次</td><td>${badge('99.8%')}</td></tr><tr><td>生成订单单据</td><td>1,082 份</td><td>${badge('100%')}</td></tr><tr><td>发送补货提醒</td><td>428 封</td><td>${badge('98.6%')}</td></tr><tr><td>云端自动归档</td><td>1,082 份</td><td>${badge('100%')}</td></tr></tbody></table></div></section></div>`;}
function bindAnalytics(){bindRanges();bindChart();$('#analytics-export').onclick=()=>downloadCsv('效果分析',[['来源','订单数','关联销售额'],['搭配销售',139,18460],['补货提醒',47,6220]]);}

function renderSettings(){const email=read(`sender-${store}`,{sender:store==='uk'?'orders@uk.example.com':'orders@eu.example.com',name:'Northline Store',auto:true});return `<div class="page-heading"><div><h1>设置与集成</h1><p class="page-description">管理店铺信息、通知方式与工作空间偏好。</p></div></div><div class="settings-layout"><nav class="settings-nav" aria-label="设置分类">${[['store','店铺与权限'],['email','通知与邮件'],['integrations','应用集成'],['general','通用设置']].map(([id,label])=>`<button data-settings-tab="${id}" class="${id===settingsTab?'active':''}">${label}</button>`).join('')}</nav><section class="card">${settingsTab==='store'?`<div class="settings-section"><h3>当前店铺</h3><p>各店铺的授权、数据、主体及配置独立管理。</p><div class="settings-row"><div class="integration-name"><span class="store-flag">${store==='uk'?'🇬🇧':'🇪🇺'}</span><div><strong>${store==='uk'?'英国旗舰店':'欧洲旗舰店'}</strong><small>${store==='uk'?'United Kingdom · GBP · English':'European Union · EUR · Deutsch'}</small></div></div>${badge('演示店铺','neutral')}</div><div class="form-grid" style="margin-top:20px"><label class="field">公司开票主体<input class="input" id="legal-entity" value="${esc(read(`entity-${store}`,store==='uk'?'Northline Trading Ltd.':'Northline Europe GmbH'))}"></label><label class="field">VAT 注册号<input class="input" id="vat-number" value="${esc(read(`vat-${store}`,store==='uk'?'GB 123 4567 89':'DE 123456789'))}"></label></div><div class="plan-card"><h4>店铺能力检查</h4><p>套餐资格在正式连接 Shopify 后检测，当前不代表真实店铺权限。</p><div class="capability-row">${icon('check',15)}商品页与购物车组件 ${badge('可实现')}</div><div class="capability-row">${icon('info',15)}实时结账运费 ${badge('需核对 CCS','warning')}</div><div class="capability-row">${icon('info',15)}精确组合折扣与结账组件 ${badge('自用需 Plus','warning')}</div></div></div><div class="settings-section"><h3>操作权限</h3><div class="settings-row"><div><strong>Jack</strong><small>工作空间管理员 · 可管理全部模块</small></div>${badge('管理员','neutral')}</div></div><div class="settings-save"><button class="button button-primary" id="save-store">保存店铺设置</button></div>`:settingsTab==='email'?`<form id="email-settings"><div class="settings-section"><h3>发件人设置</h3><p>发票和补货邮件使用各店铺配置的发件身份。</p><div class="form-grid"><label class="field">发件人名称<input class="input" name="name" value="${esc(email.name)}" required></label><label class="field">发件人邮箱<input class="input" type="email" name="sender" value="${esc(email.sender)}" required></label></div><div class="info-note">${icon('shield',16)}域名验证将在连接邮件服务后完成，当前仅预览邮件样式。</div></div><div class="settings-section"><h3>通知偏好</h3><div class="settings-row"><div><strong>自动生成发票</strong><small>订单完成付款后生成单据</small></div>${toggle('auto-invoice',read(`auto-invoice-${store}`,true),'自动生成发票')}</div><div class="settings-row"><div><strong>自动补货提醒</strong><small>可售库存恢复后分批通知订阅顾客</small></div>${toggle('auto-restock',read(`auto-restock-${store}`,true),'自动补货提醒')}</div><div class="settings-row"><div><strong>任务失败提醒</strong><small>需要人工处理时通知工作空间管理员</small></div>${toggle('failure-alert',read(`failure-alert-${store}`,true),'任务失败提醒')}</div></div><div class="settings-save"><button class="button button-primary" type="submit">保存邮件设置</button></div></form>`:settingsTab==='integrations'?`<div class="settings-section"><h3>连接你的运营工具</h3><p>统一管理单据归档、评价展示和联系人同步。</p>${[['Google Drive','发票与单据自动归档','G','#edf4fc','#5e91bf',true],['Dropbox','文件归档与备份','D','#eef2ff','#6280c6',false],['Mailchimp','营销订阅与联系人同步','M','#fff6d9','#9f873c',false],['Judge.me','搭配商品评价展示','J','#eaf5ee','#4f916d',true],['Stripe','报价与部分付款','S','#f0edfc','#8b75ba',false]].map(([name,desc,letter,bg,color,initial])=>{const enabled=read(`integration-${store}-${name}`,initial);return `<div class="settings-row"><div class="integration-name"><span class="integration-logo" style="background:${bg};color:${color}">${letter}</span><div><strong>${name}</strong><small>${desc}</small></div></div><button class="button button-small" data-integration="${name}" data-enabled="${enabled}">${enabled?'已添加到演示':'添加配置'}</button></div>`;}).join('')}</div>`:`<div class="settings-section"><h3>显示与区域</h3><p>本地保存界面偏好，不影响 Shopify 店铺真实设置。</p><div class="form-grid"><label class="field">后台语言<select class="select"><option>简体中文</option></select></label><label class="field">金额展示<select class="select" id="currency-preference"><option>${store==='uk'?'GBP 英镑':'EUR 欧元'}</option></select></label></div><div class="settings-row"><div><strong>启用界面动效</strong><small>系统设置减少动态效果时，自动遵循系统偏好</small></div>${toggle('animation',read('animation',true),'启用界面动效')}</div></div><div class="settings-section"><h3>演示数据</h3><p>你在原型中创建的配置只保存在此浏览器中。</p><button class="button button-danger" id="reset-demo">重置本地演示数据</button></div>`}</section></div>`;}
function bindSettings(){ $$('[data-settings-tab]').forEach(x=>x.onclick=()=>{settingsTab=x.dataset.settingsTab;renderPage();});$('#save-store')?.addEventListener('click',()=>{persist(`entity-${store}`,$('#legal-entity').value);persist(`vat-${store}`,$('#vat-number').value);toast('店铺设置已保存在本地');});$('#email-settings')?.addEventListener('submit',e=>{e.preventDefault();const form=new FormData(e.target);persist(`sender-${store}`,Object.fromEntries(form));toast('邮件设置已保存在本地');});$$('[data-toggle]').forEach(x=>x.onclick=()=>{const value=x.getAttribute('aria-checked')!=='true';x.setAttribute('aria-checked',value);persist(x.dataset.toggle==='animation'?'animation':`${x.dataset.toggle}-${store}`,value);toast('偏好设置已更新');});$$('[data-integration]').forEach(x=>x.onclick=()=>{const name=x.dataset.integration;const enabled=x.dataset.enabled==='true';openModal(`${name} 配置`, `<form id="modal-form"><p class="modal-description">此处用于预览 ${esc(name)} 连接流程，正式接入时通过服务商授权，不在原型中输入真实凭据。</p><label class="field">配置名称<input class="input" name="name" value="${esc(name)} · ${store==='uk'?'英国':'欧洲'}旗舰店" required></label><label class="inline-check"><input type="checkbox" name="enabled" ${!enabled?'checked':''}>在演示中启用此集成</label></form>`,form=>{persist(`integration-${store}-${name}`,new FormData(form).has('enabled'));renderPage();toast(`${name} 演示配置已保存`);});});$('#reset-demo')?.addEventListener('click',()=>openModal('重置演示数据', '<form id="modal-form"><p class="modal-description">将清除这个原型在当前浏览器中创建的规则、报价和偏好设置，恢复到初始演示状态。</p><label class="inline-check"><input type="checkbox" required>我确认重置当前原型数据</label></form>',()=>{Object.keys(localStorage).filter(k=>k.startsWith('cs-')).forEach(k=>localStorage.removeItem(k));shell();toast('演示数据已重置');}));}

let modalVersion = 0;
let modalSaving = false;
function toast(message) {
  const savingMessage = runtime.enabled && runtime.pending && /已保存|已创建|已启用|已暂停|已更新|已开启|已复制/.test(message);
  localToast(savingMessage ? '更改正在保存到云端…' : message);
}
function closeModal() { if (!modalSaving) localCloseModal(); }
function openModal(title, html, onSave) {
  const version = ++modalVersion;
  if (!runtime.enabled || !onSave) return localOpenModal(title, html, onSave);
  return localOpenModal(title, html, async (form) => {
    const button = $('#modal-save');
    const label = button?.textContent;
    if (button) { button.disabled = true; button.textContent = '正在保存…'; }
    modalSaving = true;
    try {
      const result = await onSave(form);
      if (result === false) return false;
      await runtime.flush();
      return version === modalVersion ? result : false;
    } catch (error) {
      if (!error.notified) toast(error.message || '保存失败，请重试');
      return false;
    } finally {
      modalSaving = false;
      if (button) { button.disabled = false; button.textContent = label; }
    }
  });
}

function renderPage() {
  const content = $('#page-content');
  if (!content) return;
  try {
    if (runtime.production) { content.innerHTML = renderProductionPage(ctx(), page); bindProductionPage(ctx(), page); document.title = `${pages[page]} · Commerce Suite`; }
    else offlineRenderPage();
  } catch (error) {
    content.innerHTML = `<section class="card"><div class="empty-state">当前页面未能加载：${esc(error.message)}<br>请刷新数据后重试。</div></section>`;
  }
}

function shell() {
  if (runtime.enabled && !runtime.authenticated) return renderLogin();
  offlineShell();
  if (!runtime.enabled) return;
  const current = runtime.currentStore || {};
  const connected = runtime.data.connection?.connected === true;
  const awaiting = (runtime.data.subscriptions || []).filter((entry) => entry.active !== false).length;
  $('.workspace-title').innerHTML = `${icon(connected ? 'check' : 'info', 14)} ${connected ? '当前店铺已连接' : '等待店铺授权'}`;
  $('.workspace-card p').textContent = `${runtime.stores.length} 个店铺 · 独立配置`;
  $('#store-switcher').innerHTML = `<span class="store-flag">${current.country === 'GB' ? '🇬🇧' : '🇪🇺'}</span><span>${esc(current.name || '尚未配置店铺')}</span>${icon('chevronDown', 14)}`;
  const chip = $('.demo-chip');
  chip.innerHTML = `${runtime.production ? '正式应用' : '云端演示 · 重启清空'} <span id="cloud-save-status" role="status">${runtime.pending ? '正在保存…' : '已连接云端'}</span>`;
  const navCount = $('[data-nav="restock"] .nav-count');
  if (navCount) navCount.textContent = String(awaiting);
  $('#notifications').setAttribute('aria-label', '查看真实后台任务');
  $('.notification-dot')?.remove();
  $('#profile').textContent = 'AD'; $('#profile').setAttribute('aria-label', '管理员会话');
  $('#profile').onclick = () => {
    openModal('管理员会话', `<p class="modal-description">当前会话可管理服务端授权范围内的公司店铺。更改保存到云端；店铺数据和配置独立。</p><button class="button" id="runtime-logout">退出登录</button>`);
    $('#runtime-logout').onclick = async () => { try { await runtime.logout(); localCloseModal(); } catch (error) { toast(error.message); } };
  };
}

function storePopover() {
  if (!runtime.enabled) return offlineStorePopover();
  const exists = $('.store-popover');
  if (exists) { exists.remove(); $('#store-switcher').setAttribute('aria-expanded', 'false'); return; }
  const popover = document.createElement('div'); popover.className = 'store-popover';
  popover.innerHTML = runtime.stores.map((item) => `<button class="store-option" data-cloud-store="${esc(item.id)}"><span class="country">${item.country === 'GB' ? '🇬🇧' : '🇪🇺'}</span><span>${esc(item.name)}<small>${esc(item.domain || '')} · ${esc(item.currency || '')}</small></span>${item.id === store ? icon('check', 16) : ''}</button>`).join('') || '<div class="empty-state">尚未配置店铺</div>';
  document.body.appendChild(popover); $('#store-switcher').setAttribute('aria-expanded', 'true');
  $$('[data-cloud-store]', popover).forEach((element) => element.onclick = async () => {
    element.disabled = true;
    try { await runtime.hydrate(element.dataset.cloudStore); store = runtime.store; popover.remove(); shell(); toast(`已切换至${runtime.currentStore?.name || '店铺'}`); }
    catch (error) { if (!error.notified) toast(error.message); element.disabled = false; }
  });
  setTimeout(() => document.addEventListener('click', function dismiss(event) {
    if (!popover.contains(event.target) && !$('#store-switcher')?.contains(event.target)) { popover.remove(); $('#store-switcher')?.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', dismiss); }
  }), 0);
}

function help() {
  if (!runtime.enabled) return offlineHelp();
  openModal('Commerce Suite 使用说明', `<p class="modal-description">按店铺管理运费、SKU 搭配、单据与补货订阅。先在设置中连接 Shopify 并同步商品，再配置运营规则。付款订单由 Shopify Webhook 接收。</p><div class="info-note">${icon('info', 17)}<span>${runtime.production ? '当前显示真实服务端数据。配置保存、任务创建、任务处理和最终送达分别确认；尚未配置的集成不会被标为已连接。' : '当前为云端演示模式。更改保存到服务端演示存储，重启后清空；展示指标属于演示数据。'}</span></div>`);
}

function notifications() {
  if (!runtime.enabled || !runtime.production) return offlineNotifications();
  const jobs = (runtime.data.jobs || []).slice(0, 12);
  openModal('后台任务', jobs.length ? jobs.map((job) => `<div class="notification-entry"><span class="activity-icon">${icon('clock', 17)}</span><div><strong>${esc(job.type || job.kind || job.id)}</strong><p>${esc(job.status || '等待处理')}</p></div></div>`).join('') : '<p class="modal-description">暂无真实后台任务。</p>');
}

function renderLogin(message = '') {
  $('#app').innerHTML = `<main class="runtime-login"><section class="card runtime-login-card"><div class="brand-title">Commerce Suite</div><h1>登录运营工作台</h1><p class="page-description">使用部署时配置的管理员密码。店铺授权与数据同步将在登录后进行。</p><form id="runtime-login-form"><label class="field">管理员密码<input class="input" type="password" name="password" autocomplete="current-password" required autofocus></label><p id="runtime-login-error" class="runtime-error" role="alert">${esc(message)}</p><button class="button button-primary w-full" type="submit">登录</button></form></section></main>`;
  document.title = '登录 · Commerce Suite';
  $('#runtime-login-form').onsubmit = async (event) => {
    event.preventDefault(); const form = event.currentTarget; const button = $('[type="submit"]', form);
    const password = new FormData(form).get('password'); form.reset(); button.disabled = true; button.textContent = '正在登录…';
    try { await runtime.login(password); store = runtime.store || ''; shell(); }
    catch (error) { const region = $('#runtime-login-error'); if (region) region.textContent = error.status === 401 ? '密码不正确或会话未获授权，请重试。' : error.message; }
    finally { button.disabled = false; button.textContent = '登录'; }
  };
}

async function startApplication() {
  if (!runtime.enabled) return shell();
  $('#app').innerHTML = '<main class="runtime-login"><section class="card runtime-login-card"><h1>正在连接工作台…</h1><p class="page-description">正在读取服务端店铺配置与登录状态。</p></section></main>';
  try { await runtime.init(); store = runtime.store || ''; shell(); }
  catch (error) {
    if (error.status === 401) return renderLogin();
    $('#app').innerHTML = `<main class="runtime-login"><section class="card runtime-login-card"><h1>暂时无法连接工作台</h1><p class="runtime-error">${esc(error.message)}</p><button class="button button-primary" id="runtime-retry">重试连接</button></section></main>`;
    $('#runtime-retry').onclick = startApplication;
  }
}

runtime.subscribe((event) => {
  if (event.type === 'unauthorized') renderLogin();
  if (event.type === 'save-error') toast(`保存失败：${event.error.message}`);
  if (event.type === 'reload' && runtime.authenticated && $('#page-content')) renderPage();
  const status = $('#cloud-save-status');
  if (status) { status.textContent = event.type === 'saving' ? '正在保存…' : event.type === 'saved' ? '已保存到云端' : event.type === 'error' ? '保存失败' : status.textContent; status.dataset.status = event.type; }
});
window.addEventListener('beforeunload', (event) => { if (runtime.pending) { event.preventDefault(); event.returnValue = ''; } });
startApplication();

