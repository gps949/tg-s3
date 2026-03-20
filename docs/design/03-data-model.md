# 数据模型与速率限制

## D1 数据库 Schema

### objects 表（核心）

```sql
CREATE TABLE objects (
    bucket          TEXT    NOT NULL,
    key             TEXT    NOT NULL,
    size            INTEGER NOT NULL,
    etag            TEXT    NOT NULL,               -- MD5 hex, 带引号
    content_type    TEXT    NOT NULL DEFAULT 'application/octet-stream',
    last_modified   TEXT    NOT NULL,               -- ISO 8601
    storage_class   TEXT    NOT NULL DEFAULT 'STANDARD',

    -- Telegram 存储信息
    tg_chat_id      TEXT    NOT NULL,               -- Supergroup ID
    tg_message_id   INTEGER NOT NULL,               -- 消息 ID
    tg_file_id      TEXT    NOT NULL,               -- 用于 getFile
    tg_file_unique_id TEXT  NOT NULL,               -- 跨 Bot 去重

    -- 自定义元数据
    user_metadata   TEXT,                            -- JSON, 存储 x-amz-meta-* headers
    -- 系统元数据
    system_metadata TEXT,                            -- JSON, 含 HTTP 系统头和内部键 (见下方说明)
    -- 衍生文件来源
    derived_from    TEXT,                            -- 父对象 key (图片变体、缩略图等)

    PRIMARY KEY (bucket, key)
);

-- idx_objects_list 不需要: PRIMARY KEY (bucket, key) 已隐式创建等效索引
-- 按修改时间查询
CREATE INDEX idx_objects_modified ON objects (bucket, last_modified);
-- 按 file_unique_id 去重查询
CREATE INDEX idx_objects_file_uid ON objects (tg_file_unique_id);
-- 衍生文件查询 (删除父对象时清理)
CREATE INDEX idx_objects_derived ON objects (bucket, derived_from);
```

**system_metadata JSON 键说明**

| 键 | 类型 | 来源 | 说明 |
|---|---|---|---|
| `content-encoding` | string | S3 PUT header | HTTP 内容编码 |
| `content-disposition` | string | S3 PUT header | 下载文件名 |
| `content-language` | string | S3 PUT header | 内容语言 |
| `cache-control` | string | S3 PUT header | 缓存控制 |
| `expires` | string | S3 PUT header | 过期时间 |
| `_mp_part_sizes` | JSON string (number[]) | CompleteMultipartUpload | 各 Part 字节大小数组，用于 GetObject `partNumber` 查询计算偏移 |
| `_live_photo_video_key` | string | 媒体处理 | Live Photo 关联视频的 object key，分享页和 GetObject 用于联合展示 |

> 约定: 下划线前缀 `_` 的键为内部使用，不通过 S3 API 返回给客户端。

### chunks 表（分块文件） [Phase 2 - 分块上传/下载未实现]

> 当前实现中，单文件大小上限为 2GB (VPS Local Bot API)。分块上传/下载流程用于突破此限制，
> 留待后续版本实现。chunks 表已创建，CRUD 操作已实现（putChunk/getChunks/deleteChunks），
> 当前用于 DeleteObject 时清理关联的 chunk 记录和 TG 消息。

```sql
CREATE TABLE chunks (
    bucket          TEXT    NOT NULL,
    key             TEXT    NOT NULL,
    chunk_index     INTEGER NOT NULL,               -- 0-based
    offset          INTEGER NOT NULL,               -- 在原始文件中的字节偏移
    size            INTEGER NOT NULL,               -- 此块大小
    tg_chat_id      TEXT    NOT NULL,
    tg_message_id   INTEGER NOT NULL,
    tg_file_id      TEXT    NOT NULL,

    PRIMARY KEY (bucket, key, chunk_index)
);
```

### buckets 表

```sql
CREATE TABLE buckets (
    name            TEXT    PRIMARY KEY,
    created_at      TEXT    NOT NULL,               -- ISO 8601
    tg_chat_id      TEXT    NOT NULL,               -- Supergroup ID
    tg_topic_id     INTEGER,                         -- Forum Topic ID (每个 Bucket 一个 Topic)
    description     TEXT,                            -- 可选描述
    object_count    INTEGER NOT NULL DEFAULT 0,     -- 缓存计数，非精确
    total_size      INTEGER NOT NULL DEFAULT 0      -- 缓存总大小，非精确
);
```

### multipart_uploads 表

```sql
CREATE TABLE multipart_uploads (
    upload_id       TEXT    PRIMARY KEY,             -- UUID
    bucket          TEXT    NOT NULL,
    key             TEXT    NOT NULL,
    created_at      TEXT    NOT NULL,
    content_type    TEXT,
    user_metadata   TEXT,                            -- JSON
    system_metadata TEXT                             -- JSON, Content-Encoding/Disposition 等
);

-- 清理过期的未完成上传
CREATE INDEX idx_multipart_created ON multipart_uploads (created_at);
-- ListMultipartUploads 按 bucket+key 查询
CREATE INDEX idx_multipart_bucket_key ON multipart_uploads (bucket, key);
```

