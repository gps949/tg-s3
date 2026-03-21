import type { Env } from '../types';
import type { Lang } from '../i18n';
import { botT } from '../i18n';
import { MetadataStore } from '../storage/metadata';
import { createShareToken } from '../sharing/tokens';
import { sendMessageWithKeyboard } from './webhook';
import { formatSize, escHtml } from '../utils/format';
import { SubscriptionStore } from '../subscription/store';
import { sendSubscriptionInvoice } from '../subscription/payment';
import { getTierLimits, PRO_STARS_PRICE } from '../subscription/tiers';
import { checkFeatureAccess } from '../subscription/middleware';

export interface BotReply {
  text: string;
  keyboard?: Array<Array<{ text: string; callback_data?: string }>>;
}


// Pending delete confirmations: short ID → {bucket, key}
// Used to avoid TG 64-byte callback_data limit truncating long bucket:key paths.
// Entries expire after 5 minutes (user must confirm within that window).
const pendingDeletes = new Map<string, { bucket: string; key: string; ts: number }>();
const PENDING_TTL = 5 * 60 * 1000;

// Generic callback data store: avoids TG 64-byte callback_data limit (which counts UTF-8 bytes)
// for share/info/ls callbacks that may contain long or non-ASCII bucket:key paths.
const pendingCallbacks = new Map<string, { data: string; ts: number }>();
const CALLBACK_TTL = 10 * 60 * 1000;

export function storeCallbackData(data: string): string {
  const id = generateShortId();
  pendingCallbacks.set(id, { data, ts: Date.now() });
  for (const [k, v] of pendingCallbacks) {
    if (Date.now() - v.ts > CALLBACK_TTL) pendingCallbacks.delete(k);
  }
  return id;
}

export function resolveCallbackData(shortId: string): string | null {
  const entry = pendingCallbacks.get(shortId);
  if (!entry) return null;
  if (Date.now() - entry.ts > CALLBACK_TTL) {
    pendingCallbacks.delete(shortId);
    return null;
  }
  return entry.data;
}

export async function getDefaultBucket(chatId: string, env: Env): Promise<string | undefined> {
  const store = new MetadataStore(env);
  const val = await store.getUserPref(chatId, 'default_bucket');
  return val ?? undefined;
}

function generateShortId(): string {
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

export function resolvePendingDelete(shortId: string): { bucket: string; key: string } | null {
  const entry = pendingDeletes.get(shortId);
  if (!entry) return null;
  pendingDeletes.delete(shortId);
  if (Date.now() - entry.ts > PENDING_TTL) return null;
  // Opportunistic cleanup of expired entries
  for (const [k, v] of pendingDeletes) {
    if (Date.now() - v.ts > PENDING_TTL) pendingDeletes.delete(k);
  }
  return { bucket: entry.bucket, key: entry.key };
}

export async function handleBotCommand(text: string, chatId: string, env: Env, baseUrl?: string, lang: Lang = 'en'): Promise<string | BotReply | null> {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@\w+$/, ''); // remove @botname suffix
  const args = parts.slice(1);

  switch (cmd) {
    case '/start':
      return botT(lang, 'start_text');

    case '/help':
      return botT(lang, 'help_text');

    case '/buckets':
      return listBucketsCmd(env, lang);

    case '/ls':
      return listObjectsCmd(args, env, lang);

    case '/info':
      return objectInfoCmd(args, env, lang);

    case '/share':
      return shareCmd(args, chatId, env, lang, baseUrl);

    case '/shares':
      return listSharesCmd(args, env, lang, baseUrl);

    case '/revoke':
      return revokeShareCmd(args, chatId, env, lang);

    case '/stats':
      return statsCmd(env, lang);

    case '/delete':
      return deleteCmd(args, chatId, env, lang);

    case '/search':
      return searchCmd(args, env, lang);

    case '/miniapp':
      return miniAppCmd(chatId, env, lang, baseUrl);

    case '/setbucket':
      return setBucketCmd(args, chatId, env, lang);

    case '/subscribe':
      return subscribeCmd(chatId, env, lang);

    case '/status':
      return statusCmd(chatId, env, lang);

    default:
      return null;
  }
}

