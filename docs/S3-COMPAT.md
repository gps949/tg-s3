# S3 Compatibility Status

tg-s3 implements an S3-compatible API on top of Telegram as the storage backend.
This document records the compatibility status and deliberate design decisions.

## Supported Operations (22)

| Operation | Status | Notes |
|-----------|--------|-------|
| ListBuckets | Full | |
| CreateBucket | Full | Idempotent (200 on existing bucket) |
| DeleteBucket | Full | Rejects non-empty buckets and in-progress multipart uploads |
| HeadBucket | Full | Returns x-amz-bucket-region |
| GetBucketLocation | Full | |
| GetBucketVersioning | Stub | Always returns disabled |
| ListObjects (V1) | Full | Supports prefix, delimiter, marker, encoding-type |
| ListObjectsV2 | Full | Opaque base64 continuation tokens |
| GetObject | Full | Conditional headers, Range, partNumber, response-* overrides |
| PutObject | Full | Content-MD5, x-amz-content-sha256 verification, 0-byte support |
| HeadObject | Full | Same headers as GetObject, partNumber support |
| DeleteObject | Full | Returns 204 even if key doesn't exist |
| DeleteObjects | Full | Quiet mode, 1-1000 key range validation, Content-MD5 verification |
| CopyObject | Full | Metadata directives, conditional copy headers, self-copy detection |
| CreateMultipartUpload | Full | Preserves user/system metadata |
| UploadPart | Full | Content-MD5/SHA256 verification, re-upload cleanup |
| UploadPartCopy | Full | Range copy, conditional copy headers |
| CompleteMultipartUpload | Full | Part order validation, 5MB minimum, multipart ETag |
| AbortMultipartUpload | Full | Cleans up TG messages |
| ListParts | Full | Pagination with part-number-marker |
| ListMultipartUploads | Full | Prefix, delimiter, pagination |

## Authentication

- **SigV4 header auth**: Full, with specific error codes (SignatureDoesNotMatch, InvalidAccessKeyId, RequestTimeTooSkewed, AuthorizationHeaderMalformed)
- **Presigned URLs**: Full, 7-day max expiry, SigV4 query string auth
- **AWS chunked streaming** (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`): Body parsing supported; per-chunk signature verification skipped (HTTPS provides transport integrity)
- **Bearer token**: tg-s3 extension for simplified auth

## Response Headers

- All responses include `Date`, `x-amz-request-id`, `x-amz-id-2` (added by global middleware)
- All XML responses use `xmlns="http://s3.amazonaws.com/doc/2006-03-01/"` namespace
- 304 Not Modified responses include `Content-Type` in addition to `ETag` and `Last-Modified`
- CORS exposes all S3-relevant headers: `Last-Modified`, `Accept-Ranges`, `Content-Disposition`, `Content-Encoding`, `x-amz-mp-parts-count`, `x-amz-bucket-region`, `Retry-After`, `Location`, etc.

## Error Responses

- All errors return standard S3 XML format with `<Code>`, `<Message>`, `<Resource>`, `<RequestId>`
- Error responses include `x-amz-error-code` and `x-amz-error-message` headers for HEAD compatibility (AWS SDKs read these when body is stripped)
- Rate limiting returns 503 with `Retry-After` header and consistent `x-amz-request-id` across XML body and headers

## Deliberately Not Implemented

### Versioning

**Decision**: Not implemented. Permanently deferred.

**Rationale**:

1. **Storage cost mismatch**: Each object version requires a separate Telegram message. Versioning would cause rapid storage growth in a system where storage is bounded by Telegram's message limits. This is fundamentally different from real S3 where storage is elastic.

2. **Semantic scope**: Versioning changes the behavior of nearly every S3 operation. DELETE no longer deletes but creates a "delete marker". GET must resolve version chains. A new ListObjectVersions operation is needed. The implementation cost is disproportionate to the value.

3. **Use case mismatch**: tg-s3's primary use case is a personal cloud drive backed by Telegram. Users needing version protection are better served by a trash bin / soft-delete feature (planned), which provides accidental deletion recovery at a fraction of the complexity.

4. **Ecosystem reality**: Many S3-compatible services (Cloudflare R2, Backblaze B2, etc.) also do not implement versioning. No mainstream S3 client requires it to function.

**Alternative**: A trash bin feature (soft delete with configurable retention period) is the recommended path for file protection. This covers the primary user need (undo accidental deletion) without the architectural complexity of full S3 versioning.

### Sub-resource Operations (acl, tagging, policy, etc.)

Unsupported S3 sub-resource operations (`?acl`, `?tagging`, `?policy`, `?cors`, `?lifecycle`, `?encryption`, etc.) are explicitly detected and return `501 NotImplemented`. This prevents them from being misrouted to data operations (e.g. `PUT /key?acl` being treated as PutObject).

## Platform Constraints

These are inherent to the Telegram storage backend:

- **Single object size limit**: 2GB (Local Bot API) or 50MB (standard Bot API upload) / 20MB (standard Bot API download)
- **No server-side encryption (SSE)**: Telegram handles storage; we don't control encryption at rest
- **No storage classes**: All objects are effectively STANDARD
- **No lifecycle policies**: Use cron-based cleanup instead
- **No object locking / retention**: Not applicable to Telegram storage
- **No bucket policies / ACL**: Single-owner system with bearer token or SigV4 auth
