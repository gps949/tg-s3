import type { Env, S3Request } from '../types';
import { MetadataStore } from '../storage/metadata';
import { TelegramClient } from '../telegram/client';
import { errorResponse } from '../xml/builder';
import { purgeCdnCache, purgeR2Cache } from './get-object';

export async function handleDeleteObject(s3: S3Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const store = new MetadataStore(env);
  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
  const obj = await store.deleteObject(s3.bucket, s3.key);

  // S3 returns 204 even if object doesn't exist
  if (obj) {
    ctx.waitUntil(cleanupDeletedObject(s3.bucket, s3.key, obj, s3.url.origin, env, store).catch(e => console.error('Cleanup failed:', e)));
  }

  return new Response(null, { status: 204 });
}

export async function handleDeleteObjects(s3: S3Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!s3.body) return errorResponse(400, 'MalformedXML', 'Request body is empty.');

  const store = new MetadataStore(env);
  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const bodyText = await new Response(s3.body).text();

  // S3 requires Content-MD5 for DeleteObjects to protect data integrity
  const contentMd5 = s3.headers.get('content-md5');
  if (!contentMd5) {
    return errorResponse(400, 'MissingContentMD5', 'Content-MD5 HTTP header is required for Delete Multiple Objects requests.');
  }
  const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(bodyText));
  const actualMd5 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  if (actualMd5 !== contentMd5) {
    return errorResponse(400, 'BadDigest', 'The Content-MD5 you specified did not match what we received.');
  }
  const { parseDeleteObjects } = await import('../xml/parser');
  const { keys, quiet } = parseDeleteObjects(bodyText);

  // S3 requires between 1 and 1000 objects
  if (keys.length === 0 || keys.length > 1000) {
    return errorResponse(400, 'MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema.');
  }

  const deleted: string[] = [];
  const errors: Array<{ key: string; code: string; message: string }> = [];

  for (const key of keys) {
    try {
      const obj = await store.deleteObject(s3.bucket, key);
      deleted.push(key);
      if (obj) {
        ctx.waitUntil(cleanupDeletedObject(s3.bucket, key, obj, s3.url.origin, env, store).catch(e => console.error('Cleanup failed:', e)));
      }
    } catch (e) {
      errors.push({ key, code: 'InternalError', message: (e as Error).message });
    }
  }

  const { deleteObjectsXml, xmlResponse } = await import('../xml/builder');
  // S3 Quiet mode: only return errors, suppress successful deletions
  return xmlResponse(deleteObjectsXml(quiet ? [] : deleted, errors));
}

/**
 * Full cleanup for a deleted object: TG message, derivatives, share tokens, CDN/R2 cache.
 * Used by S3 API delete, Bot delete, and Mini App delete to ensure consistent behavior.
 */
export async function cleanupDeletedObject(
  bucket: string, key: string, obj: { tg_chat_id: string; tg_message_id: number; tg_file_id: string },
  baseUrl: string, env: Env, store: MetadataStore,
): Promise<void> {
  const promises: Promise<void>[] = [];
  if (obj.tg_file_id !== '__zero__' && obj.tg_message_id !== 0) {
    promises.push(deleteTgMessage(obj.tg_chat_id, obj.tg_message_id, env));
  }
  promises.push(deleteDerivatives(bucket, key, env, store));
  promises.push(deleteChunks(bucket, key, env, store));
  promises.push(store.deleteShareTokensByObject(bucket, key).then(() => {}));
  promises.push(purgeCdnCache(baseUrl, bucket, key));
  promises.push(purgeR2Cache(env, bucket, key));
  await Promise.allSettled(promises);
}

async function deleteTgMessage(chatId: string, messageId: number, env: Env): Promise<void> {
  const tg = new TelegramClient(env);
  try {
    await tg.deleteMessage(chatId, messageId);
  } catch (e) { console.error(`deleteTgMessage(${chatId}, ${messageId}) failed:`, e); }
}

export async function deleteChunks(bucket: string, key: string, env: Env, store: MetadataStore): Promise<void> {
  try {
    const chunks = await store.deleteChunks(bucket, key);
    if (chunks.length > 0) {
      const tg = new TelegramClient(env);
      await Promise.allSettled(chunks.map(chunk =>
        tg.deleteMessage(chunk.tg_chat_id, chunk.tg_message_id).catch(e => console.error(`deleteChunks: deleteMessage(${chunk.tg_chat_id}, ${chunk.tg_message_id}) failed:`, e))
      ));
    }
  } catch (e) { console.error(`deleteChunks(${bucket}, ${key}) failed:`, e); }
}

export async function deleteDerivatives(bucket: string, key: string, env: Env, store: MetadataStore): Promise<void> {
  try {
    // Use derived_from index for efficient lookup instead of prefix scan
    const derivatives = await store.getObjectsByDerivedFrom(bucket, key);
    if (derivatives.length === 0) return;
    const tg = new TelegramClient(env);
    await Promise.allSettled(derivatives.map(async (obj) => {
      const deleted = await store.deleteObject(bucket, obj.key);
      if (deleted) {
        await tg.deleteMessage(deleted.tg_chat_id, deleted.tg_message_id).catch(e => console.error(`deleteDerivatives: deleteMessage(${deleted.tg_chat_id}, ${deleted.tg_message_id}) failed:`, e));
      }
    }));
  } catch (e) { console.error(`deleteDerivatives(${bucket}, ${key}) failed:`, e); }
}