async function listBucketsCmd(env: Env, lang: Lang): Promise<string> {
  const store = new MetadataStore(env);
  const buckets = await store.listBuckets();
  if (buckets.length === 0) return botT(lang, 'no_buckets');

  const lines = buckets.map(b => {
    const size = formatSize(b.total_size);
    const desc = b.description ? `\n  ${escHtml(b.description)}` : '';
    return botT(lang, 'bucket_item', escHtml(b.name), b.object_count, size, desc);
  });
  return lines.join('\n');
}

async function listObjectsCmd(args: string[], env: Env, lang: Lang): Promise<string | BotReply> {
  if (args.length < 1) return botT(lang, 'usage_ls');
  const bucket = args[0];
  // Last arg might be a page number
  let prefix = '';
  let page = 1;
  if (args.length >= 3 && /^\d+$/.test(args[args.length - 1])) {
    page = Math.max(1, parseInt(args[args.length - 1], 10));
    prefix = args.slice(1, -1).join(' ');
  } else {
    prefix = args.slice(1).join(' ');
  }
  return listObjectsDirect(bucket, prefix, page, env, lang);
}

/** Direct list objects with structured params (bypasses command string parsing) */
export async function listObjectsDirect(bucket: string, prefix: string, page: number, env: Env, lang: Lang = 'en'): Promise<string | BotReply> {
  const pageSize = 20;
  const store = new MetadataStore(env);
  const bucketObj = await store.getBucket(bucket);
  if (!bucketObj) return botT(lang, 'bucket_not_found', escHtml(bucket));

  // Fetch enough items to skip previous pages
  const totalFetch = page * pageSize;
  const result = await store.listObjects(bucket, prefix, '/', totalFetch);

  // Combine folders and files, then paginate
  const allItems: string[] = [];
  for (const cp of result.commonPrefixes) {
    allItems.push(`📁 ${escHtml(cp)}`);
  }
  for (const obj of result.contents) {
    const name = obj.key.slice(prefix.length);
    allItems.push(`📄 ${escHtml(name)} (${formatSize(obj.size)})`);
  }

  if (allItems.length === 0) return botT(lang, 'empty_path');

  const start = (page - 1) * pageSize;
  const pageItems = allItems.slice(start, start + pageSize);
  if (pageItems.length === 0) return botT(lang, 'page_empty', page, allItems.length);

  const totalPages = Math.ceil(allItems.length / pageSize) + (result.isTruncated ? 1 : 0);
  const header = allItems.length > pageSize || page > 1
    ? botT(lang, 'page_header', page, totalPages > 1 ? botT(lang, 'page_of', totalPages) : '')
    : '';
  const text = header + pageItems.join('\n');

  // Build inline keyboard for pagination
  const hasPrev = page > 1;
  const hasNext = start + pageSize < allItems.length || result.isTruncated;
  if (!hasPrev && !hasNext) return text;

  const buttons: Array<{ text: string; callback_data: string }> = [];
  if (hasPrev) {
    const id = storeCallbackData(`${bucket}\n${prefix}\n${page - 1}`);
    buttons.push({ text: botT(lang, 'page_prev', page - 1), callback_data: `ls:${id}` });
  }
  if (hasNext) {
    const id = storeCallbackData(`${bucket}\n${prefix}\n${page + 1}`);
    buttons.push({ text: botT(lang, 'page_next', page + 1), callback_data: `ls:${id}` });
  }
  return { text, keyboard: [buttons] };
}

async function objectInfoCmd(args: string[], env: Env, lang: Lang): Promise<string> {
  if (args.length < 2) return botT(lang, 'usage_info');
  const [bucket, ...keyParts] = args;
  const key = keyParts.join(' ');

  const store = new MetadataStore(env);
  const bucketExists = await store.getBucket(bucket);
  if (!bucketExists) return botT(lang, 'bucket_not_found', escHtml(bucket));
  const obj = await store.getObject(bucket, key);
  if (!obj) return botT(lang, 'file_not_found_hint', escHtml(bucket));

  return botT(lang, 'file_detail',
    escHtml(obj.key), escHtml(obj.bucket), formatSize(obj.size),
    escHtml(obj.content_type), escHtml(obj.etag), obj.last_modified);
}

