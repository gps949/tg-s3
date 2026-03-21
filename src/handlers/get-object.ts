import type { Env, S3Request, ObjectRow, BucketRow } from '../types';
import { MetadataStore } from '../storage/metadata';
import { downloadFromTelegram } from '../telegram/download';
import { uploadToTelegram } from '../telegram/upload';
import { computeEtag } from '../utils/crypto';
import { parseRange, formatHttpDate, isImageContentType, etagMatches } from '../utils/headers';
import { errorResponse } from '../xml/builder';
import { BOT_API_GETFILE_LIMIT, R2_CACHE_MIN_SIZE, R2_CACHE_MAX_SIZE } from '../constants';
import { VpsClient } from '../media/vps-client';
import { parseSseCHeaders, validateKeyMd5, decrypt, isEncrypted, getStoredKeyMd5, addSseResponseHeaders, SseCError, isEncryptedS3, decryptS3, addSseS3ResponseHeaders } from '../utils/sse';

const MAX_DIRECT_DOWNLOAD = BOT_API_GETFILE_LIMIT;

function isR2Cacheable(size: number): boolean {
  return size >= R2_CACHE_MIN_SIZE && size <= R2_CACHE_MAX_SIZE;
}

// CDN Cache: build a cache key URL for a given object
function cacheKeyUrl(baseUrl: string, bucket: string, key: string): string {
  return `${baseUrl}/__cache__/${bucket}/${encodeURIComponent(key)}`;
}

// CDN Cache: purge cached response for an object
export async function purgeCdnCache(baseUrl: string, bucket: string, key: string): Promise<void> {
  try {
    const cache = caches.default;
    const url = cacheKeyUrl(baseUrl, bucket, key);
    await cache.delete(new Request(url));
  } catch { /* best effort */ }
}

