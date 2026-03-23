# S3 API 规范

## 请求路由

Worker 通过 HTTP Method + Path + Query Params 判断 S3 操作类型：

```typescript
// 路由伪代码
function routeS3Request(method: string, path: string, query: URLSearchParams): S3Operation {
  const { bucket, key } = parsePath(path);

  if (!bucket) {
    if (method === 'GET') return 'ListBuckets';
  }

  if (!key) {
    if (method === 'GET' && query.has('location'))     return 'GetBucketLocation';
    if (method === 'GET' && query.has('versioning'))   return 'GetBucketVersioning';
    if (method === 'GET' && query.has('uploads'))      return 'ListMultipartUploads';
    if (method === 'GET' && query.get('list-type')==='2') return 'ListObjectsV2';
    if (method === 'GET')                              return 'ListObjects'; // v1
    if (method === 'HEAD')                             return 'HeadBucket';
    if (method === 'PUT')                              return 'CreateBucket';
    if (method === 'DELETE')                            return 'DeleteBucket';
    if (method === 'POST' && query.has('delete'))       return 'DeleteObjects';
  }

  if (key) {
    if (method === 'GET' && query.has('uploadId'))     return 'ListParts';
    if (method === 'GET')                              return 'GetObject';
    if (method === 'HEAD')                             return 'HeadObject'; // 含子资源检查
    if (method === 'PUT' && query.has('partNumber') && hasHeader('x-amz-copy-source'))
                                                        return 'UploadPartCopy';
    if (method === 'PUT' && query.has('partNumber'))    return 'UploadPart';
    if (method === 'PUT' && hasHeader('x-amz-copy-source'))
                                                        return 'CopyObject';
    if (method === 'PUT')                              return 'PutObject';
    if (method === 'DELETE' && query.has('uploadId'))    return 'AbortMultipartUpload';
    if (method === 'DELETE')                            return 'DeleteObject';
    if (method === 'POST' && query.has('uploads'))      return 'CreateMultipartUpload';
    if (method === 'POST' && query.has('uploadId'))     return 'CompleteMultipartUpload';
  }
}
```

### 不支持的子资源操作安全网

路由在匹配数据操作（GetObject/HeadObject/PutObject/DeleteObject）之前，会检查请求是否携带不支持的 S3 子资源查询参数（如 `?acl`, `?policy` 等）。如果匹配到不支持的子资源，返回 `501 NotImplemented` 而非落到数据操作。这防止了客户端发送 `PUT /{bucket}/{key}?acl` 时将 ACL XML body 当作文件内容覆盖写入的数据损坏风险。

已实现的子资源: `tagging`（对象标签）、`lifecycle`（生命周期规则）、`uploads`/`uploadId`（分段上传）。

拦截的子资源列表: `acl`, `policy`, `cors`, `encryption`, `notification`, `replication`, `website`, `logging`, `analytics`, `metrics`, `inventory`, `accelerate`, `requestPayment`, `object-lock`, `legal-hold`, `retention`, `torrent`, `restore`, `select`, `intelligent-tiering`, `ownershipControls`, `publicAccessBlock`, `versions`。

## 路径格式

支持 Path-style（不支持 Virtual-hosted-style，因为需要通配符 DNS）：

```
https://tg-s3.example.com/{bucket}/{key}
https://tg-s3.example.com/             → ListBuckets
https://tg-s3.example.com/photos/      → ListObjectsV2 (bucket=photos)
https://tg-s3.example.com/photos/a.jpg → GetObject (bucket=photos, key=a.jpg)
```

## 各操作详细规范

### PutObject

```
PUT /{bucket}/{key}
Headers:
  Content-Type: application/octet-stream (或实际类型)
  Content-Length: 12345
  Content-MD5: base64 (可选, 完整性校验)
  x-amz-meta-*: 自定义元数据
  x-amz-tagging: key1=val1&key2=val2 (可选, 最多 10 个标签, key<=128 chars, value<=256 chars)
  x-amz-server-side-encryption-customer-algorithm: AES256 (SSE-C)
  x-amz-server-side-encryption: AES256 (SSE-S3, 需配置 SSE_MASTER_KEY)
Body: 文件内容
```

大小路由：
- 分块传输编码 (chunked): Worker 内存缓冲, 上限 100MB (WORKER_BODY_LIMIT)
- <=20MB: Worker 内存缓冲, 通过 Bot API 上传
- 20MB-2GB: 流式转发到 VPS, VPS 计算 ETag 并上传到 TG Local Bot API

