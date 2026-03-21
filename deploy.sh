#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# tg-s3 一键部署脚本
# 用法: ./deploy.sh [--cf-only | --vps-only | --all]
# 默认: --all (部署 CF Worker + VPS)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC} $1" >&2; }
step() { echo -e "\n${CYAN}==>${NC} $1"; }

# 生成随机字符串 (base62, 指定长度)
gen_random() {
  local len="${1:-32}"
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$len" 2>/dev/null || \
    openssl rand -base64 "$((len * 2))" | tr -dc 'A-Za-z0-9' | head -c "$len"
}

# ---- 加载 .env ----
if [ ! -f .env ]; then
  err "未找到 .env 文件。请复制 .env.example 为 .env 并填写配置:"
  err "  cp .env.example .env && vim .env"
  exit 1
fi

set -a
source .env
set +a

# ---- 自动生成可自动化的 secrets ----
# Webhook secret 从 TG_BOT_TOKEN 派生，不再需要 BEARER_TOKEN
derive_webhook_secret() {
  node -e "const c=require('crypto');console.log(c.createHmac('sha256',process.env.TG_BOT_TOKEN).update('tg-s3-webhook').digest('hex'))"
}

if [ -z "${VPS_SECRET:-}" ]; then
  VPS_SECRET="$(gen_random 48)"
  log "自动生成 VPS_SECRET"
fi

# ---- 参数解析 ----
MODE="all"
case "${1:-}" in
  --cf-only)  MODE="cf" ;;
  --vps-only) MODE="vps" ;;
  --all)      MODE="all" ;;
  "")         MODE="all" ;;
  *)
    echo "用法: $0 [--cf-only | --vps-only | --all]"
    exit 1
    ;;
esac

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

validate_vps() {
  if [ -z "${VPS_SSH:-}" ]; then
    err "VPS 部署需要设置 VPS_SSH (如 root@1.2.3.4)"
    exit 1
  fi
}

# ============================================================
# CF Worker 部署
# ============================================================
deploy_cf() {
  step "部署 Cloudflare Worker"

  # 检查 wrangler
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

  # 检查 wrangler 登录状态
  step "检查 Cloudflare 认证状态"
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    log "使用 CLOUDFLARE_API_TOKEN 认证"
  elif ! npx wrangler whoami &>/dev/null 2>&1; then
    warn "wrangler 未登录, 正在打开浏览器授权..."
    npx wrangler login
  fi
  log "Cloudflare 认证正常"

  # 创建 D1 数据库 (如果 wrangler.toml 中 database_id 为空)
  CURRENT_DB_ID=$(grep 'database_id' wrangler.toml | head -1 | sed 's/.*= *"\(.*\)"/\1/')
  if [ -z "$CURRENT_DB_ID" ]; then
    step "创建 D1 数据库 tg-s3-db"
    DB_OUTPUT=$(npx wrangler d1 create tg-s3-db 2>&1) || true

    # 提取 database_id
    DB_ID=$(echo "$DB_OUTPUT" | grep -o 'database_id = "[^"]*"' | head -1 | sed 's/database_id = "\(.*\)"/\1/')
    if [ -z "$DB_ID" ]; then
      # 数据库可能已存在, 尝试从 list 获取
      DB_ID=$(npx wrangler d1 list 2>&1 | grep 'tg-s3-db' | awk '{print $1}')
    fi

    if [ -z "$DB_ID" ]; then
      err "无法获取 D1 数据库 ID, 请手动创建:"
      err "  npx wrangler d1 create tg-s3-db"
      exit 1
    fi

    # 更新 wrangler.toml
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s/database_id = \"\"/database_id = \"$DB_ID\"/" wrangler.toml
    else
      sed -i "s/database_id = \"\"/database_id = \"$DB_ID\"/" wrangler.toml
    fi
    log "D1 数据库创建成功: $DB_ID"
  else
    DB_ID="$CURRENT_DB_ID"
    log "D1 数据库已存在: $DB_ID"
  fi

  # 创建 R2 缓存 bucket (如果不存在)
  step "创建 R2 缓存 bucket tg-s3-cache"
  if npx wrangler r2 bucket list 2>&1 | grep -q 'tg-s3-cache'; then
    log "R2 缓存 bucket 已存在"
  else
    npx wrangler r2 bucket create tg-s3-cache 2>&1 || true
    log "R2 缓存 bucket 创建完成"
  fi

  # R2 lifecycle: 90 天兜底 GC (实际清理由 cron 智能完成，lifecycle 只防止遗漏)
  step "配置 R2 兜底清理策略 (90 天)"
  npx wrangler r2 bucket lifecycle add tg-s3-cache \
    --expire-days 90 \
    --rule-id "cache-gc" 2>&1 || true
  log "R2 lifecycle 规则已设置"

  # 初始化数据库 schema
  step "初始化 D1 数据库 schema"
  npx wrangler d1 execute tg-s3-db --remote --file=src/storage/schema.sql --yes 2>&1 || true
  log "数据库 schema 已应用"

  # 设置 secrets (webhook secret 从 TG_BOT_TOKEN 派生，无需单独设置)
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
  DEPLOY_OUTPUT=$(npx wrangler deploy 2>&1)
  echo "$DEPLOY_OUTPUT"

  # 提取 Worker URL
  WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[^ ]+\.workers\.dev' | head -1)
  if [ -n "$WORKER_URL" ]; then
    log "Worker 部署成功: $WORKER_URL"
  else
    log "Worker 部署完成"
  fi

  # 设置 WORKER_URL secret (cron CDN 缓存清理和 bot 分享链接需要)
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
    WEBHOOK_RES=$(curl -sf "https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook?url=${WEBHOOK_URL}&secret_token=${WEBHOOK_SECRET}" 2>&1) || true
    if echo "$WEBHOOK_RES" | grep -q '"ok":true'; then
      log "Webhook 注册成功: $WEBHOOK_URL"
    else
      warn "Webhook 注册可能失败, 请手动检查"
      [ -n "$WEBHOOK_RES" ] && warn "  响应: $WEBHOOK_RES"
    fi
  fi

  # 设置自定义域名
  if [ -n "${CF_CUSTOM_DOMAIN:-}" ]; then
    step "配置自定义域名: $CF_CUSTOM_DOMAIN"
    warn "请在 Cloudflare Dashboard 中手动绑定自定义域名到 tg-s3 Worker"
    warn "Workers & Pages -> tg-s3 -> Settings -> Domains & Routes"
  fi
}

