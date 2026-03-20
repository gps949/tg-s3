import type { Env } from '../types';
import { hmacSha256, bufToHex } from '../utils/crypto';
import { formatAmzDate, formatAmzDateShort } from '../utils/headers';
import { MetadataStore } from '../storage/metadata';

// AWS SigV4 UriEncode: like encodeURIComponent but also encodes !'()* per AWS spec
function awsUriEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Generate a presigned URL using the first available admin credential.
 * Priority: D1 credentials table -> legacy env vars.
 */
export async function generatePresignedUrl(params: {
  bucket: string; key: string; method?: string; expiresIn?: number; env: Env; baseUrl: string;
}): Promise<string> {
  const { bucket, key, method = 'GET', expiresIn: rawExpires = 3600, env, baseUrl } = params;

  // Resolve credential: prefer D1, fallback to env vars
  let accessKeyId: string;
  let secretAccessKey: string;
  const store = new MetadataStore(env);
  const creds = await store.listCredentials();
  const adminCred = creds.find(c => c.is_active && c.permission === 'admin');
  if (adminCred) {
    accessKeyId = adminCred.access_key_id;
    secretAccessKey = adminCred.secret_access_key;
  } else if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
    accessKeyId = env.S3_ACCESS_KEY_ID;
    secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  } else {
    throw new Error('No S3 credentials available for presigned URL generation');
  }

  // S3 caps presigned URL expiry at 7 days (604800 seconds)
  const expiresIn = Math.min(Math.max(1, rawExpires), 604800);
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateShort = formatAmzDateShort(now);
  const region = env.S3_REGION || 'us-east-1';
  const credential = `${accessKeyId}/${dateShort}/${region}/s3/aws4_request`;

  // Encode path segments to handle keys with special chars (spaces, ?, #)
  const encodedPath = '/' + bucket + '/' + key.split('/').map(s => awsUriEncode(s)).join('/');
  const url = new URL(encodedPath, baseUrl);
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', credential);
  url.searchParams.set('X-Amz-Date', amzDate);
  url.searchParams.set('X-Amz-Expires', expiresIn.toString());
  url.searchParams.set('X-Amz-SignedHeaders', 'host');

  // SigV4 spec requires sorting by character code point, not locale order
  const sortedParams = [...url.searchParams.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const queryString = sortedParams.map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`).join('&');

  const canonicalRequest = [
    method,
    `/${bucket}/${key}`.split('/').map(s => awsUriEncode(s)).join('/'),
    queryString,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const { sha256Hex } = await import('../utils/crypto');
  const crHash = await sha256Hex(new TextEncoder().encode(canonicalRequest).buffer as ArrayBuffer);
  const scope = `${dateShort}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${crHash}`;

  const enc = new TextEncoder();
  let sigKey = await hmacSha256(enc.encode(`AWS4${secretAccessKey}`).buffer as ArrayBuffer, dateShort);
  sigKey = await hmacSha256(sigKey, region);
  sigKey = await hmacSha256(sigKey, 's3');
  sigKey = await hmacSha256(sigKey, 'aws4_request');
  const signature = bufToHex(await hmacSha256(sigKey, stringToSign));

  url.searchParams.set('X-Amz-Signature', signature);
  return url.toString();
}
