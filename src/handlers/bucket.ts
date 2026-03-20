import type { Env, S3Request } from '../types';
import { MetadataStore } from '../storage/metadata';
import { TelegramClient } from '../telegram/client';
import { listBucketsXml, xmlResponse, errorResponse } from '../xml/builder';

export async function handleListBuckets(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);
  const buckets = await store.listBuckets();
  return xmlResponse(listBucketsXml(buckets));
}

export async function handleCreateBucket(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);

  const existing = await store.getBucket(s3.bucket);
  // S3: CreateBucket is idempotent — returns 200 if bucket already exists and is owned by caller
  if (existing) return new Response(null, { status: 200, headers: { 'Location': `/${s3.bucket}` } });

  // Validate bucket name (S3 naming rules)
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(s3.bucket)
    || /\.\./.test(s3.bucket)       // no consecutive periods
    || /\.-|-\./.test(s3.bucket)    // no period adjacent to hyphen
    || /^\d+\.\d+\.\d+\.\d+$/.test(s3.bucket)  // must not be IP address format
    || s3.bucket.startsWith('xn--')             // reserved: IDN labels
    || s3.bucket.endsWith('-s3alias') || s3.bucket.endsWith('--ol-s3')  // reserved suffixes
  ) {
    return errorResponse(400, 'InvalidBucketName', 'The specified bucket is not valid.');
  }

  // Parse optional CreateBucketConfiguration XML body (some SDKs always send it)
  if (s3.body) {
    try {
      const bodyText = await new Response(s3.body).text();
      if (bodyText.trim()) {
        const locMatch = bodyText.match(/<LocationConstraint>([^<]+)<\/LocationConstraint>/);
        if (locMatch) {
          const requestedRegion = locMatch[1].trim();
          const ourRegion = env.S3_REGION || 'us-east-1';
          if (requestedRegion && requestedRegion !== ourRegion) {
            return errorResponse(400, 'InvalidLocationConstraint',
              `The specified location-constraint is not valid. This server only supports '${ourRegion}'.`);
          }
        }
      }
    } catch { /* ignore unparseable body */ }
  }

  const chatId = env.DEFAULT_CHAT_ID;
  if (!chatId) return errorResponse(500, 'InternalError', 'DEFAULT_CHAT_ID not configured.');

  // Auto-create a Forum Topic in the supergroup for bucket isolation.
  // DEFAULT_CHAT_ID should be a supergroup with Forum (Topics) enabled.
  // Each bucket gets its own topic; files are sent to that topic.
  const tg = new TelegramClient(env);
  let topicId: number | null = null;
  try {
    const topicRes = await tg.createForumTopic(chatId, s3.bucket);
    topicId = topicRes.result.message_thread_id;
  } catch (e) {
    // If forum topic creation fails (e.g. group doesn't have topics enabled),
    // fall back to sending to the general topic (no isolation).
    console.warn(`Forum topic creation failed for bucket '${s3.bucket}', falling back to general topic:`, e instanceof Error ? e.message : e);
  }

  const description = s3.headers.get('x-amz-meta-description') || undefined;
  await store.createBucket(s3.bucket, chatId, topicId, description);
  return new Response(null, { status: 200, headers: { 'Location': `/${s3.bucket}` } });
}

export async function handleDeleteBucket(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);

  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  // Check if bucket is empty
  const objects = await store.listObjects(s3.bucket, '', '', 1);
  if (objects.contents.length > 0) {
    return errorResponse(409, 'BucketNotEmpty', 'The bucket you tried to delete is not empty.', s3.bucket);
  }

  // Check for in-progress multipart uploads (S3 requires aborting them first)
  const uploads = await store.listMultipartUploads(s3.bucket, { maxUploads: 1 });
  if (uploads.uploads.length > 0) {
    return errorResponse(409, 'BucketNotEmpty', 'The bucket you tried to delete has in-progress multipart uploads.', s3.bucket);
  }

  // Delete the Forum Topic if it exists
  if (bucket.tg_topic_id) {
    const tg = new TelegramClient(env);
    try {
      await tg.deleteForumTopic(bucket.tg_chat_id, bucket.tg_topic_id);
    } catch { /* best effort - topic may already be deleted */ }
  }

  // Clean all share tokens for this bucket
  await store.deleteShareTokensByBucket(s3.bucket);

  await store.deleteBucket(s3.bucket);
  return new Response(null, { status: 204 });
}

export async function handleHeadBucket(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);
  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
  const headers: Record<string, string> = { 'x-amz-bucket-region': env.S3_REGION || 'us-east-1' };
  if (bucket.description) {
    headers['x-amz-meta-description'] = bucket.description;
  }
  return new Response(null, { status: 200, headers });
}

export async function handleGetBucketLocation(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);
  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
  const region = env.S3_REGION || 'us-east-1';
  // AWS S3: us-east-1 returns empty LocationConstraint; other regions include the value
  const body = region === 'us-east-1'
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`
    : `<?xml version="1.0" encoding="UTF-8"?>\n<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${region}</LocationConstraint>`;
  return xmlResponse(body);
}

export async function handleGetBucketVersioning(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);
  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
  // Versioning not supported - return empty (disabled) status
  return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?>\n<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`);
}
