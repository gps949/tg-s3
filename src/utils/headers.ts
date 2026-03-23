import type { ObjectRow } from '../types';
import { CACHE_CONTROL_IMMUTABLE, CACHE_CONTROL_DEFAULT } from '../constants';

// Returns { start, end } for valid range, 'unsatisfiable' for valid syntax but
// out-of-bounds range (→ 416), or null for missing/malformed header (→ ignore).
export function parseRange(header: string | null, totalSize: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header || !header.startsWith('bytes=')) return null;
  const range = header.slice(6);
  // S3 does not support multi-range requests; ignore Range header if multiple ranges specified
  if (range.includes(',')) return null;
  const [startStr, endStr] = range.split('-');
  let start = startStr ? parseInt(startStr, 10) : NaN;
  let end = endStr ? parseInt(endStr, 10) : NaN;
  if (isNaN(start) && isNaN(end)) return null;
  if (isNaN(start)) {
    // Suffix range: bytes=-N. Per RFC 7233, if N > totalSize, return entire file.
    start = Math.max(0, totalSize - end);
    end = totalSize - 1;
  } else if (isNaN(end)) { end = totalSize - 1; }
  if (start < 0 || start >= totalSize || end < start) return 'unsatisfiable';
  if (end >= totalSize) end = totalSize - 1;
  return { start, end };
}

export function extractUserMetadata(headers: Headers): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const [k, v] of headers.entries()) {
    if (k.toLowerCase().startsWith('x-amz-meta-')) {
      meta[k.toLowerCase().slice(11)] = v;
    }
  }
  return meta;
}

// S3 system-defined metadata headers (stored on PutObject, returned on GetObject/HeadObject)
const SYSTEM_METADATA_HEADERS = [
  'content-encoding', 'content-disposition', 'content-language', 'cache-control', 'expires',
];

export function extractSystemMetadata(headers: Headers): Record<string, string> | undefined {
  const meta: Record<string, string> = {};
  for (const name of SYSTEM_METADATA_HEADERS) {
    const val = headers.get(name);
    if (val) meta[name] = val;
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

export function formatHttpDate(iso: string): string {
  return new Date(iso).toUTCString();
}

export function formatAmzDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function formatAmzDateShort(d: Date): string {
  return formatAmzDate(d).slice(0, 8);
}

export function isImageContentType(ct: string): boolean {
  return ct.startsWith('image/');
}

// Strip W/ prefix and surrounding quotes from an ETag value
function stripEtagQuotes(etag: string): string {
  let s = etag.trim();
  if (s.startsWith('W/')) s = s.slice(2);
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s;
}

// Check if an If-Match/If-None-Match header value matches an ETag.
// Handles wildcard *, comma-separated lists, and quoted/weak ETags.
// When strong=true (for If-Match), weak ETags (W/"...") in the header are rejected per RFC 7232.
export function etagMatches(header: string, etag: string, strong = false): boolean {
  if (header.trim() === '*') return true;
  const stripped = stripEtagQuotes(etag);
  return header.split(',').some(e => {
    const trimmed = e.trim();
    if (strong && trimmed.startsWith('W/')) return false;
    return stripEtagQuotes(trimmed) === stripped;
  });
}

// S3 system metadata: maps stored metadata key → HTTP header name → response-* override query param
export const SYS_META_HEADERS: Array<[string, string, string]> = [
  ['content-disposition', 'Content-Disposition', 'response-content-disposition'],
  ['content-encoding', 'Content-Encoding', 'response-content-encoding'],
  ['content-language', 'Content-Language', 'response-content-language'],
  ['cache-control', 'Cache-Control', 'response-cache-control'],
  ['expires', 'Expires', 'response-expires'],
];

// Build standard S3 response headers for GetObject / HeadObject
export function buildResponseHeaders(obj: ObjectRow, query?: URLSearchParams): Record<string, string> {
  const h: Record<string, string> = {
    'ETag': obj.etag,
    'Content-Type': query?.get('response-content-type') || obj.content_type,
    'Content-Length': obj.size.toString(),
    'Last-Modified': formatHttpDate(obj.last_modified),
    'Accept-Ranges': 'bytes',
  };

  let sysMeta: Record<string, string> = {};
  if (obj.system_metadata) {
    try { sysMeta = JSON.parse(obj.system_metadata); } catch { /* ignore */ }
  }

  for (const [metaKey, headerName, overrideParam] of SYS_META_HEADERS) {
    const override = query?.get(overrideParam);
    const stored = sysMeta[metaKey];
    if (override) {
      h[headerName] = override;
    } else if (stored) {
      h[headerName] = stored;
    }
  }

  if (!h['Cache-Control']) {
    h['Cache-Control'] = isImageContentType(obj.content_type)
      ? CACHE_CONTROL_IMMUTABLE
      : CACHE_CONTROL_DEFAULT;
  }

  if (!h['Content-Disposition'] && isImageContentType(obj.content_type)) {
    h['Content-Disposition'] = 'inline';
    h['Access-Control-Allow-Origin'] = '*';
  }

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
const HEADERS_TO_STRIP_304 = ['Content-Type', 'Content-Length', 'Content-Encoding', 'Content-Language', 'Content-Disposition', 'Content-Range', 'Accept-Ranges'];

export function strip304Headers(h: Record<string, string>): Record<string, string> {
  const out = { ...h };
  for (const name of HEADERS_TO_STRIP_304) delete out[name];
  return out;
}