### multipart_parts 表

```sql
CREATE TABLE multipart_parts (
    upload_id       TEXT    NOT NULL,
    part_number     INTEGER NOT NULL,
    size            INTEGER NOT NULL,
    etag            TEXT    NOT NULL,
    tg_chat_id      TEXT    NOT NULL,
    tg_message_id   INTEGER NOT NULL,
    tg_file_id      TEXT    NOT NULL,
    created_at      TEXT,                            -- Part 创建时间

    PRIMARY KEY (upload_id, part_number)
);
```

### share_tokens 表

```sql
CREATE TABLE share_tokens (
    token           TEXT    PRIMARY KEY,             -- 随机生成 URL-safe 字符串
    bucket          TEXT    NOT NULL,
    key             TEXT    NOT NULL,
    created_at      TEXT    NOT NULL,
    expires_at      TEXT,                            -- NULL = 永不过期
    password_hash   TEXT,                            -- PBKDF2 (CF Workers 不支持 bcrypt), NULL = 无口令
    max_downloads   INTEGER,                         -- NULL = 无限制
    download_count  INTEGER NOT NULL DEFAULT 0,
    creator         TEXT,                            -- 创建者标识
    note            TEXT                             -- 备注

    -- 注: 不使用 FOREIGN KEY，改由应用层在 DeleteObject/DeleteBucket 时
    -- 主动清理关联的 share_tokens，并由 cron 定期清理孤儿记录
);

CREATE INDEX idx_share_expires ON share_tokens (expires_at);
CREATE INDEX idx_share_object ON share_tokens (bucket, key);
```

### share_password_attempts 表（口令暴力破解防护）

```sql
CREATE TABLE share_password_attempts (
    token           TEXT    NOT NULL,
    ip              TEXT    NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,               -- 锁定到期时间 (ISO 8601)
    last_attempt    TEXT    NOT NULL,
    PRIMARY KEY (token, ip)
);
```

规则: 同一 token+IP 密码验证失败 5 次后锁定 15 分钟，成功验证后清除记录。
Cron 清理: 过期锁定记录和超过 1 天的旧记录。

### user_preferences 表（Bot 用户偏好）

```sql
CREATE TABLE user_preferences (
    chat_id         TEXT    NOT NULL,
    pref_key        TEXT    NOT NULL,
    pref_value      TEXT    NOT NULL,
    PRIMARY KEY (chat_id, pref_key)
);
```

目前用于存储 `/setbucket` 设置的默认上传 Bucket。

### credentials 表（S3 API 凭证）

```sql
CREATE TABLE credentials (
    access_key_id       TEXT    PRIMARY KEY,
    secret_access_key   TEXT    NOT NULL,
    name                TEXT    NOT NULL DEFAULT '',     -- 凭证名称（便于管理）
    buckets             TEXT    NOT NULL DEFAULT '*',    -- '*' 或逗号分隔的 Bucket 名
    permission          TEXT    NOT NULL DEFAULT 'admin', -- 'admin' | 'readwrite' | 'readonly'
    created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used_at        TEXT,                            -- 概率更新（10%），减少 D1 写入
    is_active           INTEGER NOT NULL DEFAULT 1       -- 0=停用, 1=启用
);
```

SigV4 认证流程中，通过 Access Key ID 查询对应的 Secret Access Key 进行签名验证。
凭证带 60s 内存缓存，PATCH/DELETE 操作时主动失效缓存。
权限级别：`admin`（全部操作）、`readwrite`（读写，不含凭证管理和 Bucket 删除）、`readonly`（只读）。

## 速率限制设计

### TG API 限制回顾

| 限制 | 数值 | 安全阈值（75%） |
|------|------|----------------|
| 单频道消息 | ~20条/分钟 | 15条/分钟 |
| 全局消息 | ~30条/秒 | 22条/秒 |
| getFile 调用 | 无明确限制，但与消息共享额度 | 保守 20次/秒 |

### 限速算法：令牌桶

```typescript
interface RateLimiter {
  // 两层限制
  channelLimiter: TokenBucket;  // 每频道 15 tokens/分钟
  globalLimiter: TokenBucket;   // 全局 22 tokens/秒
}

interface TokenBucket {
  tokens: number;
  maxTokens: number;
  refillRate: number;       // tokens per millisecond
  lastRefillTime: number;
}

function tryConsume(bucket: TokenBucket): boolean {
  refill(bucket);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}
```

### 限速位置

```
客户端请求 → [Worker 认证] → [速率限制检查] → [TG API 调用]
                                   │
                                   ├─ 通过 → 正常处理
                                   └─ 拒绝 → 503 SlowDown + Retry-After header
```

### 哪些操作需要限速

