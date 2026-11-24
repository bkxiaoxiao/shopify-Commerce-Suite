import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes} from 'node:crypto';
import {loadConfig} from '../server/config.js';
import {createStore} from '../server/store.js';
import {ShopifyService} from '../server/shopify.js';
import {seal,unseal} from '../server/security.js';

async function fixture(t,fetcher){
  const config=loadConfig({APP_MODE:'demo',APP_URL:'http://localhost:8080',STORES_JSON:JSON.stringify([{id:'uk',name:'Fixture',domain:'fixture.myshopify.com',country:'GB',currency:'GBP'}]),SHOPIFY_API_KEY:'fixture-key',SHOPIFY_API_SECRET:randomBytes(32).toString('base64url'),SHOPIFY_STOREFRONT_ACCESS_TOKEN:randomBytes(32).toString('base64url')});
  const store=await createStore(config);await store.init({skipLock:true});t.after(()=>store.close());config.mode='production';
  return {config,store,shopify:new ShopifyService(config,store,fetcher)};
}

test('demo cannot connect or use a real Shopify credential even when supplied by mistake',async t=>{
  const {config,store}=await fixture(t,()=>{throw new Error('External request must not occur');});
  const demo=new ShopifyService({...config,mode:'demo'},store,()=>{throw new Error('External request must not occur');});
  await assert.rejects(demo.begin('uk'),{status:412});
  await assert.rejects(demo.accessToken('uk'),{status:412});
});

test('OAuth binds browser state, verifies HMAC and persists only encrypted expiring tokens',async t=>{
  const token={access_token:randomBytes(32).toString('base64url'),refresh_token:randomBytes(32).toString('base64url'),expires_in:3600,refresh_token_expires_in:86400};
  let exchanges=0;
  const {config,store,shopify}=await fixture(t,async(url,options)=>{exchanges++;assert.equal(new URL(url).pathname,'/admin/oauth/access_token');assert.equal(JSON.parse(options.body).expiring,1);return Response.json(token);});
  const begin=await shopify.begin('uk'),state=new URL(begin.url).searchParams.get('state');
  const url=new URL('http://localhost:8080/auth/callback');url.search=new URLSearchParams({shop:'fixture.myshopify.com',state,code:'one-time-code',timestamp:String(Math.floor(Date.now()/1000))});
  const message=[...url.searchParams].sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>`${k}=${v}`).join('&');url.searchParams.set('hmac',createHmac('sha256',config.credentialsFor('fixture.myshopify.com').apiSecret).update(message).digest('hex'));
  const req={headers:{cookie:begin.cookie.split(';')[0]}};
  await assert.rejects(shopify.callback({headers:{}},url),{status:401});assert.equal(exchanges,0);
  await shopify.callback(req,url);
  const installation=await store.installation('uk');assert.ok(!installation.token_cipher.includes(token.access_token));assert.equal(unseal(installation.token_cipher,config.encryptionKey).refresh_token,token.refresh_token);
  assert.equal((await store.list('jobs','uk')).length,1);
  await assert.rejects(shopify.callback(req,url),{status:401});assert.equal(exchanges,1);
});

test('concurrent requests rotate an expired offline credential once under the database lock',async t=>{
  let refreshes=0;
  const newToken=randomBytes(32).toString('base64url');
  const {config,store,shopify}=await fixture(t,async(url,options)=>{refreshes++;assert.equal(JSON.parse(options.body).grant_type,'refresh_token');return Response.json({access_token:newToken,refresh_token:'new-refresh',expires_in:3600,refresh_token_expires_in:86400});});
  await store.saveInstallation('uk',seal({access_token:'expired-access',refresh_token:'prior-refresh',expiresAt:Date.now()-1,refreshExpiresAt:Date.now()+60000},config.encryptionKey));
  const values=await Promise.all([shopify.accessToken('uk'),shopify.accessToken('uk')]);assert.equal(values.every(v=>v===newToken),true);assert.equal(refreshes,1);
  assert.equal(unseal((await store.installation('uk')).token_cipher,config.encryptionKey).refresh_token,'new-refresh');
});

test('market availability sends a used country context and does not substitute an Admin token',async t=>{
  const {config,shopify}=await fixture(t,async(url,options)=>{const input=JSON.parse(options.body);assert.match(input.query,/@inContext\(country:\$country\)/);assert.equal(input.variables.country,'DE');assert.equal(options.headers['X-Shopify-Access-Token'],undefined);assert.equal(options.headers['Shopify-Storefront-Private-Token'],config.credentialsFor('fixture.myshopify.com').storefrontToken);return Response.json({data:{node:{id:input.variables.id,availableForSale:false}}});});
  assert.equal((await shopify.contextualAvailability('uk','gid://shopify/ProductVariant/1','DE')).availableForSale,false);
});

test('catalog sync keeps inactive inventory and incomplete location counts explicit',async t=>{
  const {store,shopify}=await fixture(t,async()=>{throw new Error('No network expected');});
  shopify.graphql=async(_,query)=>{assert.match(query,/products\(first:1,after:\$after\)/);assert.match(query,/variants\(first:10\)/);assert.match(query,/nodes\{isActive location/);assert.match(query,/inventoryLevels\(first:20\)[\s\S]+pageInfo/);return {products:{nodes:[{id:'gid://shopify/Product/1',title:'Fixture product',handle:'fixture',status:'ACTIVE',variants:{nodes:[{id:'gid://shopify/ProductVariant/1',title:'Default',sku:'fixture',price:'10.29',inventoryQuantity:5,inventoryPolicy:'DENY',inventoryItem:{id:'gid://shopify/InventoryItem/1',tracked:true,measurement:{weight:{value:1.5,unit:'KILOGRAMS'}},inventoryLevels:{nodes:[{isActive:false,location:{id:'location',isActive:true,fulfillsOnlineOrders:true},quantities:[{name:'available',quantity:5}]}],pageInfo:{hasNextPage:true}}}}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}}};};
  await shopify.syncProducts('uk');
  const data=(await store.list('products','uk'))[0].data;assert.equal(data.priceMinor,1029);assert.equal(data.grams,1500);assert.equal(data.inventoryLevels[0].isActive,false);assert.equal(data.inventoryLevelsTruncated,true);assert.equal(data.published,false);
});

test('bounded catalog queries preserve durable product-cursor pagination',async t=>{
  const {store,shopify}=await fixture(t,async()=>{throw new Error('No network expected');});
  let calls=0;
  shopify.graphql=async(_,query,variables)=>{calls++;assert.match(query,/products\(first:1,after:\$after\)/);assert.equal(variables.after,'current-cursor');return {products:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'next-product-cursor'}}};};
  assert.equal(await shopify.syncProducts('uk','current-cursor'),0);
  const [job]=await store.list('jobs','uk');assert.equal(job.kind,'sync');assert.equal(job.payload.cursor,'next-product-cursor');
  assert.equal((await store.get('uk','last-sync')).complete,false);assert.equal(calls,1);
});
