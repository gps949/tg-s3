# Deployment Guide

[English](deployment.md) | [中文](deployment.zh.md) | [日本語](deployment.ja.md) | [Français](deployment.fr.md)

## Deployment Tiers

TG-S3 supports three deployment tiers:

| Tier | Components | Cost | Capabilities |
|------|-----------|------|-------------|
| Minimal | CF Worker + D1 + R2 | $0/month | S3 API, Bot, Mini App, files up to 20MB |
| Standard | Minimal + VPS | ~$4/month | + files up to 2GB, media processing |
| Enhanced | Standard + CF paid plan | ~$9/month | + higher rate limits, more D1 queries |

## Prerequisites

1. **Telegram Bot** -- Create via [@BotFather](https://t.me/BotFather), save the token
2. **Telegram Group** -- Create a group/supergroup, add your bot as admin, get the chat ID
3. **Cloudflare Account** -- Sign up at [dash.cloudflare.com](https://dash.cloudflare.com)
4. **Node.js 22+** -- Required for wrangler CLI (manual deploy only)

### Getting the Chat ID

Add [@userinfobot](https://t.me/userinfobot) to your group temporarily. It will reply with the chat ID (a negative number like `-1001234567890`). Remove it after.

### Creating a Cloudflare API Token

For Docker deployment, create a token at [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) with these permissions:
- Account / Workers Scripts: Edit
- Account / D1: Edit
- Account / R2: Edit
- Account / Account Settings: Read
- Account / Cloudflare Tunnel: Edit *(only if using tunnel)*
- Zone / DNS: Edit *(only if using tunnel with custom domain)*

## Method 1: Docker Deployment (Recommended)

Best for VPS deployment. One command handles everything.

```bash
# Clone and configure
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
cp .env.example .env
```

Edit `.env` with required values (only 2 required):

```bash
# Required
TG_BOT_TOKEN=123456:ABC-DEF...
DEFAULT_CHAT_ID=-1001234567890

# Docker deployment
CLOUDFLARE_API_TOKEN=your-cf-api-token

# Optional: custom domain (also enables automatic tunnel creation)
CF_CUSTOM_DOMAIN=s3.example.com
```

All other credentials (S3 keys, VPS_SECRET, webhook secret) are **auto-generated** during deployment.

Deploy:

```bash
./deploy.sh
```

The script auto-detects the environment and does the right thing:
- **Host with Docker:** Builds images, deploys the CF Worker, configures tunnel (if enabled), starts all services
- **Host without Docker:** Uses local wrangler to deploy the Worker directly

After deployment, create S3 credentials in the Telegram Mini App (Keys tab) to connect S3 clients.

### Cloudflare Tunnel (Recommended for VPS)

Cloudflare Tunnel creates a secure connection between the processor and CF Workers without exposing ports publicly.

> **Note:** 2GB large-file support requires **both** the Local Bot API (`TELEGRAM_API_ID`/`TELEGRAM_API_HASH`) **and** a Worker-reachable processor (`VPS_URL`, typically via this tunnel). Setting only `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` is not enough -- files larger than 20MB will still fail.

**Automatic setup** (requires `CF_CUSTOM_DOMAIN` in `.env`):

`deploy.sh` auto-creates a tunnel and configures DNS. The tunnel hostname will be `vps.<your-custom-domain>`, and `VPS_URL` is set for you (in `.env` and as a Worker secret). Just run `./deploy.sh` -- tunnel setup is handled automatically when `CF_CUSTOM_DOMAIN` is set.

**Manual setup** (without custom domain):

1. Go to CF Dashboard > Zero Trust > Networks > Tunnels
2. Create a tunnel named `tg-s3`
3. Add a public hostname pointing to `http://processor:3000`
4. Copy the tunnel token **and** the public hostname from step 3 to `.env`:

```bash
CF_TUNNEL_TOKEN=eyJhIjo...
VPS_URL=https://vps.example.com   # public hostname configured in step 3
```

5. Start with tunnel profile:

```bash
./deploy.sh
```

The Worker reaches the processor through Cloudflare's network instead of a direct connection, but it still needs `VPS_URL` (pushed as a Worker secret by `deploy.sh`) to know the tunnel's public hostname. With manual setup you must set `VPS_URL` yourself, otherwise files larger than 20MB will fail.

### Updating

```bash
git pull && ./deploy.sh
```

## Method 2: Manual Deployment (No Docker)

### Cloudflare Worker Only (Minimal Tier)

```bash
npm install
cp .env.example .env
# Edit .env (only TG_BOT_TOKEN and DEFAULT_CHAT_ID required)

./deploy.sh
```

The script auto-detects that Docker is not available and uses local wrangler. It will:
1. Validate configuration
2. Create D1 database and initialize schema
3. Create R2 bucket with lifecycle policy
4. Auto-generate VPS_SECRET
5. Create initial admin S3 credential in D1
6. Set all secrets in Cloudflare
7. Deploy the Worker
8. Register Telegram Bot webhook

### Legacy VPS SSH Deployment

For deploying the processor to a remote VPS over SSH, add VPS settings to `.env`:

```bash
VPS_SSH=user@your-vps-ip
VPS_DEPLOY_DIR=/opt/tg-s3
VPS_PORT=3000
VPS_URL=https://vps.example.com:3000
# VPS_SECRET is auto-generated if not set
```

Then deploy:

```bash
./deploy.sh --vps
```

The VPS deployment will:
1. Check SSH connectivity
2. Install Docker if needed
3. Upload processor files via rsync
4. Build and start the processor container

## Post-Deployment

### S3 Credentials

S3 credentials are shown once during deployment. You can also manage credentials (create, revoke, set per-bucket permissions) in the Mini App's **Keys** tab.

### Verify S3 Access

```bash
# AWS CLI (use credentials from deploy output)
aws --endpoint-url https://your-worker.workers.dev s3 ls
aws --endpoint-url https://your-worker.workers.dev s3 mb s3://test
aws --endpoint-url https://your-worker.workers.dev s3 cp file.txt s3://test/

# rclone
rclone config create tgs3 s3 \
  provider=Other \
  access_key_id=YOUR_KEY \
  secret_access_key=YOUR_SECRET \
  endpoint=https://your-worker.workers.dev \
  acl=private
rclone ls tgs3:default
```

### Verify Bot

Send `/start` to your bot in Telegram. It should respond with a welcome message.

### Verify Mini App

Send `/miniapp` to the bot, or access `https://your-worker.workers.dev/miniapp` directly.

## Custom Domain

1. Add a CNAME record in Cloudflare DNS pointing to your worker
2. In the Cloudflare dashboard, go to Workers & Pages > your worker > Settings > Triggers
3. Add the custom domain
4. Set `CF_CUSTOM_DOMAIN` in `.env` and redeploy

## Troubleshooting

### Worker not responding
- Check `npx wrangler tail` for live logs
- Verify secrets are set: `npx wrangler secret list`

### Bot not receiving messages
- Verify webhook: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
- Re-register: redeploy with `deploy.sh` (webhook secret is derived from TG_BOT_TOKEN automatically)

### D1 errors
- Check database exists: `npx wrangler d1 list`
- Re-initialize schema: `npm run db:init:remote`

### VPS processor not reachable
- Check container: `docker compose logs processor`
- Verify port is open: `curl http://localhost:3000/health`
- Consider using Cloudflare Tunnel instead of direct port exposure