async function shareCmd(args: string[], chatId: string, env: Env, lang: Lang, baseUrl?: string): Promise<string> {
  if (args.length < 2) return botT(lang, 'usage_share');

  // Tier enforcement: share links require Pro
  const subStore = new SubscriptionStore(env);
  const tier = await subStore.getActiveTier(chatId);
  const featureErr = checkFeatureAccess(tier, 'shareLinks');
  if (featureErr) return botT(lang, 'tier_limit_feature', 'Share links');
  const bucket = args[0];
  // Parse optional trailing params from the end to support keys with spaces.
  let keyEndIdx = args.length;
  let maxDownloads: number | undefined;
  let password: string | undefined;
  let expiresIn: number | undefined;
  if (keyEndIdx > 2 && /^\d+$/.test(args[keyEndIdx - 1])) {
    if (keyEndIdx > 4 && /^\d+$/.test(args[keyEndIdx - 3])) {
      maxDownloads = parseInt(args[keyEndIdx - 1], 10);
      password = args[keyEndIdx - 2] || undefined;
      expiresIn = parseInt(args[keyEndIdx - 3], 10);
      keyEndIdx -= 3;
    } else if (keyEndIdx > 3 && !/^\d+$/.test(args[keyEndIdx - 2])) {
      maxDownloads = parseInt(args[keyEndIdx - 1], 10);
      password = args[keyEndIdx - 2] || undefined;
      keyEndIdx -= 2;
    } else if (keyEndIdx > 2) {
      expiresIn = parseInt(args[keyEndIdx - 1], 10);
      keyEndIdx -= 1;
    }
  }
  const key = args.slice(1, keyEndIdx).join(' ');

  if (expiresIn !== undefined && expiresIn < 1) expiresIn = undefined;
  if (maxDownloads !== undefined && maxDownloads < 1) maxDownloads = undefined;

  const store = new MetadataStore(env);
  const bucketExists = await store.getBucket(bucket);
  if (!bucketExists) return botT(lang, 'bucket_not_found', escHtml(bucket));
  const obj = await store.getObject(bucket, key);
  if (!obj) return botT(lang, 'file_not_found_hint', escHtml(bucket));

  const share = await createShareToken({ bucket, key, expiresIn, password, maxDownloads }, env);
  const expiryStr = share.expires_at ? botT(lang, 'share_expires_at', share.expires_at) : botT(lang, 'share_permanent');
  const pwdStr = password ? botT(lang, 'share_pwd_set') : '';
  const dlStr = maxDownloads ? botT(lang, 'share_max_dl', maxDownloads) : '';
  const shareUrl = baseUrl ? `${baseUrl}/share/${share.token}` : `/share/${share.token}`;

  return botT(lang, 'share_created', share.token, expiryStr, pwdStr, dlStr, shareUrl);
}

async function listSharesCmd(args: string[], env: Env, lang: Lang, baseUrl?: string): Promise<string | BotReply> {
  const bucket = args[0] || undefined;
  return listSharesDirect(bucket, 1, env, baseUrl, lang);
}

