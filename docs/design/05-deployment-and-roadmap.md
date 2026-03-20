# 部署架构与实现路线

## 一、部署拓扑

### 最小部署（$0/月，Tier 1 功能）

```
所需资源:
  - Cloudflare 免费账户
  - 一个域名（托管在 CF）
  - Telegram Bot Token
  - 一个 TG 私有频道/群组（Bot 为管理员）

部署方式: ./deploy.sh --cf-only (一键自动化)
  自动完成: D1 创建 + R2 Bucket 创建 + Schema 初始化 + Secrets 配置 + Worker 部署

部署内容:
  - 1x CF Worker: S3 API Gateway + Cron 定时任务
  - 1x CF D1 Database: tg-s3-db 元数据
  - 1x CF R2 Bucket: tg-s3-cache 持久缓存
  - Telegram Mini App (内置于 Worker)

能力:
  - S3 基础 CRUD + List + Multipart
  - 文件 <=20MB (上传与下载对齐，确保上传的文件可通过 Bot API 下载)
  - 三层缓存: CDN + R2 + TG
  - 图床直链 + 图片变体 (?w=, ?fmt= 需 VPS)
  - 文件分享 (时效/口令/下载限制)
  - Bearer Token + SigV4 + Presigned URL 认证
  - Telegram Bot 管理 (13 命令含 /start + 文件上传 + 删除确认)
  - Mini App 文件管理器
```

### 标准部署（$4/月，全功能）

```
所需资源:
  - 上述所有 +
  - 1x VPS (Hetzner CAX11 ARM, 2C4G, ~$4/月)

部署方式: ./deploy.sh --all (一键自动化 CF + VPS)
  VPS: 自动 SSH 上传 + Docker 构建 + 启动 + 健康检查

VPS 上运行:
  - Local Telegram Bot API Server (Docker)
  - 媒体处理服务 (Node.js: sharp + ffmpeg)
  - HTTP API (供 Worker 调用)

额外能力:
  - 文件 <=2GB
  - 文件分块 (>2GB) [Phase 2]
  - HTTP Range 请求 (大文件 seek)
  - HEIC/HEIF 转换
  - 实况照片支持
  - 视频转码
  - 图片变体 (?w=, ?fmt=)
  - 缩略图自动生成
```

### 增强部署（$5-9/月，最佳性能）

```
所需资源:
  - 上述所有 +
  - CF Workers 付费计划 ($5/月)

额外能力:
  - 30s CPU 时间 (SigV4 无压力)
  - 完整 AWS SigV4 认证
  - 可选: Workers WASM 图片处理 (wasm-vips, 轻量任务不走 VPS)
  - 无限请求数
```

## 二、VPS 部署详情

### Docker Compose

```yaml
version: '3.8'

services:
  # 一次性部署服务: 将 CF Worker 推送到 Cloudflare，运行后退出
  deploy:
    build:
      context: .
      dockerfile: Dockerfile.deploy
    env_file: .env
    environment:
      - CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN:-}
      - CLOUDFLARE_ACCOUNT_ID=${CF_ACCOUNT_ID:-}
    restart: "no"

  # 媒体处理 + 大文件代理服务 (常驻)
  processor:
    build: ./processor
    restart: unless-stopped
    ports:
      - "127.0.0.1:${VPS_PORT:-3000}:3000"
    environment:
      - PORT=3000
      - TG_BOT_TOKEN=${TG_BOT_TOKEN}
      - AUTH_SECRET=${VPS_SECRET}
      - TG_LOCAL_API=${TG_LOCAL_API:-https://api.telegram.org}
      - DEFAULT_CHAT_ID=${DEFAULT_CHAT_ID}
      - TEMP_DIR=/tmp/tg-s3
    volumes:
      - processor-data:/tmp/tg-s3
    deploy:
      resources:
        limits:
          memory: 2G

  # Optional: Telegram Local Bot API Server (2GB 文件支持)
  # telegram-bot-api:
  #   image: aiogram/telegram-bot-api:latest
  #   restart: unless-stopped
  #   environment:
  #     - TELEGRAM_API_ID=${TELEGRAM_API_ID}
  #     - TELEGRAM_API_HASH=${TELEGRAM_API_HASH}
  #     - TELEGRAM_LOCAL=1
  #   ports:
  #     - "127.0.0.1:8081:8081"
  #   volumes:
  #     - tg-bot-api-data:/var/lib/telegram-bot-api

volumes:
  processor-data:
  # tg-bot-api-data:
```