处理流程：
1. 验证认证
2. 检查速率限制
3. 读取 Content-Type, Content-Length, x-amz-meta-*, x-amz-tagging headers
4. 验证标签: 最多 10 个, key<=128, value<=256
5. 支持条件写入: `If-None-Match: *` 阻止覆盖已有对象，返回 412 PreconditionFailed
6. 计算请求体 MD5 作为 ETag (大文件由 VPS 计算)
7. 判断大小路由到 TG Bot API 或 VPS
7. 调用 TG sendDocument:
   ```
   POST https://api.telegram.org/bot{token}/sendDocument
   Content-Type: multipart/form-data
   chat_id: {bucket_channel_id}
   document: (文件内容)
   filename: {key} (文件名显示在 TG 消息中)
   ```
8. 从 TG 响应提取 file_id, file_unique_id, message_id
9. INSERT INTO objects ... ON CONFLICT(bucket, key) DO UPDATE（覆盖写）
10. 如果是覆盖写，删除旧的 TG 消息（异步，可选）

响应：
```xml
HTTP/1.1 200 OK
ETag: "d41d8cd98f00b204e9800998ecf8427e"
```

### GetObject

```
GET /{bucket}/{key}
Headers:
  Range: bytes=0-999 (可选)
  If-Match: "etag" (可选, 不匹配返回 412)
  If-None-Match: "etag" (可选, 匹配返回 304)
  If-Modified-Since: <date> (可选, 未修改返回 304)
  If-Unmodified-Since: <date> (可选, 已修改返回 412)

Query Parameters:
  partNumber=<n>           (可选, 返回多段上传对象的第 n 段, 206 响应)
  response-content-type    (可选, 覆盖响应 Content-Type)
  response-content-disposition (可选, 覆盖 Content-Disposition, 如强制下载)
  response-content-encoding    (可选, 覆盖 Content-Encoding)
  response-content-language    (可选, 覆盖 Content-Language)
  response-cache-control       (可选, 覆盖 Cache-Control)
  response-expires             (可选, 覆盖 Expires)
  w=<width>    (图片专用, 缩放宽度 1-4096px, 高度按比例)
  fmt=<format> (图片专用, 格式转换: auto/webp/jpeg/jpg/png/avif)
  q=<quality>  (图片专用, 质量 1-100)
  original=1   (图片专用, 跳过自动转换返回原始文件)
```

处理流程：
1. 验证认证（SigV4 / Bearer / 预签名 URL）
2. 查 D1 获取元数据
3. 条件请求处理（按 S3 优先级）：
   - If-Match → 不匹配返回 412
   - If-Unmodified-Since → 已修改返回 412（If-Match 存在时跳过）
   - If-None-Match → 匹配返回 304
   - If-Modified-Since → 未修改返回 304（If-None-Match 存在时跳过）
4. 三层缓存查找（非 Range 请求，<=20MB）：
   a. 第 1 层: CDN Cache → ETag 一致则直接返回
   b. 第 2 层: R2 缓存 (64KB-20MB) → ETag 一致则返回并回填 CDN
   c. 第 3 层: TG 源站（下载后回填 CDN + R2）
5. 按文件大小路由下载：
   a. <=20MB: Worker 调 TG Bot API getFile → 流式返回；Range 请求在 Worker 内切片
   b. >20MB: Worker 请求 VPS → VPS 通过 Local Bot API 下载 → 流式返回（含 Range 支持）
6. 图片变体处理（w/fmt/q 参数）：
   - HEIC/HEIF 自动转换为浏览器兼容格式（除非传 original=1）
   - fmt=auto 根据 Accept 头选择最优格式（AVIF > WebP > JPEG）
   - 变体缓存到 D1 + TG，后续请求直接返回
   - 加密对象不支持图片变体

响应：
```
HTTP/1.1 200 OK
Content-Type: image/jpeg
Content-Length: 12345
ETag: "d41d8cd98f00b204e9800998ecf8427e"
Last-Modified: Mon, 15 Mar 2026 08:00:00 GMT
Cache-Control: public, max-age=86400

(文件内容流)
```

### HeadObject

同 GetObject 但不返回 body，只返回 headers。直接查 D1，不调 TG API。

### DeleteObject

```
DELETE /{bucket}/{key}
```

