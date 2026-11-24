#!/usr/bin/env bash
# Reviewable Cloud Run source deployment. No cloud changes without --execute.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bash deploy/deploy.sh [--dry-run|--execute]

Export reviewed values from deploy/env.example first. The default --dry-run
validates local configuration and prints the target without calling gcloud.
--execute first checks existing project resources, then builds/deploys only the
named service. No APIs, databases, secrets, buckets, or IAM roles are provisioned
by this script. Cloud Run source deployment itself creates build artifacts.
USAGE
}

execute=0
case "${1:---dry-run}" in
  --dry-run) ;;
  --execute) execute=1 ;;
  --help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }

fail() { printf 'Deployment stopped: %s\n' "$*" >&2; exit 1; }
require_var() { [[ -n "${!1:-}" ]] || fail "export $1 before running this script"; }
app_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for var in GOOGLE_CLOUD_PROJECT GOOGLE_CLOUD_REGION CLOUD_RUN_SERVICE \
  DEPLOYMENT_OWNER DEPLOYER_ACCOUNT RUNTIME_SERVICE_ACCOUNT \
  BUILD_SERVICE_ACCOUNT CLOUD_SQL_INSTANCE APP_URL STORES_JSON \
  SHOPIFY_SHOPS_ALLOWLIST DATABASE_URL_SECRET AUTH_SECRET_SECRET \
  ENCRYPTION_KEY_SECRET INTERNAL_TASK_SECRET_SECRET; do
  require_var "$var"
  [[ "${!var}" != *replace* && "${!var}" != *REPLACE* ]] || fail "$var still contains an example placeholder"
  [[ "${!var}" != *$'\n'* && "${!var}" != *'|'* ]] || fail "$var contains an unsupported newline or | delimiter"
done
if [[ -z "${SHOPIFY_SHOP_CREDENTIALS_SECRET:-}" ]]; then
  require_var SHOPIFY_API_KEY
  require_var SHOPIFY_API_SECRET_SECRET
  [[ "$SHOPIFY_API_KEY" != *replace* && "$SHOPIFY_API_SECRET_SECRET" != *replace* ]] || fail "Shopify shared credentials still contain example placeholders"
fi

