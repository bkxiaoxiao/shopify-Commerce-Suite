# 本次本地验收记录

日期：2026-11-24。版本：0.2.0。没有执行 Google Cloud 或 Shopify 生产发布。

| 项目 | 结果与证据 |
| --- | --- |
| 根目录依赖 | `npm ci --ignore-scripts --no-audit --no-fund` 成功；pg 8.23.1、pdfkit 0.17.2、PGlite 0.3.16，根锁文件已包含 |
| 源码及部署检查 | `npm run check` 通过，检查 27 个 JS 源文件、入口、字体/许可、Docker 启动命令与 shell 语法 |
| 自动测试 | `npm test` **131 / 131 通过**。包含 HTTP 权限/跨店、顶层 OAuth handoff、原始 Webhook 签名和重放、配置冲突、财务对账/退款、实际 PDF、持久任务/租约、补货暂停和跨天邮件重试、前台主题及 Function 逻辑 |
| 持久层 | 在真实 PostgreSQL 引擎 PGlite 上验证事务、CAS、取号、原子 outbox、去重、租约和失败恢复；测试适配器串行化访问，不替代真实 Cloud SQL 多连接验收 |
| HTTP / 页面 | 正式界面在隔离本地测试服务中通过密码登录、主体设置持久化、创建中文报价；2 × £129.99 + 20% VAT = £311.98，生成 `%PDF-` 真实文件，10,884 字节 |
| 响应式 | 正式界面的总览、运费、搭配、单据、补货、分析、设置 7 页在 390 px 宽度下均无文档级横向溢出，也无页面渲染异常 |
| Shopify Function | CLI 5.0.2 + SDK 2.0.1 / Javy 编译成功，WASM 8,795 字节。官方 runner 的完整组合、缺成员、固定 1 分分摊 3 个样例通过。完整记录见扩展 `build-report.json` |
| 部署脚本 | 正常配置 dry-run 通过，无 gcloud 请求；无管理员、非法店铺 ID、过短 worker 超时会被拦截。脚本默认仅计划，显式 `--execute` 才部署 |
| 本地服务 | `npm start` 成功监听 `0.0.0.0:8080`，保留演示预览。正式部署不使用此演示数据 |

本地 Node.js 为 24.19，Dockerfile 使用 Node.js 22。当前机器无 Docker，**没有执行 Docker 镜像构建**；也没有创建 GCP 资源、部署 Cloud Run、连接真实 Shopify 店铺、发布主题或发送真实邮件。真实权限、平台资格、Cloud SQL 多实例、镜像构建、Cloud Run 及业务验收按 [部署指南](CLOUD_RUN.md) 继续完成。

本地测试中的提供方和 Shopify 网络响应为受控 stub，防止试验改动真实业务。WASM runner 与生成 PDF 为实际执行结果，但不代表实际结账/发票合规/邮件送达已验收。高级功能缺口见 [实现清单](IMPLEMENTATION.md)。
