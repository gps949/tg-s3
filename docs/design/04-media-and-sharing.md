# 媒体处理与文件分享

## 一、文件分块引擎 [Phase 2 - 分块上传/下载未实现]

> 当前实现中，单文件通过 Bot API 上传 (<=20MB) 或 VPS Local Bot API (<=2GB)。
> 分块上传/下载流程用于突破 2GB 限制，留待后续版本实现。chunks 表已创建，CRUD
> 操作已实现，当前用于 DeleteObject 时清理关联的 chunk 记录和 TG 消息。

### 分块策略

| 部署方式 | 块大小 | 原因 |
|---------|--------|------|
| 纯 Worker (Bot API) | 18 MB | 留 2MB 余量（20MB 下载限制） |
| VPS (Local Bot API) | 1.8 GB | 留余量（2GB 限制） |

### 上传分块流程

```
大文件 (>= chunk_size)
    │
    ├─ 1. Worker/VPS 接收完整文件流
    ├─ 2. 流式切块，每块送 TG sendDocument
    ├─ 3. 每块获得 file_id, message_id
    ├─ 4. 写入 chunks 表:
    │     chunk_index=0, offset=0, size=18MB, file_id=aaa
    │     chunk_index=1, offset=18MB, size=18MB, file_id=bbb
    │     chunk_index=2, offset=36MB, size=5MB, file_id=ccc
    │
    └─ 5. 写入 objects 表: size=41MB (chunks 表记录分块映射, Phase 2 需扩展 objects 表增加 is_chunked/chunk_count 列)
```

### 下载重组装流程

```
GetObject 请求 → 查 D1 → is_chunked=true
    │
    ├─ 无 Range header: 按序下载所有块，流式拼接返回
    │   chunk_0 → stream → chunk_1 → stream → chunk_2 → stream → 完成
    │
    └─ 有 Range header: 计算目标块，只下载需要的块
        Range: bytes=20000000-25000000
        → 目标 chunk_index=1 (offset 18MB-36MB)
        → 在 chunk 内 offset = 20MB - 18MB = 2MB
        → 下载 chunk_1，seek 到 2MB，读取 5MB
```

### Range 请求实现

```typescript
interface RangeResult {
  startChunk: number;
  endChunk: number;
  startOffset: number;  // 在第一个 chunk 内的偏移
  endOffset: number;    // 在最后一个 chunk 内的结束位置
}

function resolveRange(
  chunks: ChunkInfo[],
  rangeStart: number,
  rangeEnd: number
): RangeResult {
  let startChunk = -1, endChunk = -1;
  for (const chunk of chunks) {
    if (startChunk < 0 && chunk.offset + chunk.size > rangeStart) {
      startChunk = chunk.chunk_index;
    }
    if (chunk.offset + chunk.size >= rangeEnd) {
      endChunk = chunk.chunk_index;
      break;
    }
  }
  return {
    startChunk,
    endChunk,
    startOffset: rangeStart - chunks[startChunk].offset,
    endOffset: rangeEnd - chunks[endChunk].offset,
  };
}
```

---

## 二、媒体处理管线 [Phase 2 - 需 VPS]

> 当前实现中，Worker 支持图片变体请求 (?w=, ?fmt=) 并通过 VPS API 处理。
> 完整的自动媒体处理管线（HEIC 转换、视频转码、缩略图生成）需 VPS 配合，留待后续完善。

### 架构

```
上传请求 → Worker
    │
    ├─ 普通文件 → 直接存 TG → 完成
    │
    └─ 媒体文件 (图片/视频/实况照片)
         │
         ├─ 原始文件 → 存 TG (保留原件)
         │
         └─ 推送处理任务到 VPS
              │
              ├─ 图片: sharp 处理
              │   ├─ HEIC → JPEG (全尺寸)
              │   ├─ 生成 WebP 缩略图 (多尺寸)
              │   └─ 提取 EXIF 元数据
              │
              ├─ 实况照片: sharp + ffmpeg
              │   ├─ HEIC → JPEG
              │   ├─ MOV → MP4 (H.264, web 兼容)
              │   └─ 提取 ContentIdentifier 关联
              │
              └─ 视频: ffmpeg
                  ├─ 转码 H.264 MP4
                  ├─ 生成封面帧 JPEG
                  └─ 可选: 多码率 HLS 分段
              │
              └─ 衍生文件 → 存 TG → 更新 D1 元数据
```

