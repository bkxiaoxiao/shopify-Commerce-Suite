import {fail} from './security.js';
import {nativeDiscountInput} from './domain/bundles.js';

/** Shopify owns checkout execution; the local price preview never grants a discount. */
export async function publishBundle({store,shopify,storeId,bundle,functionHandle='commerce-suite-bundle-discount'}){
  const native=nativeDiscountInput(bundle),key=`discount-${bundle.id}`,published=await store.get(storeId,key);
  let result;
  if(native.action==='deactivate'){
    if(!published?.id)return {status:'inactive'};
    await shopify.graphql(storeId,'mutation Stop($id:ID!){discountAutomaticDeactivate(id:$id){automaticDiscountNode{id} userErrors{field message}}}',{id:published.id});
    result={...published,status:'inactive'};
  }else if(native.supported){
    if(published?.id&&published.kind==='function')fail(409,'此组合已使用 Functions，请新建组合后发布不同的折扣类型');
    const update=!!published?.id,mutation=update?'discountAutomaticBxgyUpdate':'discountAutomaticBxgyCreate';
    const data=await shopify.graphql(storeId,update?'mutation Update($id:ID!,$input:DiscountAutomaticBxgyInput!){discountAutomaticBxgyUpdate(id:$id,automaticBxgyDiscount:$input){automaticDiscountNode{id} userErrors{field message}}}':'mutation Create($input:DiscountAutomaticBxgyInput!){discountAutomaticBxgyCreate(automaticBxgyDiscount:$input){automaticDiscountNode{id} userErrors{field message}}}',{...(update?{id:published.id}:{}),input:native.input});
    result={id:data[mutation].automaticDiscountNode.id,kind:'native-bxgy',status:'published'};
  }else{
    if(!['percentage','fixed'].includes(bundle.discountType||'percentage'))fail(422,native.reason);
    const plan=await shopify.graphql(storeId,'query Capability{shop{currencyCode plan{shopifyPlus}}}');
    if(plan.shop?.plan?.shopifyPlus!==true)fail(422,'精确整组优惠需要此自用 App 安装于 Shopify Plus 店铺；普通套餐请使用买 X 享 Y 折扣');
    if(published?.id&&published.kind!=='function')fail(409,'此组合已使用原生优惠，请新建组合后发布 Functions 折扣');
    const update=!!published?.id;
    const currency=bundle.currency||plan.shop.currencyCode;
    if(!['GBP','EUR'].includes(currency))fail(422,'当前精确折扣扩展支持 GBP/EUR，请确认店铺和规则币种');
    if(bundle.markets?.some(m=>!/^[A-Z]{2}$/.test(m)))fail(422,'精确组合的市场限制请使用两个字母的国家代码');
    let field={namespace:'$app:commerce-suite',key:'bundle',type:'json',value:JSON.stringify({...bundle,currency})};
    if(update){const existing=await shopify.graphql(storeId,'query Configuration($id:ID!){discountNode(id:$id){metafield(namespace:"$app:commerce-suite",key:"bundle"){id}}}',{id:published.id});if(existing.discountNode?.metafield?.id)field={...field,id:existing.discountNode.metafield.id};}
    const input={title:bundle.name,functionHandle,discountClasses:['PRODUCT'],startsAt:bundle.startsAt||new Date().toISOString(),endsAt:bundle.endsAt||null,combinesWith:{orderDiscounts:false,productDiscounts:false,shippingDiscounts:false},metafields:[field]};
    const mutation=update?'discountAutomaticAppUpdate':'discountAutomaticAppCreate';
    const data=await shopify.graphql(storeId,update?'mutation Update($id:ID!,$input:DiscountAutomaticAppInput!){discountAutomaticAppUpdate(id:$id,automaticAppDiscount:$input){automaticAppDiscount{discountId} userErrors{field message}}}':'mutation Create($input:DiscountAutomaticAppInput!){discountAutomaticAppCreate(automaticAppDiscount:$input){automaticAppDiscount{discountId} userErrors{field message}}}',{...(update?{id:published.id}:{}),input});
    result={id:data[mutation].automaticAppDiscount.discountId,kind:'function',status:'published'};
  }
  await store.set(storeId,key,result);await store.audit(storeId,'discount.updated',{bundleId:bundle.id,...result});return result;
}
