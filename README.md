# Commerce Suite — UK / EU internal Shopify app

公司内部多店使用的四合一应用：邮编运费、搭配销售、财务单据、补货通知。本次将原有交互原型接上 Node.js 服务、PostgreSQL、Shopify 授权和持久任务队列，提供 Cloud Run 部署包。

## 本地查看

使用 Node.js 22.12 或以上：

```sh
npm ci
npm run dev
```

打开 http://localhost:8080 。默认 `APP_MODE=demo`，带有演示数据标识；仅用于查看交互。没有数据库连接时使用临时 PGlite PostgreSQL，重启清空。演示模式不会发送真实邮件。

正式模式必须配置 PostgreSQL、HTTPS `APP_URL`、真实店铺 allowlist 和安全密钥，否则启动失败；不会退回浏览器演示数据。前端保存经后端确认、按店铺隔离，冲突会回滚并提示刷新。

## 当前实现

| 模块 | 已实现的代码 | 仍需目标环境验收 |
| --- | --- | --- |
| 运费 | 国家/邮编/区间重量、固定费、偏远附加、禁运、覆盖范围内满额免运费；试算、CarrierService 注册和真实回调 | 店铺 CCS 资格、配送区域/拆单行为、实际结账与压力测试 |
| 搭配销售 | 实际变体组合配置、主题推荐/加购、完整成员和数量校验、原生 BXGY 发布；Plus 精确折扣 Function | Shopify 扩展构建/发布、Plus 资格、实际购物车删件/多币种/叠加验证 |
| 单据 | 报价创建；付款事件发票；部分退款贷项；原始税额对账；并发编号、不可变快照、多语言 HTML/真实 PDF、邮件任务 | Shopify 订单字段/退款样本、财务确认主体/VAT 与各国票样、真实邮件提供方 |
| 补货 | 商品/变体/市场订阅；独立营销同意；线上可售库存 0→正检测；发送前复查市场和库存；退订与任务去重 | 私有 Storefront token、目标市场发布状态、真实库存事件及邮件收件验证 |
| 共同能力 | 多店隔离、密码或 App Bridge 身份、OAuth state/HMAC、令牌加密/续期、Webhook 去重、CAS 保存、租约任务/有限重试、失败重试、审计和健康检查 | Cloud SQL 备份/恢复、多实例运行、告警、应用权限与真实店铺授权 |

自动生成发票、自动贷项和自动补货通知默认关闭，须在后台明确启用。Webhook 收到后先可靠入队；Cloud Scheduler 请求受保护的 worker 入口后才处理任务。邮件提供方接受请求只表示提交成功，不代表收件箱送达。

此版本是方案中的**可部署核心版**，尚未完整替代四款竞品的全部高级功能。逐项边界与后续工作见 [功能与验收清单](docs/IMPLEMENTATION.md)。Google Drive/Dropbox/FTP 归档、支付服务商、POS、客户账户下载、完整历史迁移、共购模型及电子发票平台接口没有假授权开关。

## Cloud Run

完整步骤见 [部署指南](docs/CLOUD_RUN.md)，参数见 [deploy/env.example](deploy/env.example)。脚本默认只检查本地配置并打印部署计划；只有显式 `--execute` 才调用云端构建/部署。项目、区域、身份、已有 Cloud SQL 和 Secret 版本均需明确填写。

```sh
cp deploy/env.example deploy/deploy.env
# 私下填写并审查 deploy/deploy.env
set -a
source deploy/deploy.env
set +a
bash deploy/deploy.sh
# 审查输出后才执行：bash deploy/deploy.sh --execute
```

Dockerfile 使用非 root 用户，监听 `0.0.0.0:$PORT`。正式数据及任务保存在 PostgreSQL；PDF 从不可变快照生成，不依赖容器本地文件持久化。Cloud Run 上不运行请求结束后的后台循环。

Shopify 的主题和 Functions 扩展需要通过 Shopify CLI 独立部署，并在目标主题启用；部署 Cloud Run 服务不会自动改动商店。见 [前台接入说明](docs/STOREFRONT.md)。

## 检查

```sh
npm run check
npm test
```

测试使用本机实际 PostgreSQL 引擎 PGlite 检查持久层和事务，用 HTTP 集成检查权限、原始 Webhook 签名、跨店下载、配置冲突及真实 PDF。邮件/Shopify 网络边界在测试中以 stub 验证，不能据此宣称云端或目标店铺已验收。完整 PostgreSQL 多连接、真实 Shopify 和 Cloud Run 仍需按部署指南单独验收。

本次本地 **131 项测试通过**，Plus Function 已编译为 WASM 并通过 3 项实际 runner 案例；详细结果和未验收边界见 [验证记录](docs/VALIDATION.md)。
