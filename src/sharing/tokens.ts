import type { Env, ShareOptions, ShareTokenRow } from '../types';
import { MetadataStore } from '../storage/metadata';
import { generateToken, hashPassword } from '../utils/crypto';

export async function createShareToken(opts: ShareOptions, env: Env): Promise<ShareTokenRow> {
  const store = new MetadataStore(env);
  const token = generateToken(32);
  // Truncate to second precision to match objects table timestamps
  const nowMs = Math.floor(Date.now() / 1000) * 1000;
  const now = new Date(nowMs).toISOString();
  const expiresAt = opts.expiresIn
    ? new Date(nowMs + opts.expiresIn * 1000).toISOString()
    : null;
  const passwordHash = opts.password
    ? await hashPassword(opts.password)
    : null;

  const row: ShareTokenRow = {
    token,
    bucket: opts.bucket,
    key: opts.key,
    created_at: now,
    expires_at: expiresAt,
    password_hash: passwordHash,
    max_downloads: opts.maxDownloads ?? null,
    download_count: 0,
    creator: null,
    note: opts.note ?? null,
  };

  await store.createShareToken(row);
  return row;
}

export async function validateShareToken(token: string, password: string | null, env: Env, clientIp?: string): Promise<{
  valid: boolean;
  reason?: string;
  shareToken?: ShareTokenRow;
  needsPassword?: boolean;
  wrongPassword?: boolean;
  locked?: boolean;
  lockSeconds?: number;
  remainingAttempts?: number;
}> {
  const store = new MetadataStore(env);
  const share = await store.getShareToken(token);

  if (!share) return { valid: false, reason: 'not_found' };

  // Check expiry
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return { valid: false, reason: 'expired', shareToken: share };
  }

  // Check download limit
  if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
    return { valid: false, reason: 'max_downloads', shareToken: share };
  }

  // Check password
  if (share.password_hash) {
    const ip = clientIp ?? '0.0.0.0';

    // 暴力破解防护: 检查是否被锁定
    const lockSeconds = await store.checkPasswordLock(token, ip);
    if (lockSeconds > 0) {
      return { valid: false, needsPassword: true, locked: true, lockSeconds, shareToken: share };
    }

    if (!password) {
      return { valid: false, needsPassword: true, shareToken: share };
    }
    const { verifyPassword } = await import('../utils/crypto');
    const match = await verifyPassword(password, share.password_hash);
    if (!match) {
      // 记录失败尝试
      const maxAttempts = 5;
      const attempts = await store.recordPasswordFailure(token, ip, maxAttempts);
      const remaining = Math.max(0, maxAttempts - attempts);
      return { valid: false, needsPassword: true, wrongPassword: true, shareToken: share, remainingAttempts: remaining };
    }
    // 验证成功: 清除失败记录
    await store.clearPasswordAttempts(token, ip);
  }

  return { valid: true, shareToken: share };
}

// Validate share token when session cookie proves prior password verification.
// Checks expiry and download limits only, skips password.
export async function validateShareTokenWithCookie(token: string, env: Env): Promise<{
  valid: boolean;
  reason?: string;
  shareToken?: ShareTokenRow;
  needsPassword?: boolean;
  wrongPassword?: boolean;
  locked?: boolean;
  lockSeconds?: number;
  remainingAttempts?: number;
}> {
  const store = new MetadataStore(env);
  const share = await store.getShareToken(token);
  if (!share) return { valid: false, reason: 'not_found' };
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return { valid: false, reason: 'expired', shareToken: share };
  }
  if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
    return { valid: false, reason: 'max_downloads', shareToken: share };
  }
  return { valid: true, shareToken: share };
}