// R2 Cache: key for a cached object
export function r2CacheKey(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

// R2 Cache: parse bucket and key from R2 cache key
export function parseR2CacheKey(r2Key: string): { bucket: string; key: string } | null {
  const slashIdx = r2Key.indexOf('/');
  if (slashIdx < 0) return null;
  return { bucket: r2Key.slice(0, slashIdx), key: r2Key.slice(slashIdx + 1) };
}

// R2 Cache: purge cached object
export async function purgeR2Cache(env: Env, bucket: string, key: string): Promise<void> {
  if (!env.CACHE) return;
  try {
    await env.CACHE.delete(r2CacheKey(bucket, key));
  } catch { /* best effort */ }
}

// R2 Cache: clean orphaned entries (D1 source deleted or ETag mismatch)
export async function cleanR2Cache(env: Env, store: MetadataStore, limit = 20): Promise<number> {
  if (!env.CACHE) return 0;
  let cleaned = 0;
  try {
    const listed = await env.CACHE.list({ limit });
    for (const obj of listed.objects) {
      const parsed = parseR2CacheKey(obj.key);
      if (!parsed) { await env.CACHE.delete(obj.key); cleaned++; continue; }
      const dbObj = await store.getObject(parsed.bucket, parsed.key);
      if (!dbObj || dbObj.etag !== obj.customMetadata?.etag) {
        await env.CACHE.delete(obj.key);
        cleaned++;
      }
    }
  } catch { /* R2 unavailable */ }
  return cleaned;
}

export async function handleGetObject(s3: S3Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const store = new MetadataStore(env);
  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
  const obj = await store.getObject(s3.bucket, s3.key);
  if (!obj) return errorResponse(404, 'NoSuchKey', 'The specified key does not exist.', `/${s3.bucket}/${s3.key}`);

  // SSE-C: if object is encrypted with customer key, require matching SSE-C headers
  const objEncrypted = isEncrypted(obj.system_metadata);
  let sseParams: ReturnType<typeof parseSseCHeaders> = null;
  if (objEncrypted) {
    try {
      sseParams = parseSseCHeaders(s3.headers);
      if (!sseParams) {
        return errorResponse(400, 'InvalidRequest', 'The object was stored using SSE-C. You must provide the encryption key headers.');
      }
      await validateKeyMd5(sseParams);
      const storedMd5 = getStoredKeyMd5(obj.system_metadata);
      if (storedMd5 && sseParams.keyMd5 !== storedMd5) {
        return errorResponse(403, 'AccessDenied', 'The provided encryption key does not match the key used to encrypt the object.');
      }
    } catch (e) {
      if (e instanceof SseCError) return errorResponse(400, 'InvalidArgument', e.message);
      throw e;
    }
  }

  // SSE-S3: object encrypted with server-managed key (auto-decrypt)
  const objEncryptedS3 = isEncryptedS3(obj.system_metadata);

  // Conditional: If-Match (412 if ETag doesn't match)
  const ifMatch = s3.headers.get('if-match');
  if (ifMatch && !etagMatches(ifMatch, obj.etag, true)) {
    return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
  }

  // Conditional: If-Unmodified-Since (skip if If-Match present)
  if (!ifMatch) {
    const ifUnmodified = s3.headers.get('if-unmodified-since');
    if (ifUnmodified && new Date(obj.last_modified).getTime() > new Date(ifUnmodified).getTime()) {
      return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
    }
  }

  // Build response headers early so 304 responses include user metadata
  const headers = buildResponseHeaders(obj, s3.query);
  // Add SSE response headers
  if (objEncrypted) addSseResponseHeaders(headers, obj.system_metadata);
  if (objEncryptedS3) addSseS3ResponseHeaders(headers, obj.system_metadata);

  // Conditional: If-None-Match (304 if ETag matches)
  const ifNoneMatch = s3.headers.get('if-none-match');
  if (ifNoneMatch && etagMatches(ifNoneMatch, obj.etag)) {
    return new Response(null, { status: 304, headers: strip304Headers(headers) });
  }

  // Conditional: If-Modified-Since (304 if not modified, skip if If-None-Match present)
  if (!ifNoneMatch) {
    const ifModified = s3.headers.get('if-modified-since');
    if (ifModified && new Date(obj.last_modified).getTime() <= new Date(ifModified).getTime()) {
      return new Response(null, { status: 304, headers: strip304Headers(headers) });
    }
  }

  // Handle GetObject with partNumber (return a specific part of a multipart-uploaded object)
  const partNumberParam = s3.query.get('partNumber');
  if (partNumberParam) {
    return handlePartNumberGet(s3, obj, headers, parseInt(partNumberParam, 10), env);
  }

  // Auto-convert HEIC/HEIF to web-compatible format (browsers can't display HEIC natively)
  const isHeic = obj.content_type === 'image/heic' || obj.content_type === 'image/heif';
  if (isHeic && !s3.query.has('original') && !s3.query.get('fmt') && env.VPS_URL) {
    s3.query = new URLSearchParams(s3.query);
    s3.query.set('fmt', 'auto');
  }

  // Handle image variant requests (w=, fmt=, q=)
  const width = s3.query.get('w');
  let format = s3.query.get('fmt');
  const quality = s3.query.get('q');
  const fmtAuto = format === 'auto';
  if ((width || format || quality) && isImageContentType(obj.content_type) && !obj.content_type.includes('svg')) {
    // Resolve fmt=auto from Accept header (AVIF > WebP > JPEG)
    if (fmtAuto) {
      const accept = s3.headers.get('accept') || '';
      if (accept.includes('image/avif')) format = 'avif';
      else if (accept.includes('image/webp')) format = 'webp';
      else format = 'jpeg';
    }
    const ALLOWED_FORMATS = ['webp', 'jpeg', 'jpg', 'png', 'avif'];
    if (width && (!/^\d+$/.test(width) || +width < 1 || +width > 4096)) {
      return errorResponse(400, 'InvalidArgument', 'w must be an integer between 1 and 4096.');
    }
    if (format && !ALLOWED_FORMATS.includes(format)) {
      return errorResponse(400, 'InvalidArgument', `fmt must be one of: auto, ${ALLOWED_FORMATS.join(', ')}.`);
    }
    if (quality && (!/^\d+$/.test(quality) || +quality < 1 || +quality > 100)) {
      return errorResponse(400, 'InvalidArgument', 'q must be an integer between 1 and 100.');
    }
    return handleImageVariant(s3, obj, env, store, bucket, width, format, quality, fmtAuto, ctx);
  }

  const rangeHeader = s3.headers.get('range');

  // 0-byte objects: reject Range requests (416), otherwise return empty body
  if (obj.size === 0) {
    if (rangeHeader) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': 'bytes */0' },
      });
    }
    return new Response(new ArrayBuffer(0), {
      status: 200,
      headers: { ...headers, 'Content-Length': '0' },
    });
  }

  // Skip CDN/R2 cache for SSE-C encrypted objects (cache doesn't know the key)
  // CDN Cache: try serving from CF edge cache for non-Range full GETs of <=20MB files
  if (!objEncrypted && !rangeHeader && obj.size > 0 && obj.size <= MAX_DIRECT_DOWNLOAD) {
    const cache = caches.default;
    const cacheUrl = cacheKeyUrl(s3.url.origin, s3.bucket, s3.key);
    const cacheReq = new Request(cacheUrl);
    const cached = await cache.match(cacheReq);
    if (cached) {
      const cachedEtag = cached.headers.get('ETag');
      if (cachedEtag === obj.etag) {
        const mergedHeaders: Record<string, string> = { ...headers, 'Content-Length': obj.size.toString(), 'X-Cache': 'HIT' };
        return new Response(cached.body, { status: 200, headers: mergedHeaders });
      }
      // Stale cache: ETag mismatch, purge
      ctx?.waitUntil(cache.delete(cacheReq));
    }
  }

  // R2 Cache: try serving from R2 persistent cache (survives CDN eviction)
  if (!objEncrypted && env.CACHE && !rangeHeader && isR2Cacheable(obj.size)) {
    try {
      const r2Obj = await env.CACHE.get(r2CacheKey(s3.bucket, s3.key));
      if (r2Obj && r2Obj.customMetadata?.etag === obj.etag) {
        const r2Data = await r2Obj.arrayBuffer();
        const mergedHeaders: Record<string, string> = {
          ...headers, 'Content-Length': obj.size.toString(), 'X-Cache': 'R2-HIT',
        };
        // Also populate CDN cache from R2 hit
        if (ctx) {
          const cacheUrl = cacheKeyUrl(s3.url.origin, s3.bucket, s3.key);
          ctx.waitUntil(caches.default.put(new Request(cacheUrl), new Response(r2Data, { status: 200, headers: mergedHeaders }).clone()).catch(e => console.error('CDN cache put failed:', e)));
        }
        return new Response(r2Data, { status: 200, headers: mergedHeaders });
      }
      // Stale R2 cache: ETag mismatch, purge
      if (r2Obj) ctx?.waitUntil(env.CACHE.delete(r2CacheKey(s3.bucket, s3.key)));
    } catch { /* R2 unavailable, continue to TG */ }
  }

  // >20MB: must go through VPS proxy (Bot API getFile can't handle it)
  if (obj.size > MAX_DIRECT_DOWNLOAD) {
    if (!env.VPS_URL) {
      return errorResponse(503, 'ServiceUnavailable', 'File exceeds 20MB and requires VPS proxy which is not configured.');
    }
    return downloadViaVps(obj, headers, rangeHeader, env);
  }

  // Check range satisfiability before downloading
  const range = rangeHeader ? parseRange(rangeHeader, obj.size) : null;
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${obj.size}` },
    });
  }

  // <=20MB: download from TG directly (Range by slicing, acceptable for small files)
  const tgRes = await downloadFromTelegram(obj.tg_file_id, env);
  let data = await tgRes.arrayBuffer();

  // Decrypt after download (SSE-C or SSE-S3)
  if (objEncrypted && sseParams) {
    data = await decrypt(data, sseParams.keyBase64);
  } else if (objEncryptedS3 && env.SSE_MASTER_KEY) {
    data = await decryptS3(data, env.SSE_MASTER_KEY);
  }

  if (range) {
    const sliced = data.slice(range.start, range.end + 1);
    return new Response(sliced, {
      status: 206,
      headers: {
        ...headers,
        'Content-Length': sliced.byteLength.toString(),
        'Content-Range': `bytes ${range.start}-${range.end}/${obj.size}`,
      },
    });
  }

  // Cache store: CDN + R2 for full non-Range responses (skip for encrypted objects)
  const response = new Response(data, {
    status: 200,
    headers: { ...headers, 'Content-Length': obj.size.toString(), 'X-Cache': objEncrypted ? 'SSE-C' : objEncryptedS3 ? 'SSE-S3' : 'MISS' },
  });
  if (ctx && !objEncrypted) {
    const cacheUrl = cacheKeyUrl(s3.url.origin, s3.bucket, s3.key);
    ctx.waitUntil(caches.default.put(new Request(cacheUrl), response.clone()).catch(e => console.error('CDN cache put failed:', e)));
    // Store to R2 persistent cache (only for files within cacheable size range)
    if (env.CACHE && isR2Cacheable(obj.size)) {
      ctx.waitUntil(env.CACHE.put(r2CacheKey(s3.bucket, s3.key), data, {
        customMetadata: { etag: obj.etag },
        httpMetadata: { contentType: obj.content_type },
      }).catch(e => console.error('R2 cache put failed:', e)));
    }
  }
  return response;
}

async function handlePartNumberGet(
  s3: S3Request, obj: ObjectRow, headers: Record<string, string>,
  partNumber: number, env: Env,
): Promise<Response> {
  // Extract part sizes from system metadata (stored during CompleteMultipartUpload)
  let partSizes: number[] | undefined;
  if (obj.system_metadata) {
    try {
      const sysMeta = JSON.parse(obj.system_metadata);
      if (sysMeta._mp_part_sizes) {
        partSizes = JSON.parse(sysMeta._mp_part_sizes);
      }
    } catch { /* ignore */ }
  }

  if (!partSizes || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > partSizes.length) {
    return errorResponse(400, 'InvalidPartNumber', 'The requested partNumber is not valid.');
  }

  // Calculate byte range for this part
  let start = 0;
  for (let i = 0; i < partNumber - 1; i++) start += partSizes[i];
  const partSize = partSizes[partNumber - 1];
  const end = start + partSize - 1;

  // Download and serve the part range
  let data: ArrayBuffer;
  if (obj.size <= MAX_DIRECT_DOWNLOAD) {
    const tgRes = await downloadFromTelegram(obj.tg_file_id, env);
    const full = await tgRes.arrayBuffer();
    data = full.slice(start, end + 1);
  } else if (env.VPS_URL) {
    try {
      const vps = new VpsClient(env);
      const vpsRes = await vps.proxyRange(obj.tg_file_id, start, end);
      data = await vpsRes.arrayBuffer();
    } catch {
      return errorResponse(503, 'ServiceUnavailable', 'Storage backend temporarily unavailable.');
    }
  } else {
    return errorResponse(400, 'InvalidRequest', 'Object exceeds direct download limit.');
  }

  return new Response(data, {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': partSize.toString(),
      'Content-Range': `bytes ${start}-${end}/${obj.size}`,
      'x-amz-mp-parts-count': partSizes.length.toString(),
    },
  });
}

async function downloadViaVps(
  obj: ObjectRow, headers: Record<string, string>,
  rangeHeader: string | null, env: Env,
): Promise<Response> {
  const vps = new VpsClient(env);

  if (rangeHeader) {
    // Forward Range request to VPS
    const range = parseRange(rangeHeader, obj.size);
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${obj.size}` },
      });
    }
    if (range) {
      try {
        const vpsRes = await vps.proxyRange(obj.tg_file_id, range.start, range.end);
        return new Response(vpsRes.body, {
          status: 206,
          headers: {
            ...headers,
            'Content-Length': (range.end - range.start + 1).toString(),
            'Content-Range': `bytes ${range.start}-${range.end}/${obj.size}`,
          },
        });
      } catch {
        return errorResponse(503, 'ServiceUnavailable', 'Storage backend temporarily unavailable.');
      }
    }
  }

  // Full download via VPS proxy
  try {
    const vpsRes = await vps.proxyGet(obj.tg_file_id);
    return new Response(vpsRes.body, {
      status: 200,
      headers: { ...headers, 'Content-Length': obj.size.toString() },
    });
  } catch {
    return errorResponse(503, 'ServiceUnavailable', 'Storage backend temporarily unavailable.');
  }
}

