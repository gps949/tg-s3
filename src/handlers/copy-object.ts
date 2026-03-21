import type { Env, S3Request } from '../types';
import { MetadataStore } from '../storage/metadata';
import { TelegramClient } from '../telegram/client';
import { downloadFromTelegram } from '../telegram/download';
import { uploadToTelegram } from '../telegram/upload';
import { computeEtag } from '../utils/crypto';
import { extractUserMetadata, extractSystemMetadata, etagMatches } from '../utils/headers';
import { copyObjectXml, xmlResponse, errorResponse } from '../xml/builder';
import { purgeCdnCache, purgeR2Cache } from './get-object';
import { deleteDerivatives, deleteChunks } from './delete-object';
import {
  parseSseCHeaders, validateKeyMd5, encrypt, decrypt,
  isEncrypted, getStoredKeyMd5, addSseMetadata, SseCError,
  SSE_HEADERS, SSE_COPY_HEADERS,
} from '../utils/sse';

export async function handleCopyObject(s3: S3Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const store = new MetadataStore(env);

  // Parse x-amz-copy-source header (strip ?versionId= if present, we don't support versioning)
  const copySource = s3.headers.get('x-amz-copy-source') || '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(copySource.split('?')[0]);
  } catch {
    return errorResponse(400, 'InvalidArgument', 'Invalid copy source encoding.');
  }
  const trimmed = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx < 0) return errorResponse(400, 'InvalidArgument', 'Invalid copy source.');

  const srcBucket = trimmed.slice(0, slashIdx);
  const srcKey = trimmed.slice(slashIdx + 1);

  // x-amz-metadata-directive: COPY (default) or REPLACE
  const metadataDirective = (s3.headers.get('x-amz-metadata-directive') || 'COPY').toUpperCase();
  if (metadataDirective !== 'COPY' && metadataDirective !== 'REPLACE') {
    return errorResponse(400, 'InvalidArgument', `Unknown metadata directive '${metadataDirective}'.`);
  }

  // S3 rejects copy-to-self with COPY directive (must use REPLACE to modify metadata)
  if (srcBucket === s3.bucket && srcKey === s3.key && metadataDirective !== 'REPLACE') {
    return errorResponse(400, 'InvalidRequest',
      'This copy request is illegal because it is trying to copy an object to itself without changing the object\'s metadata, storage class, website redirect location or encryption attributes.');
  }

  // Check source bucket exists
  const srcBucketRow = await store.getBucket(srcBucket);
  if (!srcBucketRow) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', srcBucket);

  // Get source object
  const srcObj = await store.getObject(srcBucket, srcKey);
  if (!srcObj) return errorResponse(404, 'NoSuchKey', 'The specified key does not exist.', `/${srcBucket}/${srcKey}`);

  // Conditional copy headers (S3 precedence: if-match overrides if-unmodified-since,
  // if-none-match overrides if-modified-since)
  const copyIfMatch = s3.headers.get('x-amz-copy-source-if-match');
  if (copyIfMatch && !etagMatches(copyIfMatch, srcObj.etag, true)) {
    return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
  }
  if (!copyIfMatch) {
    const copyIfUnmodifiedSince = s3.headers.get('x-amz-copy-source-if-unmodified-since');
    if (copyIfUnmodifiedSince && new Date(srcObj.last_modified).getTime() > new Date(copyIfUnmodifiedSince).getTime()) {
      return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
    }
  }
  const copyIfNoneMatch = s3.headers.get('x-amz-copy-source-if-none-match');
  if (copyIfNoneMatch && etagMatches(copyIfNoneMatch, srcObj.etag)) {
    return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
  }
  if (!copyIfNoneMatch) {
    const copyIfModifiedSince = s3.headers.get('x-amz-copy-source-if-modified-since');
    if (copyIfModifiedSince && new Date(srcObj.last_modified).getTime() <= new Date(copyIfModifiedSince).getTime()) {
      return errorResponse(412, 'PreconditionFailed', 'At least one of the pre-conditions you specified did not hold.');
    }
  }

  // SSE-C: parse source and destination encryption headers
  let srcSse: ReturnType<typeof parseSseCHeaders> = null;
  let destSse: ReturnType<typeof parseSseCHeaders> = null;
  try {
    srcSse = parseSseCHeaders(s3.headers, SSE_COPY_HEADERS);
    if (srcSse) await validateKeyMd5(srcSse);
    destSse = parseSseCHeaders(s3.headers, SSE_HEADERS);
    if (destSse) await validateKeyMd5(destSse);
  } catch (e) {
    if (e instanceof SseCError) return errorResponse(400, 'InvalidArgument', e.message);
    throw e;
  }

  // If source is encrypted, require source SSE-C headers
  const srcEncrypted = isEncrypted(srcObj.system_metadata);
  if (srcEncrypted && !srcSse) {
    return errorResponse(400, 'InvalidRequest', 'The source object was stored using SSE-C. You must provide the source encryption key headers.');
  }
  if (srcEncrypted && srcSse) {
    const storedMd5 = getStoredKeyMd5(srcObj.system_metadata);
    if (storedMd5 && srcSse.keyMd5 !== storedMd5) {
      return errorResponse(403, 'AccessDenied', 'The provided source encryption key does not match.');
    }
  }

  // Check destination bucket exists
  const destBucket = await store.getBucket(s3.bucket);
  if (!destBucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  // Determine if re-encryption is needed (source encrypted or dest wants encryption)
  const needsReEncrypt = srcEncrypted || !!destSse;

  let tgChatId = srcObj.tg_chat_id;
  let tgMessageId = srcObj.tg_message_id;
  let tgFileId = srcObj.tg_file_id;

  if (needsReEncrypt && srcObj.size > 0) {
    // Must download, decrypt source, re-encrypt for dest, re-upload
    const tgRes = await downloadFromTelegram(srcObj.tg_file_id, env);
    let data = await tgRes.arrayBuffer();
    if (srcEncrypted && srcSse) {
      data = await decrypt(data, srcSse.keyBase64);
    }
    if (destSse) {
      data = await encrypt(data, destSse.keyBase64);
    }
    const result = await uploadToTelegram(data, destBucket.tg_chat_id, s3.key, srcObj.content_type, env, destBucket.tg_topic_id);
    tgChatId = result.tgChatId;
    tgMessageId = result.tgMessageId;
    tgFileId = result.tgFileId;
  } else if (srcObj.size > 0 && srcBucketRow && destBucket.tg_chat_id !== srcBucketRow.tg_chat_id) {
    // No encryption change, different bucket: forward/re-send TG message
    const tg = new TelegramClient(env);
    if (srcObj.tg_message_id === 0) {
      const sendRes = await tg.sendDocumentByFileId(destBucket.tg_chat_id, srcObj.tg_file_id, destBucket.tg_topic_id);
      tgChatId = destBucket.tg_chat_id;
      tgMessageId = sendRes.result.message_id;
      if (sendRes.result.document) tgFileId = sendRes.result.document.file_id;
    } else {
      const fwdRes = await tg.forwardMessage(srcObj.tg_chat_id, destBucket.tg_chat_id, srcObj.tg_message_id, destBucket.tg_topic_id);
      tgChatId = destBucket.tg_chat_id;
      tgMessageId = fwdRes.result.message_id;
      if (fwdRes.result.document) tgFileId = fwdRes.result.document.file_id;
    }
  } else if (srcObj.size === 0) {
    tgChatId = destBucket.tg_chat_id;
  }

  let userMetadata: Record<string, string> | undefined;
  let systemMetadata: Record<string, string> | undefined;
  let contentType = srcObj.content_type;

  if (metadataDirective === 'REPLACE') {
    // Use metadata and content-type from the PUT request instead of source
    userMetadata = extractUserMetadata(s3.headers);
    if (Object.keys(userMetadata).length === 0) userMetadata = undefined;
    systemMetadata = extractSystemMetadata(s3.headers);
    contentType = s3.headers.get('content-type') || 'application/octet-stream';
  } else {
    // COPY: preserve source metadata
    if (srcObj.user_metadata) {
      try { userMetadata = JSON.parse(srcObj.user_metadata); } catch { /* ignore corrupt */ }
    }
    if (srcObj.system_metadata) {
      try { systemMetadata = JSON.parse(srcObj.system_metadata); } catch { /* ignore corrupt */ }
    }
  }

  // Add destination SSE-C metadata (or strip source SSE metadata if no dest encryption)
  if (destSse) {
    systemMetadata = addSseMetadata(systemMetadata || {}, destSse);
  } else if (srcEncrypted && systemMetadata) {
    // Source was encrypted but dest is not: remove SSE metadata
    delete systemMetadata._sse;
    delete systemMetadata._sse_key_md5;
    if (Object.keys(systemMetadata).length === 0) systemMetadata = undefined;
  }

  // Check for existing object at destination (for old TG message cleanup)
  const oldObj = await store.getObject(s3.bucket, s3.key);

  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  await store.putObject({
    bucket: s3.bucket,
    key: s3.key,
    size: srcObj.size,
    etag: srcObj.etag,
    contentType,
    tgChatId,
    tgMessageId,
    tgFileId,
    tgFileUniqueId: srcObj.tg_file_unique_id,
    userMetadata,
    systemMetadata,
  }, oldObj);

  // Async cleanup: delete old TG message + stale derivatives if destination was overwritten
  if (oldObj && oldObj.tg_file_id !== '__zero__' && oldObj.tg_file_id !== tgFileId) {
    const tg = new TelegramClient(env);
    ctx.waitUntil(tg.deleteMessage(oldObj.tg_chat_id, oldObj.tg_message_id).catch(() => {}));
  }
  // Only clean derivatives/chunks if the underlying file changed (not metadata-only update)
  if (oldObj && oldObj.tg_file_id !== tgFileId) {
    ctx.waitUntil(deleteDerivatives(s3.bucket, s3.key, env, store));
    ctx.waitUntil(deleteChunks(s3.bucket, s3.key, env, store));
  }

  // Purge CDN + R2 cache for destination key
  ctx.waitUntil(purgeCdnCache(s3.url.origin, s3.bucket, s3.key));
  ctx.waitUntil(purgeR2Cache(env, s3.bucket, s3.key));

  const copyResp = xmlResponse(copyObjectXml(srcObj.etag, now));
  if (destSse) {
    copyResp.headers.set('x-amz-server-side-encryption-customer-algorithm', 'AES256');
    copyResp.headers.set('x-amz-server-side-encryption-customer-key-MD5', destSse.keyMd5);
  }
  return copyResp;
}
