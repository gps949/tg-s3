import type { Env, S3Request, S3Operation, AuthFailure, AuthContext, CredentialRow } from './types';
import { parseS3Path } from './utils/path';
import { verifyBearer } from './auth/bearer';
import { verifySignature, type CredentialResolver } from './auth/sigv4';
import { generatePresignedUrl } from './auth/presigned';
import { errorResponse } from './xml/builder';
import { timingSafeEqual, deriveWebhookSecret } from './utils/crypto';
import { S3_MAX_PRESIGN_EXPIRES } from './constants';

// Handlers
import { handleGetObject } from './handlers/get-object';
import { handlePutObject } from './handlers/put-object';
import { handleHeadObject } from './handlers/head-object';
import { handleDeleteObject, handleDeleteObjects, cleanupDeletedObject } from './handlers/delete-object';
import { handleListObjectsV2, handleListObjects } from './handlers/list-objects';
import { handleCopyObject } from './handlers/copy-object';
import { handleCreateMultipartUpload, handleUploadPart, handleUploadPartCopy, handleCompleteMultipartUpload, handleAbortMultipartUpload, handleListParts, handleListMultipartUploads } from './handlers/multipart';
import { handleListBuckets, handleCreateBucket, handleDeleteBucket, handleHeadBucket, handleGetBucketLocation, handleGetBucketVersioning } from './handlers/bucket';
import { handleShareApi, handleShareAccess } from './handlers/share';
import { handleWebhook } from './bot/webhook';
import { MetadataStore } from './storage/metadata';
import { TelegramClient } from './telegram/client';
import { cleanR2Cache } from './handlers/get-object';
import { renderMiniApp } from './bot/miniapp';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return addCorsHeaders(handleCors());
    }

    // Bot webhook (verified by secret_token derived from TG_BOT_TOKEN)
    if (path === '/bot/webhook' && request.method === 'POST') {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      const expectedSecret = await deriveWebhookSecret(env.TG_BOT_TOKEN);
      if (!timingSafeEqual(secret, expectedSecret)) {
        return new Response('Unauthorized', { status: 401 });
      }
      return handleWebhook(request, env);
    }

    // Mini App (served as HTML, auth via Telegram WebApp initData)
    if (path === '/miniapp' || path === '/miniapp/') {
      return new Response(renderMiniApp(url.origin), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // Share access (public, no auth required)
    if (path.startsWith('/share/')) {
      return addCorsHeaders(await handleShareAccess(request, url, env));
    }

    // Presigned URL generation API (requires auth)
    if (path === '/api/presign' && request.method === 'POST') {
      const authResult = await authenticate(request, url, env);
      if (isAuthFailure(authResult)) return addCorsHeaders(errorResponse(authResult.status, authResult.code, authResult.message));
      return addCorsHeaders(await handlePresignApi(request, url, env, authResult));
    }

    // Share management API (requires auth)
    if (path.startsWith('/api/shares')) {
      const authResult = await authenticate(request, url, env);
      if (isAuthFailure(authResult)) return addCorsHeaders(errorResponse(authResult.status, authResult.code, authResult.message));
      return addCorsHeaders(await handleShareApi(request, url, env, authResult));
    }

    // Simple Upload API: Bearer token auth using S3 credentials (for iOS Shortcuts, scripts, etc.)
    // PUT /api/upload?bucket=...&key=...  Authorization: Bearer <access_key_id>:<secret_access_key>
    if (path === '/api/upload' && (request.method === 'PUT' || request.method === 'POST')) {
      const authResult = await authenticateSimpleToken(request, env);
      if ('error' in authResult) {
        return addCorsHeaders(Response.json({ error: authResult.error }, { status: authResult.status }));
      }
      const bucket = url.searchParams.get('bucket')?.toLowerCase();
      const key = url.searchParams.get('key');
      if (!bucket || !key) return addCorsHeaders(Response.json({ error: 'bucket and key required' }, { status: 400 }));
      // Check credential has access to this bucket
      const cred = authResult.credential;
      if (cred.buckets !== '*' && !cred.buckets.split(',').map((b: string) => b.trim()).includes(bucket)) {
        return addCorsHeaders(Response.json({ error: 'No access to this bucket' }, { status: 403 }));
      }
      if (cred.permission === 'readonly') {
        return addCorsHeaders(Response.json({ error: 'Read-only credential' }, { status: 403 }));
      }
      const s3: S3Request = {
        method: 'PUT', bucket, key,
        query: new URLSearchParams(),
        headers: request.headers,
        body: request.body,
        url,
      };
      return addCorsHeaders(await handlePutObject(s3, env, ctx));
    }

    // Mini App API (requires auth)
    if (path.startsWith('/api/miniapp/')) {
      // Support auth token in query string for browser-navigable URLs (download, thumbnails)
      let authReq = request;
      if (!request.headers.get('Authorization') && url.searchParams.has('auth')) {
        const headers = new Headers(request.headers);
        headers.set('Authorization', 'Bearer ' + url.searchParams.get('auth'));
        authReq = new Request(request, { headers });
      }
      const authResult = await authenticate(authReq, url, env);
      if (isAuthFailure(authResult)) return addCorsHeaders(errorResponse(authResult.status, authResult.code, authResult.message));
      try {
        return addCorsHeaders(await handleMiniAppApi(request, url, env, ctx, authResult));
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Internal error';
        return addCorsHeaders(Response.json({ error: msg }, { status: 500 }));
      }
    }

    // Public bucket access: allow unauthenticated GET/HEAD for public buckets
    if ((request.method === 'GET' || request.method === 'HEAD') && !request.headers.get('authorization') && !url.searchParams.has('X-Amz-Algorithm')) {
      const { bucket, key } = parseS3Path(url);
      if (bucket && key) {
        const store = new MetadataStore(env);
        const bucketRow = await store.getBucket(bucket);
        if (bucketRow?.is_public) {
          let query = url.searchParams;
          // Auto-optimize: inject default compression params if bucket has optimize_config
          // Skip if ?original=1 or if explicit w/fmt/q params are present
          if (bucketRow.optimize_config && !url.searchParams.has('original')) {
            const hasExplicitParams = url.searchParams.has('w') || url.searchParams.has('fmt') || url.searchParams.has('q');
            if (!hasExplicitParams) {
              try {
                const cfg = JSON.parse(bucketRow.optimize_config);
                if (cfg.enabled) {
                  query = new URLSearchParams(url.searchParams);
                  query.set('w', cfg.maxWidth.toString());
                  query.set('q', cfg.quality.toString());
                  query.set('fmt', cfg.format === 'auto' ? 'auto' : cfg.format);
                }
              } catch { /* invalid config, use original query */ }
            }
          }
          const s3: S3Request = { method: request.method, bucket, key, query, headers: request.headers, body: null, url };
          const handler = request.method === 'GET' ? handleGetObject : handleHeadObject;
          return addCorsHeaders(await handler(s3, env, ctx));
        }
      }
    }

    // S3 API
    try {
      // Authenticate (returns AuthContext on success, AuthFailure on failure)
      const authResult = await authenticate(request, url, env);
      if (isAuthFailure(authResult)) {
        return addCorsHeaders(errorResponse(authResult.status, authResult.code, authResult.message));
      }

      const { bucket, key } = parseS3Path(url);
      const s3: S3Request = {
        method: request.method,
        bucket,
        key,
        query: url.searchParams,
        headers: request.headers,
        body: request.body,
        url,
      };

      const operation = routeS3Request(s3);
      if (!operation) {
        // S3 returns 405 MethodNotAllowed for unsupported HTTP methods
        const supportedMethods = ['GET', 'HEAD', 'PUT', 'DELETE', 'POST'];
        if (!supportedMethods.includes(request.method)) {
          return addCorsHeaders(errorResponse(405, 'MethodNotAllowed', 'The specified method is not allowed against this resource.'));
        }
        // Return 501 for known S3 sub-resource operations we don't support
        const subresource = hasUnsupportedSubresource(s3.query);
        if (subresource) {
          return addCorsHeaders(errorResponse(501, 'NotImplemented', `The ${subresource} sub-resource is not supported.`));
        }
        return addCorsHeaders(errorResponse(400, 'InvalidRequest', 'Could not determine S3 operation.'));
      }

      // Authorization: check credential permissions for this operation + bucket
      const authzErr = authorize(authResult, bucket, operation);
      if (authzErr) {
        return addCorsHeaders(errorResponse(authzErr.status, authzErr.code, authzErr.message));
      }

      // CopyObject / UploadPartCopy: also check read permission on source bucket
      if (operation === 'CopyObject' || operation === 'UploadPartCopy') {
        const copySource = s3.headers.get('x-amz-copy-source') || '';
        try {
          const decoded = decodeURIComponent(copySource.split('?')[0]);
          const trimmed = decoded.startsWith('/') ? decoded.slice(1) : decoded;
          const si = trimmed.indexOf('/');
          if (si > 0) {
            const srcBucket = trimmed.slice(0, si);
            if (srcBucket !== bucket) {
              const srcAuthzErr = authorize(authResult, srcBucket, 'GetObject');
              if (srcAuthzErr) {
                return addCorsHeaders(errorResponse(srcAuthzErr.status, srcAuthzErr.code, `Access Denied: no read permission for source bucket '${srcBucket}'.`));
              }
            }
          }
        } catch { /* decoding error handled in handler */ }
      }

      // S3 limits key length to 1024 bytes (UTF-8 encoded); validate on write operations
      const WRITE_OPS: S3Operation[] = ['PutObject', 'CopyObject', 'CreateMultipartUpload', 'UploadPartCopy'];
      if (key && WRITE_OPS.includes(operation) && new TextEncoder().encode(key).length > 1024) {
        return addCorsHeaders(errorResponse(400, 'KeyTooLongError', 'Your key is too long.'));
      }

      let response = await dispatchS3(operation, s3, env, ctx);
      // HEAD responses must not have a body per HTTP spec
      if (request.method === 'HEAD' && response.body) {
        response = new Response(null, { status: response.status, headers: response.headers });
      }
      return addCorsHeaders(response);
    } catch (e) {
      console.error('Unhandled error:', e instanceof Error ? e.message : e);
      const errRes = errorResponse(500, 'InternalError', 'An internal error occurred.');
      if (request.method === 'HEAD') {
        return addCorsHeaders(new Response(null, { status: errRes.status, headers: errRes.headers }));
      }
      return addCorsHeaders(errRes);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = new MetadataStore(env);

    if (!env.WORKER_URL) {
      console.warn('Cron: WORKER_URL not set, CDN cache purge during consistency cleanup will be skipped.');
    }

    // Each task is independently try-caught so a failure in one doesn't block the rest

    let expiredShares = 0;
    try {
      expiredShares = await store.cleanExpiredShares();
    } catch (e) { console.error('Cron: cleanExpiredShares failed:', e); }

    let orphanedShares = 0;
    try {
      orphanedShares = await store.cleanOrphanedShares();
    } catch (e) { console.error('Cron: cleanOrphanedShares failed:', e); }

    let staleUploads = 0;
    try {
      const staleResult = await store.cleanStaleMultiparts(24);
      staleUploads = staleResult.count;
      if (staleResult.parts.length > 0) {
        const tgCleanup = new TelegramClient(env);
        await Promise.allSettled(staleResult.parts.map(part =>
          tgCleanup.deleteMessage(part.tg_chat_id, part.tg_message_id).catch(() => {})
        ));
      }
    } catch (e) { console.error('Cron: cleanStaleMultiparts failed:', e); }

    let inconsistent = 0;
    try {
      const { TgApiError } = await import('./telegram/client');
      const tg = new TelegramClient(env);
      // Dynamic sampling: 2% of objects, clamped to [5, 50]
      const totalCount = await store.countObjects();
      const sampleSize = Math.min(50, Math.max(5, Math.ceil(totalCount * 0.02)));
      const samples = await store.sampleObjects(sampleSize);
      for (const obj of samples) {
        try {
          await tg.getFile(obj.tg_file_id);
        } catch (e) {
          // Only delete if TG explicitly says the file is invalid (400 Bad Request).
          // Transient errors (timeout, network, FloodWait, 5xx) should NOT trigger deletion.
          if (e instanceof TgApiError && e.status === 400) {
            inconsistent++;
            await store.deleteObject(obj.bucket, obj.key);
            // Full cleanup: TG message, derivatives, share tokens, CDN/R2 cache
            const cronBaseUrl = env.WORKER_URL
              ? (env.WORKER_URL.startsWith('http') ? env.WORKER_URL : `https://${env.WORKER_URL}`)
              : '';
            await cleanupDeletedObject(obj.bucket, obj.key, obj, cronBaseUrl, env, store);
            console.log(`Consistency: removed orphaned D1 record ${obj.bucket}/${obj.key}`);
          } else {
            console.warn(`Consistency: skipped ${obj.bucket}/${obj.key} due to transient error: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
    } catch (e) { console.error('Cron: D1-TG consistency check failed:', e); }

    let r2Cleaned = 0;
    try {
      r2Cleaned = await cleanR2Cache(env, store, 20);
    } catch (e) { console.error('Cron: cleanR2Cache failed:', e); }

    let expiredAttempts = 0;
    try {
      expiredAttempts = await store.cleanExpiredPasswordAttempts();
    } catch (e) { console.error('Cron: cleanExpiredPasswordAttempts failed:', e); }

    let orphanedChunks = 0;
    try {
      const chunkResult = await store.cleanOrphanedChunks();
      orphanedChunks = chunkResult.count;
      if (chunkResult.chunks.length > 0) {
        const tgChunkCleanup = new TelegramClient(env);
        await Promise.allSettled(chunkResult.chunks.map(chunk =>
          tgChunkCleanup.deleteMessage(chunk.tg_chat_id, chunk.tg_message_id).catch(() => {})
        ));
      }
    } catch (e) { console.error('Cron: cleanOrphanedChunks failed:', e); }

    // Lifecycle rules: delete expired objects
    let lifecycleDeleted = 0;
    try {
      const expired = await store.findExpiredObjects(50);
      for (const obj of expired) {
        try {
          const objRow = await store.getObject(obj.bucket, obj.key);
          if (!objRow) continue;
          await store.deleteObject(obj.bucket, obj.key);
          const cronBaseUrl = env.WORKER_URL
            ? (env.WORKER_URL.startsWith('http') ? env.WORKER_URL : `https://${env.WORKER_URL}`)
            : '';
          await cleanupDeletedObject(obj.bucket, obj.key, objRow, cronBaseUrl, env, store);
          lifecycleDeleted++;
        } catch (e) { console.warn(`Lifecycle: failed to delete ${obj.bucket}/${obj.key}:`, e); }
      }
    } catch (e) { console.error('Cron: lifecycle evaluation failed:', e); }

    console.log(`Cron cleanup: ${expiredShares} expired shares, ${orphanedShares} orphaned shares, ${staleUploads} stale multipart uploads, ${inconsistent} inconsistent objects, ${r2Cleaned} stale R2 cache entries, ${expiredAttempts} expired password attempts, ${orphanedChunks} orphaned chunks, ${lifecycleDeleted} lifecycle-expired objects`);
  },
};

const ADMIN_CONTEXT: AuthContext = { accessKeyId: '__bearer__', permission: 'admin', buckets: ['*'] };

// Module-level credential cache (persists across requests within the same isolate)
const credentialCache = new Map<string, { cred: { secret_access_key: string; access_key_id: string; permission: string; buckets: string } | null; ts: number }>();
const CRED_CACHE_TTL = 60_000; // 60 seconds
const CRED_CACHE_MAX = 200; // cap size to prevent memory exhaustion from random key probes

function buildCredentialResolver(env: Env): CredentialResolver {
  return async (accessKeyId: string) => {
    // Check cache first to reduce D1 reads
    const cached = credentialCache.get(accessKeyId);
    const now = Date.now();
    let cred: typeof cached extends undefined ? never : NonNullable<typeof cached>['cred'] | null;
    if (cached && now - cached.ts < CRED_CACHE_TTL) {
      cred = cached.cred;
    } else {
      const store = new MetadataStore(env);
      const row = await store.getCredentialByAccessKey(accessKeyId);
      if (row) {
        cred = { secret_access_key: row.secret_access_key, access_key_id: row.access_key_id, permission: row.permission, buckets: row.buckets };
        if (credentialCache.size >= CRED_CACHE_MAX) {
          const oldest = credentialCache.keys().next().value!;
          credentialCache.delete(oldest);
        }
        credentialCache.set(accessKeyId, { cred, ts: now });
      } else {
        // Negative cache: remember that this key doesn't exist to prevent D1 read amplification
        if (credentialCache.size >= CRED_CACHE_MAX) {
          // Evict oldest entry
          const oldest = credentialCache.keys().next().value!;
          credentialCache.delete(oldest);
        }
        credentialCache.set(accessKeyId, { cred: null, ts: now });
        cred = null;
      }
    }
    if (cred) {
      // Update last_used_at with 10% probability to reduce D1 writes
      if (Math.random() < 0.1) {
        const store = new MetadataStore(env);
        store.touchCredentialLastUsed(accessKeyId).catch(() => {});
      }
      return {
        secretKey: cred.secret_access_key,
        context: {
          accessKeyId: cred.access_key_id,
          permission: cred.permission as AuthContext['permission'],
          buckets: cred.buckets === '*' ? ['*'] : cred.buckets.split(',').map(b => b.trim()),
        },
      };
    }
    return null;
  };
}

// Simple token auth for /api/upload: Bearer <access_key_id>:<secret_access_key>
async function authenticateSimpleToken(request: Request, env: Env): Promise<{ credential: CredentialRow } | { error: string; status: number }> {
  const auth = request.headers.get('Authorization');
  if (!auth) return { error: 'Authorization header required', status: 401 };
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return { error: 'Expected: Bearer <access_key_id>:<secret_access_key>', status: 401 };
  const colonIdx = parts[1].indexOf(':');
  if (colonIdx < 0) return { error: 'Expected: Bearer <access_key_id>:<secret_access_key>', status: 401 };
  const accessKeyId = parts[1].slice(0, colonIdx);
  const secretKey = parts[1].slice(colonIdx + 1);
  const store = new MetadataStore(env);
  const cred = await store.getCredentialByAccessKey(accessKeyId);
  if (!cred) return { error: 'Invalid credentials', status: 401 };
  if (!timingSafeEqual(secretKey, cred.secret_access_key)) return { error: 'Invalid credentials', status: 401 };
  await store.touchCredentialLastUsed(accessKeyId);
  return { credential: cred };
}

async function authenticate(request: Request, url: URL, env: Env): Promise<AuthFailure | AuthContext> {
  const resolve = buildCredentialResolver(env);

  // Check for presigned URL auth
  if (url.searchParams.has('X-Amz-Algorithm')) {
    return verifySignature(request, url, resolve);
  }

  // Check Authorization header
  const auth = request.headers.get('Authorization');
  if (!auth) {
    return { status: 403, code: 'AccessDenied', message: 'No authentication provided.' };
  }

  // Bearer token auth (tg-s3 extension + Telegram WebApp initData validation)
  if (auth.startsWith('Bearer ')) {
    const valid = await verifyBearer(request, env);
    return valid
      ? ADMIN_CONTEXT
      : { status: 403, code: 'AccessDenied', message: 'Invalid bearer token.' };
  }

  // SigV4 auth (returns specific error codes)
  if (auth.startsWith('AWS4-HMAC-SHA256')) {
    return verifySignature(request, url, resolve);
  }

  return { status: 403, code: 'AccessDenied', message: 'Unsupported authentication scheme.' };
}

function isAuthFailure(result: AuthFailure | AuthContext): result is AuthFailure {
  return 'code' in result && 'status' in result;
}

/** Check if the credential is authorized for the given operation on the bucket */
function authorize(auth: AuthContext, bucket: string, operation: S3Operation): AuthFailure | null {
  // Check bucket access
  if (!auth.buckets.includes('*') && bucket && !auth.buckets.includes(bucket)) {
    return { status: 403, code: 'AccessDenied', message: `Access Denied: no permission for bucket '${bucket}'.` };
  }
  // Check operation permission
  if (auth.permission === 'admin') return null;
  const readOps: S3Operation[] = ['GetObject', 'HeadObject', 'ListObjectsV2', 'ListObjects', 'ListBuckets', 'HeadBucket', 'GetBucketLocation', 'GetBucketVersioning', 'ListParts', 'ListMultipartUploads', 'GetObjectTagging', 'GetBucketLifecycleConfiguration'];
  if (auth.permission === 'readonly' && !readOps.includes(operation)) {
    return { status: 403, code: 'AccessDenied', message: 'Access Denied: read-only credential.' };
  }
  // readwrite: allow everything except bucket create/delete
  if (auth.permission === 'readwrite') {
    const bucketAdminOps: S3Operation[] = ['CreateBucket', 'DeleteBucket'];
    if (bucketAdminOps.includes(operation)) {
      return { status: 403, code: 'AccessDenied', message: 'Access Denied: insufficient permission for bucket management.' };
    }
  }
  return null;
}

// S3 sub-resource query parameters that indicate a distinct operation.
// If any of these are present, the request must NOT fall through to data
// operations (GetObject, PutObject, DeleteObject) — doing so could
// silently corrupt data (e.g. PUT ?acl would overwrite the object with
// the ACL XML body).
const UNSUPPORTED_SUBRESOURCES = new Set([
  'acl', 'policy', 'cors', 'encryption',
  'notification', 'replication', 'website', 'logging', 'analytics',
  'metrics', 'inventory', 'accelerate', 'requestPayment',
  'object-lock', 'legal-hold', 'retention', 'torrent', 'restore',
  'select', 'intelligent-tiering', 'ownershipControls',
  'publicAccessBlock', 'versions',
]);

function hasUnsupportedSubresource(query: URLSearchParams): string | null {
  for (const name of UNSUPPORTED_SUBRESOURCES) {
    if (query.has(name)) return name;
  }
  return null;
}

function routeS3Request(s3: S3Request): S3Operation | null {
  const { method, bucket, key, query, headers } = s3;

  if (!bucket) {
    if (method === 'GET') return 'ListBuckets';
    return null;
  }

  if (!key) {
    if (method === 'GET' && query.has('location')) return 'GetBucketLocation';
    if (method === 'GET' && query.has('versioning')) return 'GetBucketVersioning';
    if (method === 'GET' && query.has('uploads')) return 'ListMultipartUploads';
    if (method === 'GET' && query.has('lifecycle')) return 'GetBucketLifecycleConfiguration';
    if (method === 'PUT' && query.has('lifecycle')) return 'PutBucketLifecycleConfiguration';
    if (method === 'DELETE' && query.has('lifecycle')) return 'DeleteBucketLifecycleConfiguration';
    // Block unsupported bucket sub-resource operations before falling to ListObjects
    if (hasUnsupportedSubresource(query)) return null;
    if (method === 'GET' && query.get('list-type') === '2') return 'ListObjectsV2';
    if (method === 'GET') return 'ListObjects';
    if (method === 'HEAD') return 'HeadBucket';
    if (method === 'PUT') return 'CreateBucket';
    if (method === 'DELETE') return 'DeleteBucket';
    if (method === 'POST' && query.has('delete')) return 'DeleteObjects';
    return null;
  }

  // Key present — block unsupported object sub-resource operations before
  // they fall through to data operations (prevents data corruption)
  if (method === 'GET') {
    if (query.has('uploadId')) return 'ListParts';
    if (query.has('tagging')) return 'GetObjectTagging';
    if (hasUnsupportedSubresource(query)) return null;
    return 'GetObject';
  }

  if (method === 'HEAD') {
    if (hasUnsupportedSubresource(query)) return null;
    return 'HeadObject';
  }

  if (method === 'PUT') {
    if (query.has('partNumber') && headers.get('x-amz-copy-source')) return 'UploadPartCopy';
    if (query.has('partNumber')) return 'UploadPart';
    if (query.has('tagging')) return 'PutObjectTagging';
    if (hasUnsupportedSubresource(query)) return null;
    if (headers.get('x-amz-copy-source')) return 'CopyObject';
    return 'PutObject';
  }

  if (method === 'DELETE') {
    if (query.has('uploadId')) return 'AbortMultipartUpload';
    if (query.has('tagging')) return 'DeleteObjectTagging';
    if (hasUnsupportedSubresource(query)) return null;
    return 'DeleteObject';
  }

  if (method === 'POST') {
    if (query.has('uploads')) return 'CreateMultipartUpload';
    if (query.has('uploadId')) return 'CompleteMultipartUpload';
    return null;
  }

  return null;
}

// ── Object Tagging handlers ─────────────────────────────────────────

async function handleGetObjectTagging(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);
  const obj = await store.getObject(s3.bucket, s3.key);
  if (!obj) return errorResponse(404, 'NoSuchKey', 'The specified key does not exist.', `/${s3.bucket}/${s3.key}`);
  const tags = await store.getObjectTags(s3.bucket, s3.key);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${
    tags.map(t => `<Tag><Key>${escXml(t.key)}</Key><Value>${escXml(t.value)}</Value></Tag>`).join('')
  }</TagSet></Tagging>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
}

async function handlePutObjectTagging(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);
  const obj = await store.getObject(s3.bucket, s3.key);
  if (!obj) return errorResponse(404, 'NoSuchKey', 'The specified key does not exist.', `/${s3.bucket}/${s3.key}`);
  if (!s3.body) return errorResponse(400, 'MalformedXML', 'Request body is empty.');
  const bodyText = await new Response(s3.body).text();
  const tags = parseTaggingXml(bodyText);
  if (tags.length > 10) return errorResponse(400, 'BadRequest', 'Object tags cannot exceed 10.');
  for (const t of tags) {
    if (t.key.length > 128) return errorResponse(400, 'InvalidTag', 'Tag key exceeds 128 characters.');
    if (t.value.length > 256) return errorResponse(400, 'InvalidTag', 'Tag value exceeds 256 characters.');
  }
  await store.putObjectTags(s3.bucket, s3.key, tags);
  return new Response(null, { status: 200 });
}

async function handleDeleteObjectTagging(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);
  const obj = await store.getObject(s3.bucket, s3.key);
  if (!obj) return errorResponse(404, 'NoSuchKey', 'The specified key does not exist.', `/${s3.bucket}/${s3.key}`);
  await store.deleteObjectTags(s3.bucket, s3.key);
  return new Response(null, { status: 204 });
}

