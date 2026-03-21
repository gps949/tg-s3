#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# tg-s3 一键部署脚本
#
# 用法: ./deploy.sh
#   自动检测运行环境:
#   - 宿主机 + Docker 可用: 构建镜像 + 部署 Worker + 启动所有服务
#   - 宿主机 + 无 Docker:   使用本地 wrangler 部署 Worker
#   - Docker 容器内:         仅部署 Worker (由宿主机编排调用)
#
# 可选参数:
#   --vps    传统 SSH 部署模式 (非 Docker)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---- 颜色 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC} $1" >&2; }
step() { echo -e "\n${CYAN}==>${NC} $1"; }

gen_random() {
  local len="${1:-32}"
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$len" 2>/dev/null || \
    openssl rand -base64 "$((len * 2))" | tr -dc 'A-Za-z0-9' | head -c "$len"
}

# ---- 环境检测 ----
IN_CONTAINER=0
if [ -f /.dockerenv ] || grep -qsE 'docker|containerd' /proc/1/cgroup 2>/dev/null; then
  IN_CONTAINER=1
fi

# ---- 加载 .env ----
if [ ! -f .env ]; then
  err "未找到 .env 文件。请复制 .env.example 为 .env 并填写配置:"
  err "  cp .env.example .env && vim .env"
  exit 1
fi

set -a
source .env
set +a

# 兼容旧版 CF_ACCOUNT_ID (wrangler 4.x 要求 CLOUDFLARE_ACCOUNT_ID)
if [ -n "${CF_ACCOUNT_ID:-}" ] && [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
  export CLOUDFLARE_ACCOUNT_ID
fi

# ---- 工具函数 ----
# 跨平台 sed -i (macOS 需要 -i ''，Linux 需要 -i)
sed_inplace() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

derive_webhook_secret() {
  node -e "const c=require('crypto');console.log(c.createHmac('sha256',process.env.TG_BOT_TOKEN).update('tg-s3-webhook').digest('hex'))"
}

# 持久化写入 .env (已有则更新，没有则追加)
# 使用逐行重写避免 sed 特殊字符转义问题
persist_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    # 逐行重写: 避免 sed 对 val 中 | & \ 等特殊字符的转义问题
    local tmpfile
    tmpfile=$(mktemp "${TMPDIR:-/tmp}/env.XXXXXX")
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ "$line" == "${key}="* ]]; then
        echo "${key}=${val}"
      else
        echo "$line"
      fi
    done < .env > "$tmpfile"
    if cat "$tmpfile" > .env; then
      rm -f "$tmpfile"
    else
      rm -f "$tmpfile"
      return 1
    fi
  else
    echo "${key}=${val}" >> .env
  fi
}

# ---- 自动生成 secrets (写回 .env) ----
if [ -z "${VPS_SECRET:-}" ]; then
  VPS_SECRET="$(gen_random 48)"
  persist_env VPS_SECRET "$VPS_SECRET"
  log "自动生成 VPS_SECRET (已写入 .env)"
fi

# ---- 校验必填项 ----
validate_required() {
  local missing=0
  for var in TG_BOT_TOKEN DEFAULT_CHAT_ID; do
    if [ -z "${!var:-}" ]; then
      err "缺少必填项: $var"
      missing=1
    fi
  done
  if [ $missing -eq 1 ]; then
    err "请在 .env 中填写所有必填项"
    exit 1
  fi
}

