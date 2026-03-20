import type { Env, S3Request, ObjectRow } from '../types';
import { MetadataStore } from '../storage/metadata';
import { uploadToTelegram, RateLimitError, FileTooLargeError } from '../telegram/upload';
import { TelegramClient } from '../telegram/client';
import { computeEtag, sha256Hex } from '../utils/crypto';
import { extractUserMetadata, extractSystemMetadata } from '../utils/headers';
import { errorResponse } from '../xml/builder';
import { purgeCdnCache, purgeR2Cache } from './get-object';
import { deleteDerivatives, deleteChunks } from './delete-object';

export async function handlePutObject(s3: S3Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const store = new MetadataStore(env);

  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  // S3 allows 0-byte objects (directory markers, metadata-only)
  const body = await readBody(s3) ?? new ArrayBuffer(0);

  // Validate Content-MD5 if provided
  const contentMd5 = s3.headers.get('content-md5');
  if (contentMd5) {
    const digest = await crypto.subtle.digest('MD5', body);
    const actualMd5 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    if (actualMd5 !== contentMd5) {
      return errorResponse(400, 'BadDigest', 'The Content-MD5 you specified did not match what we received.');
    }
  }

  // Validate x-amz-content-sha256 if a real hash is provided (not UNSIGNED-PAYLOAD or STREAMING-*)
  const contentSha256 = s3.headers.get('x-amz-content-sha256');
  if (contentSha256 && contentSha256 !== 'UNSIGNED-PAYLOAD' && !contentSha256.startsWith('STREAMING-')) {
    const actualSha256 = await sha256Hex(body);
    if (actualSha256 !== contentSha256) {
      return errorResponse(400, 'XAmzContentSHA256Mismatch',
        'The provided \'x-amz-content-sha256\' header does not match what was computed.');
    }
  }

  const contentType = s3.headers.get('content-type') || 'application/octet-stream';
  const userMeta = extractUserMetadata(s3.headers);
  const sysMeta = extractSystemMetadata(s3.headers);
  const etag = computeEtag(body);

  // S3 conditional write (2024-08): If-None-Match: * prevents overwriting existing objects
  const ifNoneMatch = s3.headers.get('if-none-match');
  if (ifNoneMatch && ifNoneMatch.trim() === '*') {
    const existing = await store.getObject(s3.bucket, s3.key);
    if (existing) {
      return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
    }
  }

  // Save old object info BEFORE overwriting (for cleanup)
  const oldObj = ifNoneMatch?.trim() === '*' ? null : await store.getObject(s3.bucket, s3.key);

  // 0-byte objects: store metadata only, Telegram rejects empty documents
  if (body.byteLength === 0) {
    await store.putObject({
      bucket: s3.bucket, key: s3.key, size: 0, etag, contentType,
      tgChatId: bucket.tg_chat_id, tgMessageId: 0,
      tgFileId: '__zero__', tgFileUniqueId: '__zero__',
      userMetadata: Object.keys(userMeta).length > 0 ? userMeta : undefined,
      systemMetadata: sysMeta,
    }, oldObj);
    if (oldObj) ctx.waitUntil(cleanupOldObject(s3.bucket, s3.key, oldObj, env));
    ctx.waitUntil(purgeCdnCache(s3.url.origin, s3.bucket, s3.key));
    ctx.waitUntil(purgeR2Cache(env, s3.bucket, s3.key));
    const zeroHeaders: Record<string, string> = { 'ETag': etag };
    if (contentMd5) zeroHeaders['Content-MD5'] = contentMd5;
    return new Response(null, { status: 200, headers: zeroHeaders });
  }

  let result;
  try {
    result = await uploadToTelegram(body, bucket.tg_chat_id, s3.key, contentType, env, bucket.tg_topic_id);
  } catch (e) {
    if (e instanceof FileTooLargeError) {
      return errorResponse(400, 'EntityTooLarge', e.message);
    }
    if (e instanceof RateLimitError) {
      return errorResponse(503, 'SlowDown', 'Please reduce your request rate.', undefined, e.retryAfter);
    }
    throw e;
  }

  // Save metadata (pass oldObj to avoid redundant getObject query inside putObject)
  await store.putObject({
    bucket: s3.bucket, key: s3.key, size: body.byteLength, etag, contentType,
    tgChatId: result.tgChatId, tgMessageId: result.tgMessageId,
    tgFileId: result.tgFileId, tgFileUniqueId: result.tgFileUniqueId,
    userMetadata: Object.keys(userMeta).length > 0 ? userMeta : undefined,
    systemMetadata: sysMeta,
  }, oldObj);

  // Async cleanup old TG message + stale derivatives
  if (oldObj) {
    ctx.waitUntil(cleanupOldObject(s3.bucket, s3.key, oldObj, env));
  }

  // Purge CDN + R2 cache for this key
  ctx.waitUntil(purgeCdnCache(s3.url.origin, s3.bucket, s3.key));
  ctx.waitUntil(purgeR2Cache(env, s3.bucket, s3.key));

  // Auto-trigger media processing if VPS is available
  if (env.VPS_URL) {
    ctx.waitUntil(triggerMediaProcessing(s3.bucket, s3.key, result.tgFileId, contentType, env));
  }

  const putHeaders: Record<string, string> = { 'ETag': etag };
  if (contentMd5) putHeaders['Content-MD5'] = contentMd5;
  return new Response(null, { status: 200, headers: putHeaders });
}