function parseTaggingXml(xml: string): Array<{ key: string; value: string }> {
  const tags: Array<{ key: string; value: string }> = [];
  const tagRegex = /<Tag>\s*<Key>([^<]*)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g;
  let match;
  while ((match = tagRegex.exec(xml)) !== null) {
    tags.push({ key: unescXml(match[1]), value: unescXml(match[2]) });
  }
  return tags;
}

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescXml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

// ── Bucket Lifecycle handlers ───────────────────────────────────────

async function handleGetBucketLifecycle(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);
  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
  const rules = await store.getLifecycleRules(s3.bucket);
  if (rules.length === 0) {
    return errorResponse(404, 'NoSuchLifecycleConfiguration', 'The lifecycle configuration does not exist.');
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${
    rules.map(r => `<Rule><ID>${escXml(r.id)}</ID><Filter>${
      r.prefix ? `<Prefix>${escXml(r.prefix)}</Prefix>` : ''
    }${r.tagKey ? `<Tag><Key>${escXml(r.tagKey)}</Key><Value>${escXml(r.tagValue || '')}</Value></Tag>` : ''
    }</Filter><Status>${r.enabled ? 'Enabled' : 'Disabled'}</Status><Expiration><Days>${r.expirationDays}</Days></Expiration></Rule>`).join('')
  }</LifecycleConfiguration>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
}