处理流程：
1. 验证认证
2. 查 D1 获取元数据
3. DELETE FROM objects WHERE bucket=? AND key=?
4. 异步清理（全部 best-effort，不阻塞 204 响应）：
   a. 删除 TG 消息
   b. 删除派生文件 (derivatives)
   c. 删除分块消息 (chunks)
   d. 删除关联的分享令牌 (share tokens)
   e. 清除 CDN 缓存
   f. 清除 R2 缓存

响应：
```
HTTP/1.1 204 No Content
```

### ListObjectsV2

```
GET /{bucket}?list-type=2&prefix=photos/&delimiter=/&max-keys=1000&continuation-token=xxx
```

处理流程：
1. 验证认证
2. SQL 查询 D1：
   ```sql
   SELECT key, size, etag, last_modified, content_type
   FROM objects
   WHERE bucket = ?
     AND key >= ?           -- prefix
     AND key < ?            -- prefix 的下一个字典序
   ORDER BY key ASC
   LIMIT ? + 1              -- max-keys + 1（判断是否 truncated）
   ```
3. 如果有 delimiter（通常是 `/`），需要在结果中提取 CommonPrefixes：
   ```typescript
   // 对于 prefix="photos/", delimiter="/"
   // key="photos/2024/a.jpg" → CommonPrefix="photos/2024/"
   // key="photos/b.jpg" → 正常 Contents 条目
   ```
4. 生成 XML 响应

响应：
```xml
<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>photos</Name>
  <Prefix>photos/</Prefix>
  <Delimiter>/</Delimiter>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>photos/b.jpg</Key>
    <LastModified>2026-03-15T08:00:00.000Z</LastModified>
    <ETag>&quot;d41d8cd9...&quot;</ETag>
    <Size>12345</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <CommonPrefixes>
    <Prefix>photos/2024/</Prefix>
  </CommonPrefixes>
</ListBucketResult>
```

### CopyObject

```
PUT /{dest-bucket}/{dest-key}
Headers:
  x-amz-copy-source: /{src-bucket}/{src-key}
  x-amz-metadata-directive: COPY | REPLACE (默认 COPY)
  x-amz-tagging-directive: COPY | REPLACE (默认 COPY)
  x-amz-tagging: key1=val1&key2=val2 (仅 tagging-directive=REPLACE 时使用)
```

处理流程：
1. 解析 `x-amz-copy-source` header（URL 解码，去除 `?versionId=`）
2. 自身复制保护: 同 bucket 同 key + COPY directive → 返回 400 InvalidRequest（AWS S3 标准行为，不允许不修改元数据的自身复制）
3. 查 D1 获取源对象元数据，支持条件 copy headers（if-match/if-none-match/if-modified-since/if-unmodified-since）
4. 检查 `x-amz-metadata-directive`: COPY（默认，保留源元数据）或 REPLACE（使用请求中的新元数据）
5. 检查 `x-amz-tagging-directive`: COPY（默认，复制源对象标签）或 REPLACE（使用 `x-amz-tagging` header 中的新标签）
5. 同 bucket: 复用同一个 file_id，仅 INSERT D1 记录
   - 特殊情况: 0 字节对象 (`__zero__` sentinel) 的 tg_chat_id 指向目标 bucket 的 chat_id
6. 跨 bucket: 调用 TG `forwardMessage`（含 `message_thread_id`）转发消息到目标频道/话题（受速率限制），获取新的 file_id + message_id
   - 特殊情况: Bot 上传的文件 (tg_message_id=0) 无频道消息可转发，改用 `sendDocumentByFileId` 重新发送
7. 如果目标 key 已有对象（覆盖写），异步删除旧 TG 消息
8. 异步清除目标 key 的 CDN + R2 缓存

### DeleteObjects (批量删除)

```
POST /{bucket}?delete
Body:
<Delete>
  <Object><Key>file1.txt</Key></Object>
  <Object><Key>file2.txt</Key></Object>
</Delete>
```

处理流程：
1. 解析 XML body，校验 Content-MD5（必需，缺失返回 400 MissingContentMD5）
2. 逐条处理每个 key（非批量 SQL，因为每条需要独立的副作用处理）：
   - 删除 D1 对象记录 + 更新 bucket 统计
   - 删除关联的衍生文件（_derivatives）
   - 删除关联的 share_tokens
   - 异步删除 TG 消息 + CDN/R2 缓存