> 注: `deploy` 服务为一次性服务 (`restart: "no"`)，`docker compose up -d` 后自动部署 Worker 并退出。
> `processor` 为常驻服务，处理大文件和媒体请求。
> `telegram-bot-api` 为可选服务，需要 2GB 文件支持时取消注释并配置 `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`。

### Caddyfile

```
vps.tg-s3.example.com {
    reverse_proxy tg-s3-processor:3000

    header {
        Strict-Transport-Security "max-age=31536000"
    }

    # 仅允许来自 CF Worker 的请求
    @not-cf {
        not remote_ip 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22
        # ... 完整 CF IP 列表
    }
    respond @not-cf 403
}
```

### 处理服务 Dockerfile

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
```

### VPS 安全

| 措施 | 说明 |
|------|------|
| IP 白名单 | 只接受 CF Worker IP 段的请求 |
| Bearer Token | Worker 请求携带 `Authorization: Bearer ${VPS_SECRET}`，VPS 验证 |
| HTTPS | Caddy 自动 Let's Encrypt |
| 防火墙 | 只开放 443，关闭 SSH 密码登录 |
| Docker 网络隔离 | 服务间通过 Docker 内部网络通信 |

## 三、CF Worker 部署

### wrangler.toml

```toml
name = "tg-s3"
main = "src/index.ts"
compatibility_date = "2026-03-15"

[vars]
S3_REGION = "us-east-1"

# Secrets (通过 wrangler secret put 设置，不写入 toml):
# TG_BOT_TOKEN, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, BEARER_TOKEN,
# DEFAULT_CHAT_ID, VPS_URL (可选), VPS_SECRET (可选)

[[d1_databases]]
binding = "DB"
database_name = "tg-s3-db"
database_id = ""

[[r2_buckets]]
binding = "CACHE"
bucket_name = "tg-s3-cache"

[triggers]
crons = ["0 */6 * * *"]  # 每 6 小时: 7 项清理 (过期/孤儿分享, 过期 multipart, D1-TG 一致性, R2 缓存, 密码锁定, 孤儿分块)
```

### Worker 项目结构

```
src/
├── index.ts                 # 入口: 请求路由 + Cron handler + Mini App API
├── types.ts                 # 类型定义: Env, ObjectRow, S3Request, TG types 等
├── constants.ts             # 常量: TG API 限制, S3 限制, 超时参数
├── auth/
│   ├── sigv4.ts            # AWS SigV4 验证
│   ├── bearer.ts           # Bearer Token 验证
│   └── presigned.ts        # 预签名 URL 生成/验证
├── handlers/
│   ├── get-object.ts       # GetObject + 三层缓存 + R2 管理 + 图片变体
│   ├── put-object.ts       # PutObject + 覆盖写 + 缓存清除
│   ├── delete-object.ts    # DeleteObject + DeleteObjects 批量删除 + 缓存清除
│   ├── head-object.ts
│   ├── list-objects.ts     # ListObjectsV2 + ListObjects (v1)
│   ├── copy-object.ts      # CopyObject + 缓存清除
│   ├── multipart.ts        # Multipart Upload 全部操作 (含 UploadPartCopy)
│   ├── bucket.ts           # Bucket CRUD + GetBucketLocation + GetBucketVersioning
│   └── share.ts            # 分享 CRUD API + 公开分享访问
├── telegram/
│   ├── client.ts           # TG Bot API 封装
│   ├── upload.ts           # 上传逻辑 (直传 + VPS 代理)
│   └── download.ts         # 下载逻辑 (直取封装, VPS 代理在 handlers 层)
├── storage/
│   ├── metadata.ts         # D1 操作封装
│   └── schema.sql          # 建表 SQL (含 migration 注释)
├── rate-limit/
│   └── limiter.ts          # 令牌桶限速器 (内存实现)
├── bot/
│   ├── webhook.ts          # TG Bot webhook + Callback Query + 文件上传 + setMyCommands
│   ├── commands.ts         # Bot 命令实现 (13 个命令含 /start)
│   └── miniapp.ts          # Telegram Mini App (内联 HTML/CSS/JS)
├── sharing/
│   ├── tokens.ts           # Token 生成/验证 (PBKDF2)
│   └── pages.ts            # HTML 分享页面渲染 (暗色模式, 倒计时, 多格式预览)
├── media/
│   └── vps-client.ts       # VPS 媒体处理客户端
├── xml/
│   ├── builder.ts          # S3 XML 响应构建器
│   └── parser.ts           # S3 XML 请求解析器
└── utils/
    ├── crypto.ts           # SHA256, HMAC, PBKDF2
    ├── md5.ts              # 纯 JS MD5 实现 (CF Workers 不支持 node:crypto)
    ├── path.ts             # S3 路径解析
    ├── headers.ts          # S3 headers/Range/ETag 处理
    └── format.ts           # 共享格式化工具 (formatSize, escHtml)