async function handlePutBucketLifecycle(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);
  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
  if (!s3.body) return errorResponse(400, 'MalformedXML', 'Request body is empty.');
  const bodyText = await new Response(s3.body).text();
  const rules = parseLifecycleXml(bodyText);
  if (rules.length > 100) return errorResponse(400, 'BadRequest', 'Lifecycle rules cannot exceed 100.');
  // Validate unique rule IDs (D1 PRIMARY KEY on id would crash the batch otherwise)
  const idSet = new Set(rules.map(r => r.id));
  if (idSet.size !== rules.length) return errorResponse(400, 'InvalidArgument', 'Lifecycle rule IDs must be unique.');
  await store.putLifecycleRules(s3.bucket, rules);
  return new Response(null, { status: 200 });
}

async function handleDeleteBucketLifecycle(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);
  await store.deleteLifecycleRules(s3.bucket);
  return new Response(null, { status: 204 });
}

function parseLifecycleXml(xml: string): Array<{
  id: string; prefix: string; expirationDays: number;
  tagKey?: string; tagValue?: string; enabled?: boolean;
}> {
  const rules: Array<{ id: string; prefix: string; expirationDays: number; tagKey?: string; tagValue?: string; enabled?: boolean }> = [];
  const ruleRegex = /<Rule>([\s\S]*?)<\/Rule>/g;
  let match;
  while ((match = ruleRegex.exec(xml)) !== null) {
    const ruleXml = match[1];
    const id = ruleXml.match(/<ID>([^<]*)<\/ID>/)?.[1] || crypto.randomUUID();
    const prefix = ruleXml.match(/<Prefix>([^<]*)<\/Prefix>/)?.[1] || '';
    const days = parseInt(ruleXml.match(/<Days>(\d+)<\/Days>/)?.[1] || '0', 10);
    const tagKey = ruleXml.match(/<Tag>\s*<Key>([^<]*)<\/Key>/)?.[1];
    const tagValue = ruleXml.match(/<Value>([^<]*)<\/Value>/)?.[1];
    const status = ruleXml.match(/<Status>([^<]*)<\/Status>/)?.[1];
    if (days > 0) {
      // S3 tag filters require both key and value; drop tag filter if value is missing
      const hasValidTag = tagKey !== undefined && tagValue !== undefined;
      rules.push({
        id: unescXml(id), prefix: unescXml(prefix), expirationDays: days,
        tagKey: hasValidTag ? unescXml(tagKey) : undefined,
        tagValue: hasValidTag ? unescXml(tagValue) : undefined,
        enabled: status !== 'Disabled',
      });
    }
  }
  return rules;
}

