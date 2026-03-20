# Configuration Reference

[English](configuration.md) | [中文](configuration.zh.md) | [日本語](configuration.ja.md) | [Français](configuration.fr.md)

## Environment Variables

All configuration is via environment variables. For Docker deployment, set them in `.env`. For manual deployment, they are read from `.env` by `deploy.sh` and pushed as Cloudflare secrets.

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `TG_BOT_TOKEN` | Telegram Bot API token from @BotFather | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| `DEFAULT_CHAT_ID` | Telegram group/supergroup chat ID | `-1001234567890` |
| `S3_ACCESS_KEY_ID` | S3 access key for client authentication | `myaccesskey` |
| `S3_SECRET_ACCESS_KEY` | S3 secret key for client authentication | `mysecretkey123` |
| `BEARER_TOKEN` | Shared secret for Bot webhook verification and internal auth | `random-string-here` |

### Cloudflare (Docker deployment)

| Variable | Description | Example |
|----------|-------------|---------|
| `CLOUDFLARE_API_TOKEN` | CF API token (required for Docker, optional for manual) | `cf-api-token...` |
| `CF_ACCOUNT_ID` | CF account ID (auto-detected if not set) | `abc123def456` |
| `CF_CUSTOM_DOMAIN` | Custom domain for the worker | `s3.example.com` |

### VPS / Processor (Optional)

| Variable | Description | Default |
|----------|-------------|---------|
| `VPS_SSH` | SSH connection string for VPS deployment | -- |
| `VPS_DEPLOY_DIR` | Deployment directory on VPS | `/opt/tg-s3` |
| `VPS_PORT` | Processor service port | `3000` |
| `VPS_URL` | Public URL of the VPS processor | -- |
| `VPS_SECRET` | Auth secret between Worker and processor | -- |
| `TG_LOCAL_API` | Telegram Local Bot API endpoint | `https://api.telegram.org` |

### Worker Runtime

These are set in `wrangler.toml` as vars or bindings:

| Variable | Description | Default |
|----------|-------------|---------|
| `S3_REGION` | Reported AWS region | `us-east-1` |
| `WORKER_URL` | Public worker URL (auto-set by deploy.sh) | -- |

### D1 and R2 Bindings

Configured in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "tg-s3-db"
database_id = "your-database-id"

[[r2_buckets]]
binding = "CACHE"
bucket_name = "tg-s3-cache"
```

## wrangler.toml

Key configuration sections:

```toml
name = "tg-s3"
main = "src/index.ts"
compatibility_date = "2026-03-15"

[vars]
S3_REGION = "us-east-1"

[triggers]
crons = ["0 */6 * * *"]  # Maintenance every 6 hours
```

### Cron Maintenance Tasks

The scheduled handler runs every 6 hours and performs:

1. Clean expired share tokens
2. Clean orphaned share tokens (object deleted but share remains)
3. Clean stale multipart uploads (>24 hours)
4. Clean orphaned chunks
5. Clean expired password attempt records
6. Consistency check (sample 50 objects, verify Telegram file access)
7. R2 cache cleanup (evict objects deleted from D1)

## Security Notes

- **S3 credentials** are used for AWS SigV4 signature verification. Choose strong, random values.
- **BEARER_TOKEN** authenticates Telegram webhook calls and presigned URL generation. Keep it secret.
- **VPS_SECRET** authenticates Worker-to-processor communication. Use a separate random value.
- **CLOUDFLARE_API_TOKEN** has write access to your CF account. Never commit it to git.
- The `.env` file is in `.gitignore` and `.dockerignore` by default.

## Rate Limits

### Cloudflare Free Tier

| Resource | Limit |
|----------|-------|
| Worker requests | 100,000/day |
| D1 reads | 5,000,000/day |
| D1 writes | 100,000/day |
| D1 queries per invocation | 50 |
| R2 Class A ops (write) | 1,000,000/month |
| R2 Class B ops (read) | 10,000,000/month |
| R2 storage | 10 GB |

### Telegram Bot API

| Resource | Limit |
|----------|-------|
| Messages per channel | ~20/minute |
| Global message rate | ~30/second |
| File download | 20 MB (Bot API) / 2 GB (Local Bot API) |
| File upload | 50 MB (Bot API) / 2 GB (Local Bot API) |
