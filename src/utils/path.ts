export function parseS3Path(url: URL): { bucket: string; key: string } {
  const path = url.pathname;
  // Remove leading slash, then split on first '/' to get bucket vs key
  const trimmed = path.startsWith('/') ? path.slice(1) : path;
  if (!trimmed) return { bucket: '', key: '' };
  const slashIdx = trimmed.indexOf('/');
  try {
    if (slashIdx < 0) return { bucket: decodeURIComponent(trimmed).toLowerCase(), key: '' };
    return {
      bucket: decodeURIComponent(trimmed.slice(0, slashIdx)).toLowerCase(),
      key: decodeURIComponent(trimmed.slice(slashIdx + 1)),
    };
  } catch {
    // Malformed percent-encoding: fall back to raw path
    if (slashIdx < 0) return { bucket: trimmed.toLowerCase(), key: '' };
    return { bucket: trimmed.slice(0, slashIdx).toLowerCase(), key: trimmed.slice(slashIdx + 1) };
  }
}

export function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