async function dispatchS3(op: S3Operation, s3: S3Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  switch (op) {
    case 'ListBuckets': return handleListBuckets(s3, env);
    case 'CreateBucket': return handleCreateBucket(s3, env);
    case 'DeleteBucket': return handleDeleteBucket(s3, env);
    case 'HeadBucket': return handleHeadBucket(s3, env);
    case 'GetBucketLocation': return handleGetBucketLocation(s3, env);
    case 'GetBucketVersioning': return handleGetBucketVersioning(s3, env);
    case 'ListObjectsV2': return handleListObjectsV2(s3, env);
    case 'ListObjects': return handleListObjects(s3, env);
    case 'GetObject': return handleGetObject(s3, env, ctx);
    case 'PutObject': return handlePutObject(s3, env, ctx);
    case 'HeadObject': return handleHeadObject(s3, env);
    case 'DeleteObject': return handleDeleteObject(s3, env, ctx);
    case 'CopyObject': return handleCopyObject(s3, env, ctx);
    case 'DeleteObjects': return handleDeleteObjects(s3, env, ctx);
    case 'CreateMultipartUpload': return handleCreateMultipartUpload(s3, env);
    case 'UploadPart': return handleUploadPart(s3, env, ctx);
    case 'UploadPartCopy': return handleUploadPartCopy(s3, env, ctx);
    case 'CompleteMultipartUpload': return handleCompleteMultipartUpload(s3, env, ctx);
    case 'AbortMultipartUpload': return handleAbortMultipartUpload(s3, env, ctx);
    case 'ListParts': return handleListParts(s3, env);
    case 'ListMultipartUploads': return handleListMultipartUploads(s3, env);
    case 'GetObjectTagging': return handleGetObjectTagging(s3, env);
    case 'PutObjectTagging': return handlePutObjectTagging(s3, env);
    case 'DeleteObjectTagging': return handleDeleteObjectTagging(s3, env);
    case 'GetBucketLifecycleConfiguration': return handleGetBucketLifecycle(s3, env);
    case 'PutBucketLifecycleConfiguration': return handlePutBucketLifecycle(s3, env);
    case 'DeleteBucketLifecycleConfiguration': return handleDeleteBucketLifecycle(s3, env);
    default: return errorResponse(400, 'InvalidRequest', `Unknown operation: ${op}`);
  }
}