```

## 四、Telegram Bot 管理界面

### Bot 命令设计

```
/start               - 欢迎介绍 + 快速上手引导 (TG 内建，不计入 setMyCommands)
/help                - 完整命令列表
/buckets             - 列出所有 Buckets
/ls <bucket> [prefix] [页码] - 列出文件 (支持分页，每页 20 条)
/info <bucket> <key> - 文件详情
/delete <bucket> <key> - 删除文件
/search <bucket> <keyword> - 搜索文件名
/share <bucket> <key> [秒数] [口令] [最大次数] - 生成分享链接
/shares [bucket]     - 列出分享
/revoke <token>      - 撤销分享
/stats               - 存储统计
/setbucket [name]    - 设置默认上传 Bucket (无参数时显示当前设置和可用列表)
/miniapp             - 打开网盘管理 Mini App (发送 web_app 按钮，点击即可内联打开)
直接发送文件            - 自动上传到默认 Bucket (可通过 /setbucket 设置)
```

### Bot 交互流程

```
用户直接发送文件给 Bot:
  1. Bot 收到文件 (通过 webhook)
  2. 自动识别文件类型 (document/photo/video/audio)
  3. 记录 file_id 到默认 Bucket 的 D1 元数据
  4. 返回上传确认 (bucket名、文件名、大小)
  注: 文件名冲突时自动加时间戳后缀

用户发送 /share docs report.pdf 86400 mypass:
  1. 解析参数: bucket=docs, key=report.pdf, expires=86400秒, password=mypass
  2. 生成分享 Token (PBKDF2 哈希口令)
  3. 返回分享 Token 和链接