# ============================================================
# Cloudflare Tunnel 自动创建
# 需要: CLOUDFLARE_API_TOKEN + CF_CUSTOM_DOMAIN
# 创建后写入 CF_TUNNEL_TOKEN 到 .env
# ============================================================
setup_tunnel() {
  step "配置 Cloudflare Tunnel"

  # 如果已有 token, 跳过创建
  if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
    log "CF_TUNNEL_TOKEN 已设置, 跳过 tunnel 创建"
    return 0
  fi

  # 需要 API Token 和自定义域名
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    warn "需要 CLOUDFLARE_API_TOKEN 来自动创建 tunnel"
    warn "或在 CF Dashboard > Zero Trust > Tunnels 手动创建后设置 CF_TUNNEL_TOKEN"
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
  local ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
  if [ -z "$ACCOUNT_ID" ]; then
    step "获取 Cloudflare Account ID"
    ACCOUNT_ID=$(curl -sf "$CF_API/accounts" -H "$AUTH_HEADER" | \
      node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result?.[0]?.id||'')" 2>/dev/null) || ACCOUNT_ID=""
    if [ -z "$ACCOUNT_ID" ]; then
      warn "无法获取 Account ID, 请在 .env 中设置 CF_ACCOUNT_ID"
      return 1
    fi
    log "Account ID: ${ACCOUNT_ID:0:8}..."
  fi

  # 检查是否已有同名 tunnel
  step "检查现有 tunnel"
  local EXISTING=$(curl -sf "$CF_API/accounts/$ACCOUNT_ID/cfd_tunnel?name=tg-s3&is_deleted=false" \
    -H "$AUTH_HEADER" | \
    node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); const t=d.result?.find(t=>t.name==='tg-s3'); console.log(t?.id||'')" 2>/dev/null) || EXISTING=""

  local TUNNEL_ID=""
  if [ -n "$EXISTING" ]; then
    TUNNEL_ID="$EXISTING"
    log "已有 tunnel tg-s3: ${TUNNEL_ID:0:8}..."
  else
    # 创建 tunnel
    step "创建 Cloudflare Tunnel: tg-s3"
    local TUNNEL_SECRET
    TUNNEL_SECRET=$(openssl rand -base64 32 2>/dev/null || node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
    local CREATE_RESP
    CREATE_RESP=$(curl -sf -X POST "$CF_API/accounts/$ACCOUNT_ID/cfd_tunnel" \
      -H "$AUTH_HEADER" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"tg-s3\",\"tunnel_secret\":\"$TUNNEL_SECRET\",\"config_src\":\"cloudflare\"}") || CREATE_RESP=""
    TUNNEL_ID=$(echo "$CREATE_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result?.id||'')" 2>/dev/null) || TUNNEL_ID=""
    if [ -z "$TUNNEL_ID" ]; then
      warn "tunnel 创建失败, 请在 CF Dashboard 手动创建"
      [ -n "$CREATE_RESP" ] && warn "响应: $CREATE_RESP"
      return 1
    fi
    log "Tunnel 创建成功: ${TUNNEL_ID:0:8}..."
  fi

  # 配置 tunnel ingress
  local TUNNEL_HOSTNAME="vps.${CF_CUSTOM_DOMAIN}"
  step "配置 tunnel ingress: $TUNNEL_HOSTNAME -> processor:3000"
  curl -sf -X PUT "$CF_API/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "{\"config\":{\"ingress\":[{\"hostname\":\"$TUNNEL_HOSTNAME\",\"service\":\"http://processor:3000\",\"originRequest\":{\"noTLSVerify\":true}},{\"service\":\"http_status:404\"}]}}" >/dev/null 2>&1 || true
  log "Tunnel ingress 已配置"

  # 创建 DNS CNAME (如果不存在)
  step "配置 DNS: $TUNNEL_HOSTNAME -> tunnel"
  # 找到 zone: 从 CF_CUSTOM_DOMAIN 提取根域 (尝试匹配)
  local ZONE_ID=""
  # 先尝试完整域名, 再逐级去掉子域
  local DOMAIN="$CF_CUSTOM_DOMAIN"
  while [ -n "$DOMAIN" ] && [ -z "$ZONE_ID" ]; do
    ZONE_ID=$(curl -sf "$CF_API/zones?name=$DOMAIN" -H "$AUTH_HEADER" | \
      node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result?.[0]?.id||'')" 2>/dev/null) || ZONE_ID=""
    if [ -z "$ZONE_ID" ]; then
      # 去掉最左边的子域
      DOMAIN="${DOMAIN#*.}"
      # 如果没有点了, 停止
      if [[ "$DOMAIN" != *.* ]]; then break; fi
    fi
  done

  if [ -n "$ZONE_ID" ]; then
    # 检查记录是否已存在
    local EXISTING_DNS
    EXISTING_DNS=$(curl -sf "$CF_API/zones/$ZONE_ID/dns_records?name=$TUNNEL_HOSTNAME&type=CNAME" \
      -H "$AUTH_HEADER" | \
      node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result?.[0]?.id||'')" 2>/dev/null) || EXISTING_DNS=""

    if [ -n "$EXISTING_DNS" ]; then
      # 更新现有记录
      curl -sf -X PUT "$CF_API/zones/$ZONE_ID/dns_records/$EXISTING_DNS" \
        -H "$AUTH_HEADER" \
        -H "Content-Type: application/json" \
        -d "{\"type\":\"CNAME\",\"name\":\"$TUNNEL_HOSTNAME\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true}" >/dev/null 2>&1 || true
      log "DNS 记录已更新: $TUNNEL_HOSTNAME"
    else
      # 创建新记录
      curl -sf -X POST "$CF_API/zones/$ZONE_ID/dns_records" \
        -H "$AUTH_HEADER" \
        -H "Content-Type: application/json" \
        -d "{\"type\":\"CNAME\",\"name\":\"$TUNNEL_HOSTNAME\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true}" >/dev/null 2>&1 || true
      log "DNS 记录已创建: $TUNNEL_HOSTNAME"
    fi
  else
    warn "无法找到域名 $CF_CUSTOM_DOMAIN 对应的 CF Zone"
    warn "请手动添加 DNS CNAME: $TUNNEL_HOSTNAME -> $TUNNEL_ID.cfargotunnel.com"
  fi

  # 获取 tunnel token
  step "获取 tunnel connector token"
  local TOKEN_RESP
  TOKEN_RESP=$(curl -sf "$CF_API/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" \
    -H "$AUTH_HEADER") || TOKEN_RESP=""
  CF_TUNNEL_TOKEN=$(echo "$TOKEN_RESP" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.result||'')" 2>/dev/null) || CF_TUNNEL_TOKEN=""

  if [ -z "$CF_TUNNEL_TOKEN" ]; then
    warn "无法获取 tunnel token"
    warn "请在 CF Dashboard > Zero Trust > Tunnels > tg-s3 中获取 token"
    return 1
  fi
  log "Tunnel token 已获取"

  # 写入 .env (追加或更新)
  if grep -q '^CF_TUNNEL_TOKEN=' .env 2>/dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^CF_TUNNEL_TOKEN=.*|CF_TUNNEL_TOKEN=$CF_TUNNEL_TOKEN|" .env
    else
      sed -i "s|^CF_TUNNEL_TOKEN=.*|CF_TUNNEL_TOKEN=$CF_TUNNEL_TOKEN|" .env
    fi
  else
    echo "" >> .env
    echo "CF_TUNNEL_TOKEN=$CF_TUNNEL_TOKEN" >> .env
  fi
  log "CF_TUNNEL_TOKEN 已写入 .env"

  # 设置 VPS_URL 为 tunnel 域名
  VPS_URL="https://$TUNNEL_HOSTNAME"
  log "VPS_URL 已设为: $VPS_URL"

  # 同步到 Worker secrets
  echo "$VPS_URL" | npx wrangler secret put VPS_URL 2>&1 || true
  log "VPS_URL secret 已更新"

  echo ""
  echo -e "  ${GREEN}Cloudflare Tunnel 配置完成${NC}"
  echo -e "  Tunnel hostname: ${CYAN}$TUNNEL_HOSTNAME${NC}"
  echo -e "  启动 tunnel:  ${CYAN}docker compose --profile tunnel up -d${NC}"
  echo ""

  TUNNEL_CONFIGURED=1
}

# ============================================================
# VPS 部署 (非 Docker 模式, 通过 SSH 部署到远程 VPS)
# ============================================================
deploy_vps() {
  step "部署 VPS 处理服务"

  validate_vps

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
  ssh "$VPS_SSH" "mkdir -p $VPS_DIR"

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
  ssh "$VPS_SSH" "cat > $VPS_DIR/.env" <<ENV_EOF
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
    cd $VPS_DIR
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
    # 404 is expected for nonexistent job, but connection should work
    if ssh "$VPS_SSH" "curl -sf -w '%{http_code}' -o /dev/null http://127.0.0.1:${VPS_PORT:-3000}/api/jobs/test 2>/dev/null" | grep -qE '40[0-9]'; then
      log "VPS 处理服务运行正常 (API 响应中)"
    else
      warn "VPS 服务可能未就绪, 请检查日志:"
      warn "  ssh $VPS_SSH 'cd $VPS_DIR && docker compose logs'"
    fi
  fi
}

# ============================================================
# 部署后配置提示
# ============================================================
print_summary() {
  echo ""
  echo -e "${GREEN}============================================================${NC}"
  echo -e "${GREEN}  tg-s3 部署完成${NC}"
  echo -e "${GREEN}============================================================${NC}"
  echo ""

  if [ "$MODE" != "vps" ] && [ -n "${WORKER_URL:-}" ]; then
    echo -e "  Worker URL:  ${CYAN}${WORKER_URL}${NC}"
  fi
  if [ "$MODE" != "cf" ] && [ -n "${VPS_URL:-}" ]; then
    if [ "$TUNNEL_CONFIGURED" -eq 1 ]; then
      echo -e "  Tunnel URL:  ${CYAN}${VPS_URL}${NC} (via Cloudflare Tunnel)"
    else
      echo -e "  VPS URL:     ${CYAN}${VPS_URL}${NC}"
    fi
  fi

  echo ""
  echo -e "  S3 凭据请在 Telegram Mini App 的 ${CYAN}Keys${NC} 标签页中创建"

  echo ""
  echo "  快速验证:"
  echo "  rclone mkdir tg-s3:photos"
  echo "  rclone copy ./test.jpg tg-s3:photos/"
  echo "  rclone ls tg-s3:photos/"
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

# 初始化 summary 变量
TUNNEL_CONFIGURED=0

validate_required

case "$MODE" in
  cf)
    deploy_cf
    # 尝试创建 tunnel (可选, 失败不阻塞)
    setup_tunnel || true
    ;;
  vps)
    if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
      warn "Docker 环境下 processor 由 docker compose 管理, 无需单独部署"
      warn "运行: docker compose up -d processor"
      warn "如需 tunnel: docker compose --profile tunnel up -d"
    else
      deploy_vps
    fi
    ;;
  all)
    deploy_cf
    if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
      # Docker 环境: processor 是本地 compose 服务
      # 尝试创建 tunnel (可选, 失败不阻塞)
      setup_tunnel || true
      log "CF Worker 部署完成。processor 由 docker compose 管理"
      if [ "$TUNNEL_CONFIGURED" -eq 1 ]; then
        log "启动所有服务: docker compose --profile tunnel up -d"
      else
        log "deploy 容器退出后, docker compose 会自动启动 processor"
      fi
    elif [ -n "${VPS_SSH:-}" ]; then
      deploy_vps
    else
      warn "VPS_SSH 未设置, 跳过 VPS 部署"
      warn "如需大文件和媒体处理功能, 请在 .env 中配置 VPS_SSH 后运行:"
      warn "  ./deploy.sh --vps-only"
    fi
    ;;
esac

print_summary