async function handlePresignApi(request: Request, url: URL, env: Env, auth: AuthContext): Promise<Response> {
  let body: { bucket: string; key: string; method?: string; expiresIn?: number };
  try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (!body.bucket || !body.key) {
    return Response.json({ error: 'bucket and key are required' }, { status: 400 });
  }
  const method = (body.method || 'GET').toUpperCase();
  if (!['GET', 'PUT', 'HEAD', 'DELETE'].includes(method)) {
    return Response.json({ error: 'method must be GET, PUT, HEAD, or DELETE' }, { status: 400 });
  }
  // Map HTTP method to S3 operation for authorization check
  const opMap: Record<string, S3Operation> = { GET: 'GetObject', PUT: 'PutObject', HEAD: 'HeadObject', DELETE: 'DeleteObject' };
  const authzErr = authorize(auth, body.bucket, opMap[method]);
  if (authzErr) {
    return Response.json({ error: authzErr.message }, { status: authzErr.status });
  }
  if (body.expiresIn !== undefined && body.expiresIn > S3_MAX_PRESIGN_EXPIRES) {
    return Response.json({ error: `expiresIn cannot exceed ${S3_MAX_PRESIGN_EXPIRES} seconds (7 days)` }, { status: 400 });
  }
  const presignedUrl = await generatePresignedUrl({
    bucket: body.bucket,
    key: body.key,
    method,
    expiresIn: body.expiresIn,
    env,
    baseUrl: url.origin,
  });
  return Response.json({ url: presignedUrl });
}

