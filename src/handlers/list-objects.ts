import type { Env, S3Request } from '../types';
import { MetadataStore } from '../storage/metadata';
import { listObjectsV2Xml, listObjectsV1Xml, xmlResponse, errorResponse } from '../xml/builder';
import { S3_MAX_KEYS_DEFAULT } from '../constants';

function clampInt(val: string | null, defaultVal: number, min: number, max: number): number {
  const n = parseInt(val || String(defaultVal), 10);
  if (isNaN(n)) return defaultVal;
  return Math.max(min, Math.min(n, max));
}

// S3 continuation tokens should be opaque; base64 encode to match real S3 behavior
function encodeToken(key: string): string {
  return btoa(encodeURIComponent(key));
}

function decodeToken(token: string): string {
  try {
    return decodeURIComponent(atob(token));
  } catch {
    // Fallback: treat as raw key for backward compatibility with old tokens
    return token;
  }
}

export async function handleListObjectsV2(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);

  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const prefix = s3.query.get('prefix') || '';
  const delimiter = s3.query.get('delimiter') || '';
  const maxKeys = clampInt(s3.query.get('max-keys'), S3_MAX_KEYS_DEFAULT, 0, S3_MAX_KEYS_DEFAULT);
  // S3 semantics: continuation-token takes precedence; start-after only used on first request
  const rawContinuationToken = s3.query.get('continuation-token') || undefined;
  const startAfter = s3.query.get('start-after') || undefined;
  // Decode opaque token back to raw key for DB query
  const cursor = rawContinuationToken ? decodeToken(rawContinuationToken) : startAfter || undefined;
  const rawEncodingType = s3.query.get('encoding-type') || undefined;
  // S3 only accepts encoding-type=url; reject other values
  if (rawEncodingType && rawEncodingType !== 'url') {
    return errorResponse(400, 'InvalidArgument', `Invalid encoding type. Only "url" is supported.`);
  }
  const encodingType = rawEncodingType;
  const fetchOwner = s3.query.get('fetch-owner') === 'true';

  const result = await store.listObjects(s3.bucket, prefix, delimiter, maxKeys, cursor);

  return xmlResponse(listObjectsV2Xml({
    bucket: s3.bucket,
    prefix,
    delimiter,
    maxKeys,
    startAfter: startAfter || '',
    // Echo back original opaque token, encode next token for opacity
    continuationToken: rawContinuationToken || '',
    contents: result.contents,
    commonPrefixes: result.commonPrefixes,
    isTruncated: result.isTruncated,
    nextToken: result.nextToken ? encodeToken(result.nextToken) : undefined,
    keyCount: result.contents.length + result.commonPrefixes.length,
    encodingType,
    fetchOwner,
  }));
}

export async function handleListObjects(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);

  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);

  const prefix = s3.query.get('prefix') || '';
  const delimiter = s3.query.get('delimiter') || '';
  const maxKeys = clampInt(s3.query.get('max-keys'), S3_MAX_KEYS_DEFAULT, 0, S3_MAX_KEYS_DEFAULT);
  const marker = s3.query.get('marker') || undefined;
  const rawEncodingType = s3.query.get('encoding-type') || undefined;
  if (rawEncodingType && rawEncodingType !== 'url') {
    return errorResponse(400, 'InvalidArgument', `Invalid encoding type. Only "url" is supported.`);
  }
  const encodingType = rawEncodingType;

  const result = await store.listObjects(s3.bucket, prefix, delimiter, maxKeys, marker);

  return xmlResponse(listObjectsV1Xml({
    bucket: s3.bucket,
    prefix,
    delimiter,
    maxKeys,
    marker: marker || '',
    contents: result.contents,
    commonPrefixes: result.commonPrefixes,
    isTruncated: result.isTruncated,
    // S3 only returns NextMarker when delimiter is specified
    nextMarker: delimiter ? result.nextToken : undefined,
    encodingType,
  }));
}
