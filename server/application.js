import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {authenticate,assertOrigin,authorizeStore,cookies,fail,safeEqual,sessionCookie,signToken,verifyToken,verifyWebhook,verifyProxy} from './security.js';
import {validateShippingRules,quoteShipping} from './domain/shipping.js';
import {validateBundles,getRecommendations} from './domain/bundles.js';
import {publishBundle} from './discounts.js';
import {validateQuote,createInvoiceSnapshot,renderDocumentHtml} from './domain/documents.js';
import {validateSubscription} from './domain/restock.js';
import {decimalMinor} from './shopify.js';
import {generatePdf} from './pdf.js';

const uiRoot=resolve(fileURLToPath(new URL('../ui/',import.meta.url)));
const topics=new Set(['orders/paid','refunds/create','products/update','products/create','products/delete','inventory_levels/update','inventory_levels/connect','inventory_levels/disconnect','app/uninstalled','customers/data_request','customers/redact','shop/redact']);
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
const send=(res,status,type,body,headers={})=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store',...headers});res.end(body);};
async function body(req,max=1024*1024){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>max)fail(413,'请求内容过大');chunks.push(chunk);}return Buffer.concat(chunks);}
async function jsonBody(req,max){const raw=await body(req,max);if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail(415,'请使用 application/json');try{return JSON.parse(raw);}catch{fail(400,'JSON 格式错误');}}
function safeId(value){if(!/^[A-Za-z0-9_:.-]{1,200}$/.test(value||''))fail(400,'无效标识');return value;}
function assertEmail(value){if(typeof value!=='string'||value.length>254||!/^\S+@[^\s<>@]+\.[^\s<>@]+$/.test(value)||/[\r\n<>]/.test(value))fail(400,'邮箱格式错误');return value;}
const toVariant=value=>/^\d+$/.test(value||'')?`gid://shopify/ProductVariant/${value}`:value;
const visibleStores=(config,user)=>config.stores.filter(s=>!user.shop||user.shop===s.domain);
function activeInstallation(value){if(!value?.active||!value.token_cipher)fail(412,'请先连接 Shopify 店铺');}

function validateState(id,key,value,config){
  if(!config.production){if(/^(shipping-rules|commerce-bundles|commerce-documents|commerce-restock|demo-cart|demo-restock|entity|vat|sender|enabled|integration|auto-invoice|auto-restock|failure-alert|commerce-storefront-bundle)-/.test(key))return value;fail(400,'不支持此演示配置');}
  if(key===`shipping-rules-${id}`)return validateShippingRules(value);
  if(key===`commerce-bundles-${id}`){validateBundles(value);if(config.production)for(const b of value)for(const member of b.members||[b.buy,b.get].filter(Boolean)){if(!/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(member.variantId))fail(400,'组合必须选择实际 Shopify 变体');}return value;}
  if(key===`commerce-documents-${id}`){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['settings','entries'].includes(k))||(value.entries!==undefined&&(!Array.isArray(value.entries)||value.entries.length)))fail(400,'只能修改单据设置，已签发单据不可改写');
    const s=value.settings;if(!s||typeof s!=='object'||Array.isArray(s))fail(400,'单据设置无效');
    if(s.seller){if(typeof s.seller.name!=='string'||s.seller.name.length>250||!Array.isArray(s.seller.address)||s.seller.address.some(x=>typeof x!=='string'||x.length>300))fail(400,'开票主体及地址格式错误');if(s.seller.email)assertEmail(s.seller.email);}
    for(const k of ['automaticInvoices','automaticEmail','automaticCreditNotes'])if(s[k]!==undefined&&typeof s[k]!=='boolean')fail(400,`${k} 必须为布尔值`);
    if(s.language)try{Intl.getCanonicalLocales(s.language);}catch{fail(400,'单据语言格式错误');}
    return value;
  }
  if(key===`commerce-restock-${id}`){if(!value||Object.keys(value).some(k=>!['automatic','language','senderName'].includes(k))||typeof value.automatic!=='boolean')fail(400,'只能修改补货通知设置，订阅记录由接口保存');return value;}
  if(new RegExp(`^enabled-${id}-(shipping|bundles|documents|restock)$`).test(key)){if(typeof value!=='boolean')fail(400,'模块开关必须为布尔值');return value;}
  if(key===`capabilities-${id}`){if(!value||!['unknown','standard','plus'].includes(value.plan)||Object.keys(value).some(k=>!['plan','carrierAccess'].includes(k))||typeof value.carrierAccess!=='boolean')fail(400,'套餐能力配置无效');return value;}
  fail(400,'不支持修改此配置项');
}