async function triggerMediaProcessing(
  bucket: string, key: string, tgFileId: string, contentType: string, env: Env,
): Promise<void> {
  // Only trigger for images and videos
  const isImage = contentType.startsWith('image/') && !contentType.includes('svg');
  const isVideo = contentType.startsWith('video/');
  if (!isImage && !isVideo) return;

  // Skip derivative files
  if (key.includes('._derivatives/')) return;

  const jobType = isImage ? 'image_convert' : 'video_transcode';
  try {
    const { VpsClient } = await import('../media/vps-client');
    const vps = new VpsClient(env);
    await vps.submitJob({ bucket, key, tgFileId, jobType });
  } catch (e) { console.warn(`Media processing trigger failed for ${bucket}/${key}:`, e); }
}

export async function readBody(s3: S3Request): Promise<ArrayBuffer | null> {
  if (!s3.body) return null;

  // Detect AWS chunked transfer encoding (used by AWS SDK for streaming uploads)
  const contentSha = s3.headers.get('x-amz-content-sha256');
  if (contentSha === 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD') {
    return parseAwsChunkedBody(s3.body);
  }

  const reader = s3.body.getReader();
  const parts: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  if (parts.length === 0) return null;
  const total = parts.reduce((s, p) => s + p.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { buf.set(p, offset); offset += p.length; }
  return buf.buffer as ArrayBuffer;
}

/**
 * Parse AWS chunked transfer encoding format.
 * Format per chunk: "{hex_size};chunk-signature={sig}\r\n{data}\r\n"
 * Final chunk: "0;chunk-signature={sig}\r\n\r\n"
 */
async function parseAwsChunkedBody(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let buf = new Uint8Array(0);

  function append(data: Uint8Array) {
    const merged = new Uint8Array(buf.length + data.length);
    merged.set(buf);
    merged.set(data, buf.length);
    buf = merged;
  }

  async function fillUntil(minBytes: number): Promise<boolean> {
    while (buf.length < minBytes) {
      const { done, value } = await reader.read();
      if (done) return false;
      append(value);
    }
    return true;
  }

  function findCRLF(): number {
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
    }
    return -1;
  }

  while (true) {
    // Read until we find \r\n (end of chunk header line)
    let crlfIdx = findCRLF();
    while (crlfIdx < 0) {
      const { done, value } = await reader.read();
      if (done) break;
      append(value);
      crlfIdx = findCRLF();
    }
    if (crlfIdx < 0) break;

    // Parse header: "hex_size;chunk-signature=sig"
    const headerStr = new TextDecoder().decode(buf.subarray(0, crlfIdx));
    buf = buf.subarray(crlfIdx + 2);

    const semiIdx = headerStr.indexOf(';');
    const hexSize = (semiIdx >= 0 ? headerStr.slice(0, semiIdx) : headerStr).trim();
    const chunkSize = parseInt(hexSize, 16);

    if (isNaN(chunkSize) || chunkSize === 0) break;

    // Read exactly chunkSize bytes + trailing \r\n
    await fillUntil(chunkSize + 2);
    chunks.push(buf.slice(0, chunkSize));
    buf = buf.subarray(chunkSize + 2);
  }

  reader.releaseLock();

  const total = chunks.reduce((s, c) => s + c.length, 0);
  if (total === 0) return new ArrayBuffer(0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { result.set(c, offset); offset += c.length; }
  return result.buffer as ArrayBuffer;
}

async function cleanupOldObject(bucket: string, key: string, oldObj: ObjectRow, env: Env): Promise<void> {
  const promises: Promise<void>[] = [];
  // Delete old TG message
  if (oldObj.tg_file_id !== '__zero__' && oldObj.tg_message_id !== 0) {
    const tg = new TelegramClient(env);
    promises.push(tg.deleteMessage(oldObj.tg_chat_id, oldObj.tg_message_id).then(() => {}).catch(e => {
      console.warn(`Cleanup: failed to delete TG message ${oldObj.tg_message_id}:`, e);
    }));
  }
  // Delete stale derivatives (generated from old content) and orphaned chunks
  const store = new MetadataStore(env);
  promises.push(deleteDerivatives(bucket, key, env, store));
  promises.push(deleteChunks(bucket, key, env, store));
  await Promise.allSettled(promises);
}