[[ "$GOOGLE_CLOUD_PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail "GOOGLE_CLOUD_PROJECT must be an explicit project ID"
[[ "$GOOGLE_CLOUD_REGION" =~ ^[a-z]+-[a-z]+[0-9]+$ ]] || fail "GOOGLE_CLOUD_REGION is invalid"
[[ "$CLOUD_RUN_SERVICE" =~ ^[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]] || fail "CLOUD_RUN_SERVICE must be a lower-case service name (2-63 characters)"
[[ "$DEPLOYMENT_OWNER" =~ ^[a-z][a-z0-9_-]{0,62}$ ]] || fail "DEPLOYMENT_OWNER must be a lower-case owner/team label"
[[ "$DEPLOYER_ACCOUNT" == *@* ]] || fail "DEPLOYER_ACCOUNT must name the explicit authenticated deployer"
for var in RUNTIME_SERVICE_ACCOUNT BUILD_SERVICE_ACCOUNT; do
  [[ "${!var}" == *@"$GOOGLE_CLOUD_PROJECT".iam.gserviceaccount.com ]] || fail "$var must belong to the selected project"
done
[[ "$CLOUD_SQL_INSTANCE" == "$GOOGLE_CLOUD_PROJECT:$GOOGLE_CLOUD_REGION:"* ]] || fail "CLOUD_SQL_INSTANCE must name an existing instance in the selected project and region"
[[ "$CLOUD_SQL_INSTANCE" =~ ^[a-z][a-z0-9-]+:[a-z]+-[a-z]+[0-9]+:[a-z][a-z0-9-]*$ ]] || fail "CLOUD_SQL_INSTANCE must be PROJECT:REGION:INSTANCE"
[[ "$APP_URL" =~ ^https://[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]+)?/?$ ]] || fail "APP_URL must be an HTTPS origin without credentials, a path, or a query"
[[ "${APP_MODE:-production}" == production ]] || fail "this deployment script only deploys APP_MODE=production"

IFS=',' read -r -a allowed_shops <<< "$SHOPIFY_SHOPS_ALLOWLIST"
[[ ${#allowed_shops[@]} -gt 0 ]] || fail "SHOPIFY_SHOPS_ALLOWLIST must not be empty"
for shop in "${allowed_shops[@]}"; do
  [[ "$shop" =~ ^[a-z0-9][a-z0-9-]*\.myshopify\.com$ ]] || fail "SHOPIFY_SHOPS_ALLOWLIST must contain comma-separated myshopify.com domains without spaces"
done
[[ "$SHOPIFY_SHOPS_ALLOWLIST" != *, ]] || fail "SHOPIFY_SHOPS_ALLOWLIST has a trailing comma"
command -v node >/dev/null 2>&1 || fail "Node.js 22 is required to validate the local store configuration"
node --input-type=module <<'VALIDATE_STORES'
const stop = message => { process.stderr.write(`Deployment stopped: ${message}\n`); process.exit(1); };
if (Number(process.versions.node.split('.')[0]) < 22) stop('use Node.js 22 or newer for local validation');
let stores;
try { stores = JSON.parse(process.env.STORES_JSON); }
catch { stop('STORES_JSON must be valid JSON'); }
if (!Array.isArray(stores) || stores.length === 0) stop('STORES_JSON must be a nonempty store array');
const allowed = new Set(process.env.SHOPIFY_SHOPS_ALLOWLIST.split(','));
const ids = new Set(), domains = new Set();
for (const store of stores) {
  if (!store || typeof store !== 'object' || !/^[a-z][a-z0-9-]{0,31}$/.test(store.id || '') ||
      typeof store.name !== 'string' || !store.name.trim() || !allowed.has(store.domain) ||
      !/^[A-Z]{2}$/.test(store.country || '') || !/^[A-Z]{3}$/.test(store.currency || '')) {
    stop('each store needs a unique id, name, allowed domain, two-letter country and three-letter currency');
  }
  if (ids.has(store.id) || domains.has(store.domain)) stop('STORES_JSON contains duplicate store ids or domains');
  ids.add(store.id); domains.add(store.domain);
}
if ([...allowed].some(domain => !domains.has(domain))) stop('each allowed shop must have a STORES_JSON entry');
if (process.env.SHOPIFY_ADMIN_USER_IDS && !/^\d+(,\d+)*$/.test(process.env.SHOPIFY_ADMIN_USER_IDS)) {
  stop('SHOPIFY_ADMIN_USER_IDS must contain comma-separated numeric staff IDs');
}
if (!process.env.SHOPIFY_ADMIN_USER_IDS && !process.env.ADMIN_PASSWORD_SECRET) {
  stop('configure SHOPIFY_ADMIN_USER_IDS or ADMIN_PASSWORD_SECRET; otherwise no administrator can log in');
}
VALIDATE_STORES

MIN_INSTANCES="${MIN_INSTANCES:-0}"
MAX_INSTANCES="${MAX_INSTANCES:-3}"
CONCURRENCY="${CONCURRENCY:-20}"
MEMORY="${MEMORY:-512Mi}"
CPU="${CPU:-1}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-120}"
for var in MIN_INSTANCES MAX_INSTANCES CONCURRENCY REQUEST_TIMEOUT; do
  [[ "${!var}" =~ ^(0|[1-9][0-9]*)$ ]] || fail "$var must be a nonnegative integer"
done
(( MAX_INSTANCES >= 1 && MAX_INSTANCES <= 20 )) || fail "MAX_INSTANCES must be 1-20; review DB capacity before raising this script's bound"
(( MIN_INSTANCES <= MAX_INSTANCES )) || fail "MIN_INSTANCES cannot exceed MAX_INSTANCES"
(( CONCURRENCY >= 1 && CONCURRENCY <= 80 )) || fail "CONCURRENCY must be 1-80"
(( REQUEST_TIMEOUT >= 120 && REQUEST_TIMEOUT <= 900 )) || fail "REQUEST_TIMEOUT must be 120-900 seconds for bounded durable workers"
[[ "$CPU" == 1 || "$CPU" == 2 ]] || fail "CPU must be 1 or 2 for this bounded configuration"
[[ "$MEMORY" == 512Mi || "$MEMORY" == 1Gi || "$MEMORY" == 2Gi ]] || fail "MEMORY must be 512Mi, 1Gi, or 2Gi"

secret_bindings=()
secret_names=()
secret_versions=()
add_secret() {
  local env_name="$1" name_var="$2" version_var="$3" secret_name secret_version
  secret_name="${!name_var:-}"
  [[ -n "$secret_name" ]] || return 0
  secret_version="${!version_var:-1}"
  [[ "$secret_name" =~ ^[a-zA-Z0-9_-]+$ ]] || fail "$name_var must be a Secret Manager name in the selected project"
  [[ "$secret_version" =~ ^[1-9][0-9]*$ ]] || fail "$version_var must be a pinned numeric secret version"
  secret_bindings+=("$env_name=$secret_name:$secret_version")
  secret_names+=("$secret_name")
  secret_versions+=("$secret_version")
}
add_secret DATABASE_URL DATABASE_URL_SECRET DATABASE_URL_SECRET_VERSION
add_secret AUTH_SECRET AUTH_SECRET_SECRET AUTH_SECRET_SECRET_VERSION
add_secret ENCRYPTION_KEY ENCRYPTION_KEY_SECRET ENCRYPTION_KEY_SECRET_VERSION
add_secret SHOPIFY_API_SECRET SHOPIFY_API_SECRET_SECRET SHOPIFY_API_SECRET_SECRET_VERSION
add_secret SHOPIFY_SHOP_CREDENTIALS SHOPIFY_SHOP_CREDENTIALS_SECRET SHOPIFY_SHOP_CREDENTIALS_SECRET_VERSION
add_secret INTERNAL_TASK_SECRET INTERNAL_TASK_SECRET_SECRET INTERNAL_TASK_SECRET_SECRET_VERSION
add_secret ADMIN_PASSWORD ADMIN_PASSWORD_SECRET ADMIN_PASSWORD_SECRET_VERSION
add_secret RESEND_API_KEY RESEND_API_KEY_SECRET RESEND_API_KEY_SECRET_VERSION
secret_spec="$(IFS=,; printf '%s' "${secret_bindings[*]}")"

[[ "${DB_AUTO_MIGRATE:-true}" == true || "${DB_AUTO_MIGRATE:-true}" == false ]] || fail "DB_AUTO_MIGRATE must be true or false"
env_bindings=("NODE_ENV=production" "APP_MODE=production" "APP_URL=${APP_URL%/}" \
  "STORES_JSON=$STORES_JSON" "SHOPIFY_SHOPS_ALLOWLIST=$SHOPIFY_SHOPS_ALLOWLIST" \
  "DB_AUTO_MIGRATE=${DB_AUTO_MIGRATE:-true}")
for var in SHOPIFY_API_KEY SHOPIFY_ADMIN_USER_IDS MAIL_FROM GCS_BUCKET; do
  if [[ -n "${!var:-}" ]]; then
    [[ "${!var}" != *'|'* && "${!var}" != *$'\n'* ]] || fail "$var contains an unsupported newline or | delimiter"
    env_bindings+=("$var=${!var}")
  fi
done
env_spec="^|^$(IFS='|'; printf '%s' "${env_bindings[*]}")"

for path in package.json package-lock.json Dockerfile .dockerignore server/index.js ui; do
  [[ -e "$app_root/$path" ]] || fail "missing runtime source: $path"
done

deploy_args=(run deploy "$CLOUD_RUN_SERVICE"
  "--project=$GOOGLE_CLOUD_PROJECT" "--account=$DEPLOYER_ACCOUNT"
  "--region=$GOOGLE_CLOUD_REGION" --platform=managed --execution-environment=gen2
  "--service-account=$RUNTIME_SERVICE_ACCOUNT"
  "--build-service-account=projects/$GOOGLE_CLOUD_PROJECT/serviceAccounts/$BUILD_SERVICE_ACCOUNT"
  "--set-cloudsql-instances=$CLOUD_SQL_INSTANCE"
  "--set-env-vars=$env_spec" "--set-secrets=$secret_spec"
  --port=8080 "--cpu=$CPU" "--memory=$MEMORY" "--concurrency=$CONCURRENCY"
  "--min-instances=$MIN_INSTANCES" "--max-instances=$MAX_INSTANCES"
  "--timeout=$REQUEST_TIMEOUT" --ingress=all --allow-unauthenticated
  "--labels=app-owner=$DEPLOYMENT_OWNER,managed-by=reviewed-script"
  --startup-probe=httpGet.path=/readyz,httpGet.port=8080,timeoutSeconds=2,periodSeconds=5,failureThreshold=24
  --liveness-probe=httpGet.path=/healthz,httpGet.port=8080,timeoutSeconds=3,periodSeconds=30,failureThreshold=3
  --quiet)

printf 'Deployment target: project=%s region=%s service=%s owner=%s\n' \
  "$GOOGLE_CLOUD_PROJECT" "$GOOGLE_CLOUD_REGION" "$CLOUD_RUN_SERVICE" "$DEPLOYMENT_OWNER"
printf 'Runtime: APP_MODE=production, instances=%s..%s, concurrency=%s\n' "$MIN_INSTANCES" "$MAX_INSTANCES" "$CONCURRENCY"
printf 'Secrets: %s pinned references; secret payloads are never printed.\n' "${#secret_bindings[@]}"
if (( ! execute )); then
  printf 'Dry run only; no gcloud requests were made. Reviewed command:\n'
  printf '%q ' gcloud "${deploy_args[@]}" '--source=<isolated-runtime-source>'
  printf '\nUse --execute only after preparing the named resources and reviewing docs/CLOUD_RUN.md.\n'
  exit 0
fi

command -v gcloud >/dev/null 2>&1 || fail "gcloud is required for --execute"
common=("--project=$GOOGLE_CLOUD_PROJECT" "--account=$DEPLOYER_ACCOUNT" --quiet)
enabled_apis="$(gcloud services list --enabled "${common[@]}" --format='value(config.name)')"
for api in run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com sqladmin.googleapis.com; do
  found=0
  while IFS= read -r enabled; do [[ "$enabled" != "$api" ]] || found=1; done <<< "$enabled_apis"
  (( found )) || fail "required API $api is not enabled; an owner must prepare it explicitly"
done
gcloud artifacts repositories describe cloud-run-source-deploy "${common[@]}" \
  "--location=$GOOGLE_CLOUD_REGION" --format='value(name)' >/dev/null \
  || fail "prepare the existing cloud-run-source-deploy Artifact Registry repository first"
for account in "$RUNTIME_SERVICE_ACCOUNT" "$BUILD_SERVICE_ACCOUNT"; do
  gcloud iam service-accounts describe "$account" "${common[@]}" --format='value(email)' >/dev/null \
    || fail "the specified service account does not exist or cannot be inspected"
done
sql_instance_name="${CLOUD_SQL_INSTANCE##*:}"
actual_sql="$(gcloud sql instances describe "$sql_instance_name" "${common[@]}" --format='value(connectionName)')"
[[ "$actual_sql" == "$CLOUD_SQL_INSTANCE" ]] || fail "Cloud SQL connection name does not match the reviewed target"
for (( i=0; i<${#secret_names[@]}; i++ )); do
  secret_state="$(gcloud secrets versions describe "${secret_versions[$i]}" \
    "--secret=${secret_names[$i]}" "${common[@]}" --format='value(state)')"
  [[ "$secret_state" == ENABLED ]] || fail "a referenced secret version is not enabled"
done
service_list="$(gcloud run services list "${common[@]}" "--region=$GOOGLE_CLOUD_REGION" --format='value(metadata.name)')"
while IFS= read -r existing_service; do
  if [[ "$existing_service" == "$CLOUD_RUN_SERVICE" && "${ALLOW_UPDATE_EXISTING:-0}" != 1 ]]; then
    fail "the named service already exists; review it and explicitly export ALLOW_UPDATE_EXISTING=1 to update it"
  fi
done <<< "$service_list"

# Upload only runtime files, never the planning PDFs, screenshots, or .env files.
staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/shopify-ops-source.XXXXXX")"
cleanup() { [[ -z "${staging_dir:-}" ]] || rm -rf -- "$staging_dir"; }
trap cleanup EXIT
tar -C "$app_root" --exclude=.env --exclude='.env.*' --exclude=node_modules \
  --exclude=screenshots --exclude=standalone.html --exclude=.git --exclude='.DS_Store' \
  -cf - package.json package-lock.json Dockerfile .dockerignore server ui \
  | tar -C "$staging_dir" -xf -
cat > "$staging_dir/.gcloudignore" <<'GCLOUDIGNORE'
.gcloudignore
.git
**/.env
**/.env.*
**/node_modules
**/screenshots
**/standalone.html
GCLOUDIGNORE

printf 'Preflight passed. Building/deploying the explicitly selected service.\n'
gcloud "${deploy_args[@]}" "--source=$staging_dir"
printf 'Deployment command completed. Verify /healthz, /readyz, authentication and Shopify callbacks before live acceptance.\n'
