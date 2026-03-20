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
export function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  const stripped = stripEtagQuotes(etag);
  return header.split(',').some(e => stripEtagQuotes(e) === stripped);
}
