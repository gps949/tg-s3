import type { Env, S3Request } from '../types';
import { MetadataStore } from '../storage/metadata';
import { formatHttpDate, isImageContentType, etagMatches } from '../utils/headers';
import { errorResponse } from '../xml/builder';
import { parseSseCHeaders, validateKeyMd5, isEncrypted, getStoredKeyMd5, addSseResponseHeaders, SseCError } from '../utils/sse';

export async function handleHeadObject(s3: S3Request, env: Env): Promise<Response> {
  const store = new MetadataStore(env);
  const bucket = await store.getBucket(s3.bucket);
  if (!bucket) return errorResponse(404, 'NoSuchBucket', 'The specified bucket does not exist.', s3.bucket);
  const obj = await store.getObject(s3.bucket, s3.key);
  if (!obj) return errorResponse(404, 'NoSuchKey', 'The specified key does not exist.', `/${s3.bucket}/${s3.key}`);

  // SSE-C: if object is encrypted, require matching SSE-C headers (AWS behavior)
  if (isEncrypted(obj.system_metadata)) {
    try {
      const sseParams = parseSseCHeaders(s3.headers);
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

  // Build base headers (shared by 200, 304, and partNumber responses)
  const headers: Record<string, string> = {
    'Content-Type': s3.query.get('response-content-type') || obj.content_type,
    'Content-Length': obj.size.toString(),
    'ETag': obj.etag,
    'Last-Modified': formatHttpDate(obj.last_modified),
    'Accept-Ranges': 'bytes',
  };

  // Apply stored system metadata as defaults
  let sysMeta: Record<string, string> = {};
  if (obj.system_metadata) {
    try { sysMeta = JSON.parse(obj.system_metadata); } catch { /* ignore */ }
  }

  // response-* overrides take precedence over stored system metadata
  const overrides: Array<[string, string, string]> = [
    ['content-disposition', 'Content-Disposition', 'response-content-disposition'],
    ['content-encoding', 'Content-Encoding', 'response-content-encoding'],
    ['content-language', 'Content-Language', 'response-content-language'],
    ['cache-control', 'Cache-Control', 'response-cache-control'],
    ['expires', 'Expires', 'response-expires'],
  ];
  for (const [metaKey, headerName, overrideParam] of overrides) {
    const override = s3.query.get(overrideParam);
    const stored = sysMeta[metaKey];
    if (override) {
      headers[headerName] = override;
    } else if (stored) {
      headers[headerName] = stored;
    }
  }

  if (!headers['Cache-Control']) {
    headers['Cache-Control'] = isImageContentType(obj.content_type)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=86400';
  }

  if (!headers['Content-Disposition'] && isImageContentType(obj.content_type)) {
    headers['Content-Disposition'] = 'inline';
  }

  // S3 returns x-amz-mp-parts-count for objects uploaded via multipart
  const mpMatch = obj.etag.match(/-(\d+)"$/);
  if (mpMatch) {
    headers['x-amz-mp-parts-count'] = mpMatch[1];
  }

  // SSE-C response headers
  addSseResponseHeaders(headers, obj.system_metadata);

  // Include user metadata before any return path (304, partNumber, or normal)
  if (obj.user_metadata) {
    try {
      const meta = JSON.parse(obj.user_metadata) as Record<string, string>;
      for (const [k, v] of Object.entries(meta)) {
        headers[`x-amz-meta-${k}`] = v;
      }
    } catch { /* ignore */ }
  }

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

  // Handle HeadObject with partNumber (return headers for a specific part)
  const partNumberParam = s3.query.get('partNumber');
  if (partNumberParam) {
    let partSizes: number[] | undefined;
    if (obj.system_metadata) {
      try {
        const sm = JSON.parse(obj.system_metadata);
        if (sm._mp_part_sizes) partSizes = JSON.parse(sm._mp_part_sizes);
      } catch { /* ignore */ }
    }
    const partNum = parseInt(partNumberParam, 10);
    if (!partSizes || !Number.isInteger(partNum) || partNum < 1 || partNum > partSizes.length) {
      return errorResponse(400, 'InvalidPartNumber', 'The requested partNumber is not valid.');
    }
    let start = 0;
    for (let i = 0; i < partNum - 1; i++) start += partSizes[i];
    const partSize = partSizes[partNum - 1];
    const end = start + partSize - 1;
    headers['Content-Length'] = partSize.toString();
    headers['Content-Range'] = `bytes ${start}-${end}/${obj.size}`;
    headers['x-amz-mp-parts-count'] = partSizes.length.toString();
    return new Response(null, { status: 200, headers });
  }

  return new Response(null, { status: 200, headers });
}

// RFC 7232 §4.1: 304 responses SHOULD NOT include representation headers.
const HEADERS_TO_STRIP_304 = ['Content-Type', 'Content-Length', 'Content-Encoding', 'Content-Language', 'Content-Disposition', 'Content-Range', 'Accept-Ranges'];

function strip304Headers(h: Record<string, string>): Record<string, string> {
  const out = { ...h };
  for (const name of HEADERS_TO_STRIP_304) delete out[name];
  return out;
}
