# 系统架构

## 整体架构图

```
                        ┌─────────────────────────────────┐
                        │          用户/客户端              │
                        │  rclone | aws cli | 浏览器 | App  │
                        └──────────────┬──────────────────┘
                                       │
                          S3 API / HTTPS / Share Link
                                       │
                        ┌──────────────▼──────────────────┐
                        │      Cloudflare Edge (免费)       │
                        │                                   │
                        │  ┌─────────────────────────────┐ │
                        │  │   CF Worker: S3 API Gateway  │ │
                        │  │                               │ │
                        │  │  - S3 请求解析与路由           │ │
                        │  │  - 认证（SigV4 / Bearer）     │ │
                        │  │  - 速率限制                    │ │
                        │  │  - 小文件直通 TG Bot API      │ │
                        │  │  - 大文件/媒体转发到 VPS      │ │
                        │  │  - 分享 Token 验证            │ │
                        │  │  - XML/JSON 响应序列化         │ │
                        │  └──────┬───────────┬───────────┘ │
                        │         │           │              │
                        │  ┌──────▼───┐ ┌─────▼──────────┐  │
                        │  │  CF D1   │ │  CF CDN Cache   │  │
                        │  │ (元数据)  │ │  (文件缓存)     │  │
                        │  └──────────┘ └────────────────┘  │
                        │                                    │
                        │  ┌───────────────┐  ┌──────────────┐│
                        │  │ TG Mini App   │  │ CF R2         ││
                        │  │ (内联 Web UI) │  │ (持久缓存)    ││
                        │  └───────────────┘  └──────────────┘│
                        └──────────┬──────────────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
           ┌───────▼───────┐      │     ┌────────▼────────┐
           │ Telegram       │      │     │  VPS (推荐)      │
           │ Bot API        │      │     │                  │
           │                │      │     │  Local Bot API   │
           │ - sendDocument │      │     │  Server (2GB)    │
           │ - getFile      │      │     │                  │
           │ - deleteMessage│      │     │  sharp (HEIC)    │
           │                │      │     │  ffmpeg (视频)    │
           │ 文件 <=20MB    │      │     │  分块管理        │
           └───────┬───────┘      │     │  Range 支持      │
                   │              │     └────────┬────────┘
                   │              │              │
           ┌───────▼──────────────▼──────────────▼────┐
           │            Telegram 服务器                 │
           │         (实际文件持久化存储)                │
           │    Supergroup Forum Topics = S3 Buckets   │
           └──────────────────────────────────────────┘
```

## 组件职责

### CF Worker: S3 API Gateway

**核心组件**，运行在 Cloudflare 边缘节点。

职责：
- 接收并解析 S3 HTTP 请求（路径、headers、query params）
- 认证：验证 SigV4 签名或 TG WebApp initData 或 Presigned URL
- 路由：根据操作类型分发到对应 handler
- 小文件（<=20MB）：直接调用 TG Bot API 存取（上传限制与下载对齐，确保上传的文件可下载）
- 大文件/媒体处理：转发请求到 VPS
- 查询/更新 D1 元数据
- 速率限制：令牌桶算法，确保不超 TG API 限制
- 响应格式化：输出 S3 标准 XML
- 分享验证：校验 Token 时效/口令
- 三层缓存管理：CDN Cache + R2 持久缓存 + TG 源站
- Cron 定时任务：清理过期分享、孤儿分享、过期 multipart、D1-TG 一致性检查、R2 缓存清理

### CF D1: 元数据数据库

职责：
- 存储所有文件元数据（bucket、key、size、etag、content-type、TG file_id）
- Bucket 管理（创建/删除/列表）
- 分享 Token 管理
- 分块文件的 chunk 映射
- Multipart Upload 状态跟踪
- 支持 ListObjectsV2 的前缀查询和分隔符分组

### CF CDN Cache（第 1 层缓存）

