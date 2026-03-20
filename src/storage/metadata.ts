import type { Env, ObjectRow, BucketRow, MultipartUploadRow, MultipartPartRow, ShareTokenRow, ChunkRow } from '../types';

// S3 timestamps have second precision; truncate milliseconds to avoid
// If-Modified-Since comparison failures (HTTP dates lack ms component)
function isoNowSeconds(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
}

// Compute upper bound for prefix range queries: increment last character safely.
// Handles Unicode edge case where charCode+1 could overflow BMP range.
function prefixUpperBound(prefix: string): string {
  const lastChar = prefix.charCodeAt(prefix.length - 1);
  if (lastChar >= 0xFFFF) {
    // At BMP ceiling: append max char instead of incrementing
    return prefix + '\uFFFF';
  }
  return prefix.slice(0, -1) + String.fromCharCode(lastChar + 1);
}

export class MetadataStore {
  private db: D1Database;

  constructor(env: Env) {
    this.db = env.DB;
  }

  // --- Buckets ---

  async getBucket(name: string): Promise<BucketRow | null> {
    return this.db.prepare('SELECT * FROM buckets WHERE name = ?').bind(name).first<BucketRow>();
  }

  async listBuckets(): Promise<BucketRow[]> {
    const result = await this.db.prepare('SELECT * FROM buckets ORDER BY name').all<BucketRow>();
    return result.results;
  }

  async createBucket(name: string, chatId: string, topicId?: number | null, description?: string): Promise<void> {
    await this.db.prepare(
      'INSERT INTO buckets (name, created_at, tg_chat_id, tg_topic_id, description) VALUES (?, ?, ?, ?, ?)'
    ).bind(name, isoNowSeconds(), chatId, topicId ?? null, description ?? null).run();
  }

  async deleteBucket(name: string): Promise<void> {
    await this.db.prepare('DELETE FROM buckets WHERE name = ?').bind(name).run();
  }

  async updateBucketStats(bucket: string, sizeDelta: number, countDelta: number): Promise<void> {
    await this.db.prepare(
      'UPDATE buckets SET total_size = MAX(0, total_size + ?), object_count = MAX(0, object_count + ?) WHERE name = ?'
    ).bind(sizeDelta, countDelta, bucket).run();
  }

  // --- Objects ---

  async getObject(bucket: string, key: string): Promise<ObjectRow | null> {
    return this.db.prepare('SELECT * FROM objects WHERE bucket = ? AND key = ?').bind(bucket, key).first<ObjectRow>();
  }

  async findByFileUniqueId(fileUniqueId: string): Promise<ObjectRow | null> {
    return this.db.prepare('SELECT * FROM objects WHERE tg_file_unique_id = ? LIMIT 1').bind(fileUniqueId).first<ObjectRow>();
  }

  async putObject(obj: {
    bucket: string; key: string; size: number; etag: string; contentType: string;
    tgChatId: string; tgMessageId: number; tgFileId: string; tgFileUniqueId: string;
    userMetadata?: Record<string, string>;
    systemMetadata?: Record<string, string>;
    derivedFrom?: string;
  }, existingObj?: ObjectRow | null): Promise<ObjectRow | null> {
    const now = isoNowSeconds();
    const metaJson = obj.userMetadata && Object.keys(obj.userMetadata).length > 0
      ? JSON.stringify(obj.userMetadata) : null;
    const sysMetaJson = obj.systemMetadata && Object.keys(obj.systemMetadata).length > 0
      ? JSON.stringify(obj.systemMetadata) : null;

    // Use caller-provided existing object if available, otherwise query
    const existing = existingObj !== undefined ? existingObj : await this.getObject(obj.bucket, obj.key);

    const upsertStmt = this.db.prepare(`
      INSERT INTO objects (bucket, key, size, etag, content_type, last_modified, tg_chat_id, tg_message_id, tg_file_id, tg_file_unique_id, user_metadata, system_metadata, derived_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bucket, key) DO UPDATE SET
        size=excluded.size, etag=excluded.etag, content_type=excluded.content_type,
        last_modified=excluded.last_modified, tg_chat_id=excluded.tg_chat_id,
        tg_message_id=excluded.tg_message_id, tg_file_id=excluded.tg_file_id,
        tg_file_unique_id=excluded.tg_file_unique_id,
        user_metadata=excluded.user_metadata, system_metadata=excluded.system_metadata,
        derived_from=excluded.derived_from
    `).bind(
      obj.bucket, obj.key, obj.size, obj.etag, obj.contentType, now,
      obj.tgChatId, obj.tgMessageId, obj.tgFileId, obj.tgFileUniqueId,
      metaJson, sysMetaJson, obj.derivedFrom ?? null,
    );

    // Batch upsert + stats update to keep them atomic
    const statsStmt = existing
      ? this.db.prepare('UPDATE buckets SET total_size = MAX(0, total_size + ?), object_count = MAX(0, object_count + ?) WHERE name = ?').bind(obj.size - existing.size, 0, obj.bucket)
      : this.db.prepare('UPDATE buckets SET total_size = MAX(0, total_size + ?), object_count = MAX(0, object_count + ?) WHERE name = ?').bind(obj.size, 1, obj.bucket);
    await this.db.batch([upsertStmt, statsStmt]);

    return existing;
  }

