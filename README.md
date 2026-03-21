# TG-S3

**Telegram-backed S3-compatible storage on Cloudflare Workers**

[English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Français](README.fr.md)

---

TG-S3 turns Telegram into an S3-compatible object storage backend. Files are stored as Telegram messages, metadata lives in Cloudflare D1, and the whole thing runs on Cloudflare Workers with zero runtime dependencies.

## Features

- **S3-compatible API** -- 21 operations including multipart upload, presigned URLs, and conditional requests
- **Unlimited free storage** -- Telegram provides the storage layer at no cost
- **Three-tier caching** -- CF CDN (L1) -> R2 (L2) -> Telegram (L3) for fast reads
- **Telegram Bot** -- Manage files, buckets, and shares directly from Telegram
- **Mini App** -- Full-featured web UI inside Telegram with file browser, uploads, and share management
- **File sharing** -- Password-protected share links with expiry, download limits, and inline preview
- **Large file support** -- Files up to 2GB via optional VPS proxy with Local Bot API
- **Media processing** -- Image conversion (HEIC/WebP), video transcoding, Live Photo handling via VPS
- **Multi-credential auth** -- D1-backed credential management with per-bucket and per-operation permissions
- **Cloudflare Tunnel** -- Secure VPS connectivity without exposing public ports
- **Multi-language** -- Mini App supports English, Chinese, Japanese, and French
- **Zero cost entry** -- Core functionality runs entirely on Cloudflare's free tier

## Architecture

```
S3 Client ─────┐
                │
Telegram Bot ───┤
                ├──▶ Cloudflare Worker ──▶ D1 (metadata)
Mini App ───────┤         │                R2 (cache)
                │         │
Share Links ────┘         ▼
                     Telegram API ◀──▶ VPS Proxy (optional, >20MB)
```

**Components:**

| Component | Role | Cost |
|-----------|------|------|
| CF Worker | S3 API gateway, bot webhook, mini app host | Free tier |
| CF D1 | Metadata storage (objects, buckets, shares) | Free tier |
| CF R2 | Persistent cache for files <=20MB | Free tier (10GB) |
| Telegram | Persistent file storage (unlimited) | Free |
| VPS + Processor | Large files (>20MB), media processing | ~$4/month (optional) |

## Quick Start

### Prerequisites

- Node.js 22+
- A [Telegram Bot](https://t.me/BotFather) with token
- A Telegram group/supergroup (get chat ID via [@userinfobot](https://t.me/userinfobot))
- A [Cloudflare account](https://dash.cloudflare.com)

### Option 1: Docker (recommended)

```bash
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
cp .env.example .env
# Edit .env: only TG_BOT_TOKEN, DEFAULT_CHAT_ID, and CLOUDFLARE_API_TOKEN needed
docker compose up -d

# With Cloudflare Tunnel (recommended, no open port needed):
docker compose --profile tunnel up -d
```

The `deploy` service pushes the Worker to Cloudflare and auto-generates secrets. S3 credentials can be created in the Telegram Mini App (Keys tab) when needed.

### Option 2: Manual deployment

```bash
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
npm install
cp .env.example .env
# Edit .env: only TG_BOT_TOKEN and DEFAULT_CHAT_ID required

# Deploy Cloudflare Worker (auto-generates all secrets)
./deploy.sh --cf-only

# (Optional) Deploy VPS processor
./deploy.sh --vps-only
```

### Verify

Configure any S3 client to point at your worker URL:

```bash
# Using AWS CLI
aws configure set aws_access_key_id YOUR_KEY
aws configure set aws_secret_access_key YOUR_SECRET
aws --endpoint-url https://your-worker.workers.dev s3 ls

# Using rclone
rclone config create tgs3 s3 \
  provider=Other \
  access_key_id=YOUR_KEY \
  secret_access_key=YOUR_SECRET \
  endpoint=https://your-worker.workers.dev \
  acl=private
rclone ls tgs3:default
```

## S3 Compatibility

21 operations supported across object CRUD, multipart upload, bucket management, and authentication.

| Category | Operations |
|----------|-----------|
| Objects | GetObject, PutObject, HeadObject, DeleteObject, DeleteObjects, CopyObject |
| Listing | ListObjectsV2, ListObjects (v1) |
| Multipart | CreateMultipartUpload, UploadPart, UploadPartCopy, CompleteMultipartUpload, AbortMultipartUpload, ListParts, ListMultipartUploads |
| Buckets | ListBuckets, CreateBucket, DeleteBucket, HeadBucket, GetBucketLocation, GetBucketVersioning |
| Auth | AWS SigV4 (multi-credential), Presigned URLs, Bearer token, Telegram initData |

**Not supported (by design):** versioning, server-side encryption, lifecycle policies, ACLs, cross-region replication. See [docs/S3-COMPAT.md](docs/S3-COMPAT.md) for details.

## Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/help` | Command reference |
| `/buckets` | List all buckets |
| `/ls [bucket] [prefix]` | List objects |
| `/info <bucket> <key>` | Object details |
| `/search <query>` | Search objects |
| `/share <bucket> <key>` | Create share link |
| `/shares` | List active shares |
| `/revoke <token>` | Revoke a share |
| `/delete <bucket> <key>` | Delete object (with confirmation) |
| `/stats` | Storage statistics |
| `/setbucket <name>` | Set default bucket |
| `/miniapp` | Open Mini App |

Send any file to the bot to upload it to the default bucket.

## Documentation

- [Deployment Guide](docs/deployment.md)
- [Configuration Reference](docs/configuration.md)
- [Bot Commands](docs/bot-commands.md)
- [S3 Compatibility](docs/S3-COMPAT.md)
- [Architecture Design](docs/design/00-overview.md)

## Tech Stack

- **Runtime:** Cloudflare Workers (zero runtime dependencies)
- **Database:** Cloudflare D1 (SQLite)
- **Cache:** Cloudflare R2 + CF Cache API
- **Auth:** AWS SigV4, presigned URLs, Bearer tokens
- **Language:** TypeScript (strict mode)
- **Media Processing:** Sharp + FFmpeg (VPS only)
- **Build:** wrangler v3

## License

MIT