// Header name mapping: system_metadata key → HTTP header, response-* override key
const SYS_META_HEADERS: Array<[string, string, string]> = [
  ['content-disposition', 'Content-Disposition', 'response-content-disposition'],
  ['content-encoding', 'Content-Encoding', 'response-content-encoding'],
  ['content-language', 'Content-Language', 'response-content-language'],
  ['cache-control', 'Cache-Control', 'response-cache-control'],
  ['expires', 'Expires', 'response-expires'],
];

function buildResponseHeaders(obj: ObjectRow, query?: URLSearchParams): Record<string, string> {
  const h: Record<string, string> = {
    'ETag': obj.etag,
    'Content-Type': query?.get('response-content-type') || obj.content_type,
    'Content-Length': obj.size.toString(),
    'Last-Modified': formatHttpDate(obj.last_modified),
    'Accept-Ranges': 'bytes',
  };

  // Apply stored system metadata as defaults
  let sysMeta: Record<string, string> = {};
  if (obj.system_metadata) {
    try { sysMeta = JSON.parse(obj.system_metadata); } catch { /* ignore */ }
  }

  // S3 response-* query parameters override stored system metadata
  for (const [metaKey, headerName, overrideParam] of SYS_META_HEADERS) {
    const override = query?.get(overrideParam);
    const stored = sysMeta[metaKey];
    if (override) {
      h[headerName] = override;
    } else if (stored) {
      h[headerName] = stored;
    }
  }

  // Default Cache-Control if not set by stored metadata or override
  if (!h['Cache-Control']) {
    h['Cache-Control'] = isImageContentType(obj.content_type)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=86400';
  }

  if (!h['Content-Disposition'] && isImageContentType(obj.content_type)) {
    h['Content-Disposition'] = 'inline';
    h['Access-Control-Allow-Origin'] = '*';
  }

  // S3 returns x-amz-mp-parts-count for objects uploaded via multipart
  const mpMatch = obj.etag.match(/-(\d+)"$/);
  if (mpMatch) {
    h['x-amz-mp-parts-count'] = mpMatch[1];
  }

  if (obj.user_metadata) {
    try {
      const meta = JSON.parse(obj.user_metadata) as Record<string, string>;
      for (const [k, v] of Object.entries(meta)) {
        h[`x-amz-meta-${k}`] = v;
      }
    } catch { /* ignore */ }
  }

  return h;
}

// RFC 7232 §4.1: 304 responses MUST include ETag, Cache-Control, Expires, Vary, Last-Modified
// but SHOULD NOT include representation headers like Content-Type, Content-Length, Content-Encoding.
// AWS S3 304 responses omit these headers.
const HEADERS_TO_STRIP_304 = ['Content-Type', 'Content-Length', 'Content-Encoding', 'Content-Language', 'Content-Disposition', 'Content-Range', 'Accept-Ranges'];

function strip304Headers(h: Record<string, string>): Record<string, string> {
  const out = { ...h };
  for (const name of HEADERS_TO_STRIP_304) delete out[name];
  return out;
}

async function handleImageVariant(
  s3: S3Request, obj: ObjectRow,
  env: Env, store: MetadataStore, bucket: BucketRow,
  width: string | null, format: string | null, quality: string | null, fmtAuto: boolean, ctx?: ExecutionContext,
): Promise<Response> {
  const qualitySuffix = quality ? `_q${quality}` : '';
  const variantKey = `${obj.key}._derivatives/w${width || 'orig'}${qualitySuffix}_${format || 'original'}`;

  // Vary: Accept ensures CDN caches different fmt=auto results per browser capability
  const variantHeaders = (ct: string, size?: number): Record<string, string> => {
    const h: Record<string, string> = {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    };
    if (size !== undefined) h['Content-Length'] = size.toString();
    if (fmtAuto) h['Vary'] = 'Accept';
    return h;
  };

  // Check D1 for cached variant
  const cached = await store.getObject(s3.bucket, variantKey);
  if (cached) {
    const tgRes = await downloadFromTelegram(cached.tg_file_id, env);
    return new Response(tgRes.body, { headers: variantHeaders(cached.content_type, cached.size) });
  }

  if (!env.VPS_URL) {
    // No VPS: return original
    const tgRes = await downloadFromTelegram(obj.tg_file_id, env);
    return new Response(tgRes.body, {
      headers: { 'Content-Type': obj.content_type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Call VPS to process variant
  const vps = new VpsClient(env);
  let vpsRes: Response;
  try {
    vpsRes = await vps.imageResize(obj.tg_file_id, width, format, quality);
  } catch {
    const tgRes = await downloadFromTelegram(obj.tg_file_id, env);
    return new Response(tgRes.body, {
      headers: { 'Content-Type': obj.content_type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Cache the variant back to TG + D1 (async, don't block response)
  const variantData = await vpsRes.arrayBuffer();
  const variantCt = vpsRes.headers.get('content-type') || 'image/jpeg';

  // Cache variant back to TG + D1 asynchronously
  {
    const cacheVariant = (async () => {
      try {
        const result = await uploadToTelegram(variantData, bucket.tg_chat_id, variantKey.split('/').pop()!, variantCt, env, bucket.tg_topic_id);
        const etag = await computeEtag(variantData);
        await store.putObject({
          bucket: s3.bucket, key: variantKey, size: variantData.byteLength, etag,
          contentType: variantCt, tgChatId: result.tgChatId, tgMessageId: result.tgMessageId,
          tgFileId: result.tgFileId, tgFileUniqueId: result.tgFileUniqueId,
          derivedFrom: obj.key,
        });
      } catch { /* best effort, will be cached on next request */ }
    })();
    if (ctx) ctx.waitUntil(cacheVariant);
  }

  return new Response(variantData, { headers: variantHeaders(variantCt, variantData.byteLength) });
}