  async deleteObject(bucket: string, key: string): Promise<ObjectRow | null> {
    const obj = await this.getObject(bucket, key);
    if (!obj) return null;

    // Batch delete + stats update to keep them atomic
    await this.db.batch([
      this.db.prepare('DELETE FROM objects WHERE bucket = ? AND key = ?').bind(bucket, key),
      this.db.prepare('UPDATE buckets SET total_size = MAX(0, total_size + ?), object_count = MAX(0, object_count + ?) WHERE name = ?').bind(-obj.size, -1, bucket),
    ]);
    return obj;
  }

  async listObjects(bucket: string, prefix: string, delimiter: string, maxKeys: number, startAfter?: string): Promise<{
    contents: ObjectRow[];
    commonPrefixes: string[];
    isTruncated: boolean;
    nextToken?: string;
  }> {
    // S3: max-keys=0 returns empty result with IsTruncated=false
    if (maxKeys === 0) return { contents: [], commonPrefixes: [], isTruncated: false };

    // No-delimiter path: simple DB query with LIMIT
    if (!delimiter) {
      let query = 'SELECT * FROM objects WHERE bucket = ?';
      const params: (string | number)[] = [bucket];

      if (prefix) {
        query += ' AND key >= ? AND key < ?';
        params.push(prefix, prefixUpperBound(prefix));
      }

      if (startAfter) {
        query += ' AND key > ?';
        params.push(startAfter);
      }

      query += ' ORDER BY key ASC LIMIT ?';
      params.push(maxKeys + 1);

      const result = await this.db.prepare(query).bind(...params).all<ObjectRow>();
      let rows = result.results;
      const isTruncated = rows.length > maxKeys;
      if (isTruncated) rows = rows.slice(0, maxKeys);

      return {
        contents: rows,
        commonPrefixes: [],
        isTruncated,
        nextToken: isTruncated ? rows[rows.length - 1].key : undefined,
      };
    }

    // Delimiter path: iterate through DB rows, properly counting
    // both contents AND common prefixes toward maxKeys.
    const contents: ObjectRow[] = [];
    const prefixSet = new Set<string>();
    let cursor = startAfter;
    let isTruncated = false;
    // Dynamic batch strategy: 5x for small maxKeys, 2x for large, clamped to [100, 1000]
    const multiplier = maxKeys <= 100 ? 5 : 2;
    const BATCH_SIZE = Math.max(Math.min(maxKeys * multiplier, 1000), 100);

    outer:
    while (true) {
      let query = 'SELECT * FROM objects WHERE bucket = ?';
      const params: (string | number)[] = [bucket];

      if (prefix) {
        query += ' AND key >= ? AND key < ?';
        params.push(prefix, prefixUpperBound(prefix));
      }

      if (cursor) {
        query += ' AND key > ?';
        params.push(cursor);
      }

      query += ' ORDER BY key ASC LIMIT ?';
      params.push(BATCH_SIZE);

      const result = await this.db.prepare(query).bind(...params).all<ObjectRow>();
      const batch = result.results;
      if (batch.length === 0) break;

      for (const row of batch) {
        const keyAfterPrefix = row.key.slice(prefix.length);
        const delimIdx = keyAfterPrefix.indexOf(delimiter);

        if (delimIdx >= 0) {
          const cp = prefix + keyAfterPrefix.slice(0, delimIdx + delimiter.length);
          if (!prefixSet.has(cp)) {
            if (contents.length + prefixSet.size >= maxKeys) {
              isTruncated = true;
              break outer;
            }
            prefixSet.add(cp);
          }
        } else {
          if (contents.length + prefixSet.size >= maxKeys) {
            isTruncated = true;
            break outer;
          }
          contents.push(row);
        }
        cursor = row.key;
      }

      if (batch.length < BATCH_SIZE) break;
    }

    return {
      contents,
      commonPrefixes: [...prefixSet].sort(),
      isTruncated,
      nextToken: isTruncated ? cursor : undefined,
    };
  }