```

### Webhook 处理

Worker 同时处理 S3 API 和 TG Bot Webhook：

```typescript
// 路由区分 (secret_token 验证 webhook 合法性，时序安全比较)
if (path === '/bot/webhook' && request.method === 'POST') {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!timingSafeEqual(secret, env.BEARER_TOKEN)) return new Response('Unauthorized', { status: 401 });
  return handleWebhook(request, env);
}
// Mini App
if (path === '/miniapp') return renderMiniApp(url.origin);
// 分享访问 (无需认证)
if (path.startsWith('/share/')) return handleShareAccess(request, url, env);
// 其余走 S3 路由 (需认证)
```

## 五、Web UI 文件管理器 (Telegram Mini App)

> 实际实现为 Telegram Mini App，取代了原设计的 CF Pages 独立应用。
> HTML/CSS/JS 内联在 Worker 中，通过 `/miniapp` 路由提供。

### 技术栈

- 纯 HTML/CSS/JS (无框架依赖，~1350 行内联代码)
- Telegram WebApp JS SDK (主题色适配)
- 部署: Worker 内联提供 (无需 CF Pages)
- API: 调用 `/api/miniapp/*` 管理 API + `/api/presign` 预签名上传

### Mini App API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/miniapp/buckets` | 列出所有 Bucket |
| POST | `/api/miniapp/bucket` | 创建 Bucket (body: `{name}`) |
| GET | `/api/miniapp/objects?bucket=&prefix=&delimiter=&maxKeys=&startAfter=` | 列出文件 |
| GET | `/api/miniapp/object?bucket=&key=` | 获取文件元数据 |
| DELETE | `/api/miniapp/object?bucket=&key=` | 删除文件 |
| GET | `/api/miniapp/search?bucket=&q=` | 搜索文件 (服务端 LIKE 查询) |
| POST | `/api/miniapp/share` | 创建分享 (body: `{bucket, key, expiresIn?, password?, maxDownloads?}`) |
| GET | `/api/miniapp/shares?bucket=` | 列出分享 |
| DELETE | `/api/miniapp/share?token=` | 撤销分享 |
| GET | `/api/miniapp/stats` | 全局统计 |
| POST | `/api/miniapp/rename` | 重命名/移动文件 (body: `{bucket, oldKey, newKey}`) |
| POST | `/api/miniapp/presign` | 生成预签名 URL (body: `{bucket, key, method?, expiresIn?}`) |

所有端点需认证（Bearer Token 或 Telegram WebApp initData）。

### 核心功能

| 功能 | 说明 |
|------|------|
| Bucket 列表 | 显示所有 Bucket 及统计信息 |
| 文件浏览 | 面包屑导航，delimiter 分组，分页加载 |
| 拖拽上传 | 多文件拖拽，通过 Presigned URL 上传 |
| 图片预览 | 缩略图内联显示 |
| 批量操作 | 多选删除、多选分享（分享暂限逐个） |
| 搜索 | 文件名模糊搜索 (服务端 D1 LIKE 查询) |
| 排序 | 6 种排序模式（名称、大小、时间，各升降序） |
| 分享管理 | 创建/查看/撤销分享链接，支持口令和有效期 |
| 文件操作 | 重命名/移动 (CopyObject + Delete)，文件详情 |
| TG 主题适配 | 自动跟随 Telegram 暗色/亮色模式 |

## 六、实现路线图

### Phase 1: S3 基础 API (MVP)

**目标**: rclone 能正常连接，完成基本增删查操作

```
交付物:
  - CF Worker 项目骨架
  - Bearer Token 认证
  - PutObject / GetObject / HeadObject / DeleteObject
  - ListObjectsV2 (prefix + delimiter)
  - HeadBucket / ListBuckets
  - D1 schema + 基础 CRUD
  - TG Bot API 集成 (sendDocument / getFile)
  - 速率限制 (内存令牌桶)
  - CDN 缓存 (GetObject 响应)

验收标准:
  - rclone lsd tg-s3: → 列出 buckets
  - rclone copy file.txt tg-s3:bucket/ → 上传成功
  - rclone cat tg-s3:bucket/file.txt → 下载成功
  - rclone delete tg-s3:bucket/file.txt → 删除成功
  - rclone ls tg-s3:bucket/ → 列出文件

估计工作量: ~2000 行 TypeScript
```

### Phase 2: 客户端兼容性

**目标**: aws cli 和 s3cmd 也能正常工作

```
交付物:
  - AWS SigV4 认证
  - CopyObject
  - DeleteObjects (批量删除)
  - CreateMultipartUpload / UploadPart / CompleteMultipartUpload
  - AbortMultipartUpload / ListParts
  - Legacy ListObjects (v1)
  - CreateBucket / DeleteBucket

验收标准:
  - aws s3 cp / ls / rm / sync 全部正常
  - s3cmd get / put / ls / del 全部正常
  - rclone sync 完整目录同步

估计增量: ~1200 行
```

### Phase 3: 文件分享 [已实现]

**目标**: 生成带时效和口令的分享链接

```
交付物:
  - 分享 Token 生成/验证
  - 预签名 URL 生成/验证
  - HTML 下载页面
  - 口令保护
  - 下载次数限制
  - 分享管理 API

验收标准:
  - 生成分享链接，浏览器可访问
  - 过期后无法访问
  - 口令错误无法下载
  - 超出下载次数限制后无法下载

估计增量: ~800 行
```

### Phase 4: 图床 [已实现]

**目标**: 图片直链访问，CDN 加速

```
交付物:
  - 图片 Content-Type 检测
  - 直链访问（内联显示，非下载）
  - CORS 头支持
  - 长缓存策略 (immutable)
  - 图片变体查询参数 (?w=400&fmt=webp) -- 需 VPS

验收标准:
  - <img src="https://tg-s3.example.com/bucket/photo.jpg"> 正常显示
  - Markdown 引用图片正常
  - 缓存命中率 >90% (热图片)

估计增量: ~400 行
```

### Phase 5: VPS + 大文件

**目标**: 突破 20MB 限制，支持 Range 请求

```
交付物:
  - VPS 处理服务（Docker Compose）
  - Local Bot API Server 集成
  - 文件分块上传/下载
  - Range 请求支持
  - Worker <-> VPS 通信协议

验收标准:
  - 上传/下载 500MB 文件成功
  - 视频文件浏览器内播放，可拖进度条
  - 断点续传正常

估计增量: ~1500 行 (Worker + VPS)
```

### Phase 6: 媒体处理

**目标**: HEIC 转换、实况照片、视频转码

```
交付物:
  - sharp 图片处理管线
  - ffmpeg 视频处理管线
  - HEIC -> JPEG/WebP 自动转换
  - 实况照片识别和展示
  - 视频转码和封面生成
  - 缩略图自动生成
  - 衍生文件存储

验收标准:
  - 上传 HEIC 后自动生成 JPEG 版本
  - 上传实况照片后 Web UI 可以播放
  - 上传视频后自动转码 + 封面

估计增量: ~1200 行 (VPS 服务)
```

### Phase 7: Web UI (Telegram Mini App) [已实现]

**目标**: 可用的文件管理器界面

```
交付物:
  - Telegram Mini App (纯 HTML/CSS/JS, 内联在 Worker 中)
  - 文件浏览器 (面包屑导航、delimiter 分组、分页)
  - 拖拽上传 (Presigned URL, 多文件并发)
  - 图片缩略图预览
  - 分享管理 (创建/查看/撤销, 支持口令和有效期)
  - 文件操作 (重命名/移动/删除/详情)
  - 6 种排序模式、文件名搜索
  - TG 主题色适配 (暗色/亮色模式)
  - 空状态引导、上传预检 (>20MB 提示)、加载骨架屏

验收标准:
  - 在 Telegram 内完整管理文件
  - 移动端体验良好
  - 无需独立域名或 CF Pages

估计工作量: ~1350 行内联代码
```

### Phase 8: Telegram Bot [已实现]

**目标**: 通过 TG Bot 管理文件

```
交付物:
  - 13 个 Bot 命令 (12 个注册到 setMyCommands + /start 内建)
  - 文件上传 (直接发文件给 Bot, 支持 document/photo/video/audio)
  - 文件列表/搜索/删除 (含 Inline Keyboard 确认)
  - 分享链接创建/列表/撤销
  - Callback Query 处理 (删除确认)
  - setMyCommands 自动注册

估计增量: ~800 行
```

## 七、总工作量估算

| Phase | 内容 | 代码量 | 累计 |
|-------|------|--------|------|
| 1 | S3 基础 API | ~2000 行 | 2000 |
| 2 | 客户端兼容 | ~1200 行 | 3200 |
| 3 | 文件分享 | ~800 行 | 4000 |
| 4 | 图床 | ~400 行 | 4400 |
| 5 | VPS + 大文件 | ~500 行 | 4900 |
| 6 | 媒体处理 | ~200 行 | 5100 |
| 7 | Web UI | ~1350 行 | 6450 |
| 8 | TG Bot | ~800 行 | 7250 |

**实际约 8,200 行代码**（TypeScript + 内联 HTML/CSS/JS）。

> 注: Phase 5-6 中 VPS 端服务代码（Docker/Node.js）为独立仓库，此处仅统计 Worker 侧代码。

## 八、环境变量与 Secrets

**Worker 侧 (CF Worker Secrets / Vars)**

| 变量 | 用途 | 存储方式 |
|------|------|---------|
| TG_BOT_TOKEN | Telegram Bot Token | Secret |
| S3_ACCESS_KEY_ID | S3 认证 Access Key | Secret |
| S3_SECRET_ACCESS_KEY | S3 认证 Secret Key | Secret |
| BEARER_TOKEN | 简化认证 Token / Webhook Secret | Secret |
| S3_REGION | S3 区域标识 (默认 "us-east-1") | Var (wrangler.toml) |
| VPS_URL | VPS 服务地址 (可选) | Secret |
| VPS_SECRET | Worker 调用 VPS 的认证密钥 (可选) | Secret |
| DEFAULT_CHAT_ID | 默认 TG 频道/群组 ID | Secret |
| WORKER_URL | Worker 公开 URL, Cron CDN 缓存清理用 (可选) | Var |

**VPS 侧 (.env)**

| 变量 | 用途 |
|------|------|
| TG_BOT_TOKEN | Telegram Bot Token (与 Worker 相同) |
| TG_API_ID | Telegram API ID (Local Bot API Server 需要) |
| TG_API_HASH | Telegram API Hash (Local Bot API Server 需要) |
| VPS_SECRET | Worker 调用认证密钥 (与 Worker 相同) |

Binding 资源：

| Binding | 类型 | 名称 | 用途 |
|---------|------|------|------|
| DB | D1 Database | tg-s3-db | 元数据存储 |
| CACHE | R2 Bucket | tg-s3-cache | 持久文件缓存 (64KB-20MB) |

**R2 Bucket 配置**

在 Cloudflare Dashboard 的 R2 > tg-s3-cache > Settings 中配置 Object Lifecycle Rule:
- Rule name: `auto-expire-cache`
- Prefix: (留空，适用于全部对象)
- Action: Delete objects after **90 天**
- 作用: 作为 cron 缓存清理的兜底安全网，防止孤儿缓存永久占用空间
