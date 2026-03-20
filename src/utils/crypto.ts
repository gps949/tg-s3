import { md5Hex } from './md5';

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

// Use MD5 for ETags (S3 standard, maximizes client compatibility)
export function computeEtag(data: ArrayBuffer): string {
  return `"${md5Hex(data)}"`;
}

// Multipart ETag format: "<md5_of_concatenated_part_md5s>-<part_count>"
export function computeMultipartEtag(partEtags: string[]): string {
  const stripped = partEtags.map(e => e.replace(/"/g, ''));
  const concat = stripped.map(h => hexToBuf(h));
  const total = concat.reduce((s, b) => s + b.byteLength, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const b of concat) { buf.set(new Uint8Array(b), off); off += b.byteLength; }
  return `"${md5Hex(buf.buffer as ArrayBuffer)}-${partEtags.length}"`;
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
  if (colonIdx < 0) {
    // Legacy: plain SHA256 hash (migration compat)
    const legacy = await sha256Hex(new TextEncoder().encode(password).buffer as ArrayBuffer);
    return timingSafeEqual(legacy, stored);
  }
  const salt = hexToBuf(stored.slice(0, colonIdx));
  const expected = stored.slice(colonIdx + 1);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return timingSafeEqual(bufToHex(derived), expected);
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
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer as ArrayBuffer;
}