  // --- Multipart Uploads ---

  async createMultipartUpload(uploadId: string, bucket: string, key: string, contentType?: string, userMetadata?: string, systemMetadata?: string): Promise<void> {
    await this.db.prepare(
      'INSERT INTO multipart_uploads (upload_id, bucket, key, created_at, content_type, user_metadata, system_metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(uploadId, bucket, key, isoNowSeconds(), contentType ?? null, userMetadata ?? null, systemMetadata ?? null).run();
  }

  async getMultipartUpload(uploadId: string): Promise<MultipartUploadRow | null> {
    return this.db.prepare('SELECT * FROM multipart_uploads WHERE upload_id = ?').bind(uploadId).first<MultipartUploadRow>();
  }

  async deleteMultipartUpload(uploadId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM multipart_uploads WHERE upload_id = ?').bind(uploadId),
      this.db.prepare('DELETE FROM multipart_parts WHERE upload_id = ?').bind(uploadId),
    ]);
  }

  async putMultipartPart(part: {
    uploadId: string; partNumber: number; size: number; etag: string;
    tgChatId: string; tgMessageId: number; tgFileId: string;
  }): Promise<void> {
    const now = isoNowSeconds();
    await this.db.prepare(`
      INSERT INTO multipart_parts (upload_id, part_number, size, etag, tg_chat_id, tg_message_id, tg_file_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(upload_id, part_number) DO UPDATE SET
        size=excluded.size, etag=excluded.etag, tg_chat_id=excluded.tg_chat_id,
        tg_message_id=excluded.tg_message_id, tg_file_id=excluded.tg_file_id,
        created_at=excluded.created_at
    `).bind(part.uploadId, part.partNumber, part.size, part.etag, part.tgChatId, part.tgMessageId, part.tgFileId, now).run();
  }

  async getMultipartPart(uploadId: string, partNumber: number): Promise<MultipartPartRow | null> {
    return this.db.prepare(
      'SELECT * FROM multipart_parts WHERE upload_id = ? AND part_number = ?'
    ).bind(uploadId, partNumber).first<MultipartPartRow>();
  }

  async getMultipartParts(uploadId: string): Promise<MultipartPartRow[]> {
    const result = await this.db.prepare(
      'SELECT * FROM multipart_parts WHERE upload_id = ? ORDER BY part_number'
    ).bind(uploadId).all<MultipartPartRow>();
    return result.results;
  }

  async listMultipartUploads(bucket: string, opts: {
    prefix?: string; delimiter?: string; keyMarker?: string; uploadIdMarker?: string; maxUploads?: number;
  } = {}): Promise<{ uploads: MultipartUploadRow[]; commonPrefixes: string[]; isTruncated: boolean; nextKeyMarker?: string; nextUploadIdMarker?: string }> {
    const maxUploads = opts.maxUploads ?? 1000;
    // S3: max-uploads=0 returns empty result with IsTruncated=false
    if (maxUploads === 0) return { uploads: [], commonPrefixes: [], isTruncated: false };

    const prefix = opts.prefix || '';
    const delimiter = opts.delimiter || '';

    // Build base query with prefix and marker filters
    let baseSql = 'SELECT * FROM multipart_uploads WHERE bucket = ?';
    const baseBinds: unknown[] = [bucket];

    if (prefix) {
      baseSql += ' AND key >= ? AND key < ?';
      baseBinds.push(prefix, prefixUpperBound(prefix));
    }
    if (opts.keyMarker) {
      if (opts.uploadIdMarker) {
        baseSql += ' AND (key > ? OR (key = ? AND upload_id > ?))';
        baseBinds.push(opts.keyMarker, opts.keyMarker, opts.uploadIdMarker);
      } else {
        baseSql += ' AND key > ?';
        baseBinds.push(opts.keyMarker);
      }
    }

    baseSql += ' ORDER BY key, upload_id';

    // No delimiter: simple limit query
    if (!delimiter) {
      const sql = baseSql + ' LIMIT ?';
      const binds = [...baseBinds, maxUploads + 1];
      const result = await this.db.prepare(sql).bind(...binds).all<MultipartUploadRow>();
      const uploads = result.results;
      const isTruncated = uploads.length > maxUploads;
      if (isTruncated) uploads.pop();
      return {
        uploads, commonPrefixes: [], isTruncated,
        nextKeyMarker: isTruncated ? uploads[uploads.length - 1].key : undefined,
        nextUploadIdMarker: isTruncated ? uploads[uploads.length - 1].upload_id : undefined,
      };
    }

    // Delimiter path: iterate and group, counting uploads + prefixes toward maxUploads
    const uploads: MultipartUploadRow[] = [];
    const prefixSet = new Set<string>();
    let isTruncated = false;
    let lastKey: string | undefined;
    let lastUploadId: string | undefined;
    const multiplier = maxUploads <= 100 ? 5 : 2;
    const BATCH_SIZE = Math.max(Math.min(maxUploads * multiplier, 1000), 100);
    let cursor: string | undefined = opts.keyMarker;
    let cursorUploadId: string | undefined = opts.uploadIdMarker;

    outer:
    while (true) {
      let sql = 'SELECT * FROM multipart_uploads WHERE bucket = ?';
      const binds: unknown[] = [bucket];
      if (prefix) {
        sql += ' AND key >= ? AND key < ?';
        binds.push(prefix, prefixUpperBound(prefix));
      }
      if (cursor) {
        if (cursorUploadId) {
          sql += ' AND (key > ? OR (key = ? AND upload_id > ?))';
          binds.push(cursor, cursor, cursorUploadId);
        } else {
          sql += ' AND key > ?';
          binds.push(cursor);
        }
      }
      sql += ' ORDER BY key, upload_id LIMIT ?';
      binds.push(BATCH_SIZE);

      const result = await this.db.prepare(sql).bind(...binds).all<MultipartUploadRow>();
      const batch = result.results;
      if (batch.length === 0) break;

      for (const row of batch) {
        const keyAfterPrefix = row.key.slice(prefix.length);
        const delimIdx = keyAfterPrefix.indexOf(delimiter);

        if (delimIdx >= 0) {
          const cp = prefix + keyAfterPrefix.slice(0, delimIdx + delimiter.length);
          if (!prefixSet.has(cp)) {
            if (uploads.length + prefixSet.size >= maxUploads) {
              isTruncated = true;
              break outer;
            }
            prefixSet.add(cp);
          }
        } else {
          if (uploads.length + prefixSet.size >= maxUploads) {
            isTruncated = true;
            break outer;
          }
          uploads.push(row);
        }
        lastKey = row.key;
        lastUploadId = row.upload_id;
        cursor = row.key;
        cursorUploadId = row.upload_id;
      }

      if (batch.length < BATCH_SIZE) break;
    }

    return {
      uploads, commonPrefixes: [...prefixSet].sort(), isTruncated,
      nextKeyMarker: isTruncated ? lastKey : undefined,
      nextUploadIdMarker: isTruncated ? lastUploadId : undefined,
    };
  }

  // --- Share Tokens ---

  async createShareToken(token: ShareTokenRow): Promise<void> {
    await this.db.prepare(`
      INSERT INTO share_tokens (token, bucket, key, created_at, expires_at, password_hash, max_downloads, download_count, creator, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      token.token, token.bucket, token.key, token.created_at,
      token.expires_at, token.password_hash, token.max_downloads,
      token.download_count, token.creator, token.note,
    ).run();
  }

  async getShareToken(token: string): Promise<ShareTokenRow | null> {
    return this.db.prepare('SELECT * FROM share_tokens WHERE token = ?').bind(token).first<ShareTokenRow>();
  }

  async listShareTokens(bucket?: string, key?: string, limit = 200): Promise<ShareTokenRow[]> {
    let query = 'SELECT * FROM share_tokens';
    const params: (string | number)[] = [];
    if (bucket && key) {
      query += ' WHERE bucket = ? AND key = ?';
      params.push(bucket, key);
    } else if (bucket) {
      query += ' WHERE bucket = ?';
      params.push(bucket);
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const result = await this.db.prepare(query).bind(...params).all<ShareTokenRow>();
    return result.results;
  }

  async deleteShareToken(token: string): Promise<void> {
    await this.db.prepare('DELETE FROM share_tokens WHERE token = ?').bind(token).run();
  }

  async incrementShareDownload(token: string): Promise<boolean> {
    // Atomic: increment only if download limit not yet reached
    const result = await this.db.prepare(
      `UPDATE share_tokens SET download_count = download_count + 1
       WHERE token = ? AND (max_downloads IS NULL OR download_count < max_downloads)`
    ).bind(token).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async updateShareToken(token: string, updates: Partial<Pick<ShareTokenRow, 'expires_at' | 'password_hash' | 'max_downloads' | 'note'>>): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (updates.expires_at !== undefined) { sets.push('expires_at = ?'); params.push(updates.expires_at); }
    if (updates.password_hash !== undefined) { sets.push('password_hash = ?'); params.push(updates.password_hash); }
    if (updates.max_downloads !== undefined) { sets.push('max_downloads = ?'); params.push(updates.max_downloads); }
    if (updates.note !== undefined) { sets.push('note = ?'); params.push(updates.note); }
    if (sets.length === 0) return;
    params.push(token);
    await this.db.prepare(`UPDATE share_tokens SET ${sets.join(', ')} WHERE token = ?`).bind(...params).run();
  }

  // --- Cleanup ---

  async searchObjects(bucket: string, query: string, limit = 20): Promise<ObjectRow[]> {
    // Escape LIKE meta-characters so user input like % or _ is matched literally
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const pattern = `%${escaped}%`;
    const result = await this.db.prepare(
      "SELECT * FROM objects WHERE bucket = ? AND key LIKE ? ESCAPE '\\' ORDER BY key ASC LIMIT ?"
    ).bind(bucket, pattern, limit).all<ObjectRow>();
    return result.results;
  }

  // --- Chunks ---

  async putChunk(chunk: ChunkRow): Promise<void> {
    await this.db.prepare(
      `INSERT INTO chunks (bucket, key, chunk_index, offset, size, tg_chat_id, tg_message_id, tg_file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bucket, key, chunk_index) DO UPDATE SET
         offset=excluded.offset, size=excluded.size, tg_chat_id=excluded.tg_chat_id,
         tg_message_id=excluded.tg_message_id, tg_file_id=excluded.tg_file_id`
    ).bind(chunk.bucket, chunk.key, chunk.chunk_index, chunk.offset, chunk.size,
           chunk.tg_chat_id, chunk.tg_message_id, chunk.tg_file_id).run();
  }

  async getChunks(bucket: string, key: string): Promise<ChunkRow[]> {
    const result = await this.db.prepare(
      'SELECT * FROM chunks WHERE bucket = ? AND key = ? ORDER BY chunk_index'
    ).bind(bucket, key).all<ChunkRow>();
    return result.results;
  }

  async deleteChunks(bucket: string, key: string): Promise<ChunkRow[]> {
    const chunks = await this.getChunks(bucket, key);
    if (chunks.length > 0) {
      await this.db.prepare(
        'DELETE FROM chunks WHERE bucket = ? AND key = ?'
      ).bind(bucket, key).run();
    }
    return chunks;
  }

  async cleanOrphanedChunks(limit = 100): Promise<{ count: number; chunks: ChunkRow[] }> {
    // Find chunks whose parent object no longer exists (or is not chunked)
    const orphans = await this.db.prepare(
      `SELECT c.* FROM chunks c WHERE NOT EXISTS (
        SELECT 1 FROM objects o WHERE o.bucket = c.bucket AND o.key = c.key
      ) LIMIT ?`
    ).bind(limit).all<ChunkRow>();
    if (orphans.results.length === 0) return { count: 0, chunks: [] };
    // Delete in batch by (bucket, key) pairs
    const seen = new Set<string>();
    const stmts: D1PreparedStatement[] = [];
    for (const c of orphans.results) {
      const pk = `${c.bucket}\0${c.key}`;
      if (seen.has(pk)) continue;
      seen.add(pk);
      stmts.push(this.db.prepare('DELETE FROM chunks WHERE bucket = ? AND key = ?').bind(c.bucket, c.key));
    }
    if (stmts.length > 0) await this.db.batch(stmts);
    return { count: orphans.results.length, chunks: orphans.results };
  }

  async deleteShareTokensByObject(bucket: string, key: string): Promise<number> {
    const result = await this.db.prepare(
      'DELETE FROM share_tokens WHERE bucket = ? AND key = ?'
    ).bind(bucket, key).run();
    return result.meta.changes ?? 0;
  }

  async deleteShareTokensByBucket(bucket: string): Promise<number> {
    const result = await this.db.prepare(
      'DELETE FROM share_tokens WHERE bucket = ?'
    ).bind(bucket).run();
    return result.meta.changes ?? 0;
  }

  async cleanExpiredShares(): Promise<number> {
    const now = isoNowSeconds();
    const result = await this.db.prepare(
      'DELETE FROM share_tokens WHERE expires_at IS NOT NULL AND expires_at < ?'
    ).bind(now).run();
    return result.meta.changes ?? 0;
  }

  async cleanOrphanedShares(limit = 100): Promise<number> {
    // Batched cleanup: find orphaned shares in chunks to avoid timeout on large datasets
    const orphans = await this.db.prepare(
      `SELECT token FROM share_tokens WHERE NOT EXISTS (
        SELECT 1 FROM objects WHERE objects.bucket = share_tokens.bucket AND objects.key = share_tokens.key
      ) LIMIT ?`
    ).bind(limit).all<{ token: string }>();
    if (orphans.results.length === 0) return 0;
    const placeholders = orphans.results.map(() => '?').join(',');
    const result = await this.db.prepare(
      `DELETE FROM share_tokens WHERE token IN (${placeholders})`
    ).bind(...orphans.results.map(o => o.token)).run();
    return result.meta.changes ?? 0;
  }

  // --- User Preferences ---

  async getUserPref(chatId: string, key: string): Promise<string | null> {
    const row = await this.db.prepare(
      'SELECT pref_value FROM user_preferences WHERE chat_id = ? AND pref_key = ?'
    ).bind(chatId, key).first<{ pref_value: string }>();
    return row?.pref_value ?? null;
  }

  async setUserPref(chatId: string, key: string, value: string): Promise<void> {
    await this.db.prepare(
      `INSERT INTO user_preferences (chat_id, pref_key, pref_value) VALUES (?, ?, ?)
       ON CONFLICT(chat_id, pref_key) DO UPDATE SET pref_value = excluded.pref_value`
    ).bind(chatId, key, value).run();
  }

  // --- Share Password Brute-force Protection ---

  /** 检查 IP 是否被锁定，返回剩余锁定秒数（0 = 未锁定）*/
  async checkPasswordLock(token: string, ip: string): Promise<number> {
    const row = await this.db.prepare(
      'SELECT locked_until FROM share_password_attempts WHERE token = ? AND ip = ?'
    ).bind(token, ip).first<{ locked_until: string | null }>();
    if (!row?.locked_until) return 0;
    const remaining = (new Date(row.locked_until).getTime() - Date.now()) / 1000;
    return remaining > 0 ? Math.ceil(remaining) : 0;
  }

  /** 记录一次密码验证失败。达到阈值后锁定。返回当前累计失败次数 */
  async recordPasswordFailure(token: string, ip: string, maxAttempts = 5, lockoutMinutes = 15): Promise<number> {
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const now = new Date(nowMs).toISOString();
    const lockUntil = new Date(nowMs + lockoutMinutes * 60 * 1000).toISOString();
    // Atomically increment attempts and set locked_until when threshold is reached
    await this.db.prepare(`
      INSERT INTO share_password_attempts (token, ip, attempts, last_attempt, locked_until)
      VALUES (?, ?, 1, ?, NULL)
      ON CONFLICT(token, ip) DO UPDATE SET
        attempts = share_password_attempts.attempts + 1,
        last_attempt = excluded.last_attempt,
        locked_until = CASE
          WHEN share_password_attempts.attempts + 1 >= ? THEN ?
          ELSE share_password_attempts.locked_until
        END
    `).bind(token, ip, now, maxAttempts, lockUntil).run();
    const row = await this.db.prepare(
      'SELECT attempts FROM share_password_attempts WHERE token = ? AND ip = ?'
    ).bind(token, ip).first<{ attempts: number }>();
    return row?.attempts ?? 1;
  }

  /** 密码验证成功后清除记录 */
  async clearPasswordAttempts(token: string, ip: string): Promise<void> {
    await this.db.prepare(
      'DELETE FROM share_password_attempts WHERE token = ? AND ip = ?'
    ).bind(token, ip).run();
  }

  /** Cron: 清理过期的锁定记录和超过 1 天的旧记录 */
  async cleanExpiredPasswordAttempts(): Promise<number> {
    const now = isoNowSeconds();
    const oneDayAgo = new Date(Math.floor(Date.now() / 1000) * 1000 - 86400 * 1000).toISOString();
    const result = await this.db.prepare(
      'DELETE FROM share_password_attempts WHERE (locked_until IS NOT NULL AND locked_until < ?) OR last_attempt < ?'
    ).bind(now, oneDayAgo).run();
    return result.meta.changes ?? 0;
  }

  // --- Derived Objects ---

  async getObjectsByDerivedFrom(bucket: string, derivedFrom: string): Promise<ObjectRow[]> {
    const result = await this.db.prepare(
      'SELECT * FROM objects WHERE bucket = ? AND derived_from = ?'
    ).bind(bucket, derivedFrom).all<ObjectRow>();
    return result.results;
  }

  // --- Atomic Rename ---

  async renameObject(bucket: string, oldKey: string, newKey: string): Promise<boolean> {
    const existing = await this.getObject(bucket, oldKey);
    if (!existing) return false;
    const conflict = await this.getObject(bucket, newKey);
    if (conflict) return false;
    const oldKeyLen = oldKey.length;
    await this.db.batch([
      this.db.prepare('UPDATE objects SET key = ?, last_modified = ? WHERE bucket = ? AND key = ?')
        .bind(newKey, new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), bucket, oldKey),
      // Update share tokens pointing to old key
      this.db.prepare('UPDATE share_tokens SET key = ? WHERE bucket = ? AND key = ?')
        .bind(newKey, bucket, oldKey),
      // Update derivative keys: replace oldKey prefix with newKey (must run before derived_from update)
      this.db.prepare('UPDATE objects SET key = ? || substr(key, ?) WHERE bucket = ? AND derived_from = ?')
        .bind(newKey, oldKeyLen + 1, bucket, oldKey),
      // Update derivatives derived_from
      this.db.prepare('UPDATE objects SET derived_from = ? WHERE bucket = ? AND derived_from = ?')
        .bind(newKey, bucket, oldKey),
      // Update chunks pointing to old key
      this.db.prepare('UPDATE chunks SET key = ? WHERE bucket = ? AND key = ?')
        .bind(newKey, bucket, oldKey),
    ]);
    return true;
  }

  // --- Sampling ---

  async countObjects(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) as cnt FROM objects').first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  async sampleObjects(limit = 10): Promise<ObjectRow[]> {
    const result = await this.db.prepare(
      'SELECT * FROM objects WHERE tg_file_id != \'__zero__\' ORDER BY RANDOM() LIMIT ?'
    ).bind(limit).all<ObjectRow>();
    return result.results;
  }

  async cleanStaleMultiparts(olderThanHours = 24): Promise<{ count: number; parts: MultipartPartRow[] }> {
    const cutoff = new Date(Math.floor(Date.now() / 1000) * 1000 - olderThanHours * 3600 * 1000).toISOString();
    const uploads = await this.db.prepare(
      'SELECT upload_id FROM multipart_uploads WHERE created_at < ? LIMIT 100'
    ).bind(cutoff).all<{ upload_id: string }>();

    if (uploads.results.length === 0) return { count: 0, parts: [] };

    // Batch all part SELECTs + upload/part DELETEs into a single D1 round-trip
    const stmts: D1PreparedStatement[] = [];
    for (const u of uploads.results) {
      stmts.push(this.db.prepare('SELECT * FROM multipart_parts WHERE upload_id = ? ORDER BY part_number').bind(u.upload_id));
    }
    for (const u of uploads.results) {
      stmts.push(this.db.prepare('DELETE FROM multipart_uploads WHERE upload_id = ?').bind(u.upload_id));
      stmts.push(this.db.prepare('DELETE FROM multipart_parts WHERE upload_id = ?').bind(u.upload_id));
    }
    const results = await this.db.batch(stmts);

    const allParts: MultipartPartRow[] = [];
    for (let i = 0; i < uploads.results.length; i++) {
      allParts.push(...(results[i] as D1Result<MultipartPartRow>).results);
    }
    return { count: uploads.results.length, parts: allParts };
  }
}
