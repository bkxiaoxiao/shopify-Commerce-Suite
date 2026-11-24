import { randomBytes } from 'node:crypto';

export function loadConfig(env=process.env) {
  const mode=env.APP_MODE||'demo';
  if(!['production','demo'].includes(mode)) throw new Error('APP_MODE must be production or demo');
  const production=mode==='production';
  const requireValue=(key)=>{if(!env[key])throw new Error(`${key} is required in production`);return env[key];};
  const authSecret=production?requireValue('AUTH_SECRET'):(env.AUTH_SECRET||randomBytes(48).toString('base64url'));
  const encryptionKey=production?requireValue('ENCRYPTION_KEY'):(env.ENCRYPTION_KEY||randomBytes(32).toString('base64'));
  if(authSecret.length<32)throw new Error('AUTH_SECRET must contain at least 32 characters');
  if(!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey)||Buffer.from(encryptionKey,'base64').length!==32||Buffer.from(encryptionKey,'base64').toString('base64')!==encryptionKey)throw new Error('ENCRYPTION_KEY must be canonical base64 for exactly 32 bytes');
  const appUrl=env.APP_URL||'http://localhost:8080';
  const parsed=new URL(appUrl);
  if(production&&parsed.protocol!=='https:')throw new Error('Production APP_URL must use HTTPS');
  if(parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new Error('APP_URL must be an origin without credentials or a path');
  if(production)requireValue('DATABASE_URL');
  if(env.DATABASE_URL&&!/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL))throw new Error('DATABASE_URL must use postgres:// or postgresql://');
  if(env.ADMIN_PASSWORD&&env.ADMIN_PASSWORD.length<16)throw new Error('ADMIN_PASSWORD must contain at least 16 characters');
  const adminUserIds=new Set((env.SHOPIFY_ADMIN_USER_IDS||'').split(',').filter(Boolean));
  if([...adminUserIds].some(id=>!/^\d+$/.test(id)))throw new Error('SHOPIFY_ADMIN_USER_IDS must contain comma-separated numeric staff IDs');
  if(production&&!env.ADMIN_PASSWORD&&!adminUserIds.size)throw new Error('Configure ADMIN_PASSWORD or SHOPIFY_ADMIN_USER_IDS to enable an administrator login');
  let stores=env.STORES_JSON?JSON.parse(env.STORES_JSON):(production?[]:[{id:'uk',name:'英国演示店',country:'GB',currency:'GBP',domain:null},{id:'eu',name:'欧洲演示店',country:'DE',currency:'EUR',domain:null}]);
  if(!Array.isArray(stores)||(!stores.length&&production))throw new Error('STORES_JSON must configure at least one store');
  const seen=new Set();
  stores=stores.map(store=>{
    if(!/^[a-z][a-z0-9-]{0,31}$/.test(store.id)||seen.has(store.id))throw new Error('Store IDs must be unique safe identifiers');
    seen.add(store.id);
    if(production&&!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store.domain||''))throw new Error(`A myshopify.com domain is required for ${store.id}`);
    if(!/^[A-Z]{2}$/.test(store.country||'')||!/^[A-Z]{3}$/.test(store.currency||''))throw new Error('Stores require country and currency codes');
    return {id:store.id,name:String(store.name||store.id),domain:store.domain||null,country:store.country,currency:store.currency};
  });
  if(new Set(stores.filter(s=>s.domain).map(s=>s.domain)).size!==stores.filter(s=>s.domain).length)throw new Error('Store domains must be unique');
  const credentials=JSON.parse(env.SHOPIFY_SHOP_CREDENTIALS||'{}');
  const allowlist=new Set((env.SHOPIFY_SHOPS_ALLOWLIST||stores.map(s=>s.domain).filter(Boolean).join(',')).split(',').filter(Boolean));
  for(const s of stores)if(s.domain&&!allowlist.has(s.domain))throw new Error(`Store ${s.id} is outside SHOPIFY_SHOPS_ALLOWLIST`);
  return {mode,production,port:Number(env.PORT||8080),host:'0.0.0.0',appUrl:parsed.origin,authSecret,encryptionKey,
    databaseUrl:env.DATABASE_URL,dbAutoMigrate:env.DB_AUTO_MIGRATE!=='false',adminPassword:env.ADMIN_PASSWORD,
    taskSecret:env.INTERNAL_TASK_SECRET,mailFrom:env.MAIL_FROM,resendApiKey:env.RESEND_API_KEY,stores,allowlist,
    shopifyApiVersion:env.SHOPIFY_API_VERSION||'2026-10',shopifyScopes:env.SHOPIFY_SCOPES||'read_products,read_inventory,read_locations,read_orders,write_app_proxy,write_shipping,write_discounts',
    adminUserIds,
    credentialsFor(shop){return credentials[shop]||{apiKey:env.SHOPIFY_API_KEY,apiSecret:env.SHOPIFY_API_SECRET,storefrontToken:env.SHOPIFY_STOREFRONT_ACCESS_TOKEN};}};
}
