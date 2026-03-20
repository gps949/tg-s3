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

## Method 1: Docker Deployment (Recommended)

Best for VPS deployment. One command handles everything.

```bash
# Clone and configure
git clone https://github.com/pocketclouds/tg-s3.git
cd tg-s3
cp .env.example .env
```

Edit `.env` with required values:

```bash
# Required
TG_BOT_TOKEN=123456:ABC-DEF...
DEFAULT_CHAT_ID=-1001234567890
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
BEARER_TOKEN=a-random-secret-string
CLOUDFLARE_API_TOKEN=your-cf-api-token

# Optional: custom domain
CF_CUSTOM_DOMAIN=s3.example.com
```

Deploy:

```bash
docker compose up -d
```

This starts two services:
- **deploy** -- Pushes the Worker to Cloudflare (runs once, then exits)
- **processor** -- Handles large files and media processing (stays running)

Check deployment logs:

```bash
docker compose logs deploy
```

### Updating

```bash
git pull
docker compose up -d --build
```

## Method 2: Manual Deployment

### Cloudflare Worker Only (Minimal Tier)

```bash
npm install
cp .env.example .env
# Edit .env

./deploy.sh --cf-only
```

The script will:
1. Validate configuration
2. Create D1 database and initialize schema
3. Create R2 bucket with lifecycle policy
4. Set all secrets in Cloudflare
5. Deploy the Worker
6. Register Telegram Bot webhook

### With VPS (Standard Tier)

Ensure your `.env` includes VPS settings:

```bash
VPS_SSH=user@your-vps-ip
VPS_DEPLOY_DIR=/opt/tg-s3
VPS_PORT=3000
VPS_URL=https://vps.example.com:3000
VPS_SECRET=a-random-vps-secret
```

Then deploy everything:

```bash
./deploy.sh --all
```

Or deploy VPS separately:

```bash
./deploy.sh --vps-only
```

The VPS deployment will:
1. Check SSH connectivity
2. Install Docker if needed
3. Upload processor files via rsync
4. Build and start the processor container

## Post-Deployment

### Verify S3 Access

```bash
# AWS CLI
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
- Re-register: `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-worker.workers.dev/bot/webhook&secret_token=<BEARER_TOKEN>"`

### D1 errors
- Check database exists: `npx wrangler d1 list`
- Re-initialize schema: `npm run db:init:remote`

### VPS processor not reachable
- Check container: `docker compose logs processor`
- Verify port is open: `curl http://localhost:3000/health`
- Ensure VPS_URL is accessible from Cloudflare Workers