# ============================================================
# CF Worker 部署 (在容器内或本地执行)
# ============================================================
deploy_cf() {
  step "部署 Cloudflare Worker"

  if ! command -v npx &>/dev/null; then
    err "需要 Node.js 和 npm, 请先安装"
    exit 1
  fi

  # 安装依赖
  if [ ! -d node_modules ]; then
    step "安装 npm 依赖"
    npm install
    log "依赖安装完成"
  fi

  # 检查 wrangler 认证
  step "检查 Cloudflare 认证状态"
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    log "使用 CLOUDFLARE_API_TOKEN 认证"
  elif ! npx wrangler whoami &>/dev/null 2>&1; then
    warn "wrangler 未登录, 正在打开浏览器授权..."
    npx wrangler login
  fi
  log "Cloudflare 认证正常"

  # 获取或创建 D1 数据库 (完全自动，支持重复部署)
  # 优先级: .env 缓存 > wrangler.toml > 远程查询 > 新建
  CURRENT_DB_ID=$(grep 'database_id' wrangler.toml | head -1 | sed 's/.*= *"\(.*\)"/\1/')
  DB_ID=""

  if [ -n "$CURRENT_DB_ID" ]; then
    DB_ID="$CURRENT_DB_ID"
    log "D1 数据库已存在: $DB_ID"
  elif [ -n "${D1_DATABASE_ID:-}" ]; then
    DB_ID="$D1_DATABASE_ID"
    log "D1 数据库 ID 已从 .env 恢复: $DB_ID"
  else
    # 先查远程是否已有同名数据库
    step "查找 D1 数据库 tg-s3-db"
    DB_ID=$(npx wrangler d1 list --json 2>/dev/null | \
      node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); const db=d.find(x=>x.name==='tg-s3-db'); console.log(db?.uuid||'')" 2>/dev/null) || DB_ID=""

    if [ -z "$DB_ID" ]; then
      # 远程没有, 创建新数据库
      step "创建 D1 数据库 tg-s3-db"
      DB_OUTPUT=$(npx wrangler d1 create tg-s3-db 2>&1) || true
      DB_ID=$(echo "$DB_OUTPUT" | grep -o 'database_id = "[^"]*"' | head -1 | sed 's/database_id = "\(.*\)"/\1/')
    fi

    if [ -z "$DB_ID" ]; then
      err "无法获取 D1 数据库 ID"
      exit 1
    fi
    log "D1 数据库: $DB_ID"
  fi

  # 确保 wrangler.toml 中有正确的 database_id
  if [ -z "$CURRENT_DB_ID" ]; then
    sed_inplace "s/database_id = \"\"/database_id = \"$DB_ID\"/" wrangler.toml
  fi

  # 持久化到 .env (Docker 容器内 wrangler.toml 不持久，.env 通过 volume 持久化)
  persist_env D1_DATABASE_ID "$DB_ID"

  # 创建 R2 缓存 bucket
  step "创建 R2 缓存 bucket tg-s3-cache"
  if npx wrangler r2 bucket list 2>&1 | grep -q 'tg-s3-cache'; then
    log "R2 缓存 bucket 已存在"
  else
    npx wrangler r2 bucket create tg-s3-cache 2>&1 || true
    log "R2 缓存 bucket 创建完成"
  fi

  # R2 lifecycle: 90 天兜底 GC
  step "配置 R2 兜底清理策略 (90 天)"
  npx wrangler r2 bucket lifecycle add tg-s3-cache "cache-gc" \
    --expire-days 90 2>&1 || true
  log "R2 lifecycle 规则已设置"

  # 初始化数据库 schema
  step "初始化 D1 数据库 schema"
  if npx wrangler d1 execute tg-s3-db --remote --file=src/storage/schema.sql --yes 2>&1; then
    log "数据库 schema 已应用"
  else
    warn "数据库 schema 应用可能失败 (如果表已存在则可忽略)"
  fi

  # 设置 secrets
  step "配置 Worker secrets"
  echo "$TG_BOT_TOKEN" | npx wrangler secret put TG_BOT_TOKEN 2>&1 || true
  echo "$DEFAULT_CHAT_ID" | npx wrangler secret put DEFAULT_CHAT_ID 2>&1 || true
  if [ -n "${VPS_URL:-}" ]; then
    echo "$VPS_URL" | npx wrangler secret put VPS_URL 2>&1 || true
  fi
  echo "$VPS_SECRET" | npx wrangler secret put VPS_SECRET 2>&1 || true
  log "Secrets 配置完成"

  # 部署 Worker
  step "部署 Worker"
  if ! DEPLOY_OUTPUT=$(npx wrangler deploy 2>&1); then
    err "Worker 部署失败:"
    echo "$DEPLOY_OUTPUT" >&2
    exit 1
  fi
  echo "$DEPLOY_OUTPUT"

  WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[^ ]+\.workers\.dev' | head -1)
  if [ -n "$WORKER_URL" ]; then
    log "Worker 部署成功: $WORKER_URL"
  else
    log "Worker 部署完成"
  fi

  # 设置 WORKER_URL secret
  EFFECTIVE_URL="${CF_CUSTOM_DOMAIN:+https://$CF_CUSTOM_DOMAIN}"
  EFFECTIVE_URL="${EFFECTIVE_URL:-$WORKER_URL}"
  if [ -n "$EFFECTIVE_URL" ]; then
    step "设置 WORKER_URL secret"
    echo "$EFFECTIVE_URL" | npx wrangler secret put WORKER_URL 2>&1 || true
    log "WORKER_URL = $EFFECTIVE_URL"
  fi

  # 注册 Telegram Webhook
  if [ -n "$EFFECTIVE_URL" ]; then
    step "注册 Telegram Bot Webhook"
    WEBHOOK_URL="$EFFECTIVE_URL/bot/webhook"
    WEBHOOK_SECRET=$(TG_BOT_TOKEN="$TG_BOT_TOKEN" derive_webhook_secret)
    WEBHOOK_RES=$(curl -s -X POST \
      "https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook" \
      -H "Content-Type: application/json" \
      -d "{\"url\":\"${WEBHOOK_URL}\",\"secret_token\":\"${WEBHOOK_SECRET}\"}" 2>&1) || WEBHOOK_RES=""
    if echo "$WEBHOOK_RES" | grep -q '"ok":true'; then
      log "Webhook 注册成功: $WEBHOOK_URL"
    else
      warn "Webhook 注册失败"
      if [ -n "$WEBHOOK_RES" ]; then
        warn "  响应: $WEBHOOK_RES"
      else
        warn "  无法连接 api.telegram.org (网络问题?)"
      fi
    fi
  fi

  # 自定义域名提示
  if [ -n "${CF_CUSTOM_DOMAIN:-}" ]; then
    step "配置自定义域名: $CF_CUSTOM_DOMAIN"
    warn "请在 Cloudflare Dashboard 中手动绑定自定义域名到 tg-s3 Worker"
    warn "Workers & Pages -> tg-s3 -> Settings -> Domains & Routes"
  fi
}

