# 配置参考

[English](configuration.md) | [中文](configuration.zh.md) | [日本語](configuration.ja.md) | [Français](configuration.fr.md)

## 环境变量

所有配置均通过环境变量完成。Docker 部署时在 `.env` 文件中设置；手动部署时，`deploy.sh` 会从 `.env` 读取并推送为 Cloudflare secrets。

### 必填

| 变量 | 说明 | 示例 |
|------|------|------|
| `TG_BOT_TOKEN` | 从 @BotFather 获取的 Telegram Bot API token | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| `DEFAULT_CHAT_ID` | Telegram 群组/超级群组的 chat ID | `-1001234567890` |

### 自动生成（无需手动设置）

| 变量 | 说明 | 生成方式 |
|------|------|----------|
| `VPS_SECRET` | Worker 与 processor 之间的认证密钥 | `deploy.sh`（随机 48 字符） |
| `SSE_MASTER_KEY` | SSE-S3 服务端加密的 Base64 密钥。deploy.sh 自动生成。 | `deploy.sh` |
| S3 凭据 | S3 API 认证用的 access key + secret key | `deploy.sh`（在 D1 `credentials` 表中创建） |
| Webhook 密钥 | Telegram webhook 验证密钥 | 由 `TG_BOT_TOKEN` 通过 HMAC-SHA256 派生 |

S3 凭据在部署时显示一次。之后可在 Mini App 的 **Keys** 标签页中管理（创建、撤销、设置单桶权限）。

### Cloudflare（Docker 部署）

| 变量 | 说明 | 示例 |
|------|------|------|
| `CLOUDFLARE_API_TOKEN` | CF API token（Docker 部署必填，手动部署可选） | `cf-api-token...` |
| `CF_ACCOUNT_ID` | CF 账户 ID（未设置时自动检测） | `abc123def456` |
| `CF_CUSTOM_DOMAIN` | Worker 的自定义域名（同时启用 tunnel 自动创建） | `s3.example.com` |
| `CF_TUNNEL_TOKEN` | Cloudflare Tunnel 连接器 token（设置 CF_CUSTOM_DOMAIN 时自动创建，也可手动设置） | `eyJhIjo...` |

API token 权限：Workers Scripts:Edit、D1:Edit、R2:Edit、Account Settings:Read。如需 tunnel 自动创建，需额外添加 Cloudflare Tunnel:Edit 和 DNS:Edit。

### VPS / Processor（可选）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VPS_SSH` | VPS 部署的 SSH 连接字符串 | -- |
| `VPS_DEPLOY_DIR` | VPS 上的部署目录 | `/opt/tg-s3` |
| `VPS_PORT` | Processor 服务端口 | `3000` |
| `VPS_URL` | VPS processor 的公网 URL（使用 tunnel 时自动设置） | -- |
| `VPS_SECRET` | Worker 与 processor 之间的认证密钥（自动生成） | -- |
| `TELEGRAM_API_ID` | Telegram API ID，用于 Local Bot API（从 https://my.telegram.org 获取），启用 2GB 文件支持 | -- |
| `TELEGRAM_API_HASH` | Telegram API Hash，用于 Local Bot API（从 https://my.telegram.org 获取） | -- |

### Worker 运行时

以下变量在 `wrangler.toml` 中以 vars 或 bindings 形式配置：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `S3_REGION` | 报告的 AWS 区域 | `us-east-1` |
| `WORKER_URL` | Worker 的公网 URL（由 deploy.sh 自动设置） | -- |

### D1 和 R2 绑定

在 `wrangler.toml` 中配置：

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

关键配置段：

```toml
name = "tg-s3"
main = "src/index.ts"
compatibility_date = "2026-03-15"

[vars]
S3_REGION = "us-east-1"

[triggers]
crons = ["0 */6 * * *"]  # 每 6 小时执行维护任务
```

### 定时维护任务

定时处理器每 6 小时运行一次，执行以下操作：

1. 清理已过期的分享 token
2. 清理孤立的分享 token（对象已删除但分享记录仍存在）
3. 清理超过 24 小时的分段上传
4. 清理孤立的分块数据
5. 清理已过期的密码尝试记录
6. 一致性检查（抽样 50 个对象，验证 Telegram 文件可访问性）
7. R2 缓存清理（清除已从 D1 删除的对象缓存）

## 安全说明

- **S3 凭据**存储在 D1 中，用于 AWS SigV4 签名验证。自动生成高强度随机值。在 Mini App Keys 标签页中管理。
- **Webhook 密钥**由 `TG_BOT_TOKEN` 通过 HMAC-SHA256 确定性派生，无需单独的环境变量。
- **VPS_SECRET** 用于 Worker 与 processor 之间的通信认证。未设置时自动生成。
- **CLOUDFLARE_API_TOKEN** 拥有对你的 CF 账户的写入权限，切勿提交到 git。
- `.env` 文件默认已被 `.gitignore` 和 `.dockerignore` 排除。

## 速率限制

### Cloudflare 免费计划

| 资源 | 限制 |
|------|------|
| Worker 请求数 | 100,000/天 |
| D1 读取 | 5,000,000/天 |
| D1 写入 | 100,000/天 |
| 每次调用的 D1 查询数 | 50 |
| R2 A 类操作（写入） | 1,000,000/月 |
| R2 B 类操作（读取） | 10,000,000/月 |
| R2 存储空间 | 10 GB |

### Telegram Bot API

| 资源 | 限制 |
|------|------|
| 每频道消息数 | 约 20/分钟 |
| 全局消息速率 | 约 30/秒 |
| 文件下载 | 20 MB（Bot API）/ 2 GB（Local Bot API） |
| 文件上传 | 20 MB（Bot API，与下载限制对齐）/ 2 GB（Local Bot API） |
