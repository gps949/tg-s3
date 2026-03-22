import type { Env, S3Request, ObjectRow, ShareTokenRow, AuthContext } from '../types';
import { MetadataStore } from '../storage/metadata';
import { createShareToken, validateShareToken, validateShareTokenWithCookie } from '../sharing/tokens';
import { renderSharePage, renderPasswordPage, renderExpiredPage } from '../sharing/pages';
import { downloadFromTelegram } from '../telegram/download';
import { errorResponse } from '../xml/builder';
import { BOT_API_GETFILE_LIMIT } from '../constants';
import { parseRange } from '../utils/headers';
import { detectLang } from '../i18n';
import { signShareSession, timingSafeEqual } from '../utils/crypto';

// RFC 6266 Content-Disposition with non-ASCII filename support
function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  // ASCII-only fallback: replace non-ASCII chars with underscore
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_');
  // RFC 2616 quoted-string: escape \ and " inside filename parameter
  const escapeQuoted = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // UTF-8 encoded filename per RFC 5987
  const utf8Name = encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (asciiFallback === filename) {
    return `${disposition}; filename="${escapeQuoted(filename)}"`;
  }
  return `${disposition}; filename="${escapeQuoted(asciiFallback)}"; filename*=UTF-8''${utf8Name}`;
}

// S3 extension: share management API (non-S3 standard)
// POST /api/shares - create share
// GET /api/shares - list shares
// GET /api/shares/:token - share details
// DELETE /api/shares/:token - revoke share
// PATCH /api/shares/:token - update share

export async function handleShareApi(request: Request, url: URL, env: Env, auth?: AuthContext): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  // Write operations require at least readwrite permission
  if (auth && auth.permission === 'readonly' && (method === 'POST' || method === 'DELETE' || method === 'PATCH')) {
    return Response.json({ error: 'Readonly credentials cannot modify shares' }, { status: 403 });
  }

  // POST /api/shares
  if (method === 'POST' && path === '/api/shares') {
    let body: { bucket: string; key: string; expiresIn?: number; password?: string; maxDownloads?: number; note?: string };
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (!body.bucket || !body.key) return Response.json({ error: 'bucket and key are required' }, { status: 400 });
    if (auth && !hasBucketAccess(auth, body.bucket)) return Response.json({ error: 'Access denied for this bucket' }, { status: 403 });
    if (body.expiresIn !== undefined && body.expiresIn < 1) body.expiresIn = undefined;
    if (body.maxDownloads !== undefined && body.maxDownloads < 1) body.maxDownloads = undefined;
    const store = new MetadataStore(env);
    const obj = await store.getObject(body.bucket, body.key);
    if (!obj) return Response.json({ error: 'Object not found' }, { status: 404 });
    const share = await createShareToken(body, env);
    return Response.json({ ...share, url: `${url.origin}/share/${share.token}` });
  }

  // GET /api/shares
  if (method === 'GET' && path === '/api/shares') {
    const store = new MetadataStore(env);
    const bucket = url.searchParams.get('bucket') || undefined;
    if (auth && bucket && !hasBucketAccess(auth, bucket)) return Response.json({ error: 'Access denied for this bucket' }, { status: 403 });
    const key = url.searchParams.get('key') || undefined;
    let tokens = await store.listShareTokens(bucket, key);
    // Filter results to only buckets the caller can access
    if (auth && !auth.buckets.includes('*')) {
      tokens = tokens.filter(t => hasBucketAccess(auth, t.bucket));
    }
    return Response.json(tokens);
  }

  // GET/DELETE/PATCH /api/shares/:token
  const tokenMatch = path.match(/^\/api\/shares\/([^/]+)$/);
  if (tokenMatch) {
    const token = tokenMatch[1];
    const store = new MetadataStore(env);

    if (method === 'GET') {
      const share = await store.getShareToken(token);
      if (!share) return Response.json({ error: 'Not found' }, { status: 404 });
      if (auth && !hasBucketAccess(auth, share.bucket)) return Response.json({ error: 'Access denied' }, { status: 403 });
      return Response.json(share);
    }

    if (method === 'DELETE') {
      const share = await store.getShareToken(token);
      if (share && auth && !hasBucketAccess(auth, share.bucket)) return Response.json({ error: 'Access denied' }, { status: 403 });
      await store.deleteShareToken(token);
      return new Response(null, { status: 204 });
    }

    if (method === 'PATCH') {
      const existing = await store.getShareToken(token);
      if (!existing) return Response.json({ error: 'Not found' }, { status: 404 });
      if (auth && !hasBucketAccess(auth, existing.bucket)) return Response.json({ error: 'Access denied' }, { status: 403 });
      let body: Record<string, unknown>;
      try { body = await request.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
      const updates: Partial<Pick<ShareTokenRow, 'expires_at' | 'password_hash' | 'max_downloads' | 'note'>> = {};
      if (body.expiresIn !== undefined) {
        const expiresIn = body.expiresIn as number;
        if (expiresIn >= 1) {
          const nowMs = Math.floor(Date.now() / 1000) * 1000;
          updates.expires_at = new Date(nowMs + expiresIn * 1000).toISOString();
        } else {
          updates.expires_at = null;
        }
      }
      if (body.password !== undefined) {
        if (body.password) {
          const { hashPassword } = await import('../utils/crypto');
          updates.password_hash = await hashPassword(body.password as string);
        } else {
          updates.password_hash = null;
        }
      }
      if (body.maxDownloads !== undefined) {
        const md = body.maxDownloads as number;
        updates.max_downloads = md >= 1 ? md : null;
      }
      if (body.note !== undefined) updates.note = (body.note || null) as string | null;
      await store.updateShareToken(token, updates);
      const updated = await store.getShareToken(token);
      return Response.json(updated);
    }
  }

  return Response.json({ error: 'Not found' }, { status: 404 });
}