async function handleMiniAppApi(request: Request, url: URL, env: Env, ctx: ExecutionContext, auth: AuthContext): Promise<Response> {
  // Mini App API is admin-only; reject non-admin credentials that may have
  // authenticated via SigV4 (normal Mini App auth uses Bearer → ADMIN_CONTEXT)
  if (auth.permission !== 'admin') {
    return Response.json({ error: 'Mini App API requires admin credentials' }, { status: 403 });
  }
  const path = url.pathname;
  const method = request.method;
  const store = new MetadataStore(env);

  // GET /api/miniapp/buckets
  if (path === '/api/miniapp/buckets' && method === 'GET') {
    const buckets = await store.listBuckets();
    return Response.json(buckets);
  }

  // GET /api/miniapp/objects?bucket=...&prefix=...&delimiter=...&maxKeys=...
  if (path === '/api/miniapp/objects' && method === 'GET') {
    const bucket = url.searchParams.get('bucket');
    if (!bucket) return Response.json({ error: 'bucket required' }, { status: 400 });
    const prefix = url.searchParams.get('prefix') || '';
    const delimiter = url.searchParams.get('delimiter') || '/';
    const maxKeys = Math.max(1, Math.min(1000, parseInt(url.searchParams.get('maxKeys') || '100', 10) || 100));
    const startAfter = url.searchParams.get('startAfter') || undefined;
    const result = await store.listObjects(bucket, prefix, delimiter, maxKeys, startAfter);
    return Response.json(result);
  }

  // GET /api/miniapp/object?bucket=...&key=...
  if (path === '/api/miniapp/object' && method === 'GET') {
    const bucket = url.searchParams.get('bucket');
    const key = url.searchParams.get('key');
    if (!bucket || !key) return Response.json({ error: 'bucket and key required' }, { status: 400 });
    const obj = await store.getObject(bucket, key);
    if (!obj) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(obj);
  }

  // DELETE /api/miniapp/object?bucket=...&key=...
  if (path === '/api/miniapp/object' && method === 'DELETE') {
    const bucket = url.searchParams.get('bucket');
    const key = url.searchParams.get('key');
    if (!bucket || !key) return Response.json({ error: 'bucket and key required' }, { status: 400 });
    const s3: S3Request = {
      method: 'DELETE', bucket, key,
      query: new URLSearchParams(), headers: request.headers,
      body: null, url,
    };
    const res = await handleDeleteObject(s3, env, ctx);
    return res;
  }

  // POST /api/miniapp/batch-delete
  if (path === '/api/miniapp/batch-delete' && method === 'POST') {
    let body: { bucket: string; keys: string[] };
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (!body.bucket || !body.keys?.length) return Response.json({ error: 'bucket and keys required' }, { status: 400 });
    if (body.keys.length > 1000) return Response.json({ error: 'Maximum 1000 keys per batch' }, { status: 400 });
    let deleted = 0;
    const failed: string[] = [];
    for (const key of body.keys) {
      try {
        const s3: S3Request = { method: 'DELETE', bucket: body.bucket, key, query: new URLSearchParams(), headers: request.headers, body: null, url };
        await handleDeleteObject(s3, env, ctx);
        deleted++;
      } catch { failed.push(key); }
    }
    return Response.json({ deleted, failed });
  }

  // POST /api/miniapp/share
  if (path === '/api/miniapp/share' && method === 'POST') {
    let body: {
      bucket: string; key: string; expiresIn?: number;
      password?: string; maxDownloads?: number;
    };
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (!body.bucket || !body.key) return Response.json({ error: 'bucket and key are required' }, { status: 400 });
    const obj = await store.getObject(body.bucket, body.key);
    if (!obj) return Response.json({ error: 'Object not found' }, { status: 404 });
    const { createShareToken } = await import('./sharing/tokens');
    const share = await createShareToken(body, env);
    return Response.json({ ...share, url: `${url.origin}/share/${share.token}` });
  }

  // GET /api/miniapp/shares?bucket=...
  if (path === '/api/miniapp/shares' && method === 'GET') {
    const bucket = url.searchParams.get('bucket') || undefined;
    const tokens = await store.listShareTokens(bucket);
    return Response.json(tokens);
  }

  // DELETE /api/miniapp/share?token=...
  if (path === '/api/miniapp/share' && method === 'DELETE') {
    const token = url.searchParams.get('token');
    if (!token) return Response.json({ error: 'token required' }, { status: 400 });
    await store.deleteShareToken(token);
    return new Response(null, { status: 204 });
  }

  // GET /api/miniapp/search?bucket=...&q=...
  if (path === '/api/miniapp/search' && method === 'GET') {
    const bucket = url.searchParams.get('bucket');
    const q = url.searchParams.get('q');
    if (!bucket || !q) return Response.json({ error: 'bucket and q required' }, { status: 400 });
    const results = await store.searchObjects(bucket, q, 200);
    // Filter out derivative objects
    const filtered = results.filter(o => !o.key.includes('._derivatives/'));
    return Response.json(filtered);
  }

  // POST /api/miniapp/rename - atomic rename within same bucket
  if (path === '/api/miniapp/rename' && method === 'POST') {
    let body: { bucket: string; oldKey: string; newKey: string };
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (!body.bucket || !body.oldKey || !body.newKey) return Response.json({ error: 'bucket, oldKey, newKey required' }, { status: 400 });
    if (body.oldKey === body.newKey) return Response.json({ error: 'Keys are identical' }, { status: 400 });
    const success = await store.renameObject(body.bucket, body.oldKey, body.newKey);
    if (!success) return Response.json({ error: 'Rename failed: source not found or destination exists' }, { status: 409 });
    return Response.json({ renamed: true });
  }

  // GET /api/miniapp/stats
  if (path === '/api/miniapp/stats' && method === 'GET') {
    const buckets = await store.listBuckets();
    const totalFiles = buckets.reduce((s, b) => s + b.object_count, 0);
    const totalSize = buckets.reduce((s, b) => s + b.total_size, 0);
    return Response.json({ bucketCount: buckets.length, totalFiles, totalSize });
  }

  // POST /api/miniapp/bucket - create bucket
  if (path === '/api/miniapp/bucket' && method === 'POST') {
    let body: { name: string };
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (!body.name) return Response.json({ error: 'name required' }, { status: 400 });
    // Reuse S3 CreateBucket handler via internal S3Request
    const s3: S3Request = {
      method: 'PUT', bucket: body.name, key: '',
      query: new URLSearchParams(), headers: request.headers,
      body: null, url,
    };
    const res = await handleCreateBucket(s3, env);
    if (res.status === 200) {
      return Response.json({ name: body.name, created: true });
    }
    // Parse error from XML response
    const text = await res.text();
    const codeMatch = text.match(/<Code>([^<]+)<\/Code>/);
    const msgMatch = text.match(/<Message>([^<]+)<\/Message>/);
    return Response.json({ error: msgMatch?.[1] || codeMatch?.[1] || 'Failed' }, { status: res.status });
  }

  // PATCH /api/miniapp/bucket?name=... - update bucket settings
  if (path === '/api/miniapp/bucket' && method === 'PATCH') {
    const name = url.searchParams.get('name');
    if (!name) return Response.json({ error: 'name required' }, { status: 400 });
    let body: { is_public?: boolean; default_encryption?: boolean; optimize_config?: { enabled: boolean; format: string; quality: number; maxWidth: number } | null };
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (body.is_public !== undefined) {
      await store.updateBucketPublicAccess(name, body.is_public);
    }
    if (body.default_encryption !== undefined) {
      await store.updateBucketDefaultEncryption(name, body.default_encryption);
    }
    if (body.optimize_config !== undefined) {
      if (body.optimize_config === null) {
        await store.updateBucketOptimizeConfig(name, null);
      } else {
        const c = body.optimize_config;
        if (!['auto', 'webp', 'avif'].includes(c.format)) return Response.json({ error: 'format must be auto, webp, or avif' }, { status: 400 });
        if (!Number.isInteger(c.quality) || c.quality < 1 || c.quality > 100) return Response.json({ error: 'quality must be 1-100' }, { status: 400 });
        if (!Number.isInteger(c.maxWidth) || c.maxWidth < 100 || c.maxWidth > 4096) return Response.json({ error: 'maxWidth must be 100-4096' }, { status: 400 });
        await store.updateBucketOptimizeConfig(name, JSON.stringify({ enabled: c.enabled, format: c.format, quality: c.quality, maxWidth: c.maxWidth }));
      }
    }
    return Response.json({ ok: true });
  }

  // PUT /api/miniapp/upload?bucket=...&key=... (direct upload, no presigned URL needed)
  if (path === '/api/miniapp/upload' && method === 'PUT') {
    const bucket = url.searchParams.get('bucket');
    const key = url.searchParams.get('key');
    if (!bucket || !key) return Response.json({ error: 'bucket and key required' }, { status: 400 });
    const s3: S3Request = {
      method: 'PUT', bucket, key,
      query: new URLSearchParams(),
      headers: request.headers,
      body: request.body,
      url,
    };
    return handlePutObject(s3, env, ctx);
  }

  // GET /api/miniapp/download?bucket=...&key=... (direct download, no presigned URL needed)
  if (path === '/api/miniapp/download' && method === 'GET') {
    const bucket = url.searchParams.get('bucket');
    const key = url.searchParams.get('key');
    if (!bucket || !key) return Response.json({ error: 'bucket and key required' }, { status: 400 });
    const s3: S3Request = {
      method: 'GET', bucket, key,
      query: url.searchParams,
      headers: request.headers,
      body: null, url,
    };
    return handleGetObject(s3, env, ctx);
  }

  // POST /api/miniapp/presign (kept for explicit "copy presigned URL" feature only)
  if (path === '/api/miniapp/presign' && method === 'POST') {
    let body: { bucket: string; key: string; method?: string; expiresIn?: number };
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (!body.bucket || !body.key) {
      return Response.json({ error: 'bucket and key are required' }, { status: 400 });
    }
    if (body.expiresIn !== undefined && body.expiresIn > S3_MAX_PRESIGN_EXPIRES) {
      return Response.json({ error: `expiresIn cannot exceed ${S3_MAX_PRESIGN_EXPIRES} seconds (7 days)` }, { status: 400 });
    }
    const presignedUrl = await generatePresignedUrl({
      bucket: body.bucket, key: body.key, method: body.method,
      expiresIn: body.expiresIn, env, baseUrl: url.origin,
    });
    return Response.json({ url: presignedUrl });
  }

  // GET /api/miniapp/credentials - list all credentials (secrets masked)
  if (path === '/api/miniapp/credentials' && method === 'GET') {
    const creds = await store.listCredentials();
    const masked = creds.map(c => ({
      ...c,
      secret_access_key: c.secret_access_key.slice(0, 4) + '****' + c.secret_access_key.slice(-4),
      status: c.is_active ? 'active' : 'inactive',
    }));
    return Response.json(masked);
  }

  // GET /api/miniapp/credential/:id/secret - get unmasked secret for sync setup
  const credSecretMatch = path.match(/^\/api\/miniapp\/credential\/([^/]+)\/secret$/);
  if (credSecretMatch && method === 'GET') {
    const cred = await store.getCredentialByAccessKeyUnsafe(credSecretMatch[1]);
    if (!cred) return Response.json({ error: 'Credential not found' }, { status: 404 });
    return Response.json({ access_key_id: cred.access_key_id, secret_access_key: cred.secret_access_key });
  }

  // POST /api/miniapp/credential - create new credential
  if (path === '/api/miniapp/credential' && method === 'POST') {
    // Limit total credentials to prevent abuse
    const credCount = await store.countCredentials();
    if (credCount >= 100) {
      return Response.json({ error: 'Maximum number of credentials (100) reached' }, { status: 400 });
    }
    let body: { name?: string; buckets?: string; permission?: string };
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    const permission = body.permission || 'readwrite';
    if (!['admin', 'readwrite', 'readonly'].includes(permission)) {
      return Response.json({ error: 'permission must be admin, readwrite, or readonly' }, { status: 400 });
    }
    // Generate random access key (20 chars) and secret key (40 chars)
    const akBuf = new Uint8Array(15);
    const skBuf = new Uint8Array(30);
    crypto.getRandomValues(akBuf);
    crypto.getRandomValues(skBuf);
    const toBase62 = (buf: Uint8Array) => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      return Array.from(buf).map(b => chars[b % 62]).join('');
    };
    const accessKeyId = 'TGS3' + toBase62(akBuf).slice(0, 16);
    const secretAccessKey = toBase62(skBuf);
    await store.createCredential({
      accessKeyId,
      secretAccessKey,
      name: body.name || '',
      buckets: (body.buckets || '*').toLowerCase(),
      permission,
    });
    // Return full credential (only time secret is shown in plain text)
    return Response.json({ access_key_id: accessKeyId, secret_access_key: secretAccessKey, name: body.name || '', buckets: (body.buckets || '*').toLowerCase(), permission });
  }

  // PATCH /api/miniapp/credential?accessKeyId=... - update credential
  if (path === '/api/miniapp/credential' && method === 'PATCH') {
    const accessKeyId = url.searchParams.get('accessKeyId');
    if (!accessKeyId) return Response.json({ error: 'accessKeyId required' }, { status: 400 });
    let body: { name?: string; buckets?: string; permission?: string; is_active?: number };
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (body.permission && !['admin', 'readwrite', 'readonly'].includes(body.permission)) {
      return Response.json({ error: 'permission must be admin, readwrite, or readonly' }, { status: 400 });
    }
    if (body.buckets) body.buckets = body.buckets.toLowerCase();
    const ok = await store.updateCredential(accessKeyId, body);
    credentialCache.delete(accessKeyId);
    return Response.json({ ok });
  }

  // POST /api/miniapp/credential/rotate?accessKeyId=... - rotate secret key
  if (path === '/api/miniapp/credential/rotate' && method === 'POST') {
    const accessKeyId = url.searchParams.get('accessKeyId');
    if (!accessKeyId) return Response.json({ error: 'accessKeyId required' }, { status: 400 });
    const existing = await store.getCredentialByAccessKeyUnsafe(accessKeyId);
    if (!existing) return Response.json({ error: 'Credential not found' }, { status: 404 });
    const skBuf = new Uint8Array(30);
    crypto.getRandomValues(skBuf);
    const toBase62 = (buf: Uint8Array) => {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      return Array.from(buf).map(b => chars[b % 62]).join('');
    };
    const newSecret = toBase62(skBuf);
    await store.updateCredentialSecret(accessKeyId, newSecret);
    credentialCache.delete(accessKeyId);
    return Response.json({ secret_access_key: newSecret });
  }

  // DELETE /api/miniapp/credential?accessKeyId=... - delete credential
  if (path === '/api/miniapp/credential' && method === 'DELETE') {
    const accessKeyId = url.searchParams.get('accessKeyId');
    if (!accessKeyId) return Response.json({ error: 'accessKeyId required' }, { status: 400 });
    const ok = await store.deleteCredential(accessKeyId);
    credentialCache.delete(accessKeyId);
    return Response.json({ ok });
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}