职责：
- 缓存 GetObject 响应
- Cache Key = `/__cache__/{bucket}/{key}`，校验 ETag 一致性
- 热文件全球边缘节点缓存，后续请求不回源 TG
- 图床场景核心优势：首次加载后全球 <50ms
- 覆盖写/删除时主动清除

### CF R2 持久缓存（第 2 层缓存）

职责：
- 持久缓存中等大小文件（64KB - 20MB），弥补 CDN 缓存容易被驱逐的不足
- R2 缓存 Key = `{bucket}/{key}`，附带 `customMetadata.etag` 用于一致性校验
- R2 命中时同时回填 CDN 缓存
- 覆盖写/删除时通过 `waitUntil` 异步清除 R2 条目
- Cron 定时智能清理：检查 D1 源记录存在性 + ETag 一致性，清除孤儿条目
- R2 lifecycle 90 天兜底 GC（防止 cron 遗漏）
- 资源控制：每次 cron 扫描限 20 条，64KB-20MB 大小阈值，精打细算 R2 免费配额

### Telegram Mini App: Web UI

> 实现说明: 原设计为 CF Pages 独立应用，实际实现为 Telegram Mini App（内联 HTML，由 Worker 提供），
> 用户无需离开 Telegram 即可管理文件。

职责：
- 文件浏览器界面（面包屑导航、文件列表）
- 拖拽上传（通过 Presigned URL）
- 图片缩略图预览
- 分享链接生成/管理
- 批量操作（选择、删除、分享）
- 搜索和多维排序
- TG 主题色适配（自动暗色模式）

### VPS: 重型处理节点（推荐部署）

职责：
- 运行 Local Bot API Server（突破 20MB 限制，支持到 2GB）
- 媒体处理：sharp (HEIC->JPEG/WebP)、ffmpeg (视频转码)
- 分块文件管理：接收大文件，切块上传 TG，记录 chunk 映射
- Range 请求支持：从 TG 下载对应 chunk，seek 到目标位置返回
- 暴露 HTTP API 供 CF Worker 调用

### Telegram: 持久存储

角色：
- 一个 Telegram Bot（通过 @BotFather 创建）
- 一个 Supergroup，启用 Forum (Topics) 功能
- 每个 S3 Bucket 对应一个 Forum Topic（隔离存储）
- 每个文件 = Topic 中的一条 Document 消息
- file_id 长期有效，存入 D1 用于后续检索
- 支持文件永久存储，无已知配额

## 请求流转

### GetObject 流程

```
1. 客户端 → CF Worker: GET /bucket/key.jpg
2. Worker: 验证认证 (SigV4/Bearer/Presigned URL)
3. Worker: 查询 D1 获取 file_id, size, content_type
4. 条件请求处理: If-Match / If-None-Match / If-Modified-Since / If-Unmodified-Since
5. 三层缓存查找 (非 Range 请求, <=20MB):
   a. 第 1 层: CDN Cache → 命中且 ETag 一致 → 直接返回
   b. 第 2 层: R2 缓存 (64KB-20MB) → 命中且 ETag 一致 → 返回并回填 CDN
   c. 第 3 层: TG 源站
6. 判断文件大小:
   a. <=20MB: Worker 直接调 TG Bot API getFile → 获取下载 URL → 流式转发
   b. >20MB: Worker 请求 VPS → VPS 通过 Local Bot API 下载 → 流式返回
7. Worker: 设置 Cache-Control, ETag headers → 响应客户端
8. 异步写缓存: CDN Cache + R2 持久缓存 (如符合大小阈值)
```

### PutObject 流程