### 处理任务队列

Worker 与 VPS 之间通过 HTTP API 通信：

```typescript
// Worker 侧: 提交处理任务
async function submitMediaJob(file: ObjectMetadata, type: MediaJobType) {
  await fetch(`${VPS_URL}/api/jobs`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${VPS_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucket: file.bucket,
      key: file.key,
      tg_file_id: file.tg_file_id,
      job_type: type,  // 'image_convert' | 'video_transcode' | 'live_photo'
    }),
  });
}
```

VPS 侧 API：

```
POST /api/jobs              提交媒体处理任务
GET  /api/jobs/:id          查询任务状态
POST /api/proxy/get         从 TG 下载文件（供 Worker 大文件使用）
POST /api/proxy/put         上传文件到 TG（供 Worker 大文件使用）
POST /api/proxy/range       Range 读取（大文件，POST body 含 file_id/start/end）
POST /api/proxy/consolidate Multipart 合并（将多个 TG part 拼接为单文件）
GET  /api/image/resize      图片变体（query: tg_file_id, width?, format?）
```

### 图片处理细节

```typescript
// VPS 侧: sharp 处理
import sharp from 'sharp';

async function processImage(inputBuffer: Buffer, format: string) {
  const pipeline = sharp(inputBuffer);

  // 读取元数据
  const metadata = await pipeline.metadata();

  const results = {
    // 全尺寸 JPEG（从 HEIC 转换）
    full: await sharp(inputBuffer)
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer(),

    // 缩略图 400px 宽
    thumb_400: await sharp(inputBuffer)
      .resize(400, null, { withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer(),

    // 缩略图 200px 宽
    thumb_200: await sharp(inputBuffer)
      .resize(200, null, { withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer(),

    metadata: {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      exif: metadata.exif,
    },
  };

  return results;
}
```

### 实况照片处理

```typescript
// VPS 侧
async function processLivePhoto(heicBuffer: Buffer, movBuffer: Buffer) {
  // 1. 从 HEIC 提取 ContentIdentifier
  const heicId = await extractContentIdentifier(heicBuffer);

  // 2. 从 MOV 提取 ContentIdentifier
  const movId = await extractMovContentIdentifier(movBuffer);

  // 3. 验证配对
  if (heicId !== movId) throw new Error('Live Photo pair mismatch');

  // 4. 转换静态图
  const jpeg = await sharp(heicBuffer).jpeg({ quality: 90 }).toBuffer();

  // 5. 转换视频
  // ffmpeg -i input.mov -c:v libx264 -c:a aac -movflags +faststart output.mp4
  const mp4 = await ffmpegConvert(movBuffer, {
    videoCodec: 'libx264',
    audioCodec: 'aac',
    movflags: '+faststart',
  });

  // 6. 生成缩略图
  const thumb = await sharp(heicBuffer)
    .resize(400)
    .webp({ quality: 80 })
    .toBuffer();

  return { jpeg, mp4, thumb, contentIdentifier: heicId };
}
```

### 实况照片 Web 展示

```html
<!-- 使用 Apple LivePhotosKit JS -->
<script src="https://cdn.apple-livephotoskit.com/lpk/1/livephotoskit.js"></script>

<div
  data-live-photo
  data-photo-src="/share/{token}/inline"
  data-video-src="/share/{token}/live-video"
  style="width:100%;height:auto;aspect-ratio:4/3;border-radius:8px">
</div>
```

### 视频转码

