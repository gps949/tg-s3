/**
 * SSE-C (Server-Side Encryption with Customer-Provided Keys) utilities.
 *
 * Implements AES-256-GCM encryption/decryption using Web Crypto API.
 * Encrypted blob format: [12-byte IV][ciphertext + 16-byte GCM auth tag]
 * The IV is prepended to the ciphertext so the blob is self-contained.
 * Metadata stores: { _sse: "AES256", _sse_key_md5: "<base64>" }
 */

const AES_GCM_IV_LENGTH = 12;

/** S3 SSE-C request header names */
export const SSE_HEADERS = {
  algorithm: 'x-amz-server-side-encryption-customer-algorithm',
  key: 'x-amz-server-side-encryption-customer-key',
  keyMd5: 'x-amz-server-side-encryption-customer-key-md5',
};

/** S3 SSE-C copy-source header names */
export const SSE_COPY_HEADERS = {
  algorithm: 'x-amz-copy-source-server-side-encryption-customer-algorithm',
  key: 'x-amz-copy-source-server-side-encryption-customer-key',
  keyMd5: 'x-amz-copy-source-server-side-encryption-customer-key-md5',
};

export interface SseCParams {
  algorithm: string;
  keyBase64: string;
  keyMd5: string;
}

/** Parse and validate SSE-C headers from a request. Returns null if no SSE-C headers present. */
export function parseSseCHeaders(headers: Headers, prefix = SSE_HEADERS): SseCParams | null {
  const algo = headers.get(prefix.algorithm);
  if (!algo) return null;

  const keyBase64 = headers.get(prefix.key);
  const keyMd5 = headers.get(prefix.keyMd5);

  if (!keyBase64 || !keyMd5) {
    throw new SseCError('You must provide all SSE-C headers (algorithm, key, key-MD5).');
  }
  if (algo !== 'AES256') {
    throw new SseCError(`The value '${algo}' for x-amz-server-side-encryption-customer-algorithm is not valid. Supported value: AES256.`);
  }

  // Validate key is 32 bytes (256 bits)
  let keyBytes: Uint8Array;
  try {
    keyBytes = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
  } catch {
    throw new SseCError('The SSE-C key is not valid base64.');
  }
  if (keyBytes.length !== 32) {
    throw new SseCError(`The SSE-C key must be 256 bits (32 bytes), got ${keyBytes.length} bytes.`);
  }

  return { algorithm: algo, keyBase64, keyMd5 };
}

/** Validate that the provided SSE-C key-MD5 matches the actual key. */
export async function validateKeyMd5(params: SseCParams): Promise<void> {
  const keyBytes = Uint8Array.from(atob(params.keyBase64), c => c.charCodeAt(0));
  const digest = await crypto.subtle.digest('MD5', keyBytes);
  const actualMd5 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  if (actualMd5 !== params.keyMd5) {
    throw new SseCError('The SSE-C key MD5 does not match the provided key.');
  }
}

/** Import the customer key for AES-256-GCM. */
async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(keyBase64), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypt plaintext with AES-256-GCM. Returns [IV + ciphertext]. */
export async function encrypt(plaintext: ArrayBuffer, keyBase64: string): Promise<ArrayBuffer> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  // Prepend IV to ciphertext
  const result = new Uint8Array(AES_GCM_IV_LENGTH + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), AES_GCM_IV_LENGTH);
  return result.buffer as ArrayBuffer;
}

/** Decrypt [IV + ciphertext] with AES-256-GCM. Returns plaintext. */
export async function decrypt(blob: ArrayBuffer, keyBase64: string): Promise<ArrayBuffer> {
  if (blob.byteLength < AES_GCM_IV_LENGTH + 16) {
    throw new SseCError('Encrypted data is too short.');
  }
  const blobBytes = new Uint8Array(blob);
  const iv = blobBytes.slice(0, AES_GCM_IV_LENGTH);
  const ciphertext = blobBytes.slice(AES_GCM_IV_LENGTH);

  const key = await importKey(keyBase64);
  try {
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  } catch {
    throw new SseCError('Decryption failed. The provided encryption key does not match.');
  }
}

/** Check if an object's system_metadata indicates SSE-C encryption. */
export function isEncrypted(systemMetadata: string | null): boolean {
  if (!systemMetadata) return false;
  try {
    const meta = JSON.parse(systemMetadata);
    return meta._sse === 'AES256';
  } catch { return false; }
}

/** Get the stored key MD5 from system_metadata. */
export function getStoredKeyMd5(systemMetadata: string | null): string | null {
  if (!systemMetadata) return null;
  try {
    const meta = JSON.parse(systemMetadata);
    return meta._sse_key_md5 || null;
  } catch { return null; }
}

/** Merge SSE metadata into a system_metadata object. */
export function addSseMetadata(sysMeta: Record<string, string>, params: SseCParams): Record<string, string> {
  return { ...sysMeta, _sse: 'AES256', _sse_key_md5: params.keyMd5 };
}

/** Add SSE-C response headers to a header record. */
export function addSseResponseHeaders(headers: Record<string, string>, systemMetadata: string | null): void {
  if (!systemMetadata) return;
  try {
    const meta = JSON.parse(systemMetadata);
    if (meta._sse === 'AES256') {
      headers['x-amz-server-side-encryption-customer-algorithm'] = 'AES256';
      headers['x-amz-server-side-encryption-customer-key-MD5'] = meta._sse_key_md5;
    }
  } catch { /* ignore */ }
}

export class SseCError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseCError';
  }
}

// ── SSE-S3 (Server-Managed Keys) ───────────────────────────────────────

/** Check if an object uses SSE-S3 encryption. */
export function isEncryptedS3(systemMetadata: string | null): boolean {
  if (!systemMetadata) return false;
  try {
    const meta = JSON.parse(systemMetadata);
    return meta._sse_s3 === 'AES256';
  } catch { return false; }
}

/** Merge SSE-S3 metadata into a system_metadata object. */
export function addSseS3Metadata(sysMeta: Record<string, string>): Record<string, string> {
  return { ...sysMeta, _sse_s3: 'AES256' };
}

/** Add SSE-S3 response header. */
export function addSseS3ResponseHeaders(headers: Record<string, string>, systemMetadata: string | null): void {
  if (!systemMetadata) return;
  try {
    const meta = JSON.parse(systemMetadata);
    if (meta._sse_s3 === 'AES256') {
      headers['x-amz-server-side-encryption'] = 'AES256';
    }
  } catch { /* ignore */ }
}

/** Encrypt with SSE-S3 master key (reuses AES-256-GCM). */
export async function encryptS3(plaintext: ArrayBuffer, masterKeyBase64: string): Promise<ArrayBuffer> {
  return encrypt(plaintext, masterKeyBase64);
}

/** Decrypt with SSE-S3 master key (reuses AES-256-GCM). */
export async function decryptS3(blob: ArrayBuffer, masterKeyBase64: string): Promise<ArrayBuffer> {
  return decrypt(blob, masterKeyBase64);
}