/** Direct list shares with page parameter (for callback pagination) */
export async function listSharesDirect(bucket: string | undefined, page: number, env: Env, baseUrl?: string, lang: Lang = 'en'): Promise<string | BotReply> {
  const pageSize = 20;
  const store = new MetadataStore(env);
  const tokens = await store.listShareTokens(bucket);

  if (tokens.length === 0) return botT(lang, 'no_shares');

  const start = (page - 1) * pageSize;
  const shown = tokens.slice(start, start + pageSize);
  if (shown.length === 0) return botT(lang, 'shares_page_empty', page, tokens.length);

  const totalPages = Math.ceil(tokens.length / pageSize);
  const header = totalPages > 1 ? botT(lang, 'page_header', page, botT(lang, 'page_of', totalPages)) : '';

  const lines = shown.map(t => {
    const expired = t.expires_at && new Date(t.expires_at) < new Date() ? botT(lang, 'share_expired_tag') : '';
    const dl = t.max_downloads !== null
      ? botT(lang, 'share_dl_limited', t.download_count, t.max_downloads)
      : botT(lang, 'share_dl_unlimited', t.download_count);
    const link = baseUrl ? `\n  ${baseUrl}/share/${t.token}` : '';
    return `🔗 ${escHtml(t.key)}${dl}${expired}\n  <code>${t.token}</code>${link}`;
  });

  const text = header + lines.join('\n');

  const hasPrev = page > 1;
  const hasNext = start + pageSize < tokens.length;
  if (!hasPrev && !hasNext) return text;

  const buttons: Array<{ text: string; callback_data: string }> = [];
  if (hasPrev) {
    const id = storeCallbackData(`${bucket || ''}\n${page - 1}`);
    buttons.push({ text: botT(lang, 'page_prev', page - 1), callback_data: `shares:${id}` });
  }
  if (hasNext) {
    const id = storeCallbackData(`${bucket || ''}\n${page + 1}`);
    buttons.push({ text: botT(lang, 'page_next', page + 1), callback_data: `shares:${id}` });
  }
  return { text, keyboard: [buttons] };
}

async function revokeShareCmd(args: string[], chatId: string, env: Env, lang: Lang): Promise<string | BotReply | null> {
  if (args.length < 1) return botT(lang, 'usage_revoke');
  const store = new MetadataStore(env);
  const token = args[0];
  const existing = await store.getShareToken(token);
  if (!existing) return botT(lang, 'share_token_not_found');

  const shortId = generateShortId();
  pendingDeletes.set(shortId, { bucket: `__revoke__:${token}`, key: existing.key, ts: Date.now() });
  await sendMessageWithKeyboard(chatId,
    botT(lang, 'revoke_confirm', escHtml(existing.key), escHtml(existing.bucket), token.slice(0, 16)),
    [[
      { text: botT(lang, 'btn_confirm_revoke'), callback_data: `del_yes:${shortId}` },
      { text: botT(lang, 'btn_cancel'), callback_data: `del_no:${shortId}` },
    ]],
    env,
  );
  return null;
}

async function statsCmd(env: Env, lang: Lang): Promise<string> {
  const store = new MetadataStore(env);
  const buckets = await store.listBuckets();
  const totalFiles = buckets.reduce((s, b) => s + b.object_count, 0);
  const totalSize = buckets.reduce((s, b) => s + b.total_size, 0);

  return botT(lang, 'stats_text', buckets.length, totalFiles, formatSize(totalSize));
}

async function deleteCmd(args: string[], chatId: string, env: Env, lang: Lang): Promise<string | null> {
  if (args.length < 2) return botT(lang, 'usage_delete');
  const bucket = args[0];
  const key = args.slice(1).join(' ');

  const store = new MetadataStore(env);
  const bucketExists = await store.getBucket(bucket);
  if (!bucketExists) return botT(lang, 'bucket_not_found', escHtml(bucket));
  const obj = await store.getObject(bucket, key);
  if (!obj) return botT(lang, 'file_not_found');

  // Send confirmation with inline keyboard
  const shortId = generateShortId();
  pendingDeletes.set(shortId, { bucket, key, ts: Date.now() });
  const cbData = `del_yes:${shortId}`;
  const cbCancel = `del_no:${shortId}`;
  await sendMessageWithKeyboard(chatId,
    botT(lang, 'delete_confirm', escHtml(key), formatSize(obj.size), escHtml(bucket)),
    [[
      { text: botT(lang, 'btn_confirm_delete'), callback_data: cbData },
      { text: botT(lang, 'btn_cancel'), callback_data: cbCancel },
    ]],
    env,
  );
  return null; // Already sent the message with keyboard
}