export function createApplication({config,store,shopify,runJobs}={}){
  async function bootstrap(id,user){
    authorizeStore(user,id,config);
    const [state,productRows,documents,subscriptions,jobs,connection,orderRows]=await Promise.all([store.state(id),store.list('products',id),store.list('documents',id),store.list('subscriptions',id),store.list('jobs',id),store.installation(id),store.list('orders',id)]);
    const products=productRows.map(r=>r.data);
    const docValues=documents.map(r=>r.snapshot);
    return {mode:config.mode,stores:visibleStores(config,user),state,products,documents,orders:orderRows.map(r=>r.data),subscriptions:subscriptions.map(r=>({...r.data,id:r.id,active:r.active,status:r.data.status||(r.active?'waiting':'unsubscribed')})),jobs:jobs.map(({id,kind,status,attempts,run_at,last_error,created_at})=>({id,kind,status,attempts,run_at,last_error,created_at})),connection:{connected:!!(connection?.active&&connection.token_cipher),lastSync:state['last-sync']?.value||null},metrics:{associatedSalesMinor:null,associatedOrders:null,invoiceCount:docValues.filter(d=>d.type==='invoice').length,subscriptionCount:subscriptions.filter(r=>r.active).length,queuedJobs:jobs.filter(j=>['pending','running'].includes(j.status)).length,quoteOutstandingMinor:docValues.filter(d=>d.type==='quote').reduce((n,d)=>n+d.totalMinor,0),shippingRuleCount:state[`shipping-rules-${id}`]?.value?.length||0,bundleCount:state[`commerce-bundles-${id}`]?.value?.length||0,shippingQuoteCount:null,shippingSuccessRate:null,restockOrderCount:null}};
  }
  async function saveSubscription(id,input){
    const subscription=validateSubscription(input);
    if(!/^[A-Z]{2}$/.test(subscription.market))fail(400,'市场必须为 ISO 国家代码');
    const product=(await store.pool.query('SELECT data FROM products WHERE shop_id=$1 AND id=$2',[id,subscription.variantId])).rows[0]?.data;
    if(!product)fail(422,'此变体尚未同步，请联系商店');
    const hash=createHash('sha256').update(`${id}:${subscription.email}`).digest('hex');
    if(!await store.throttle(`subscription:${hash}`,10))fail(429,'提交过于频繁，请稍后重试');
    const row=await store.subscribe(id,{...subscription,productTitle:product.name||product.title});
    await store.audit(id,'subscription.created',{subscriptionId:row.id,variantId:subscription.variantId,market:subscription.market});
    return row;
  }
  async function proxy(req,res,url){
    const s=shopify.findShop(url.searchParams.get('shop'));if(!s)fail(403,'Shop not allowed');
    if(!verifyProxy(url.searchParams,shopify.credentials(s.domain).apiSecret))fail(401,'无效代理签名或请求已过期');
    activeInstallation(await store.installation(s.id));
    if(req.method==='POST'&&url.pathname==='/proxy/subscriptions'){const row=await saveSubscription(s.id,await jsonBody(req,16384));return json(res,201,{id:row.id,status:'subscribed'});}
    if(req.method==='GET'&&url.pathname==='/proxy/recommendations'){
      const country=url.searchParams.get('country')||s.country;if(!/^[A-Z]{2}$/.test(country))fail(400,'Invalid country');
      const requested=url.searchParams.get('product_id')||'';
      const productId=/^\d+$/.test(requested)?`gid://shopify/Product/${requested}`:requested;
      const rows=await store.list('products',s.id),bundles=await store.get(s.id,`commerce-bundles-${s.id}`,[]);
      const base=rows.map(r=>({...r.data,id:r.data.variantId||r.data.id}));
      const sourceVariants=base.filter(p=>p.productId===productId||p.id===productId);
      const requestedVariant=url.searchParams.get('variant_id');
      if(requestedVariant&&!/^(?:gid:\/\/shopify\/ProductVariant\/)?[1-9]\d*$/.test(requestedVariant))fail(400,'Invalid variant');
      const selectedVariant=requestedVariant?toVariant(requestedVariant):null;
      const source=selectedVariant?sourceVariants.find(p=>p.id===selectedVariant):sourceVariants.length===1?sourceVariants[0]:null;
      // Product IDs do not identify a choice among size/color variants. Refuse
      // to silently choose a different SKU for an exact-member discount.
      if(!source)return json(res,200,{products:[],...(sourceVariants.length>1&&!selectedVariant?{reason:'variant_required'}:{})});
      const membersOf=b=>b.members?.length?b.members:[b.buy,b.get].filter(Boolean);
      const domainBundles=bundles.map(b=>({...b,products:membersOf(b).map(member=>member.variantId)})).filter(b=>b.products.length>=2);
      const candidates=getRecommendations({bundles:domainBundles,products:base.map(p=>({...p,published:true})),productId:source.id,market:country,limit:6});
      const bundleId=candidates[0]?.bundleId;
      const selectedBundle=bundles.find(b=>b.id===bundleId);
      const members=selectedBundle?membersOf(selectedBundle):[];
      const products=[];
      for(const p of candidates.filter(candidate=>candidate.bundleId===bundleId)){
        const available=await shopify.contextualAvailability(s.id,p.id,country);
        if(available?.id!==p.id||available.availableForSale!==true||!available.price||!/^[A-Z]{3}$/.test(available.price.currencyCode||''))continue;
        const quantity=members.find(member=>member.variantId===p.id)?.quantity||1;
        // Public responses expose the storefront projection only: warehouse
        // locations/quantities, internal inventory IDs and app config stay private.
        products.push({id:p.id,variantId:p.id,productId:p.productId,name:p.name||p.title,title:p.title||p.name,variantTitle:p.variantTitle,handle:p.handle,image:p.image,priceMinor:decimalMinor(available.price.amount),currency:available.price.currencyCode,published:true,availableForSale:true,bundleId,quantity});
      }
      return json(res,200,{products,bundleId:bundleId||null,mainQuantity:members.find(member=>member.variantId===source.id)?.quantity||1});
    }
    fail(404,'接口不存在');
  }
  async function handler(req,res){
    const requestId=randomUUID();res.setHeader('X-Request-Id',requestId);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    const ancestors=["'self'",'https://admin.shopify.com',...config.stores.filter(s=>s.domain).map(s=>`https://${s.domain}`)].join(' ');
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self' https://cdn.shopify.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.shopify.com; connect-src 'self' https://*.myshopify.com; frame-ancestors ${ancestors}; base-uri 'self'; object-src 'none'; form-action 'self'`);
    try{
      const url=new URL(req.url,'http://app.local'),path=url.pathname;
      if(req.method==='GET'&&path==='/healthz')return json(res,200,{ok:true});
      if(req.method==='GET'&&path==='/readyz'){await store.ready();return json(res,200,{ok:true});}
      if(req.method==='GET'&&path==='/runtime-config.js'){
        const shop=url.searchParams.get('shop'),s=config.stores.find(x=>x.domain===shop);
        const runtime={mode:config.mode,stores:config.stores,shopifyApiKey:s?config.credentialsFor(s.domain).apiKey:null};
        return send(res,200,'text/javascript; charset=utf-8',`window.__CLOUD_RUNTIME__=${JSON.stringify(runtime).replace(/</g,'\\u003c')};`);
      }
      if(req.method==='POST'&&path==='/internal/jobs/run'){
        if(!config.taskSecret||!safeEqual(req.headers['x-internal-task-secret'],config.taskSecret))fail(401,'无效任务凭据');
        const result=await runJobs(5);return json(res,200,{ok:true,...result});
      }
      if(req.method==='GET'&&path==='/auth/start'){
        const handoff=verifyToken(url.searchParams.get('token'),config.authSecret);
        if(handoff.purpose!=='oauth-handoff'||!handoff.nonce||!config.stores.some(s=>s.id===handoff.storeId))fail(401,'无效授权启动凭据');
        const nonceHash=createHash('sha256').update(`handoff:${handoff.nonce}`).digest('hex');
        if(!await store.consumeNonce(nonceHash,handoff.storeId))fail(401,'授权启动凭据已使用或过期');
        // Set OAuth state as a first-party top-level response. Setting a Lax
        // cookie inside the Shopify iframe is blocked by many browsers.
        const result=await shopify.begin(handoff.storeId);res.setHeader('Set-Cookie',result.cookie);
        res.writeHead(303,{Location:result.url,'Cache-Control':'no-store'});return res.end();
      }
      if(req.method==='GET'&&path==='/auth/callback'){
        const s=await shopify.callback(req,url);
        res.setHeader('Set-Cookie',[sessionCookie(signToken({role:'admin',shop:s.domain},config.authSecret),config.production),'cs_oauth=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0']);
        res.writeHead(303,{Location:`/?shop=${encodeURIComponent(s.domain)}#settings`});return res.end();
      }
      if(req.method==='POST'&&path==='/webhooks'){
        const raw=await body(req,4*1024*1024),s=shopify.findShop(req.headers['x-shopify-shop-domain']);
        if(!s||!verifyWebhook(raw,req.headers['x-shopify-hmac-sha256'],shopify.credentials(s.domain).apiSecret))fail(401,'无效 Webhook 签名');
        const topic=req.headers['x-shopify-topic'],eventId=req.headers['x-shopify-event-id']||req.headers['x-shopify-webhook-id'];
        if(!topics.has(topic)||!eventId||eventId.length>200)fail(400,'不支持的事件或缺少事件标识');
        let data;try{data=JSON.parse(raw);}catch{fail(400,'Invalid JSON');}
        const inserted=await store.receipt(s.id,eventId,topic,data);return json(res,200,{received:true,duplicate:!inserted});
      }
      const carrier=path.match(/^\/callbacks\/shipping\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)$/);
      if(req.method==='POST'&&carrier){
        const id=carrier[1],installation=await store.installation(id);
        if(!installation?.active||!safeEqual(installation.carrier_token,carrier[2]))fail(401,'无效运费回调凭据');
        const input=await jsonBody(req),s=config.stores.find(s=>s.id===id);if(!s)fail(404,'Store not found');
        if(input.rate?.currency!==s.currency)return json(res,200,{rates:[]});
        try{return json(res,200,quoteShipping({...input.rate,rules:await store.get(id,`shipping-rules-${id}`,[])}));}catch(error){if(error.status===400)return json(res,200,{rates:[]});throw error;}
      }
      if(path.startsWith('/proxy/'))return await proxy(req,res,url);
      if(path==='/unsubscribe'){
        const token=url.searchParams.get('token'),p=verifyToken(token,config.authSecret);if(p.purpose!=='unsubscribe')fail(403,'无效退订链接');
        if(req.method==='GET')return send(res,200,'text/html; charset=utf-8',`<!doctype html><meta charset="utf-8"><title>Unsubscribe</title><main><h1>Cancel stock notification</h1><p>This cancels only this product notification.</p><form method="post"><button type="submit">Confirm unsubscribe</button></form></main>`);
        if(req.method==='POST'){await store.unsubscribe(p.shopId,p.subscriptionId);return send(res,200,'text/html; charset=utf-8','<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><h1>Stock notification cancelled</h1>');}fail(405,'不支持此请求方法');
      }
      if(path.startsWith('/api/')){
        assertOrigin(req,config);
        if(req.method==='POST'&&path==='/api/login'){
          if(!config.adminPassword)fail(412,'管理员密码登录未启用，请从 Shopify 管理后台打开应用');
          if(!await store.throttle('admin-login',20))fail(429,'登录尝试过于频繁，请 15 分钟后重试');
          const {password}=await jsonBody(req,4096);if(!safeEqual(password,config.adminPassword))fail(401,'密码错误');
          res.setHeader('Set-Cookie',sessionCookie(signToken({role:'admin'},config.authSecret),config.production));return json(res,200,{ok:true});
        }
        const user=authenticate(req,config);
        if(req.method==='POST'&&path==='/api/logout'){res.setHeader('Set-Cookie',sessionCookie('',config.production,true));return json(res,200,{ok:true});}
        if(req.method==='GET'&&path==='/api/bootstrap')return json(res,200,await bootstrap(url.searchParams.get('store')||visibleStores(config,user)[0]?.id,user));
        const stateRoute=path.match(/^\/api\/state\/([a-z0-9-]+)\/([^/]+)$/);
        if(req.method==='PUT'&&stateRoute){
          const [,id,encodedKey]=stateRoute;authorizeStore(user,id,config);const key=decodeURIComponent(encodedKey);const input=await jsonBody(req);
          if(!Number.isInteger(input.revision)||input.revision<0)fail(400,'revision 必须为非负整数');
          const value=validateState(id,key,input.value,config),revision=await store.put(id,key,value,input.revision);
          await store.audit(id,'settings.updated',{key,revision});return json(res,200,{revision});
        }
        const route=path.match(/^\/api\/stores\/([a-z0-9-]+)\/(.*)$/);
        if(!route)fail(404,'接口不存在');
        const [,id,action]=route,s=authorizeStore(user,id,config);
        if(req.method==='POST'&&action==='connect'){if(!s.domain)fail(412,'请先配置店铺域名');shopify.credentials(s.domain);const nonce=randomUUID();await store.nonce(createHash('sha256').update(`handoff:${nonce}`).digest('hex'),id,new Date(Date.now()+60000));const token=signToken({purpose:'oauth-handoff',storeId:id,nonce},config.authSecret,60);return json(res,200,{url:`${config.appUrl}/auth/start?token=${encodeURIComponent(token)}`});}
        if(req.method==='POST'&&action==='sync'){activeInstallation(await store.installation(id));const jobId=await store.enqueue(id,'sync',{resource:'products'});await store.audit(id,'sync.requested',{jobId});return json(res,202,{jobId});}
        if(req.method==='POST'&&action==='carrier'){activeInstallation(await store.installation(id));const result=await shopify.registerCarrier(id);await store.audit(id,'carrier.registered',{id:result.id});return json(res,201,{carrier:result});}
        if(req.method==='POST'&&action==='shipping/test'){const input=await jsonBody(req);if(input.currency!==s.currency)fail(400,'请使用店铺本位币进行运费测试');return json(res,200,quoteShipping({...input,rules:await store.get(id,`shipping-rules-${id}`,[])}));}
        if(req.method==='POST'&&action==='quotes'){
          const input=await jsonBody(req);if(input.currency!==s.currency)fail(400,'报价币种必须与当前店铺一致');
          const quote=validateQuote({...input,issuedAt:input.issuedAt||new Date().toISOString(),taxesIncluded:input.taxesIncluded??false});
          const settings=(await store.get(id,`commerce-documents-${id}`,{})).settings||{};
          const key=req.headers['idempotency-key']?safeId(req.headers['idempotency-key']):randomUUID();
          const document=await store.createDocument(id,`quote:${key}`,'quote',number=>createInvoiceSnapshot({order:quote,settings,number,type:'quote'}));
          await store.audit(id,'quote.created',{documentId:document.id});return json(res,201,{document});
        }
        const docRoute=action.match(/^documents\/([A-Za-z0-9-]+)\.(pdf|html)$/);
        if(req.method==='GET'&&docRoute){const document=await store.document(id,docRoute[1]);if(!document)fail(404,'单据不存在');
          if(docRoute[2]==='html')return send(res,200,'text/html; charset=utf-8',renderDocumentHtml(document.snapshot));
          return send(res,200,'application/pdf',await generatePdf(document.snapshot),{'Content-Disposition':`attachment; filename="${document.snapshot.number}.pdf"`});
        }
        const mailRoute=action.match(/^documents\/([A-Za-z0-9-]+)\/send$/);
        if(req.method==='POST'&&mailRoute){if(!config.resendApiKey||!config.mailFrom)fail(412,'请先配置邮件服务及通过验证的发件人');const document=await store.document(id,mailRoute[1]);if(!document)fail(404,'单据不存在');const input=await jsonBody(req,4096),to=assertEmail(input.to||document.snapshot.customer.email);const requestKey=req.headers['idempotency-key']?safeId(req.headers['idempotency-key']):randomUUID();const jobId=await store.enqueue(id,'document-email',{documentId:document.id,to},`document-mail:${id}:${document.id}:${requestKey}`);await store.audit(id,'document.send_requested',{documentId:document.id,jobId});return json(res,202,{jobId});}
        if(req.method==='POST'&&action==='subscriptions'){const subscription=await saveSubscription(id,await jsonBody(req,16384));return json(res,201,{subscription});}
        const retry=action.match(/^jobs\/(.+)\/retry$/);
        if(req.method==='POST'&&retry){const jobId=decodeURIComponent(retry[1]);const prior=(await store.pool.query('SELECT kind,payload FROM jobs WHERE shop_id=$1 AND id=$2',[id,jobId])).rows[0];if(prior&&['document-email','restock-email'].includes(prior.kind)&&prior.payload.deliveryStartedAt&&Date.now()-Date.parse(prior.payload.deliveryStartedAt)>23*3600000)fail(409,'邮件已超出提供方的安全幂等窗口，请先核对发送记录，再通过单据发送创建新任务');const {rows}=await store.pool.query("UPDATE jobs SET status='pending',attempts=0,run_at=now(),last_error=NULL,lease_token=NULL,lease_until=NULL WHERE shop_id=$1 AND id=$2 AND status='failed' RETURNING id",[id,jobId]);if(!rows.length)fail(409,'仅可重试已失败任务');await store.audit(id,'job.retried',{jobId});return json(res,202,{jobId});}
        const discount=action.match(/^bundles\/([^/]+)\/discount$/);
        if(req.method==='POST'&&discount){
          activeInstallation(await store.installation(id));
          const bundleId=decodeURIComponent(discount[1]),bundles=await store.get(id,`commerce-bundles-${id}`,[]),bundle=bundles.find(b=>b.id===bundleId);if(!bundle)fail(404,'组合不存在');
          return json(res,200,await publishBundle({store,shopify,storeId:id,bundle}));
        }
        fail(404,'接口不存在');
      }
      if(req.method!=='GET'&&req.method!=='HEAD')fail(405,'不支持此请求方法');
      let decoded;try{decoded=decodeURIComponent(path);}catch{fail(400,'Invalid path');}
      const file=resolve(uiRoot,decoded==='/'?'index.html':`.${decoded}`);
      if(!file.startsWith(uiRoot+sep)||!['.html','.js','.css','.svg'].includes(extname(file))||file.endsWith('package.json')||(config.production&&(file.includes('standalone')||file.includes('screenshots'))))fail(404,'文件不存在');
      let content;try{content=await readFile(file);}catch{fail(404,'文件不存在');}
      if(extname(file)==='.html'&&file.endsWith('index.html')){
        const shop=url.searchParams.get('shop'),s=config.stores.find(s=>s.domain===shop),apiKey=s&&config.credentialsFor(s.domain).apiKey;
        if(apiKey)content=Buffer.from(content.toString().replace('</head>',`<meta name="shopify-api-key" content="${String(apiKey).replace(/[^A-Za-z0-9_-]/g,'')}"><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script></head>`));
      }
      send(res,200,{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}[extname(file)],req.method==='HEAD'?'':content);
    }catch(error){
      if(res.headersSent){res.destroy();return;}
      const status=Number.isInteger(error.status)?error.status:500;
      if(status>=500)console.error(JSON.stringify({severity:'ERROR',requestId,status,code:error.code||'INTERNAL_ERROR'}));
      json(res,status,{error:status>=500?'服务暂时无法完成请求，请查看任务或服务日志':error.message,requestId});
    }
  }
  return createServer(handler);
}