```typescript
// VPS 侧
async function transcodeVideo(inputPath: string, outputPath: string) {
  // 标准 H.264 MP4，web 友好
  await exec(`ffmpeg -i ${inputPath} \
    -c:v libx264 -preset medium -crf 23 \
    -c:a aac -b:a 128k \
    -movflags +faststart \
    -y ${outputPath}`);

  // 生成封面帧
  await exec(`ffmpeg -i ${inputPath} \
    -ss 00:00:01 -vframes 1 \
    -y ${outputPath}.poster.jpg`);
}
```

### 衍生文件存储

处理后的衍生文件以约定的 key 存回 TG + D1：

```
原始文件: photos/IMG_0001.heic
衍生文件:
  photos/IMG_0001.heic._derivatives/full.jpg
  photos/IMG_0001.heic._derivatives/thumb_400.webp
  photos/IMG_0001.heic._derivatives/thumb_200.webp
  photos/IMG_0001.heic._derivatives/video.mp4        (实况照片)
  photos/IMG_0001.heic._derivatives/poster.jpg        (视频封面)
  photos/IMG_0001.heic._derivatives/metadata.json     (EXIF等)
```

D1 中 objects 表存储衍生文件时，可以加一个字段关联原始文件：

```sql
ALTER TABLE objects ADD COLUMN derived_from TEXT;
-- derived_from = 'photos/IMG_0001.heic' 表示这是衍生文件
```

---

## 三、文件分享系统

### 分享 Token 生成

```typescript
interface ShareOptions {
  bucket: string;
  key: string;
  expiresIn?: number;       // 秒，null=永不过期
  password?: string;        // 明文，存储时哈希
  maxDownloads?: number;    // null=无限制
  note?: string;
}

async function createShareToken(opts: ShareOptions, env: Env): Promise<ShareTokenRow> {
  const token = generateToken(32);           // 32字节随机, base64url
  const now = new Date().toISOString();
  const expiresAt = opts.expiresIn
    ? new Date(Date.now() + opts.expiresIn * 1000).toISOString()
    : null;
  const passwordHash = opts.password
    ? await hashPassword(opts.password)       // PBKDF2 (CF Workers 不支持 bcrypt)
    : null;

  const row: ShareTokenRow = {
    token, bucket: opts.bucket, key: opts.key,
    created_at: now, expires_at: expiresAt,
    password_hash: passwordHash,
    max_downloads: opts.maxDownloads ?? null,
    download_count: 0, creator: null, note: opts.note ?? null,
  };
  await store.createShareToken(row);
  return row;                                 // 返回完整 ShareTokenRow，非仅 token 字符串
}
```

### 分享链接格式

```
https://tg-s3.example.com/share/{token}                    (浏览器: HTML 预览页; API: 直接下载)
https://tg-s3.example.com/share/{token}/download           (强制下载，计入下载次数)
https://tg-s3.example.com/share/{token}/inline             (内联媒体，用于预览页嵌入，不计下载次数，cookie 验证口令)
https://tg-s3.example.com/share/{token}/live-video         (实况照片视频组件，不计下载次数，cookie 验证口令)
```

> 安全说明: `/inline` 和 `/live-video` 不直接验证口令，而是检查 session cookie。口令保护的分享在预览页通过 POST 验证口令后，服务端设置 `HttpOnly; SameSite=Lax; Secure` 的 session cookie（1 小时有效）。后续 `<img>`/`<video>`/`<audio>` 的 src 请求自动携带此 cookie，无需再次输入口令。无口令的分享则无需 cookie，直接返回内容。

口令提交方式：
- POST 表单（推荐）: `POST /share/{token}` body 包含 `password` 字段
- Query param（兼容保留）: `GET /share/{token}?password=xxx`

> 安全说明: GET query param 方式会将口令明文暴露在 URL 中（浏览器历史、服务端日志、Referer 头），推荐使用 POST 表单方式提交口令。

### 分享访问流程