3. 支持 `<Quiet>true</Quiet>` 模式（只返回错误条目）
4. 返回结果 XML

### CreateMultipartUpload

```
POST /{bucket}/{key}?uploads
```

处理：
1. 生成 uploadId (UUID v4, `crypto.randomUUID()`)
2. INSERT INTO multipart_uploads (upload_id, bucket, key, created_at)
3. 返回 uploadId

### UploadPart

```
PUT /{bucket}/{key}?partNumber=1&uploadId=xxx
Body: part 内容
```

处理：
1. 上传 part 到 TG 作为独立文件
2. INSERT INTO multipart_parts (upload_id, part_number, size, etag, file_id)
3. 返回 ETag

### CompleteMultipartUpload

```
POST /{bucket}/{key}?uploadId=xxx
Body:
<CompleteMultipartUpload>
  <Part><PartNumber>1</PartNumber><ETag>"aaa"</ETag></Part>
  <Part><PartNumber>2</PartNumber><ETag>"bbb"</ETag></Part>
</CompleteMultipartUpload>
```

处理策略（混合方案）：
- **总大小 <=20MB**：Worker 内存中下载所有 parts，拼接，通过 Bot API 重新上传为单个文件，异步删除 part 消息
- **总大小 >20MB 且有 VPS**：委托 VPS 通过 `POST /api/proxy/consolidate` 合并所有 parts 为单个文件
- **总大小 >2GB (VPS) 或 >20MB (无 VPS)**：返回 `EntityTooLarge` 错误

### ListBuckets

```
GET /
```

查 D1 buckets 表，返回：
```xml
<ListAllMyBucketsResult>
  <Buckets>
    <Bucket>
      <Name>photos</Name>
      <CreationDate>2026-03-15T08:00:00.000Z</CreationDate>
    </Bucket>
  </Buckets>
</ListAllMyBucketsResult>
```

### CreateBucket

```
PUT /{bucket}
```

处理：
1. 在预配置的 Supergroup (Forum) 中创建新的 Topic（通过 TG Bot API `createForumTopic`）
2. INSERT INTO buckets (name, tg_chat_id, tg_topic_id, created_at)

实际实现：所有 Bucket 共用同一个 Supergroup（环境变量 `DEFAULT_CHAT_ID`），每个 Bucket 对应一个 Forum Topic，通过 `tg_topic_id` 隔离存储。Bot 需要有该 Supergroup 的管理员权限。

## 认证

### AWS SigV4（S3 客户端）

标准 S3 签名验证流程，支持多凭证（D1 `credentials` 表管理）：
1. 从 Authorization header 提取 Credential, SignedHeaders, Signature
2. 通过 Access Key ID 查询对应的 Secret Access Key（带 60s 内存缓存）
3. 重建 Canonical Request → String to Sign
4. 用 Secret Key 派生 Signing Key（HMAC-SHA256）
5. 计算签名并比对

CPU 开销：1-3ms，在免费计划 10ms CPU 限制内完全可行。

### TG WebApp initData（Mini App）

Telegram Mini App 通过 WebApp initData 认证：
1. 从 Authorization header 提取 `tg <initData>`
2. 按 Telegram 规范验证 HMAC 签名
3. 验证通过后授予 **admin 权限**（等同全权凭证，含凭证管理和 Bucket 删除）

> 设计选择: Mini App 用户统一获得 admin 权限，因为 tg-s3 是单用户系统，能打开 Mini App 的用户即为系统所有者。如果将来需要多用户支持，应引入 TG user_id 白名单机制。

### 认证模式总结

- S3 客户端 (rclone/aws cli): SigV4（多凭证）
- TG Mini App: TG WebApp initData
- 预签名 URL: SigV4 Query String 认证
- 公开分享链接: 分享 Token 认证

## 明确不实现的 S3 能力

### Versioning（对象版本控制）

**决定**: 不实现。永久搁置。

**原因**:

1. **存储成本不匹配**: 每个对象版本需要一条独立的 Telegram 消息。Telegram 存储受消息数量限制，版本控制会导致存储快速膨胀，与 S3 弹性存储的前提完全不同。

2. **实现范围过大**: 版本控制改变几乎所有 S3 操作的语义。DELETE 不再真正删除而是创建"删除标记"，GET 需要解析版本链，还需要新增 ListObjectVersions 操作。实现成本与价值不成比例。

