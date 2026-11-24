# Google Cloud Run 部署说明

这份说明与仓库内的部署文件用于把 Node.js 服务部署到 Cloud Run。当前交付是可审查的部署配置；没有创建 Google Cloud 资源、修改项目权限、运行云端部署或连接真实 Shopify 店铺。

## 运行方式与边界

- 运行时：Node.js 22、ES modules；`npm ci --omit=dev` 安装依赖，`npm start` 启动 `server/index.js`。
- HTTP：绑定 `0.0.0.0`，端口使用 `PORT`，默认 `8080`。TLS 在 Cloud Run 入口终止，应用容器提供 HTTP。[容器运行协议](https://docs.cloud.google.com/run/docs/container-contract)
- 数据：生产使用 Cloud SQL for PostgreSQL。店铺授权、配置、订阅和任务状态必须在数据库中保存；不能依靠实例内存、本地 SQLite 或容器文件系统持久化。
- PDF：按请求生成并流式返回，不依赖本地永久文件。`GCS_BUCKET` 仅用于应用支持并明确启用的对象归档；填写 bucket 名称不会创建 bucket，也不等于已经实现归档。
- 后台任务：持久化任务由 `POST /internal/jobs/run` 在请求周期内处理。不能依靠 Cloud Run 实例中的定时器、请求结束后的异步任务或 `setInterval` 确保执行。
- `APP_MODE=demo` 仅适合本地演示。云端脚本固定部署 `APP_MODE=production`，生产配置缺失时应停止启动。

## 文件

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | 使用 Node 22 构建镜像，以非 root 用户运行，无本地数据卷 |
| `.dockerignore` | 从镜像上下文排除密钥、规划文件、截图和本地依赖 |
| `compose.yaml` | 本地应用与 PostgreSQL，数据库仅在 Docker 网络内访问 |
| `deploy/env.example` | 部署目标、Secret 引用与本地环境变量的填写样例，无真实凭据 |
| `deploy/deploy.sh` | 默认离线校验；显式 `--execute` 后才检查指定云端资源并部署 |
| `deploy/cloudrun.yaml` | 单独审查 Cloud Run 服务配置的模板，包含未替换占位符，不能直接发布 |

## 先准备明确的目标资源

由项目负责人在确定项目、区域、费用和权限后准备以下资源。脚本不会执行 `gcloud config set project`，不会启用 API、创建 Cloud SQL/Secret/GCS bucket、创建服务账号或批量授予 IAM。

1. 一个已启用结算的明确项目，以及选定区域。英国可选择 `europe-west2`，欧盟可根据业务要求选合适欧盟区域；数据库与服务保持同区。本配置不是数据驻留或法规合规承诺。
2. 已启用的 Cloud Run、Cloud Build、Artifact Registry、Secret Manager 和 Cloud SQL Admin API。
3. 同区域现有的 `cloud-run-source-deploy` Artifact Registry Docker 仓库。Cloud Run 源码部署本身在缺少此仓库时可能自动创建；本脚本先检查并在缺少时退出。[源码部署行为](https://docs.cloud.google.com/run/docs/deploying-source-code)
4. 已建好的 Cloud SQL PostgreSQL 实例、应用数据库及专用数据库用户。为生产配置备份、恢复策略和数据库连接容量。
5. 两个明确的现有服务账号：运行身份与构建身份。不要默认使用高权限项目账号。
6. 现有 Secret Manager secrets，并确定每个 secret 的数字版本。
7. 应用 HTTPS 域名。可使用已知的 Cloud Run URL 或事先确定的自定义域名；`APP_URL` 必须是最终对外 origin，不能包含凭据、路径或查询串。如果首次部署后才获得服务 URL，需要按真实 URL 更新配置、重新部署并更新 Shopify 回调后再进行授权验收。

执行源码部署会触发 Cloud Build、镜像/源码存储和指定 Cloud Run 服务的创建或更新，这些操作可能计费；`MIN_INSTANCES=0` 与实例上限不会限制 Cloud SQL、构建或存储的费用。脚本并不代表零成本部署。

## 权限只授予所需身份

由项目管理员按实际资源配置权限，不要给运行身份授予 Owner/Editor：

- 部署者需要源码部署权限、Service Usage Consumer，以及对所选运行/构建服务账号的使用权限。公开调用设置还需要修改该服务访问策略的权限；若组织策略不允许公开服务，必须先确定受支持的公网入口方案，Shopify 不能通过交互式 Google 登录访问回调。
- 构建身份需要完成 Cloud Run 源码构建和写入指定 Artifact Registry 仓库的权限。按 Google 当前源码部署文档配置 `roles/run.builder` 等必要权限，范围由管理员审查。
- 运行身份需要 Cloud SQL Client；每个引用 secret 单独授予 Secret Accessor。脚本只描述 secret 版本状态，不读取明文；真正启动时由 Cloud Run 获取密钥。
- 如果实际启用 GCS，按指定私有 bucket 和所需读写能力授权；不要开放公共对象访问。运行服务使用环境提供的身份，不把服务账号 JSON 文件复制进镜像。

Google 参考：[源码构建身份与权限](https://docs.cloud.google.com/run/docs/deploying-source-code)、[运行时 Secret 引用](https://docs.cloud.google.com/run/docs/configuring/services/secrets)、[Cloud SQL 连接身份](https://docs.cloud.google.com/sql/docs/postgres/connect-run)。

## 配置与 Secret 内容

将 `deploy/env.example` 复制到本地、不提交的配置文件，填写真实资源标识。脚本不自动读取 `.env` 或当前 gcloud 项目配置；需要先显式导出。
本地离线配置校验需要 Node.js 22；真正执行部署还需要已经登录所选 `DEPLOYER_ACCOUNT` 的 gcloud。脚本不会安装工具或替换当前登录身份。

```sh
cp deploy/env.example deploy/deploy.env
# 编辑 deploy/deploy.env；不要把该文件提交到版本库。
set -a
. ./deploy/deploy.env
set +a
bash deploy/deploy.sh --dry-run
```

`deploy/deploy.env` 是需要先审查的 shell 配置文件；不要 source 来自未知来源的文件。部署文件中只填写 Secret 名称及版本；生产 Secret 的实际值不需要导出到本地 shell，也不会出现在部署命令中。环境变量方式引用 Secret 时固定数字版本，轮换后通过新版本发布使用。[Secret 版本建议](https://docs.cloud.google.com/run/docs/configuring/services/secrets)

| 应用变量 | 生产要求 |
| --- | --- |
| `DATABASE_URL` | Secret；连接应用数据库的 PostgreSQL URL |
| `AUTH_SECRET` | Secret；至少 32 个字符的随机值；用于会话签名，不使用 Shopify API secret 替代 |
| `ENCRYPTION_KEY` | Secret；32 字节随机数据的 Base64 编码，用于授权令牌加密 |
| `APP_URL` | 非 Secret；最终 HTTPS origin |
| `SHOPIFY_API_KEY` | 非 Secret；对应自用 App 的 client ID |
| `SHOPIFY_API_SECRET` | Secret；与 client ID 配套 |
| `SHOPIFY_SHOP_CREDENTIALS` | 可选 JSON Secret；每个店铺域名对应独立的 `apiKey` / `apiSecret` / 可选 `storefrontToken`；使用此映射时可省略上面的共享 client ID/secret |
| `SHOPIFY_SHOPS_ALLOWLIST` | 非 Secret；逗号分隔的准确 `*.myshopify.com` 店铺域名，不能使用任意店铺通配符 |
| `STORES_JSON` | 非 Secret；真实店铺数组，逐店设置 `id`、`name`、`domain`、`country`、`currency`，例如 UK/GB/GBP 与 EU/DE/EUR；生产不加载演示店铺 |
| `SHOPIFY_ADMIN_USER_IDS` | 可选；明确允许的 Shopify 员工 ID。不要把任意有效 App Bridge bearer token 视为内部管理员权限 |
| `INTERNAL_TASK_SECRET` | Secret；后台任务调用的随机密钥，建议至少 32 字符；不能出现在 URL 或前端代码中 |
| `ADMIN_PASSWORD` | 可选 Secret；至少 16 字符；预览登录只提交 password 字段，无用户名；不替代 Shopify 安装授权 |
| `MAIL_FROM` / `RESEND_API_KEY` | 可选；发件身份与提供方密钥，开启真实邮件前完成域名验证并检查发送配置 |
| `GCS_BUCKET` | 可选；已存在的私有 bucket 名称，是否存储文件以应用已实现的归档能力为准 |

`SHOPIFY_ADMIN_USER_IDS` 与 `ADMIN_PASSWORD` 至少配置一条登录路线；两者都为空时服务会拒绝生产启动，部署脚本也会拦截。初次安装从管理台“连接 Shopify”开始，后端返回短时、一次性的顶层授权入口，在顶层响应中写入 OAuth state cookie，再跳转 Shopify，避免依赖第三方 iframe 设置 cookie。
| `DB_AUTO_MIGRATE` | 默认 `true`，启动时幂等建表/迁移；设为 `false` 时由受控流程显式运行 `npm run migrate`，完成后才验收就绪 |

同一后端支持多店，不代表 Shopify 允许普通店铺共用一个 custom-distribution App。按实际店铺组织与套餐创建相应 App 身份，并将凭据按域名放入 `SHOPIFY_SHOP_CREDENTIALS` 的 Secret，禁止把整份映射传给前端。JSON 示例仅示意数据形状，不包含真实值：
使用逐店凭据时，将 `SHOPIFY_SHOP_CREDENTIALS_SECRET` 指向该 JSON Secret，并清空共享的 `SHOPIFY_API_KEY` 和 `SHOPIFY_API_SECRET_SECRET`，避免无意引用另一套凭据。

```json
{"store.myshopify.com":{"apiKey":"CLIENT_ID","apiSecret":"SECRET","storefrontToken":"OPTIONAL_TOKEN"}}
```

生成随机值时在自己的安全终端执行并直接写入 Secret Manager，避免粘贴到聊天记录或日志：

```sh
openssl rand -hex 32
openssl rand -base64 32
```

前者可作为 `AUTH_SECRET` 或单独生成的 `INTERNAL_TASK_SECRET`；后者用于 `ENCRYPTION_KEY`。每项使用独立值。`ENCRYPTION_KEY` 轮换需要设计已有令牌的解密/重加密迁移，不能简单覆盖后假定旧数据仍可用。

Cloud SQL 内置连接使用 Unix socket。把 URL 存为 `DATABASE_URL` 对应的 Secret，例如下面的格式，替换用户、经过 URL 编码的密码、库名和连接名：

```text
postgresql://APP_USER:URL_ENCODED_PASSWORD@localhost/APP_DATABASE?host=/cloudsql/PROJECT:REGION:INSTANCE
```

脚本的 `--set-cloudsql-instances` 挂载相应 socket；运行身份仍须有 Cloud SQL Client。此示例假设该实例可使用 Cloud Run 内置的 Cloud SQL 连接方式；仅私网实例还需要显式设置 Direct VPC egress 或连接器，不能只填 socket 路径就视为网络已通。[PostgreSQL 连接说明](https://docs.cloud.google.com/sql/docs/postgres/connect-run)

## 本地 Docker 验证

本地可先以演示模式验证容器、数据库与 UI。创建只保存在本机的 `.env`，其中至少有一个 URL-safe 随机 `POSTGRES_PASSWORD`；如果需要登录或处理任务，再按应用要求填本地专用密钥。不要复用生产密钥。

```sh
# 将一个随机、仅含十六进制字符的密码填入本地 .env 的 POSTGRES_PASSWORD。
APP_MODE=demo APP_URL=http://localhost:8080 docker compose up --build
```

应用地址为 `http://localhost:8080`。应用文件系统只读，临时文件仅可使用 `/tmp`；PostgreSQL 使用本地命名卷。`docker compose down` 不删除数据库卷；只有明确需要清空本地测试数据时才额外删除该卷。不要直接把这个 Compose 数据库作为生产数据库使用。

## 部署与回滚

默认调用是 dry run，不访问 Google Cloud。检查目标项目、账号、区域、服务名、Secret 引用和命令后，明确决定执行时再运行：

```sh
bash deploy/deploy.sh --execute
```

执行前脚本会只读检查所选项目的 API、已有仓库、两个服务账号、Cloud SQL 连接名与 Secret 数字版本；它无法替代完整 IAM 检查，也不读取 Secret 内容以校验长度。实际服务启动时还必须执行应用配置校验。

为了避免更新错误的已有服务，默认在服务已存在时退出。确认该服务确实属于此项目后，可显式允许更新：

```sh
export ALLOW_UPDATE_EXISTING=1
bash deploy/deploy.sh --dry-run
# 完成审查后才运行 --execute。
```

上传源码使用临时白名单目录，仅含根级依赖清单、Dockerfile、`server/` 与 `ui/`；规划报告、截图、`.env`、本地依赖不上传。后续增加运行目录时应同步审查 Dockerfile 与脚本白名单。云端将依本仓库 Dockerfile 构建；本机不需要安装 Docker 才能执行源码部署。[构建方式](https://docs.cloud.google.com/run/docs/deploying-source-code)

默认最多 3 个实例、每实例并发 20、1 CPU、512 MiB；按数据库实际连接池调整。连接池大小乘最大实例数，加上发布时新旧实例重叠与运维连接，必须小于数据库容量；最大实例数不是严格的数据库连接隔离手段。不要仅为了处理 PDF 增大所有请求的并发。

当前每实例 PostgreSQL pool 上限为 5，3 个正常服务实例最多占约 15 个池连接，发布重叠及其他工具还需预留。默认迁移使用数据库 advisory transaction lock 串行，仍应保持迁移兼容新旧 revision；若使用 `DB_AUTO_MIGRATE=false`，请先在明确的数据库目标运行迁移，再发布依赖新结构的代码。

发布前记录旧 revision 和兼容的数据库迁移方式。出问题时把流量切回明确记录的旧 revision，不要删除服务或数据库。以下仅为需要替换并审查的回滚命令示例：

```sh
gcloud run services update-traffic "$CLOUD_RUN_SERVICE" \
  --project="$GOOGLE_CLOUD_PROJECT" --account="$DEPLOYER_ACCOUNT" \
  --region="$GOOGLE_CLOUD_REGION" --to-revisions="REPLACE_PREVIOUS_REVISION=100"
```

流量回滚不会撤销数据库迁移、已发送邮件或真实 Shopify 写入。

## HTTPS、公网回调与业务权限

Cloud Run 必须接收 Shopify 的授权回调、签名 webhook 和运费请求，因此脚本为指定服务配置公网 HTTPS 调用。**公网可调用不等于业务 API 可匿名读取。** 管理 API 必须要求有效会话/受支持的 Shopify 身份；webhook 必须校验原始请求体签名；OAuth 必须校验 state、店铺 allowlist 等；对外订阅表单需要自己的验证和限流。

入口设置见 [Cloud Run 公开访问](https://docs.cloud.google.com/run/docs/authenticating/public)。填写 Shopify 的 App URL 与允许的 redirect URLs 时必须使用实际最终域名及应用真实路由，不允许只填写示例域名就进入生产。

## 调度任务

`POST /internal/jobs/run` 必须要求 `X-Internal-Task-Secret` 请求头，其值等于 `INTERNAL_TASK_SECRET`。缺失或错误应拒绝请求。任务入口不能通过 `GET`、查询串 secret 或匿名调用触发。

需要定时执行时，在明确选定的项目和区域单独准备 Cloud Scheduler HTTP job，使用 HTTPS `POST` 调用实际服务的 `/internal/jobs/run`，在 header 中设置专用任务密钥；Scheduler job 配置可读取该 header，管理员需控制其可见范围。不要在共享终端命令行、访问 URL 或日志中展示密钥。该仓库脚本不会自动创建 Scheduler 或把密钥复制进 job 配置。

Scheduler 可能重试同一次调用；数据库任务必须通过锁定领取、幂等键和有限批次防重。任务必须在请求返回前完成本批处理；对大量邮件或长任务，后续应改成专用 Cloud Run Job/可靠任务系统，而非在返回 `202` 后依靠本实例继续运行。只有任务队列已连接并被实际调度，才可认为后台通知已启用。

## 验证与验收

1. `GET /healthz` 返回存活状态；`GET /readyz` 确认 PostgreSQL 可用，不泄露连接串。启动探针检查 `/readyz`，存活探针检查 `/healthz`，避免数据库短暂故障引发实例循环重启。[探针配置](https://docs.cloud.google.com/run/docs/configuring/healthchecks)
2. 匿名访问受保护管理 API 必须被拒绝；错误的任务密钥必须被拒绝。确保生产页面不会以演示数据冒充已连接的店铺。
3. 完成允许店铺的 OAuth 安装，检查令牌加密保存，并确认不在 allowlist 的店铺被拒绝。
4. 验证签名 webhook、重放去重、运费回调及实际结账。运费最终开通仍受 Shopify 店铺 CCS 能力约束。
5. 重启实例、扩成两个实例后，配置、任务状态与授权仍在；不能依靠浏览器 localStorage 或单实例内存通过此项。
6. 检查实际生成的 PDF、发票编号/税额与访问权限；邮件先用测试收件人验证发送、去重和退订，再启用真实通知。
7. 检查 Cloud Run 日志和错误率，不打印 Shopify 令牌、会话密钥、完整订单个人信息或数据库连接串。

构建成功、服务健康、真实 Shopify 业务验收是三项不同结果，应分别记录。本文档未声明已通过其中任何云端或真实店铺验收。