```
GET /share/{token}
    │
    ├─ 1. 查 D1 share_tokens 表
    │
    ├─ 2. 检查过期
    │     expires_at IS NOT NULL AND expires_at < NOW → 410 Gone (渲染过期页面)
    │
    ├─ 3. 检查下载次数
    │     download_count >= max_downloads → 410 Gone (渲染次数用尽页面)
    │
    ├─ 4. 检查口令 (PBKDF2 验证 + 暴力破解防护)
    │     password_hash IS NOT NULL
    │     ├─ 检查 share_password_attempts 表: 同一 token+IP 失败 >=5 次 → 锁定 15 分钟 (429)
    │     ├─ POST form 或 query param 有 password → 验证哈希
    │     │   ├─ 失败 → 记录失败次数到 share_password_attempts
    │     │   └─ 成功 → 清除该 token+IP 的失败记录
    │     └─ 无 password → 返回 HTML 口令输入页面
    │
    ├─ 5. 验证通过, 无 action (只查看预览页, 不计下载次数):
    │     浏览器访问 (Accept: text/html) → 返回 HTML 预览页
    │     ├─ 图片 → <img> 内联展示
    │     ├─ 视频 → <video> 播放器
    │     ├─ 音频 → <audio> 播放器
    │     ├─ PDF → <embed> 内嵌预览
    │     ├─ 文本/JSON/XML (<=512KB) → <pre> 预览 (JS fetch)
    │     ├─ 实况照片 → LivePhotosKit 展示
    │     └─ 其他 → 仅显示文件信息和下载按钮
    │     页面功能: 实时倒计时、复制链接按钮、暗色模式适配
    │
    ├─ 6. /download 或 API 访问 → 增加下载计数 → 流式返回文件
    │
    ├─ 7. /inline → 检查 session cookie (口令保护时) → 返回文件内容 (不计下载次数)
    │
    └─ 8. /live-video → 检查 session cookie (口令保护时) → 返回实况照片视频 (不计下载次数)
```

### 分享页面功能（HTML，由 `src/sharing/pages.ts` 渲染）

实际实现的分享预览页包含以下功能：

- **多媒体预览**: 图片 `<img>`、视频 `<video>`、音频 `<audio>`、PDF `<embed>`、文本 `<pre>`（JS fetch，<=512KB）
- **实况照片**: Apple 设备引入 LivePhotosKit JS 播放器；非 Apple 设备（Android 等）降级为图片 + 视频独立展示（JS UA 检测自动切换）
- **实时倒计时**: JS 每秒更新，显示 "X天X时X分X秒"
- **下载 + 复制链接**: 双按钮布局，复制链接使用 `navigator.clipboard.writeText`
- **暗色模式**: `@media(prefers-color-scheme:dark)` 自动适配
- **口令页面**: 支持 POST 表单提交（`method="POST"`）和 GET query param（`?password=xxx`）两种方式
- **口令暴力破解防护**: 同一 token+IP 失败 5 次后锁定 15 分钟，返回 429 + Retry-After；成功验证后清除记录；Cron 清理过期记录
- **过期页面**: 区分 expired / max_downloads / not_found 三种状态，显示不同提示文案

### S3 预签名 URL

标准 S3 预签名 URL 也要支持，供 rclone 等工具使用：

```
https://tg-s3.example.com/bucket/key
  ?X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=AKID/20260315/auto/s3/aws4_request
  &X-Amz-Date=20260315T080000Z
  &X-Amz-Expires=3600
  &X-Amz-SignedHeaders=host
  &X-Amz-Signature=abcdef...
```

验证流程同 SigV4，从 query params 提取签名信息，重建并校验。

`X-Amz-Expires` 上限为 604800 秒（7 天）。生成预签名 URL 时超出此值将被截断；验证外部预签名 URL 时超出此值将直接拒绝（与 AWS S3 行为一致）。

### 分享管理 API（非 S3，供 Web UI 和 Bot 使用）