# ============================================================
# Cloudflare Tunnel 自动创建
# 创建后自动写入 CF_TUNNEL_TOKEN 到 .env (挂载 volume 时可持久化)
# ============================================================
setup_tunnel() {
  step "配置 Cloudflare Tunnel"

  if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
    log "CF_TUNNEL_TOKEN 已设置, 跳过 tunnel 创建"
    return 0
  fi

  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    warn "跳过 tunnel 自动创建 (需要 CLOUDFLARE_API_TOKEN)"
    warn "手动创建: CF Dashboard > Zero Trust > Tunnels, 然后设置 CF_TUNNEL_TOKEN"
    return 1
  fi

  if [ -z "${CF_CUSTOM_DOMAIN:-}" ]; then
    warn "需要 CF_CUSTOM_DOMAIN 来为 tunnel 分配域名"
    warn "或在 CF Dashboard > Zero Trust > Tunnels 手动创建后设置 CF_TUNNEL_TOKEN"
    return 1
  fi

  local CF_API="https://api.cloudflare.com/client/v4"
  local AUTH_HEADER="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

  # 获取 Account ID
  local ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-${CF_ACCOUNT_ID:-}}"
  if [ -z "$ACCOUNT_ID" ]; then
    step "获取 Cloudflare Account ID"
    ACCOUNT_ID=$(curl -s "$CF_API/accounts" -H "$AUTH_HEADER" | \
      node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result?.[0]?.id||'')" 2>/dev/null) || ACCOUNT_ID=""
    if [ -z "$ACCOUNT_ID" ]; then
      warn "无法获取 Account ID, 请在 .env 中设置 CF_ACCOUNT_ID"
      return 1
    fi
    log "Account ID: ${ACCOUNT_ID:0:8}..."
  fi

  # 检查是否已有同名 tunnel
  step "检查现有 tunnel"
  local LIST_RESP=""
  LIST_RESP=$(curl -s "$CF_API/accounts/$ACCOUNT_ID/cfd_tunnel?name=tg-s3&is_deleted=false" \
    -H "$AUTH_HEADER" 2>&1) || LIST_RESP=""
  local EXISTING=""
  EXISTING=$(echo "$LIST_RESP" | \
    node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); const t=d.result?.find(t=>t.name==='tg-s3'); console.log(t?.id||'')" 2>/dev/null) || EXISTING=""

  local TUNNEL_ID=""
  local TUNNEL_TOKEN_FROM_CREATE=""
  if [ -n "$EXISTING" ]; then
    TUNNEL_ID="$EXISTING"
    log "已有 tunnel tg-s3: ${TUNNEL_ID:0:8}..."
  else
    # 检查 API 权限 (list 失败说明 token 无权限)
    if echo "$LIST_RESP" | grep -q '"success":false'; then
      warn "API Token 缺少 Cloudflare Tunnel 权限"
      warn "请在 CF Dashboard > 我的个人资料 > API 令牌 中添加:"
      warn "  Account | Cloudflare Tunnel | Edit"
      warn "响应: $LIST_RESP"
      return 1
    fi

    step "创建 Cloudflare Tunnel: tg-s3"
    local CREATE_RESP=""
    CREATE_RESP=$(curl -s -X POST "$CF_API/accounts/$ACCOUNT_ID/cfd_tunnel" \
      -H "$AUTH_HEADER" \
      -H "Content-Type: application/json" \
      -d '{"name":"tg-s3","config_src":"cloudflare"}' 2>&1) || CREATE_RESP=""
    TUNNEL_ID=$(echo "$CREATE_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result?.id||'')" 2>/dev/null) || TUNNEL_ID=""
    # 创建响应直接包含 token，无需单独获取
    TUNNEL_TOKEN_FROM_CREATE=$(echo "$CREATE_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result?.token||'')" 2>/dev/null) || TUNNEL_TOKEN_FROM_CREATE=""
    if [ -z "$TUNNEL_ID" ]; then
      warn "tunnel 创建失败"
      if echo "$CREATE_RESP" | grep -q '"code":10000'; then
        warn "API Token 权限不足，需要 Cloudflare Tunnel: Edit"
      fi
      [ -n "$CREATE_RESP" ] && warn "响应: $CREATE_RESP"
      return 1
    fi
    log "Tunnel 创建成功: ${TUNNEL_ID:0:8}..."
  fi

  # 配置 tunnel ingress
  local TUNNEL_HOSTNAME="vps.${CF_CUSTOM_DOMAIN}"
  step "配置 tunnel ingress: $TUNNEL_HOSTNAME -> processor:3000"
  curl -s -X PUT "$CF_API/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "{\"config\":{\"ingress\":[{\"hostname\":\"$TUNNEL_HOSTNAME\",\"service\":\"http://processor:3000\",\"originRequest\":{\"noTLSVerify\":true}},{\"service\":\"http_status:404\"}]}}" >/dev/null 2>&1 || true
  log "Tunnel ingress 已配置"

  # 创建 DNS CNAME
  step "配置 DNS: $TUNNEL_HOSTNAME -> tunnel"
  local ZONE_ID=""
  local DOMAIN="$CF_CUSTOM_DOMAIN"
  while [ -n "$DOMAIN" ] && [ -z "$ZONE_ID" ]; do
    ZONE_ID=$(curl -s "$CF_API/zones?name=$DOMAIN" -H "$AUTH_HEADER" | \
      node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result?.[0]?.id||'')" 2>/dev/null) || ZONE_ID=""
    if [ -z "$ZONE_ID" ]; then
      DOMAIN="${DOMAIN#*.}"
      if [[ "$DOMAIN" != *.* ]]; then break; fi
    fi
  done

  if [ -n "$ZONE_ID" ]; then
    local EXISTING_DNS
    EXISTING_DNS=$(curl -s "$CF_API/zones/$ZONE_ID/dns_records?name=$TUNNEL_HOSTNAME&type=CNAME" \
      -H "$AUTH_HEADER" | \
      node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result?.[0]?.id||'')" 2>/dev/null) || EXISTING_DNS=""

    if [ -n "$EXISTING_DNS" ]; then
      curl -s -X PUT "$CF_API/zones/$ZONE_ID/dns_records/$EXISTING_DNS" \
        -H "$AUTH_HEADER" \
        -H "Content-Type: application/json" \
        -d "{\"type\":\"CNAME\",\"name\":\"$TUNNEL_HOSTNAME\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true}" >/dev/null 2>&1 || true
      log "DNS 记录已更新: $TUNNEL_HOSTNAME"
    else
      curl -s -X POST "$CF_API/zones/$ZONE_ID/dns_records" \
        -H "$AUTH_HEADER" \
        -H "Content-Type: application/json" \
        -d "{\"type\":\"CNAME\",\"name\":\"$TUNNEL_HOSTNAME\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true}" >/dev/null 2>&1 || true
      log "DNS 记录已创建: $TUNNEL_HOSTNAME"
    fi
  else
    warn "无法找到域名 $CF_CUSTOM_DOMAIN 对应的 CF Zone"
    warn "请手动添加 DNS CNAME: $TUNNEL_HOSTNAME -> $TUNNEL_ID.cfargotunnel.com"
  fi

  # 获取 tunnel token (优先使用创建响应中的 token)
  if [ -n "$TUNNEL_TOKEN_FROM_CREATE" ]; then
    CF_TUNNEL_TOKEN="$TUNNEL_TOKEN_FROM_CREATE"
    log "Tunnel token 已从创建响应获取"
  else
    step "获取 tunnel connector token"
    local TOKEN_RESP=""
    TOKEN_RESP=$(curl -s "$CF_API/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" \
      -H "$AUTH_HEADER" 2>&1) || TOKEN_RESP=""
    CF_TUNNEL_TOKEN=$(echo "$TOKEN_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result||'')" 2>/dev/null) || CF_TUNNEL_TOKEN=""
    if [ -z "$CF_TUNNEL_TOKEN" ]; then
      warn "无法获取 tunnel token"
      [ -n "$TOKEN_RESP" ] && warn "响应: $TOKEN_RESP"
      warn "请在 CF Dashboard > Zero Trust > Tunnels > tg-s3 中获取 token"
      return 1
    fi
    log "Tunnel token 已获取"
  fi

  # 写入 .env (volume 挂载时自动持久化到宿主机)
  persist_env CF_TUNNEL_TOKEN "$CF_TUNNEL_TOKEN"
  log "CF_TUNNEL_TOKEN 已写入 .env"

  # 设置 VPS_URL 为 tunnel 域名
  VPS_URL="https://$TUNNEL_HOSTNAME"
  persist_env VPS_URL "$VPS_URL"
  log "VPS_URL 已设为: $VPS_URL"

  # 同步到 Worker secrets
  echo "$VPS_URL" | npx wrangler secret put VPS_URL 2>&1 || true
  log "VPS_URL secret 已更新"
}

