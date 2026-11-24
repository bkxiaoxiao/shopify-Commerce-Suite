# Plus 精确组合优惠

`extensions/commerce-suite-bundle-discount` 是实际 Shopify Function，目标 `cart.lines.discounts.generate.run`，API `2026-10`。每个折扣节点的 app-owned metafield `$app:commerce-suite` / `bundle` 保存一个可信组合。浏览器的购物车属性不作为资格证据。

支持 GBP/EUR、精确变体成员及每组数量、多套与 maxSets、百分比和每组固定金额。缺少任一成员、规则停用、国家或币种不匹配时返回空操作。只对构成完整组合的商品数量打折，多余单品保留原价；固定金额按整数分摊，合计不会多或少一分。

## 构建与发布

1. 创建目标 Shopify App 的真实配置（从根目录 `shopify.app.toml.example` 复制并填写）。自用 App 的 Functions 需目标店铺具备 Plus 资格。Cloud Run 本身不会发布扩展。
2. 在此扩展目录执行 `npm ci` 安装锁定的开发工具链。检查 `schema-source.json`；生产发布前通过正确 App 身份刷新并核对 schema。
3. 在扩展目录执行 `npm run build`。必要时先 `npm run schema` / `npm run typegen`；后者访问 Shopify 的 App Management API，需要正确身份和权限。不要使用其他店铺 App 的 extension UID。
4. 本地 runner 验证示例：在此目录运行 `npm run preview -- --input fixtures/complete-bundle.json`，再验证 `incomplete-bundle.json` 和 `fixed-one-cent.json`。根据当前 CLI 参数可用 `shopify app function run --help` 查看完整选项。
5. 审查 App 身份和所有扩展/配置后，通过 Shopify CLI 发布实际 App 版本；然后在运营后台对组合点“发布结账优惠”。后端查询真实 `shop.plan.shopifyPlus`，并创建或更新真实 app discount 节点及 metafield。无资格或扩展不存在会报错，不假报已发布。
6. 在目标商店实际验证加购、删掉一项、重复数量、额外单品、混合币种、国家限制、同时存在其他折扣等情况。需要更改规则时保存配置后再次发布；后台保存与平台生效是两个动作。

普通套餐使用独立的原生 BXGY 路线；它只能表达购买指定商品后对另一个商品打折。无法表达完整多 SKU 组合的条件时，应用会拒绝近似发布。

## 已完成的本地验证

编译工具为 Shopify CLI `5.0.2`、Shopify Function SDK `2.0.1`。提供的 `dist/function.wasm` 大小 **8,795 字节**，SHA256 为 `3d5db6ba6798955062737b1762fbea1b73991f9d624ea093b647d1d59e4bb557`。编译使用 Shopify 官方 reference app 的公开 2026-10 schema，在隔离的本地配置中完成，无真实 App 登录或部署。

纯 JavaScript 的 8 个用例已通过；WASM 官方 runner 的完整组合、缺成员、固定 1 分分摊三个例子也已通过。详见扩展内 `build-report.json`。这些示例验证不等于最坏购物车规模的性能验收，也不等于真实店铺已生效。
