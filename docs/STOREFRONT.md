# 店铺前台接入

`extensions/commerce-suite` 提供两个 Shopify Theme App Extension blocks：商品搭配推荐和缺货到货提醒。尚未关联或发布到真实 Shopify App，也未在真实主题验收；Cloud Run 服务器发布与 Shopify 扩展发布是两个步骤。Plus 折扣 Function 已单独编译并验证本地 WASM，见 [Functions 说明](FUNCTIONS.md)。

## 配置与安装

1. 按 `docs/CLOUD_RUN.md` 配置真实店铺、凭据和 HTTPS 服务，并完成允许店铺的安装授权。
2. 从 `shopify.app.toml.example` 建立每个实际 App 自己的配置，填写 client ID、最终服务器域名和 `/auth/callback`。保留每店 App 身份隔离；不要复用其他 App 的扩展 uid。
3. App Proxy 路由为店铺同源 `/apps/commerce-suite`，转发至 `${APP_URL}/proxy`。示例中为明确的 `REPLACE_APP_HOST` 占位符，Shopify TOML 不会自动展开 shell 环境变量。
4. App Proxy 配置需要 `write_app_proxy` scope。修改 scope 后需要部署对应配置并完成相应店铺授权；仅修改本地文件不会改变生产安装。[官方 App Proxy 说明](https://shopify.dev/docs/apps/build/online-store/app-proxies)
5. 使用当前 Shopify CLI 连接正确的开发 App/开发店，按 CLI 为此 App 生成或关联扩展身份，再本地检查、预览。本仓库不包含真实 client ID 或已发布 uid，未执行任何 `shopify app deploy`。准备发布时先审查 App 身份、目标店铺、scope 和完整变更。
6. 扩展发布后，在主题编辑器中加入 **Product recommendations** 和 **Back in stock signup**。所在主题 section 必须支持 `@app`；也可以加入独立 Apps section。为每种实际商品模板检查位置。[主题 App blocks](https://shopify.dev/docs/storefronts/themes/architecture/blocks/app-blocks)

Shopify CLI 的 `app dev` 可能修改开发店的 App 配置，请只选择明确的开发店。App Proxy 的 prefix/subpath 可被商家修改，已安装店铺不一定随 App 默认配置改变；实际路径不同需在两个 block 的 **App proxy path** 设置中保持一致。

## 前台行为

- 推荐请求：`GET /apps/commerce-suite/recommendations?product_id=<ProductID>&variant_id=<SelectedVariantID>&country=<ISO国家>`。服务器验证变体属于此商品。当前变体变化后重新加载，并取消/丢弃旧请求；Shopify 转发时添加签名参数，浏览器不构造签名，不接触 App secret。
- 响应中的推荐产品再通过同源、包含语言前缀的 `/products/<handle>.js` 取得当前市场可购变体与价格。只接受服务器指定的精确 variant；该 variant 缺货时跳过，不自行用同商品的另一个 variant 替代。需要 selling plan 的商品被跳过。不把后台的默认店铺价格用于其他币种的自动换算。
- 加购使用同源 Shopify `cart/add.js`，按响应的 `quantity` 与 `mainQuantity` 添加真实数量，并带 `_commerce_bundle` 属性。属性只用于标记来源；服务器或 Function 不能把这个可由浏览器修改的属性当作优惠资格的可信证明。缺少完整组合时必须由 Shopify 的真实规则拒绝组合优惠。
- 推荐块显示选中商品正常售价合计，不自行改价、不生成“已减免”结果。真实优惠需通过后台已发布的原生规则或支持的 Function 生效，并以实际购物车/结账结果为准。
- 默认成功后打开购物车，保证无需适配主题购物车抽屉也能看到真实结果。关闭该选项时发出 `commerce-suite:cart-added` 事件，其 `detail.items` 来自 Shopify 响应；主题需要自行接入抽屉/角标刷新。
- 主商品变体读取实际商品表单 `[name="id"]`；支持标准 change、自定义 variant 事件、URL `variant` 变更和可见页面低频检查。多个相同商品表单时可配置准确的 CSS selector，避免误选 quick-add 表单。
- 缺货表单跟随选中变体；可购变体隐藏订阅表单，选中缺货变体时显示。模板的 `variant.available` 是页面加载时信息，最终补货发送前仍须服务器再次核验实际市场、库存与仓库资格。
- 订阅请求：`POST /apps/commerce-suite/subscriptions`，JSON 包含 `email`、`variantId`、`market`、`language`、`marketingConsent`。Newsletter 同意选项默认不显示，显示后也不默认勾选。用户请求单个商品补货提醒，不代表同意一般营销。
- 主题编辑器中阻止真实加购和提交订阅；应打开实际开发店前台测试。

前台只使用 DOM `textContent` 和安全 URL，不把 API 商品名作为 HTML 插入；Liquid 中商品标题写入 JSON 时转义 `<` 等字符。所有请求保持同源，无前端 Admin token、内部任务 secret 或跨域管理 API 调用。[扩展文件结构](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration)、[App Proxy 验签](https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies)

## 服务器必须匹配的契约

`/proxy/*` 由服务器按店铺身份、签名与时间戳验证；对订阅额外验证邮箱、变体、市场和频率，不能因请求来自代理就认为用户身份或库存是真实的。后台管理会话不能传递给这些公开表单。

```json
{
  "products": [
    {"variantId":"gid://shopify/ProductVariant/123","productId":"gid://shopify/Product/456","name":"Training rack","title":"Default Title","priceMinor":19900,"currency":"GBP","image":"https://cdn.shopify.com/example.jpg","handle":"training-rack","bundleId":"bundle-1","quantity":2,"mainQuantity":1}
  ]
}
```

不要直接把数据库安装记录、邮箱订阅、后台配置或 secret 加入该响应。返回空推荐是有效结果，不应以演示商品补齐生产空数据。

## 验收

1. 两个实际主题模板及移动端正常；含语言前缀的 `/de/` 等路径仍请求正确的 product/cart 路由。
2. 操作真实商品表单，连续切换有货/缺货变体，订阅中的 variant ID 与屏幕选择一致；两个商品表单不能串选。
3. 推荐价格、精确变体及数量与真实加购一致；缺货推荐不静默换成其他变体，未发布和要求订阅购买的推荐不被错误加入。
4. 输入包含尖括号的商品名或说明时只显示文本，不执行脚本；恶意图片协议不加载。
5. 单次加购只发送一次请求，失败后可重试；查看真实购物车数量、变体、来源属性与平台优惠，不以组件预览代替结账验收。
6. 默认订阅只申请到货提醒；重复登记保持同一订阅 ID，用户收到的退订链接能终止该商品提醒。
7. 英语、德语、法语文案与 GBP/EUR 金额正确；未验证的其他市场不承诺自动覆盖。

`test/storefront.test.js` 验证安全 URL/加购载荷、真实表单选择、变体选择顺序与扩展 schema。它不替代 Shopify CLI Theme Check、浏览器交互或真实店铺签名代理/购物车验收。