# ============================================================
# Docker 全自动编排 (宿主机执行)
# ============================================================
deploy_docker() {
  # 检查 CLOUDFLARE_API_TOKEN (Docker 模式必需)
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    err "Docker 部署需要 CLOUDFLARE_API_TOKEN"
    err "请在 .env 中设置，或使用本地 wrangler 部署:"
    err "  npm install && npx wrangler login && npx wrangler deploy"
    exit 1
  fi

  # 逐个构建镜像 (避免 BuildKit 并行构建 bug)
  step "构建 Docker 镜像 (deploy)"
  if ! docker compose build deploy; then
    err "deploy 镜像构建失败"
    exit 1
  fi

  step "构建 Docker 镜像 (processor)"
  if ! docker compose build processor; then
    err "processor 镜像构建失败"
    exit 1
  fi

  # 通过 deploy 容器部署 CF Worker + 配置 Tunnel
  # .env 文件以 volume 挂载到容器，容器内修改 (CF_TUNNEL_TOKEN 等) 自动持久化
  step "部署 CF Worker"
  if ! docker compose --profile deploy run --rm -T deploy; then
    err "CF Worker 部署失败, 请检查日志"
    exit 1
  fi

  # 重新加载 .env (容器可能写入了 CF_TUNNEL_TOKEN, VPS_URL, VPS_SECRET)
  set -a
  source .env
  set +a

  # 启动常驻服务
  step "启动服务"
  if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
    docker compose --profile tunnel up -d
    log "processor + tunnel 已启动"
  else
    docker compose up -d processor
    warn "未配置 Cloudflare Tunnel (缺少 CF_CUSTOM_DOMAIN 或 API Token 权限不足)"
    warn "processor 已启动但外部无法访问"
    warn "如需 tunnel，请设置 CF_CUSTOM_DOMAIN 后重新运行 ./deploy.sh"
  fi

  # 等待 processor 就绪
  step "检查 processor 健康状态"
  sleep 2
  if docker compose ps processor 2>/dev/null | grep -q 'running'; then
    log "processor 运行正常"
  else
    warn "processor 可能未就绪, 请检查日志: docker compose logs processor"
  fi
}

