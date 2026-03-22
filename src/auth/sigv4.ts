import type { Env, AuthFailure, AuthContext } from '../types';
import { hmacSha256, sha256Hex, bufToHex, timingSafeEqual } from '../utils/crypto';

export type CredentialResolver = (accessKeyId: string) => Promise<{ secretKey: string; context: AuthContext } | null>;

/**
 * Verify SigV4 signature. Returns AuthContext on success, or AuthFailure on failure.
 */
export async function verifySignature(request: Request, url: URL, resolve: CredentialResolver): Promise<AuthFailure | AuthContext> {
  try {
    if (url.searchParams.has('X-Amz-Algorithm')) {
      return verifyQueryStringAuth(request, url, resolve);
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('AWS4-HMAC-SHA256')) {
      return { status: 403, code: 'AccessDenied', message: 'Access Denied.' };
    }

    const parts = parseAuthHeader(authHeader);
    if (!parts) {
      return { status: 400, code: 'AuthorizationHeaderMalformed', message: 'The authorization header is malformed.' };
    }

    const { credential, signedHeaders, signature } = parts;
    const credParts = credential.split('/');
    if (credParts.length !== 5) {
      return { status: 400, code: 'AuthorizationHeaderMalformed', message: 'The authorization header is malformed.' };
    }
    const [accessKeyId, dateStr, region, service, terminator] = credParts;

    if (service !== 's3' || terminator !== 'aws4_request') {
      return { status: 400, code: 'AuthorizationHeaderMalformed', message: 'The authorization header is malformed.' };
    }

    const resolved = await resolve(accessKeyId);
    if (!resolved) {
      return { status: 403, code: 'InvalidAccessKeyId', message: 'The AWS Access Key Id you provided does not exist in our records.' };
    }

    let amzDate = request.headers.get('x-amz-date') || request.headers.get('X-Amz-Date') || '';
    // Fallback to Date header if x-amz-date is not present (older clients)
    if (!amzDate) {
      const dateHeader = request.headers.get('date');
      if (dateHeader) {
        amzDate = dateToAmzFormat(new Date(dateHeader));
      }
    }
    const requestTime = parseAmzDate(amzDate);
    if (!requestTime) {
      return { status: 403, code: 'AccessDenied', message: 'AWS authentication requires a valid Date or x-amz-date header.' };
    }
    if (Math.abs(Date.now() - requestTime.getTime()) > 15 * 60 * 1000) {
      return { status: 403, code: 'RequestTimeTooSkewed', message: 'The difference between the request time and the current time is too large.' };
    }
    // S3 requires credential scope date to match X-Amz-Date date portion
    if (amzDate.slice(0, 8) !== dateStr) {
      return { status: 403, code: 'SignatureDoesNotMatch', message: `Date in Credential scope does not match YYYYMMDD from ISO-8601 version of date from HTTP: '${dateStr}' vs '${amzDate.slice(0, 8)}'.` };
    }

    const scope = `${dateStr}/${region}/${service}/aws4_request`;
    const signingKey = await deriveSigningKey(resolved.secretKey, dateStr, region, service);

    // Try signature verification, with fallback for Cloudflare Accept-Encoding rewriting.
    // Cloudflare's edge proxy rewrites the Accept-Encoding header (e.g. "identity" -> "gzip, br")
    // before it reaches the Worker, breaking SigV4 signatures when accept-encoding is signed.
    const headerOverrides: Array<Record<string, string>> = [{}];
    if (signedHeaders.includes('accept-encoding')) {
      const received = (request.headers.get('accept-encoding') || '').trim();
      const fallbacks = ['identity', 'gzip', 'gzip, deflate', 'gzip, br', 'gzip, deflate, br', 'gzip, deflate, zstd', 'gzip, br, zstd', 'gzip, deflate, br, zstd'];
      for (const val of fallbacks) {
        if (val !== received) headerOverrides.push({ 'accept-encoding': val });
      }
    }

    for (const overrides of headerOverrides) {
      const canonicalRequest = await buildCanonicalRequest(request, url, signedHeaders, overrides);
      const crHash = await sha256Hex(new TextEncoder().encode(canonicalRequest).buffer as ArrayBuffer);
      const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${crHash}`;
      const computed = bufToHex(await hmacSha256(signingKey, stringToSign));
      if (timingSafeEqual(computed, signature)) {
        return resolved.context; // success
      }
    }

    return { status: 403, code: 'SignatureDoesNotMatch', message: 'The request signature we calculated does not match the signature you provided.' };
  } catch {
    return { status: 403, code: 'AccessDenied', message: 'Access Denied.' };
  }
}

async function verifyQueryStringAuth(request: Request, url: URL, resolve: CredentialResolver): Promise<AuthFailure | AuthContext> {
  const algorithm = url.searchParams.get('X-Amz-Algorithm');
  if (algorithm !== 'AWS4-HMAC-SHA256') {
    return { status: 400, code: 'AuthorizationQueryParametersError', message: 'Query-string authentication requires the X-Amz-Algorithm query parameter.' };
  }

  const credential = url.searchParams.get('X-Amz-Credential') || '';
  const credParts = credential.split('/');
  if (credParts.length !== 5) {
    return { status: 400, code: 'AuthorizationQueryParametersError', message: 'Invalid X-Amz-Credential parameter.' };
  }
  const [accessKeyId, dateStr, region, service, terminator] = credParts;

  if (service !== 's3' || terminator !== 'aws4_request') {
    return { status: 400, code: 'AuthorizationQueryParametersError', message: 'Invalid X-Amz-Credential parameter.' };
  }

  const resolved = await resolve(accessKeyId);
  if (!resolved) {
    return { status: 403, code: 'InvalidAccessKeyId', message: 'The AWS Access Key Id you provided does not exist in our records.' };
  }

  const amzDate = url.searchParams.get('X-Amz-Date') || '';
  const expires = parseInt(url.searchParams.get('X-Amz-Expires') || '0', 10);
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders') || '';
  const providedSig = url.searchParams.get('X-Amz-Signature') || '';

  // S3 rejects presigned URLs with expiry > 7 days (604800 seconds)
  if (expires <= 0 || expires > 604800) {
    return { status: 400, code: 'AuthorizationQueryParametersError', message: 'X-Amz-Expires must be between 1 and 604800 seconds.' };
  }

  const requestTime = parseAmzDate(amzDate);
  if (!requestTime) {
    return { status: 403, code: 'AccessDenied', message: 'Invalid X-Amz-Date parameter.' };
  }
  if (Date.now() > requestTime.getTime() + expires * 1000) {
    return { status: 403, code: 'AccessDenied', message: 'Request has expired.' };
  }
  // S3 requires credential scope date to match X-Amz-Date date portion
  if (amzDate.slice(0, 8) !== dateStr) {
    return { status: 403, code: 'SignatureDoesNotMatch', message: `Date in Credential scope does not match YYYYMMDD from ISO-8601 version of date from HTTP: '${dateStr}' vs '${amzDate.slice(0, 8)}'.` };
  }

  const queryParams = new URLSearchParams(url.searchParams);
  queryParams.delete('X-Amz-Signature');
  // SigV4 spec requires sorting by character code point, not locale order
  const sortedQuery = [...queryParams.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
    .map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`).join('&');

  const headersList = signedHeaders.split(';');
  const canonicalHeaders = headersList.map(h => {
    const val = h === 'host' ? url.host : (request.headers.get(h) || '');
    return `${h}:${val.trim().replace(/\s+/g, ' ')}\n`;
  }).join('');

  const canonicalRequest = [
    request.method,
    url.pathname,
    sortedQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const crHash = await sha256Hex(new TextEncoder().encode(canonicalRequest).buffer as ArrayBuffer);
  const scope = `${dateStr}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${crHash}`;
  const signingKey = await deriveSigningKey(resolved.secretKey, dateStr, region, service);
  const computed = bufToHex(await hmacSha256(signingKey, stringToSign));

  if (!timingSafeEqual(computed, providedSig)) {
    return { status: 403, code: 'SignatureDoesNotMatch', message: 'The request signature we calculated does not match the signature you provided.' };
  }

  return resolved.context; // success
}

function parseAuthHeader(header: string): { credential: string; signedHeaders: string; signature: string } | null {
  const m = header.match(/AWS4-HMAC-SHA256\s+Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=(\S+)/);
  if (!m) return null;
  return { credential: m[1], signedHeaders: m[2], signature: m[3] };
}

async function buildCanonicalRequest(request: Request, url: URL, signedHeadersStr: string, headerOverrides: Record<string, string> = {}): Promise<string> {
  const method = request.method;
  // S3 uses single-encoded URI paths (unlike other AWS services which double-encode).
  // url.pathname is already percent-encoded from the HTTP request, so use it directly.
  const path = url.pathname;

  const params = [...url.searchParams.entries()]
    .filter(([k]) => k !== 'X-Amz-Signature')
    // SigV4 spec requires sorting by character code point, not locale order
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  const queryString = params.map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`).join('&');

  const headersList = signedHeadersStr.split(';');
  const canonicalHeaders = headersList.map(h => {
    const val = h === 'host' ? url.host : (headerOverrides[h] ?? request.headers.get(h) ?? '');
    // SigV4 spec: trim leading/trailing whitespace, collapse sequential spaces to single space
    return `${h}:${val.trim().replace(/\s+/g, ' ')}\n`;
  }).join('');

  const payloadHash = request.headers.get('x-amz-content-sha256') || 'UNSIGNED-PAYLOAD';

  return [method, path, queryString, canonicalHeaders, signedHeadersStr, payloadHash].join('\n');
}

async function deriveSigningKey(secretKey: string, dateStr: string, region: string, service: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  let key = await hmacSha256(enc.encode(`AWS4${secretKey}`).buffer as ArrayBuffer, dateStr);
  key = await hmacSha256(key, region);
  key = await hmacSha256(key, service);
  key = await hmacSha256(key, 'aws4_request');
  return key;
}

// AWS SigV4 UriEncode: like encodeURIComponent but also encodes !'()* per AWS spec
function awsUriEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function parseAmzDate(s: string): Date | null {
  if (!s || s.length !== 16) return null;
  const y = s.slice(0, 4), mo = s.slice(4, 6), d = s.slice(6, 8);
  const h = s.slice(9, 11), mi = s.slice(11, 13), se = s.slice(13, 15);
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`);
  return isNaN(date.getTime()) ? null : date;
}

function dateToAmzFormat(d: Date): string {
  if (isNaN(d.getTime())) return '';
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