```
POST   /api/shares              创建分享
GET    /api/shares              列出所有分享
GET    /api/shares/:token       查看分享详情
DELETE /api/shares/:token       撤销分享
PATCH  /api/shares/:token       修改分享（延长时效、改口令等）
```

---

## 四、图床功能

### 图床直链

图片上传后，可以通过以下 URL 直接访问：

```
S3 路径:  https://tg-s3.example.com/images/photo.jpg
直链:     https://tg-s3.example.com/images/photo.jpg          (原图)
缩略图:   https://tg-s3.example.com/images/photo.jpg?w=400    (宽度 400px)
格式转换: https://tg-s3.example.com/images/photo.jpg?fmt=webp  (转 WebP)
```

### 图片变体请求处理 [已实现]

集成在 `handleGetObject` 中作为 `handleImageVariant` 子流程（`src/handlers/get-object.ts`）。

```
GET /{bucket}/{key}?w=400         → 宽度 400px 变体
GET /{bucket}/{key}?fmt=webp      → WebP 格式
GET /{bucket}/{key}?w=200&fmt=webp → 组合

处理流程:
  1. 检查 Content-Type 是否为图片（isImageContentType）
  2. 生成变体 key: `{key}._derivatives/w${width || 'orig'}_${format || 'original'}`
  3. 查 D1 是否已有缓存的变体 → 有则直接返回
  4. 无 VPS: 回退返回原图（Cache-Control: no-store，防止缓存污染）
  5. 有 VPS: 调用 GET /api/image/resize?tg_file_id=...&width=...&format=...
  6. VPS 处理失败: 回退返回原图（Cache-Control: no-store，防止 CDN 将原图缓存为变体）
  7. 成功: 异步将变体存回 TG + D1（derived_from 关联原始文件），直接返回变体
```

### Markdown/HTML 嵌入支持

图床典型用法 -- 返回可嵌入的 URL：

```markdown
![photo](https://tg-s3.example.com/images/photo.jpg)
![thumbnail](https://tg-s3.example.com/images/photo.jpg?w=400)
```

Worker 对图片请求设置合适的 CORS 和 Cache 头：

```typescript
headers['Access-Control-Allow-Origin'] = '*';
headers['Cache-Control'] = 'public, max-age=31536000, immutable';
headers['Content-Disposition'] = 'inline';  // 浏览器内联显示，不下载
```

---

## 五、Bot 文件上传

用户直接发送文件给 Bot 即可上传到默认 Bucket：

```
用户发送文件给 Bot:
  1. Webhook 收到文件消息 (document/photo/video/audio)
  2. 提取 file_id, file_unique_id, file_name, file_size, mime_type
  3. 大小预检: 文件 >20MB 且未配置 VPS 时，提示用户该文件无法通过 S3 API 下载，拒绝记录
  4. 内容去重: 按 tg_file_unique_id 查询，如已有相同内容的对象则返回提示而非重复记录
  5. 使用用户通过 /setbucket 设置的默认 Bucket，未设置则选择第一个 (无 Bucket 则提示先创建)
  6. 文件名冲突时自动加时间戳后缀
  7. 直接记录 TG file_id 到 D1 (文件已在 TG，无需重新上传)
  8. 返回上传确认 (bucket 名、文件名、大小)
```

支持的文件类型：document、photo（取最大尺寸）、video、audio。

### 删除确认机制

Bot 的 `/delete` 命令使用 Inline Keyboard 二次确认：

```
用户: /delete docs report.pdf
Bot: [显示文件信息 + 确认/取消按钮]
用户: [点击确认]
Bot: [删除文件 + D1 记录 + 关联分享，编辑原消息显示结果]
```

Callback data 格式：`del_yes:{shortId}` / `del_no:{shortId}`。
使用内存 Map 存储 shortId → {bucket, key} 映射，避免 TG 64 字节 callback_data 限制导致长路径截断。
映射 5 分钟过期，过期后提示用户重新执行命令。