// Public share access: GET /share/:token
export async function handleShareAccess(request: Request, url: URL, env: Env): Promise<Response> {
  const path = url.pathname;
  const tokenMatch = path.match(/^\/share\/([^/]+)(\/(.+))?$/);
  if (!tokenMatch) {
    const lang = detectLang(request);
    return new Response(renderExpiredPage('not_found', lang), {
      status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const token = tokenMatch[1];
  const action = tokenMatch[3]; // 'download' | 'inline' | 'live-video' | undefined

  const store = new MetadataStore(env);

  // Inline media and live-video: serve files for preview page embeds.
  // Don't increment download count. Check token validity (expiry + download limit).
  // If share has password, require session cookie (set after password verification).
  if (action === 'inline' || action === 'live-video') {
    const shareRow = await store.getShareToken(token);
    if (!shareRow) return new Response('Share not found', { status: 404 });
    if (shareRow.expires_at && new Date(shareRow.expires_at) < new Date()) {
      return new Response('Share expired', { status: 410 });
    }
    if (shareRow.max_downloads !== null && shareRow.download_count >= shareRow.max_downloads) {
      return new Response('Download limit reached', { status: 410 });
    }
    // Password-protected shares: verify HMAC-signed session cookie set after password entry
    if (shareRow.password_hash) {
      const cookieName = `sp_${token.slice(0, 16)}`;
      const cookies = request.headers.get('cookie') || '';
      const cookieMap = Object.fromEntries(
        cookies.split(';').map(c => c.trim().split('=').map(s => s.trim())).filter(p => p.length === 2)
      );
      const expectedCookie = await signShareSession(env.TG_BOT_TOKEN, token);
      if (!cookieMap[cookieName] || !timingSafeEqual(cookieMap[cookieName], expectedCookie)) {
        return new Response('Password required', { status: 403 });
      }
    }
    const obj = await store.getObject(shareRow.bucket, shareRow.key);
    if (!obj) return new Response('File not found', { status: 404 });

    if (action === 'live-video') {
      return serveLiveVideo(obj, shareRow, store, env);
    }
    return serveFile(obj, env, 'inline');
  }

  // Read password from POST body (form submit) or GET query (legacy/API)
  let password: string | null = url.searchParams.get('password');
  if (!password && request.method === 'POST') {
    try {
      const formData = await request.formData();
      password = formData.get('password') as string | null;
    } catch { /* not form data */ }
  }

  // If no password provided but HMAC-signed session cookie exists (set after prior password
  // verification), bypass password check by validating the share without password requirement.
  let hasSessionCookie = false;
  if (!password) {
    const cookieName = `sp_${token.slice(0, 16)}`;
    const cookies = request.headers.get('cookie') || '';
    const cookieMap = Object.fromEntries(
      cookies.split(';').map(c => c.trim().split('=').map(s => s.trim())).filter(p => p.length === 2)
    );
    const cookieValue = cookieMap[cookieName];
    if (cookieValue) {
      const expectedCookie = await signShareSession(env.TG_BOT_TOKEN, token);
      hasSessionCookie = timingSafeEqual(cookieValue, expectedCookie);
    }
  }

  const clientIp = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
  const result = hasSessionCookie
    ? await validateShareTokenWithCookie(token, env)
    : await validateShareToken(token, password, env, clientIp);
  const lang = detectLang(request);

  if (!result.valid) {
    if (result.locked && result.shareToken) {
      const lockMin = Math.ceil((result.lockSeconds ?? 0) / 60);
      return new Response(renderPasswordPage(result.shareToken, url.origin, false, lockMin, lang), {
        status: 429,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': String(result.lockSeconds ?? 900) },
      });
    }
    if (result.needsPassword && result.shareToken) {
      return new Response(renderPasswordPage(result.shareToken, url.origin, result.wrongPassword, undefined, lang, result.remainingAttempts), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    const reason = result.reason as 'expired' | 'max_downloads' | 'not_found' | undefined;
    return new Response(renderExpiredPage(reason || 'not_found', lang), {
      status: 410,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const share = result.shareToken!;
  const obj = await store.getObject(share.bucket, share.key);
  if (!obj) {
    return new Response(renderExpiredPage('not_found', lang), {
      status: 410,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // No action + browser: show HTML preview page (no download counted)
  if (!action) {
    const accept = request.headers.get('accept') || '';
    if (accept.includes('text/html')) {
      const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
      // Set HMAC-signed session cookie for password-protected shares so inline/live-video can verify
      if (share.password_hash) {
        const cookieValue = await signShareSession(env.TG_BOT_TOKEN, token);
        headers['Set-Cookie'] = `sp_${token.slice(0, 16)}=${cookieValue}; Path=/share/${token}; HttpOnly; SameSite=Lax; Secure; Max-Age=3600`;
      }
      return new Response(renderSharePage(obj, share, url.origin, lang), { headers });
    }
  }

  // Atomically increment download count BEFORE serving file (prevents TOCTOU race)
  const allowed = await store.incrementShareDownload(token);
  if (!allowed) {
    return new Response(renderExpiredPage('max_downloads', lang), {
      status: 410,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Serve the file; rollback count on failure so TG errors don't waste quota
  try {
    return await serveFile(obj, env, 'attachment', request);
  } catch {
    await store.decrementShareDownload(token);
    return new Response(renderExpiredPage('download_failed', lang), {
      status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

async function serveFile(obj: ObjectRow, env: Env, disposition: 'inline' | 'attachment', request?: Request): Promise<Response> {
  const filename = obj.key.split('/').pop() || obj.key;
  const baseHeaders: Record<string, string> = {
    'Content-Type': obj.content_type,
    'Content-Disposition': contentDisposition(disposition, filename),
    'Accept-Ranges': 'bytes',
  };
  if (disposition === 'inline') {
    baseHeaders['Cache-Control'] = 'public, max-age=86400';
  }

  const rangeHeader = request?.headers.get('range') || null;

  // 0-byte objects have no TG file to download
  if (obj.tg_file_id === '__zero__' || obj.size === 0) {
    if (rangeHeader) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': 'bytes */0' },
      });
    }
    return new Response(new ArrayBuffer(0), {
      headers: { ...baseHeaders, 'Content-Length': '0' },
    });
  }

  const range = rangeHeader ? parseRange(rangeHeader, obj.size) : null;

  // Unsatisfiable range → 416
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, 'Content-Range': `bytes */${obj.size}` },
    });
  }

  // For <=20MB files, we can support Range by slicing the buffer
  if (obj.size <= BOT_API_GETFILE_LIMIT) {
    const fileRes = await downloadFromTelegram(obj.tg_file_id, env);
    const buf = await fileRes.arrayBuffer();
    if (range) {
      const slice = buf.slice(range.start, range.end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': slice.byteLength.toString(),
          'Content-Range': `bytes ${range.start}-${range.end}/${obj.size}`,
        },
      });
    }
    return new Response(buf, {
      headers: { ...baseHeaders, 'Content-Length': obj.size.toString() },
    });
  }

  // >20MB: stream via VPS with Range support
  if (env.VPS_URL && env.VPS_SECRET) {
    const { VpsClient } = await import('../media/vps-client');
    const vps = new VpsClient(env);
    if (range) {
      const vpsRes = await vps.proxyRange(obj.tg_file_id, range.start, range.end);
      return new Response(vpsRes.body, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Length': (range.end - range.start + 1).toString(),
          'Content-Range': `bytes ${range.start}-${range.end}/${obj.size}`,
        },
      });
    }
    const fileRes = await vps.proxyGet(obj.tg_file_id);
    return new Response(fileRes.body, {
      headers: { ...baseHeaders, 'Content-Length': obj.size.toString() },
    });
  }

  // >20MB without VPS: try Bot API anyway (will likely fail, but provides correct error)
  const fileRes = await downloadFromTelegram(obj.tg_file_id, env);
  return new Response(fileRes.body, {
    headers: { ...baseHeaders, 'Content-Length': obj.size.toString() },
  });
}

async function serveLiveVideo(obj: ObjectRow, share: ShareTokenRow, store: MetadataStore, env: Env): Promise<Response> {
  if (obj.system_metadata) {
    try {
      const sysMeta = JSON.parse(obj.system_metadata);
      if (sysMeta._live_photo_video_key) {
        const videoObj = await store.getObject(share.bucket, sysMeta._live_photo_video_key);
        if (videoObj) {
          return serveFile(videoObj, env, 'inline');
        }
      }
    } catch { /* ignore */ }
  }
  return new Response('Not found', { status: 404 });
}

function hasBucketAccess(auth: AuthContext, bucket: string): boolean {
  return auth.buckets.includes('*') || auth.buckets.includes(bucket);
}