async function searchCmd(args: string[], env: Env, lang: Lang): Promise<string> {
  if (args.length < 2) return botT(lang, 'usage_search');
  const bucket = args[0];
  const query = args.slice(1).join(' ');

  const store = new MetadataStore(env);
  const bucketExists = await store.getBucket(bucket);
  if (!bucketExists) return botT(lang, 'bucket_not_found', escHtml(bucket));
  const results = await store.searchObjects(bucket, query, 21);

  if (results.length === 0) return botT(lang, 'search_no_result', escHtml(query));

  const hasMore = results.length > 20;
  const shown = hasMore ? results.slice(0, 20) : results;
  const lines = shown.map(obj => {
    return `📄 ${escHtml(obj.key)} (${formatSize(obj.size)})`;
  });

  if (hasMore) lines.push(botT(lang, 'search_more'));
  return botT(lang, 'search_title', hasMore ? '20+' : String(shown.length)) + lines.join('\n');
}

async function setBucketCmd(args: string[], chatId: string, env: Env, lang: Lang): Promise<string> {
  const store = new MetadataStore(env);
  const buckets = await store.listBuckets();

  if (args.length < 1) {
    const current = await store.getUserPref(chatId, 'default_bucket');
    const currentStr = current ? botT(lang, 'setbucket_current', escHtml(current)) : botT(lang, 'setbucket_none');
    const bucketList = buckets.map(b => `  <code>${escHtml(b.name)}</code>`).join('\n');
    return botT(lang, 'setbucket_usage', currentStr, bucketList);
  }

  const name = args[0];
  const exists = buckets.find(b => b.name === name);
  if (!exists) return botT(lang, 'setbucket_not_found', escHtml(name));

  await store.setUserPref(chatId, 'default_bucket', name);
  return botT(lang, 'setbucket_done', escHtml(name));
}

async function subscribeCmd(chatId: string, env: Env, lang: Lang): Promise<string | null> {
  const subStore = new SubscriptionStore(env);
  const tier = await subStore.getActiveTier(chatId);

  if (tier === 'pro') {
    const sub = await subStore.getSubscription(chatId);
    const expiresAt = sub?.expires_at ? new Date(sub.expires_at).toLocaleDateString() : '?';
    return botT(lang, 'already_pro', expiresAt);
  }

  // Send Stars invoice
  const success = await sendSubscriptionInvoice(chatId, env);
  if (!success) {
    return botT(lang, 'invoice_failed');
  }
  return null; // Invoice sent as a separate message
}

async function statusCmd(chatId: string, env: Env, lang: Lang): Promise<string> {
  const subStore = new SubscriptionStore(env);
  const tier = await subStore.getActiveTier(chatId);
  const sub = await subStore.getSubscription(chatId);
  const limits = getTierLimits(tier);

  const store = new MetadataStore(env);
  const allBuckets = await store.listBuckets();
  // Count user's buckets (owned or legacy)
  const userBuckets = allBuckets.filter(b => !b.owner_user_id || b.owner_user_id === chatId);
  const totalFiles = userBuckets.reduce((s, b) => s + b.object_count, 0);
  const totalSize = userBuckets.reduce((s, b) => s + b.total_size, 0);

  let statusText = botT(lang, 'status_header', tier.toUpperCase());
  if (tier === 'pro' && sub?.expires_at) {
    statusText += botT(lang, 'status_expires', new Date(sub.expires_at).toLocaleDateString());
  }
  statusText += botT(lang, 'status_usage',
    userBuckets.length, limits.maxBuckets || '∞',
    totalFiles, limits.maxFilesPerBucket || '∞',
    formatSize(totalSize),
  );
  statusText += botT(lang, 'status_features',
    limits.encryption ? '✅' : '❌',
    limits.imageOptimization ? '✅' : '❌',
    limits.customCredentials ? '✅' : '❌',
    limits.shareLinks ? '✅' : '❌',
  );

  if (tier === 'free') {
    statusText += botT(lang, 'status_upgrade_hint', PRO_STARS_PRICE);
  }

  return statusText;
}

async function miniAppCmd(chatId: string, env: Env, lang: Lang, baseUrl?: string): Promise<string | null> {
  if (baseUrl) {
    const miniAppUrl = `${baseUrl}/miniapp`;
    await sendMessageWithKeyboard(chatId, botT(lang, 'miniapp_open'), [[
      { text: botT(lang, 'btn_miniapp'), web_app: { url: miniAppUrl } },
    ]], env);
    return null;
  }
  return botT(lang, 'miniapp_fallback');
}