3. **使用场景不匹配**: tg-s3 的核心场景是个人网盘。需要版本保护的用户，通过回收站/软删除功能即可满足（规划中），只需极少的复杂度就能覆盖"误删恢复"这一核心需求。

4. **生态先例**: 多个 S3 兼容服务（Cloudflare R2、Backblaze B2 等）同样未实现版本控制。没有主流 S3 客户端要求此功能才能正常运行。

**替代方案**: 回收站功能（软删除 + 可配置保留期），覆盖用户最核心的"防误删"需求。

### 其他平台限制

以下限制源于 Telegram 存储后端：

- 单文件大小上限: 2GB（Local Bot API）或 20MB（标准 Bot API，上传与下载对齐）
- 支持 SSE-C（客户提供密钥）和 SSE-S3（服务端管理密钥，需配置 `SSE_MASTER_KEY`）
- 支持生命周期规则（基于前缀和标签的对象过期，cron 定期执行）
- 无存储类别: 所有对象等同于 STANDARD
- 无对象锁定/保留: 不适用于 Telegram 存储
- 无 Bucket Policy / ACL: 单用户系统，使用 Bearer Token 或 SigV4 认证

## 响应格式

### 通用响应头（S3 兼容性）

所有响应自动附加以下标准 S3 头，确保 AWS SDK 和 S3 客户端工具正常工作：

| Header | 值 | 说明 |
|--------|---|------|
| `Date` | UTC 时间 | AWS SDK 用于时钟偏差检测 |
| `x-amz-request-id` | 16 字符随机 hex | 请求追踪标识 |
| `x-amz-id-2` | 32 字符随机 hex | 扩展请求标识 |
| `Server` | `AmazonS3` | 部分 SDK/工具检查此头 |
| `Access-Control-Allow-Origin` | `*` | CORS 支持 |
| `Access-Control-Expose-Headers` | ETag, Content-Range 等 | 浏览器可读取的响应头列表 |

### 304 Not Modified 响应头规范

遵循 RFC 7232 §4.1，304 响应仅保留缓存相关头部，剥离表征头部：

- **保留**: ETag, Last-Modified, Cache-Control, Expires, Vary, x-amz-meta-*
- **剥离**: Content-Type, Content-Length, Content-Encoding, Content-Language, Content-Disposition, Content-Range, Accept-Ranges

此行为与 AWS S3 一致。

### 错误响应

所有错误返回 S3 标准 XML：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Error>
  <Code>NoSuchKey</Code>
  <Message>The specified key does not exist.</Message>
  <Key>nonexistent.txt</Key>
  <RequestId>A1B2C3D4E5F67890</RequestId>
</Error>
```

常用错误码：

| HTTP | S3 Code | 触发条件 |
|------|---------|---------|
| 400 | BadDigest | Content-MD5 校验失败 |
| 400 | EntityTooLarge | 文件超出大小限制 |
| 400 | InvalidArgument | 参数无效 (如 copy source 格式错误) |
| 400 | InvalidPartNumber | partNumber 超出范围 |
| 400 | KeyTooLongError | Key 超过 1024 字节 (UTF-8) |
| 400 | MalformedXML | XML 请求体解析失败 |
| 400 | MissingContent | UploadPart body 为空 |
| 400 | XAmzContentSHA256Mismatch | x-amz-content-sha256 校验失败 |
| 403 | AccessDenied | 认证失败 |
| 404 | NoSuchBucket | Bucket 不存在 |
| 404 | NoSuchKey | Key 不存在 |
| 404 | NoSuchUpload | Multipart upload ID 不存在 |
| 405 | MethodNotAllowed | 不支持的 HTTP 方法 |
| 400 | InvalidBucketName | Bucket 名称不合法 |
| 400 | InvalidPartOrder | CompleteMultipartUpload 中 Part 序号未递增 |
| 400 | InvalidPart | CompleteMultipartUpload 中 Part ETag 不匹配 |
| 400 | EntityTooSmall | Part 大小不足 (除最后一个 Part) |
| 409 | BucketNotEmpty | 删除非空 Bucket |
| 412 | PreconditionFailed | 条件请求失败 (If-Match / If-None-Match: *) |
| 501 | NotImplemented | 不支持的 S3 子资源操作 (acl, tagging 等) |
| 503 | SlowDown | 触发速率限制 |
| 500 | InternalError | TG API 失败、VPS 后端不可用等 |