function generateRequestId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function handleCors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, PATCH, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Amz-Date, X-Amz-Content-Sha256, X-Amz-Security-Token, X-Amz-Copy-Source, X-Amz-Copy-Source-Range, X-Amz-Metadata-Directive, X-Amz-Copy-Source-If-Match, X-Amz-Copy-Source-If-None-Match, X-Amz-Copy-Source-If-Modified-Since, X-Amz-Copy-Source-If-Unmodified-Since, X-Amz-Acl, X-Amz-Tagging, X-Amz-Server-Side-Encryption, X-Amz-Server-Side-Encryption-Customer-Algorithm, X-Amz-Server-Side-Encryption-Customer-Key, X-Amz-Server-Side-Encryption-Customer-Key-MD5, X-Amz-Copy-Source-Server-Side-Encryption-Customer-Algorithm, X-Amz-Copy-Source-Server-Side-Encryption-Customer-Key, X-Amz-Copy-Source-Server-Side-Encryption-Customer-Key-MD5, X-Amz-Storage-Class, Content-MD5, Content-Disposition, Content-Encoding, Content-Language, Cache-Control, Expires, Range, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since, X-Amz-Meta-*',
      'Access-Control-Expose-Headers': 'ETag, Content-Length, Content-Range, Last-Modified, Accept-Ranges, Content-Disposition, Content-Encoding, x-amz-request-id, x-amz-id-2, x-amz-error-code, x-amz-error-message, x-amz-mp-parts-count, x-amz-bucket-region, x-amz-server-side-encryption, x-amz-server-side-encryption-customer-algorithm, x-amz-server-side-encryption-customer-key-MD5, x-amz-meta-*, Retry-After, Location, Date',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  newHeaders.set('Access-Control-Expose-Headers', 'ETag, Content-Length, Content-Range, Last-Modified, Accept-Ranges, Content-Disposition, Content-Encoding, x-amz-request-id, x-amz-id-2, x-amz-error-code, x-amz-error-message, x-amz-mp-parts-count, x-amz-bucket-region, x-amz-server-side-encryption, x-amz-server-side-encryption-customer-algorithm, x-amz-server-side-encryption-customer-key-MD5, x-amz-meta-*, Retry-After, Location, Date');
  // S3 includes Date in all responses; AWS SDKs use it for clock skew detection
  if (!newHeaders.has('Date')) {
    newHeaders.set('Date', new Date().toUTCString());
  }
  if (!newHeaders.has('x-amz-request-id')) {
    newHeaders.set('x-amz-request-id', generateRequestId());
  }
  if (!newHeaders.has('x-amz-id-2')) {
    newHeaders.set('x-amz-id-2', generateRequestId() + generateRequestId());
  }
  // S3 returns Server: AmazonS3 on all responses; some SDKs/tools check this header
  if (!newHeaders.has('Server')) {
    newHeaders.set('Server', 'AmazonS3');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