# ============================================================
# VPS SSH 部署 (非 Docker 模式)
# ============================================================
deploy_vps() {
  step "部署 VPS 处理服务"

  if [ -z "${VPS_SSH:-}" ]; then
    err "VPS 部署需要设置 VPS_SSH (如 root@1.2.3.4)"
    exit 1
  fi

  VPS_DIR="${VPS_DEPLOY_DIR:-/opt/tg-s3}"

  # 测试 SSH 连接
  step "测试 SSH 连接: $VPS_SSH"
  if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS_SSH" "echo ok" &>/dev/null; then
    err "SSH 连接失败: $VPS_SSH"
    err "请确保:"
    err "  1. SSH 密钥已配置"
    err "  2. 目标主机可达"
    err "  3. VPS_SSH 格式正确 (如 root@1.2.3.4)"
    exit 1
  fi
  log "SSH 连接正常"

  # 检查 Docker
  step "检查 VPS Docker 环境"
  if ! ssh "$VPS_SSH" "command -v docker &>/dev/null && docker compose version &>/dev/null"; then
    warn "VPS 上未检测到 Docker, 正在安装..."
    ssh "$VPS_SSH" bash <<'INSTALL_DOCKER'
      curl -fsSL https://get.docker.com | sh
      systemctl enable docker
      systemctl start docker
INSTALL_DOCKER
    log "Docker 安装完成"
  else
    log "Docker 环境正常"
  fi

  # 创建部署目录
  ssh "$VPS_SSH" "mkdir -p \"$VPS_DIR\""

  # 上传文件
  step "上传处理服务文件"
  rsync -avz --delete \
    processor/package.json \
    processor/server.js \
    processor/Dockerfile \
    docker-compose.yml \
    "$VPS_SSH:$VPS_DIR/"

  # 上传 .env
  step "配置 VPS 环境变量"
  ssh "$VPS_SSH" "cat > \"$VPS_DIR/.env\"" <<ENV_EOF
TG_BOT_TOKEN=$TG_BOT_TOKEN
VPS_SECRET=${VPS_SECRET:-}
DEFAULT_CHAT_ID=$DEFAULT_CHAT_ID
TG_LOCAL_API=${TG_LOCAL_API:-https://api.telegram.org}
PORT=${VPS_PORT:-3000}
ENV_EOF
  log "VPS 环境变量已配置"

  # 构建并启动
  step "构建并启动服务"
  ssh "$VPS_SSH" bash <<DEPLOY_CMD
    cd "$VPS_DIR"
    docker compose down 2>/dev/null || true
    docker compose build --no-cache
    docker compose up -d
    echo "--- 服务状态 ---"
    docker compose ps
DEPLOY_CMD
  log "VPS 处理服务已启动"

  # 健康检查
  step "VPS 健康检查"
  sleep 3
  if ssh "$VPS_SSH" "curl -sf -o /dev/null http://127.0.0.1:${VPS_PORT:-3000}/api/jobs/nonexistent 2>/dev/null"; then
    log "VPS 处理服务运行正常"
  else
    if ssh "$VPS_SSH" "curl -sf -w '%{http_code}' -o /dev/null http://127.0.0.1:${VPS_PORT:-3000}/api/jobs/test 2>/dev/null" | grep -qE '40[0-9]'; then
      log "VPS 处理服务运行正常 (API 响应中)"
    else
      warn "VPS 服务可能未就绪, 请检查日志:"
      warn "  ssh $VPS_SSH 'cd $VPS_DIR && docker compose logs'"
    fi
  fi
}

# ============================================================
# 部署完成摘要
# ============================================================
print_summary() {
  echo ""
  echo -e "${GREEN}============================================================${NC}"
  echo -e "${GREEN}  tg-s3 部署完成${NC}"
  echo -e "${GREEN}============================================================${NC}"
  echo ""

  if [ -n "${EFFECTIVE_URL:-}" ]; then
    echo -e "  访问地址:    ${CYAN}${EFFECTIVE_URL}${NC}"
    echo -e "  Mini App:    ${CYAN}${EFFECTIVE_URL}/miniapp${NC}"
  elif [ -n "${WORKER_URL:-}" ]; then
    echo -e "  Worker URL:  ${CYAN}${WORKER_URL}${NC}"
    echo -e "  Mini App:    ${CYAN}${WORKER_URL}/miniapp${NC}"
  fi

  if [ -n "${VPS_URL:-}" ]; then
    echo -e "  Processor:   ${CYAN}${VPS_URL}${NC} (via Cloudflare Tunnel)"
  fi

  echo ""
  echo -e "  S3 凭据请在 Telegram Mini App 的 ${CYAN}Keys${NC} 标签页中创建"
  echo ""
  echo "  快速验证:"
  echo "    rclone mkdir tg-s3:photos"
  echo "    rclone copy ./test.jpg tg-s3:photos/"
  echo "    rclone ls tg-s3:photos/"
  echo ""
  echo "  常用操作:"
  echo "    更新代码后重新部署:  git pull && ./deploy.sh"
  echo "    仅重启服务:          docker compose --profile tunnel restart"
  echo "    查看日志:            docker compose --profile tunnel logs -f"
  echo "    停止所有服务:        docker compose --profile tunnel down"
  echo ""
}

# ============================================================
# 主流程
# ============================================================
echo -e "${CYAN}"
echo "  ┌─────────────────────────────────────┐"
echo "  │         tg-s3 一键部署               │"
echo "  │   Telegram-backed S3 Storage         │"
echo "  └─────────────────────────────────────┘"
echo -e "${NC}"

validate_required

if [ "$IN_CONTAINER" -eq 1 ]; then
  # ============================================
  # 容器内: 仅部署 CF Worker + 配置 tunnel
  # ============================================
  deploy_cf
  setup_tunnel || true
  print_summary
  exit 0
fi

# ============================================
# 宿主机
# ============================================
case "${1:-}" in
  --vps)
    # 传统 SSH 模式: 本地 wrangler 部署 Worker + SSH 部署 VPS
    deploy_cf
    deploy_vps
    ;;
  *)
    # 自动检测
    if command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
      # Docker 全自动编排
      deploy_docker
    else
      # 无 Docker: 本地 wrangler 部署 Worker
      deploy_cf
    fi
    ;;
esac

print_summary
