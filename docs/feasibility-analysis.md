# Telegram + Cloudflare Workers S3 兼容存储 -- 可行性分析

> 基于训练知识（截至 2025.5）。开发前需验证最新 API 限制和定价。

## 总体结论

**核心方案可行**，需分层实现。部分高级功能需额外基础设施。

| 功能 | 可行性 | 部署 | 备注 |
|------|--------|------|------|
| S3 兼容 API（基础 CRUD） | 可行 | CF Workers + D1 + TG Bot API | 免费 |
| 文件管理器 Web UI | 可行 | CF Pages | 免费 |
| Telegram Bot 管理 | 可行 | CF Workers | 免费 |
| 图床（JPEG/PNG/WebP） | 可行 | CF Workers | 免费 |
| HEIC/HEIF 转换 | 有条件 | Workers WASM 或 VPS | 需付费 |
| 实况照片 | 有条件 | 需 VPS 处理视频 | ~$4/月 |
| 视频转码 | Workers 不可行 | 必须 VPS 或 CF Stream | ~$4-5/月 |
| 文件分享（时效/口令） | 可行 | CF Workers + D1 | 免费 |

## 现有生态

| 项目 | 类型 | Stars | 关键特点 |
|------|------|-------|---------|
| Teldrive | 云盘 WebUI | ~4-5k | Go+React, PostgreSQL, MTProto, 分块/流媒体/rclone |
| TGDrive | 云盘 WebUI | ~600-900 | Python+FastAPI, SQLite, Pyrogram |
| Telegraph-Image | 图床 | ~2k | CF Pages/Workers, 5MB限制 |
| tgState | 文件托管 | ~300-500 | Go, Bot API, 直接下载链接 |
| tdl | CLI | ~3-4k | Go, 并发下载, MTProto |

**目前没有成熟的 S3 兼容网关** -- 这是生态空白和机会。

## Telegram 存储特性

| 参数 | 普通 Bot API | Local Bot API Server |
|------|-------------|---------------------|
| 上传 | 50 MB | 2 GB |
| 下载 | 20 MB | 2 GB |
| 单频道写入 | ~20条/分钟 | ~20条/分钟 |
| 全局写入 | ~30条/秒 | ~30条/秒 |
| 持久性 | 永久 | 永久 |
| 配额 | 无已知限制 | 无已知限制 |

优势：免费无限存储、永久持留、file_id 稳定、全球 CDN

限制：20MB 下载上限(普通API)、无枚举/搜索API、速率严格、可能违反ToS

## Cloudflare 免费资源

| 服务 | 免费额度 | 用途 |
|------|---------|------|
| Workers | 100k req/天, 10ms CPU | S3 API 层 |
| D1 | 5M 读/天, 100k 写/天, 5GB | 元数据库(最佳) |
| R2 | 10GB, 1M 写/月, 免费出站 | 缓存层 |
| KV | 1k 写/天 | 不适用(太少) |

10ms CPU 风险：SigV4 约 1-3ms，余量不大。可用 Bearer Token 或升付费($5/月)。

## S3 API 映射

| S3 操作 | 实现 | 可行性 |
|---------|------|--------|
| GetObject | TG 流式传输 | 好 |
| PutObject | 上传 TG + D1 | 好 |
| DeleteObject | 删 D1 | 好 |
| HeadObject | 查 D1 | 好 |
| ListObjectsV2 | D1 SQL 前缀查询 | 好 |
| Multipart Upload | 需临时存储 | 有限 |

D1 元数据 schema：

```sql
CREATE TABLE objects (
    bucket TEXT, key TEXT, size INTEGER,
    etag TEXT, last_modified TEXT, content_type TEXT,
    telegram_file_id TEXT, telegram_chat_id TEXT,
    metadata TEXT, PRIMARY KEY (bucket, key)
);
CREATE TABLE share_tokens (
    token TEXT PRIMARY KEY, bucket TEXT, key TEXT,
    expires_at TEXT, password_hash TEXT,
    max_downloads INTEGER, download_count INTEGER DEFAULT 0
);
```

## 媒体处理

| 能力 | Workers 免费 | Workers 付费 | VPS |
|------|-------------|-------------|-----|
| JPEG/PNG 缩放 | 不可 | 可(~300ms) | 可 |
| WebP 转换 | 不可 | 可(~150ms) | 可 |
| HEIC 解码 | 不可 | 可(~1-2s) | 推荐 |
| AVIF 编码 | 不可 | 不可(太慢) | 可 |
| 视频转码 | 不可 | 不可 | 必须 |

CF Image Resizing 不接受 HEIC -- 最大缺口。
实况照片 = HEIC + 3s MOV，需转为 JPEG + MP4，可用 LivePhotosKit JS 展示。
wasm-vips (~10MB) 是最强 WASM 图片库，支持 HEIC/WebP/AVIF 读取。

## 文件分享

- S3 预签名 URL：标准格式，X-Amz-Expires 控制时效
- 自定义 Token：JWT 风格，内嵌路径/过期/口令哈希/下载限制
- HTML 下载页：文件信息 + 口令框，验证后流式传输

## 推荐架构

最小方案（$0/月）：

```
Client -> CF Worker -> D1 (元数据) + TG Bot API (文件<=20MB) + R2 (可选缓存)
```

完整方案（~$9/月）：

```
Client -> CF Worker -> D1 + R2 + TG Bot API + Queue -> VPS (sharp+ffmpeg)
```

## 实现路线

| 阶段 | 内容 | 代码量 |
|------|------|--------|
| Phase 1 | S3 基础 API | ~1500-2000 行 TS |
| Phase 2 | Multipart + Copy + 批量删除 | +800-1200 行 |
| Phase 3 | 分享系统 | +500-800 行 |
| Phase 4 | Web UI 文件管理器 | +1500-2500 行前端 |
| Phase 5 | 媒体处理 | +1000-1500 行 |

## 风险

1. TG ToS 风险：可能违反条款，封号风险
2. 无 SLA：TG 可能删除内容
3. 延迟：TG API 100-500ms/次
4. 20MB 限制：普通 Bot API 下载上限
5. HEIC 缺口：CF Image Resizing 不接受