```
1. 客户端 → CF Worker: PUT /bucket/key.jpg (body=文件内容)
2. Worker: 验证认证
3. Worker: 检查速率限制 → 超限返回 503 SlowDown
4. 判断文件大小:
   a. <=20MB: Worker 调 TG Bot API sendDocument → TG 频道
   b. >20MB: Worker 转发到 VPS → VPS 通过 Local Bot API 上传（无 VPS 时拒绝，因 Bot API getFile 只支持 20MB）
   c. >2GB: Worker 转发到 VPS → VPS 切块上传多条消息 [Phase 2]
5. 获取 TG 返回的 file_id, message_id
6. Worker: 计算 ETag (MD5)
7. Worker: 写入 D1 元数据 (覆盖写时先异步删除旧 TG 消息)
8. Worker: 异步清除 CDN Cache + R2 缓存 (覆盖写场景)
9. Worker: 返回 S3 PutObject 响应 (ETag)
```

### Range GetObject 流程

```
<=20MB 文件 Range:
  1. Worker: 从 TG 下载完整文件到内存
  2. Worker: 在内存中 slice 目标字节范围
  3. Worker → 客户端: 206 Partial Content

>20MB 文件 Range (需 VPS):
  1. 客户端 → CF Worker: GET /bucket/video.mp4, Range: bytes=50000000-60000000
  2. Worker: 查 D1 获取 file_id 和 size
  3. Worker → VPS: POST /api/proxy/range { file_id, start, end }
  4. VPS: 从 TG Local Bot API 下载并 seek 到目标位置
  5. VPS → Worker → 客户端: 206 Partial Content

分块文件 Range [Phase 2]:
  查 D1 chunks 表 → 计算目标 chunk → 只下载所需 chunk
```

## 组件间通信

| 调用方 | 被调方 | 协议 | 认证 |
|-------|-------|------|------|
| Worker | D1 | Worker Binding | 内置 |
| Worker | TG Bot API | HTTPS | Bot Token |
| Worker | VPS | HTTPS | Bearer Token (VPS_SECRET) |
| Worker | R2 | Worker Binding | 内置 |
| TG Mini App | Worker | HTTPS | TG WebApp initData |
| TG Bot | Worker (webhook) | HTTPS | TG webhook secret |
| VPS | TG Local Bot API | HTTP (localhost) | Bot Token |

## 容错设计

| 故障场景 | 影响 | 应对 |
|---------|------|------|
| TG API 暂时不可用 | 读写失败 | Worker 返回 503，客户端重试 |
| TG 封禁 Bot | 无法存取文件 | 创建新 Bot，频道数据仍在，重新索引 |
| D1 不可用 | 无法查元数据 | Worker 返回 500，CF 负责 D1 可用性 |
| VPS 宕机 | 大文件和媒体处理不可用 | 小文件仍可通过 Worker 直连 TG |
| CDN 缓存失效 | 延迟升高 | 回源 TG 获取，体验降级但功能正常 |
| D1 与 TG 数据不一致 | 元数据指向已删除文件 | 定期一致性检查 + 懒修复 |

## Cron 定时任务

Worker 通过 `[triggers] crons = ["0 */6 * * *"]` 每 6 小时执行一次维护任务：

| 任务 | 说明 |
|------|------|
| 清理过期分享 | 删除 `expires_at < NOW` 的 share_tokens |
| 清理孤儿分享 | 删除引用已不存在对象的 share_tokens |
| 清理过期 Multipart | 删除超过 24 小时未完成的 multipart_uploads 及其 parts，清理关联 TG 消息 |
| D1-TG 一致性检查 | 动态采样（2% 对象数，钳位 [5, 50]），调用 TG getFile 验证 file_id 是否仍有效，仅 TG 400 才清理（跳过瞬态错误） |
| R2 缓存清理 | 扫描 R2 缓存条目（每次限 20 条），检查 D1 源记录存在性和 ETag 一致性，删除孤儿条目 |
| 清理过期口令锁定 | 清理 share_password_attempts 中过期的锁定记录和超过 1 天的旧记录 |
| 清理孤儿分块 | 清理 chunks 表中引用已不存在对象的记录，删除关联 TG 消息 |
