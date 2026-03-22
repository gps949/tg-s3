# TG-S3

**基于 Telegram 的 S3 兼容存储，运行在 Cloudflare Workers 上**

[English](README.md) | [中文](README.zh.md) | [日本語](README.ja.md) | [Français](README.fr.md)

---

TG-S3 将 Telegram 变成 S3 兼容的对象存储后端。文件作为 Telegram 消息存储，元数据保存在 Cloudflare D1 中，整个系统运行在 Cloudflare Workers 上，零运行时依赖。

## 功能特性

- **S3 兼容 API** -- 支持 27 种操作，包括分片上传、预签名 URL 和条件请求
- **无限免费存储** -- Telegram 提供免费的存储层
- **三级缓存** -- CF CDN (L1) -> R2 (L2) -> Telegram (L3)，加速读取
- **Telegram Bot** -- 直接在 Telegram 中管理文件、存储桶和分享
- **Mini App** -- Telegram 内置的完整 Web UI，支持文件浏览、上传和分享管理
- **文件分享** -- 支持密码保护、过期时间、下载限制和在线预览的分享链接
- **服务端加密** -- 支持 SSE-C（客户提供密钥）和 SSE-S3（服务端托管密钥），采用 AES-256-GCM 加密
- **大文件支持** -- 通过可选的 VPS 代理和 Local Bot API 支持最大 2GB 文件
- **媒体处理** -- 通过 VPS 实现图片转换 (HEIC/WebP)、视频转码、Live Photo 处理
- **多凭据认证** -- 基于 D1 的凭据管理，支持按存储桶和操作设置权限
- **Cloudflare Tunnel** -- 安全连接 VPS，无需暴露公网端口
- **多语言** -- Mini App 支持英语、中文、日语和法语
- **零成本起步** -- 核心功能完全运行在 Cloudflare 免费套餐上

## 架构

```
S3 客户端 ──────┐
                │
Telegram Bot ───┤
                ├──▶ Cloudflare Worker ──▶ D1 (元数据)
Mini App ───────┤         │                R2 (缓存)
                │         │
分享链接 ───────┘         ▼
                     Telegram API ◀──▶ VPS 代理 (可选，>20MB)
```

**组件：**

| 组件 | 作用 | 费用 |
|------|------|------|
| CF Worker | S3 API 网关、Bot Webhook、Mini App 托管 | 免费套餐 |
| CF D1 | 元数据存储（对象、存储桶、分享） | 免费套餐 |
| CF R2 | 持久缓存，<=20MB 文件 | 免费套餐 (10GB) |
| Telegram | 持久文件存储（无限容量） | 免费 |
| VPS + Processor | 大文件 (>20MB)、媒体处理 | 约 $4/月（可选） |

## 快速开始

### 前置条件

- Node.js 22+
- 一个 [Telegram Bot](https://t.me/BotFather) 及其 Token
- 一个 Telegram 群组/超级群组（通过 [@userinfobot](https://t.me/userinfobot) 获取 Chat ID）
- 一个 [Cloudflare 账户](https://dash.cloudflare.com)

### 一键部署

```bash
git clone https://github.com/gps949/tg-s3.git
cd tg-s3
cp .env.example .env
# 编辑 .env: 填写 TG_BOT_TOKEN、DEFAULT_CHAT_ID、CLOUDFLARE_API_TOKEN
./deploy.sh
```

`deploy.sh` 自动检测运行环境：有 Docker 时自动构建镜像、部署 CF Worker、配置 Cloudflare Tunnel 并启动所有服务；无 Docker 时使用本地 wrangler 部署。S3 凭据可在 Telegram Mini App 的 Keys 标签页中创建。

### 验证

将任意 S3 客户端指向你的 Worker URL：

```bash
# 使用 AWS CLI
aws configure set aws_access_key_id YOUR_KEY
aws configure set aws_secret_access_key YOUR_SECRET
aws --endpoint-url https://your-worker.workers.dev s3 ls

# 使用 rclone
rclone config create tgs3 s3 \
  provider=Other \
  access_key_id=YOUR_KEY \
  secret_access_key=YOUR_SECRET \
  endpoint=https://your-worker.workers.dev \
  acl=private
rclone ls tgs3:default
```

## S3 兼容性

支持 27 种操作，涵盖对象 CRUD、分片上传、存储桶管理和认证。

| 分类 | 操作 |
|------|------|
| 对象 | GetObject, PutObject, HeadObject, DeleteObject, DeleteObjects, CopyObject |
| 标签 | GetObjectTagging, PutObjectTagging, DeleteObjectTagging |
| 列举 | ListObjectsV2, ListObjects (v1) |
| 分片上传 | CreateMultipartUpload, UploadPart, UploadPartCopy, CompleteMultipartUpload, AbortMultipartUpload, ListParts, ListMultipartUploads |
| 存储桶 | ListBuckets, CreateBucket, DeleteBucket, HeadBucket, GetBucketLocation, GetBucketVersioning |
| 生命周期 | GetBucketLifecycleConfiguration, PutBucketLifecycleConfiguration, DeleteBucketLifecycleConfiguration |
| 认证 | AWS SigV4（多凭据）、预签名 URL、Bearer Token、Telegram initData |

**不支持（设计决策）：** 版本控制、ACL、跨区域复制。详见 [docs/S3-COMPAT.md](docs/S3-COMPAT.md)。

## Telegram Bot 命令

| 命令 | 说明 |
|------|------|
| `/start` | 欢迎消息 |
| `/help` | 命令帮助 |
| `/buckets` | 列出所有存储桶 |
| `/ls [bucket] [prefix]` | 列出对象 |
| `/info <bucket> <key>` | 对象详情 |
| `/search <query>` | 搜索对象 |
| `/share <bucket> <key>` | 创建分享链接 |
| `/shares` | 列出活跃的分享 |
| `/revoke <token>` | 撤销分享 |
| `/delete <bucket> <key>` | 删除对象（需确认） |
| `/stats` | 存储统计 |
| `/setbucket <name>` | 设置默认存储桶 |
| `/miniapp` | 打开 Mini App |

直接发送文件给 Bot 即可上传到默认存储桶。

## 文档

- [部署指南](docs/deployment.zh.md)
- [配置参考](docs/configuration.zh.md)
- [Bot 命令](docs/bot-commands.zh.md)
- [S3 兼容性](docs/S3-COMPAT.md)
- [架构设计](docs/design/00-overview.md)

## 技术栈

- **运行时：** Cloudflare Workers（零运行时依赖）
- **数据库：** Cloudflare D1 (SQLite)
- **缓存：** Cloudflare R2 + CF Cache API
- **认证：** AWS SigV4、预签名 URL、Bearer Token
- **语言：** TypeScript（严格模式）
- **媒体处理：** Sharp + FFmpeg（仅 VPS）
- **构建：** wrangler v3

## 许可证

MIT