| 操作 | 是否调 TG API | 主动限速 | 被动限速 |
|------|-------------|---------|--------|
| PutObject | sendDocument | 是 (channel + global 令牌桶) | FloodWait 重试 |
| UploadPart | sendDocument | 是 (channel + global 令牌桶) | FloodWait 重试 |
| GetObject (cache miss) | getFile | 否 | FloodWait 重试 |
| GetObject (cache hit) | 否 | -- | -- |
| DeleteObject | deleteMessage (async) | 否 | FloodWait 重试 |
| HeadObject | 否 (查 D1) | -- | -- |
| ListObjectsV2 | 否 (查 D1) | -- | -- |
| CopyObject (同 bucket) | 否 (查 D1) | -- | -- |
| CopyObject (跨 bucket) | forwardMessage | 否 | FloodWait 重试 |
| CreateBucket | createForumTopic | 否 | FloodWait 重试 |

> 说明: "主动限速" 指请求前检查令牌桶，超限立即返回 503 SlowDown。"被动限速" 指 TG API 返回 429 后，TelegramClient 自动等待 retry_after 秒后重试（最多 3 次）。仅写操作 (PutObject/UploadPart) 使用主动限速，因为它们是最频繁且最容易触发 TG 限制的操作。

### S3 客户端兼容

S3 标准的 503 SlowDown 响应：

```xml
HTTP/1.1 503 Slow Down
Retry-After: 5

<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>SlowDown</Code>
  <Message>Please reduce your request rate.</Message>
  <RetryAfterSeconds>5</RetryAfterSeconds>
</Error>
```

rclone 和 aws cli 都会自动处理 503 和 Retry-After，进行指数退避重试。

### 速率限制状态存储

采用 **Worker 内存** 方案：在 isolate 内存中维护令牌桶状态。

- 零延迟、无额外 D1 查询
- isolate 重启时状态丢失（可接受，相当于短暂放宽限制）
- 多个 isolate 之间不共享（可接受，CF 通常为同一域名路由到同一 isolate）
- 无需 D1 表，无持久化开销

## 数据一致性

### 上传原子性

PutObject 涉及两步操作：TG 上传 + D1 写入。需要处理中间失败：

```
场景 1: TG 上传成功，D1 写入失败
  → TG 中产生孤儿文件（无 D1 索引指向它）
  → 无害：文件在 TG 中但无法通过 S3 访问
  → 清理：定期扫描 TG 频道，删除 D1 中无记录的消息（可选）

场景 2: TG 上传失败
  → 直接返回错误，不写 D1
  → 干净，无副作用

场景 3: D1 写入成功但返回给客户端时网络中断
  → 文件实际已存储成功
  → 客户端重试 PutObject 会覆盖写（幂等）
```

### 删除最终一致

DeleteObject 策略：
1. 立即删除 D1 记录（同步）
2. 异步删除 TG 消息（通过 waitUntil）
3. 如果 TG 删除失败，消息仍在但 D1 无记录 → 孤儿文件，无害

### 覆盖写语义

S3 的 PutObject 是覆盖写。TG 不支持原地更新文件，所以：
1. 上传新文件到 TG → 获得新 file_id
2. UPDATE D1 记录指向新 file_id
3. 异步删除旧 TG 消息

## 三层缓存策略

### 架构

```
请求 → CDN Cache (L1) → R2 持久缓存 (L2) → Telegram (L3 源站)
```

| 层级 | 介质 | 命中标识 | 适用文件 | 特点 |
|------|------|---------|---------|------|
| L1 CDN | CF 边缘节点内存 | X-Cache: HIT | <=20MB 非 Range | 全球低延迟，但易被驱逐 |
| L2 R2 | CF R2 对象存储 | X-Cache: R2-HIT | 64KB - 20MB | 持久，命中后回填 CDN |
| L3 TG | Telegram 服务器 | X-Cache: MISS | 所有文件 | 永久存储，延迟较高 |

### CDN Cache Key

```
Cache-Key URL: {origin}/__cache__/{bucket}/{encodeURIComponent(key)}
```

ETag 校验：CDN 命中后检查 `ETag` 是否与 D1 一致，不一致则视为 stale 并清除。

### R2 Cache Key

```
R2 Key: {bucket}/{key}
customMetadata: { etag: "..." }
```

大小阈值：`R2_CACHE_MIN_SIZE = 64KB`，`R2_CACHE_MAX_SIZE = 20MB`。
低于下限的文件从 TG 直接下载足够快；上限与 Bot API getFile 20MB 限制对齐（>20MB 文件走 VPS 代理，不经过 R2 缓存写入路径）。

### Cache-Control

```typescript
// 图片: 长期缓存
'Cache-Control': 'public, max-age=31536000, immutable'
// 其他: 24 小时
'Cache-Control': 'public, max-age=86400'
```

图片默认设为 `immutable`，告诉浏览器不需要重新验证。覆盖写时主动清除缓存。

### 缓存失效

PutObject 覆盖写、DeleteObject、CopyObject 时，通过 `waitUntil` 异步清除：

```typescript
ctx.waitUntil(purgeCdnCache(baseUrl, bucket, key));
ctx.waitUntil(purgeR2Cache(env, bucket, key));
```

### R2 缓存清理

Cron 定时任务每 6 小时执行智能清理（每次限 20 条）：
1. 列出 R2 缓存条目
2. 解析出 bucket/key，查询 D1 源记录
3. 源记录不存在或 ETag 不一致 → 删除 R2 条目
4. R2 lifecycle 90 天兜底 GC 作为安全网
