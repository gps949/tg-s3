export async function sha256(data: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', data);
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  return bufToHex(await sha256(data));
}

export async function hmacSha256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

export async function hmacSha256Hex(key: ArrayBuffer, data: string): Promise<string> {
  return bufToHex(await hmacSha256(key, data));
}

// Use Web Crypto MD5 for ETags (S3 standard, maximizes client compatibility)
export async function computeEtag(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('MD5', data);
  return `"${bufToHex(digest)}"`;
}

// Multipart ETag format: "<md5_of_concatenated_part_md5s>-<part_count>"
export async function computeMultipartEtag(partEtags: string[]): Promise<string> {
  const stripped = partEtags.map(e => e.replace(/"/g, ''));
  const concat = stripped.map(h => hexToBuf(h));
  const total = concat.reduce((s, b) => s + b.byteLength, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const b of concat) { buf.set(new Uint8Array(b), off); off += b.byteLength; }
  const digest = await crypto.subtle.digest('MD5', buf.buffer as ArrayBuffer);
  return `"${bufToHex(digest)}-${partEtags.length}"`;
}

export function generateToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return bufToHex(salt.buffer as ArrayBuffer) + ':' + bufToHex(derived);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const colonIdx = stored.indexOf(':');
  if (colonIdx < 0) return false;
  const salt = hexToBuf(stored.slice(0, colonIdx));
  const expected = stored.slice(colonIdx + 1);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return timingSafeEqual(bufToHex(derived), expected);
}

/** Sign a share session cookie so it cannot be forged without knowing the bot token */
export async function signShareSession(botToken: string, shareToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(botToken), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`share-session:${shareToken}`));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** Derive a deterministic webhook secret from the bot token (no separate env var needed) */
export async function deriveWebhookSecret(botToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(botToken), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode('tg-s3-webhook'));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBuf(hex: string): ArrayBuffer {
  if (hex.length % 2 !== 0) return new ArrayBuffer(0);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const v = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(v)) return new ArrayBuffer(0);
    bytes[i / 2] = v;
  }
  return bytes.buffer as ArrayBuffer;
}
