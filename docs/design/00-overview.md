# TG-S3: Telegram-backed S3-Compatible Storage

## 项目名称

**TG-S3** (暂定，可改)

## 项目定位

基于 Telegram 无限免费存储，提供 S3 兼容 API 的个人/小团队存储方案。附带图床、文件管理器、媒体处理、文件分享等功能。

## 核心设计原则

1. **Telegram 是唯一持久存储层** -- 所有文件数据存储在 TG 频道中，CF/VPS 只做计算和索引
2. **S3 兼容优先** -- 能对接 rclone、aws cli、s3cmd 等标准工具
3. **免费优先，付费增强** -- 核心功能在 CF 免费额度内运行，VPS 是可选增强
4. **安全使用 TG** -- 内置速率限制，永远不触发 TG FloodWait

## 功能矩阵

### Tier 1: 核心存储（CF 免费）

- S3 兼容 API（PutObject / GetObject / DeleteObject / ListObjectsV2 / HeadObject / CopyObject）
- 元数据索引（D1）
- CDN 缓存加速（CF CDN）
- 认证（SigV4 签名 + TG WebApp initData）
- 图床直链（支持 JPEG/PNG/WebP/GIF 直接访问）

### Tier 2: 增强功能（CF 免费）

- 文件公开分享（时效控制、口令保护、下载次数限制）
- 预签名 URL（S3 标准格式）
- Telegram Mini App 文件管理器（Worker 内联 HTML）
- Telegram Bot 文件管理
- Multipart Upload（小文件重组装）
- 批量删除（DeleteObjects）

### Tier 3: 高级功能（需 VPS ~$4/月）

- 大文件支持（<=2GB，通过 Local Bot API Server）
- HTTP Range 请求（视频拖进度条、断点续传）
- 文件分块存储与透明重组装
- HEIC/HEIF 格式转换
- Apple 实况照片存储与展示
- 视频转码（ffmpeg）
- 缩略图自动生成

## 非目标

- 不做多租户 SaaS 平台
- 不做高并发/低延迟的生产级对象存储
- 不做数据库或日志存储
- 不替代 S3 Standard，定位是个人级"免费无限温存储"

## 技术栈

| 组件 | 技术 | 角色 |
|------|------|------|
| S3 API 网关 | Cloudflare Worker (TypeScript) | 接收 S3 请求，路由处理 |
| 元数据存储 | Cloudflare D1 (SQLite) | 文件索引、分享 Token、Bucket 管理 |
| CDN 缓存 | Cloudflare CDN | 热文件缓存，减少 TG 回源 |
| 文件存储 | Telegram Bot API / Local Bot API | 实际文件持久化 |
| Web UI | Telegram Mini App (内联 HTML) | 文件管理器 (Worker 内联提供) |
| 媒体处理 | VPS (sharp + ffmpeg) | HEIC 转换、视频转码 |
| 大文件支持 | VPS (Local Bot API Server) | 突破 20MB 下载限制 |
| 热文件缓存 | Cloudflare R2（可选） | 高频访问文件缓存 |
