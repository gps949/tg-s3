import type { Env } from '../types';
import { MetadataStore } from '../storage/metadata';
import { createShareToken } from '../sharing/tokens';
import { sendMessageWithKeyboard } from './webhook';
import { formatSize, escHtml } from '../utils/format';

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

export async function handleBotCommand(text: string, chatId: string, env: Env, baseUrl?: string): Promise<string | BotReply | null> {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@\w+$/, ''); // remove @botname suffix
  const args = parts.slice(1);

  switch (cmd) {
    case '/start':
      return startText();

    case '/help':
      return helpText();

    case '/buckets':
      return listBucketsCmd(env);

    case '/ls':
      return listObjectsCmd(args, env);

    case '/info':
      return objectInfoCmd(args, env);

    case '/share':
      return shareCmd(args, env, baseUrl);

    case '/shares':
      return listSharesCmd(args, env, baseUrl);

    case '/revoke':
      return revokeShareCmd(args, chatId, env);

    case '/stats':
      return statsCmd(env);

    case '/delete':
      return deleteCmd(args, chatId, env);

    case '/search':
      return searchCmd(args, env);

    case '/miniapp':
      return miniAppCmd(chatId, env, baseUrl);

    case '/setbucket':
      return setBucketCmd(args, chatId, env);

    default:
      return null;
  }
}

function startText(): string {
  return `欢迎使用 <b>tg-s3</b> - 基于 Telegram 的 S3 兼容存储。

<b>快速上手</b>
1. 直接发送文件给我，自动上传到默认 Bucket
2. 使用 /ls 查看文件，/share 创建分享链接
3. 使用 /miniapp 打开网盘管理面板

支持 S3 API (rclone/aws cli)、Bot 管理、Mini App 三种访问方式。
输入 /help 查看完整命令列表。`;
}

function helpText(): string {
  return `<b>tg-s3 Bot</b>

<b>Bucket 管理</b>
/buckets - 列出所有 Bucket
/stats - 存储统计

<b>文件操作</b>
/ls &lt;bucket&gt; [prefix] [页码] - 列出文件
  例: <code>/ls photos 2024/</code>  <code>/ls photos 2024/ 2</code>
/info &lt;bucket&gt; &lt;key&gt; - 文件详情
  例: <code>/info docs report.pdf</code>
/delete &lt;bucket&gt; &lt;key&gt; - 删除文件
  例: <code>/delete docs old-report.pdf</code>
/search &lt;bucket&gt; &lt;关键词&gt; - 搜索文件
  例: <code>/search photos sunset</code>

<b>分享管理</b>
/share &lt;bucket&gt; &lt;key&gt; [秒数] [口令] [最大次数] - 创建分享
  例: <code>/share docs report.pdf 86400 mypass 10</code>
  (86400秒=1天, 口令和次数可选)
/shares [bucket] - 列出分享
/revoke &lt;token&gt; - 撤销分享

<b>管理面板</b>
/miniapp - 打开网盘管理 Mini App
/setbucket [bucket] - 设置默认上传 Bucket`;
}

async function listBucketsCmd(env: Env): Promise<string> {
  const store = new MetadataStore(env);
  const buckets = await store.listBuckets();
  if (buckets.length === 0) return '暂无 Bucket。';

  const lines = buckets.map(b => {
    const size = formatSize(b.total_size);
    const desc = b.description ? `\n  ${escHtml(b.description)}` : '';
    return `📁 <b>${escHtml(b.name)}</b> - ${b.object_count} 个文件, ${size}${desc}`;
  });
  return lines.join('\n');
}

async function listObjectsCmd(args: string[], env: Env): Promise<string | BotReply> {
  if (args.length < 1) return '用法: /ls &lt;bucket&gt; [prefix] [页码]\n例: <code>/ls photos 2024/ 2</code>';
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
  return listObjectsDirect(bucket, prefix, page, env);
}

/** Direct list objects with structured params (bypasses command string parsing) */
export async function listObjectsDirect(bucket: string, prefix: string, page: number, env: Env): Promise<string | BotReply> {
  const pageSize = 20;
  const store = new MetadataStore(env);
  const bucketObj = await store.getBucket(bucket);
  if (!bucketObj) return `Bucket <b>${escHtml(bucket)}</b> 不存在。使用 /buckets 查看已有 Bucket。`;

  // Fetch enough items to skip previous pages
  // For simplicity with delimiter grouping, we fetch all up to page*pageSize and take the last pageSize
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

  if (allItems.length === 0) return '该路径下无文件。';

  const start = (page - 1) * pageSize;
  const pageItems = allItems.slice(start, start + pageSize);
  if (pageItems.length === 0) return `第 ${page} 页无内容，共 ${allItems.length} 项。`;

  const totalPages = Math.ceil(allItems.length / pageSize) + (result.isTruncated ? 1 : 0);
  const header = allItems.length > pageSize || page > 1
    ? `[第 ${page} 页${totalPages > 1 ? ` / 约 ${totalPages} 页` : ''}]\n`
    : '';
  const text = header + pageItems.join('\n');

  // Build inline keyboard for pagination
  const hasPrev = page > 1;
  const hasNext = start + pageSize < allItems.length || result.isTruncated;
  if (!hasPrev && !hasNext) return text;

  const buttons: Array<{ text: string; callback_data: string }> = [];
  if (hasPrev) {
    const id = storeCallbackData(`${bucket}\n${prefix}\n${page - 1}`);
    buttons.push({ text: `« 第 ${page - 1} 页`, callback_data: `ls:${id}` });
  }
  if (hasNext) {
    const id = storeCallbackData(`${bucket}\n${prefix}\n${page + 1}`);
    buttons.push({ text: `第 ${page + 1} 页 »`, callback_data: `ls:${id}` });
  }
  return { text, keyboard: [buttons] };
}

async function objectInfoCmd(args: string[], env: Env): Promise<string> {
  if (args.length < 2) return '用法: /info <bucket> <key>';
  const [bucket, ...keyParts] = args;
  const key = keyParts.join(' ');

  const store = new MetadataStore(env);
  const bucketExists = await store.getBucket(bucket);
  if (!bucketExists) return `Bucket <b>${escHtml(bucket)}</b> 不存在。使用 /buckets 查看已有 Bucket。`;
  const obj = await store.getObject(bucket, key);
  if (!obj) return `文件不存在。使用 <code>/ls ${escHtml(bucket)}</code> 查看文件列表。`;

  return `<b>文件信息</b>
名称: ${escHtml(obj.key)}
Bucket: ${escHtml(obj.bucket)}
大小: ${formatSize(obj.size)}
类型: ${escHtml(obj.content_type)}
ETag: ${escHtml(obj.etag)}
修改时间: ${obj.last_modified}`;
}

async function shareCmd(args: string[], env: Env, baseUrl?: string): Promise<string> {
  if (args.length < 2) return '用法: /share &lt;bucket&gt; &lt;key&gt; [时效秒数] [口令] [最大次数]\n例: <code>/share docs report.pdf</code> (永久)\n例: <code>/share docs report.pdf 86400</code> (1天)\n例: <code>/share docs report.pdf 86400 mypass 10</code>';
  const bucket = args[0];
  // Parse optional trailing params from the end to support keys with spaces.
  // Pattern: <key...> [expiresIn(numeric)] [password] [maxDownloads(numeric)]
  let keyEndIdx = args.length;
  let maxDownloads: number | undefined;
  let password: string | undefined;
  let expiresIn: number | undefined;
  // maxDownloads: last arg if numeric
  if (keyEndIdx > 2 && /^\d+$/.test(args[keyEndIdx - 1])) {
    // Could be maxDownloads, expiresIn, or part of key — check context
    // If 3+ trailing args look like [number, string, number], parse as options
    if (keyEndIdx > 4 && /^\d+$/.test(args[keyEndIdx - 3])) {
      maxDownloads = parseInt(args[keyEndIdx - 1], 10);
      password = args[keyEndIdx - 2] || undefined;
      expiresIn = parseInt(args[keyEndIdx - 3], 10);
      keyEndIdx -= 3;
    } else if (keyEndIdx > 3 && !/^\d+$/.test(args[keyEndIdx - 2])) {
      // [string, number] → password + maxDownloads
      maxDownloads = parseInt(args[keyEndIdx - 1], 10);
      password = args[keyEndIdx - 2] || undefined;
      keyEndIdx -= 2;
    } else if (keyEndIdx > 2) {
      // Single trailing number → expiresIn (most common: /share bucket key 86400)
      expiresIn = parseInt(args[keyEndIdx - 1], 10);
      keyEndIdx -= 1;
    }
  }
  const key = args.slice(1, keyEndIdx).join(' ');

  const store = new MetadataStore(env);
  const bucketExists = await store.getBucket(bucket);
  if (!bucketExists) return `Bucket <b>${escHtml(bucket)}</b> 不存在。使用 /buckets 查看已有 Bucket。`;
  const obj = await store.getObject(bucket, key);
  if (!obj) return `文件不存在。使用 <code>/ls ${escHtml(bucket)}</code> 查看文件列表。`;

  const share = await createShareToken({ bucket, key, expiresIn, password, maxDownloads }, env);
  const expiryStr = share.expires_at ? `\n有效期至: ${share.expires_at}` : '\n永久有效';
  const pwdStr = password ? '\n口令: 已设置' : '';
  const dlStr = maxDownloads ? `\n下载限制: ${maxDownloads} 次` : '';
  const shareUrl = baseUrl ? `${baseUrl}/share/${share.token}` : `/share/${share.token}`;

  return `<b>分享已创建</b>
Token: <code>${share.token}</code>${expiryStr}${pwdStr}${dlStr}

分享链接:
${shareUrl}`;
}

async function listSharesCmd(args: string[], env: Env, baseUrl?: string): Promise<string | BotReply> {
  const bucket = args[0] || undefined;
  return listSharesDirect(bucket, 1, env, baseUrl);
}

/** Direct list shares with page parameter (for callback pagination) */
export async function listSharesDirect(bucket: string | undefined, page: number, env: Env, baseUrl?: string): Promise<string | BotReply> {
  const pageSize = 20;
  const store = new MetadataStore(env);
  const tokens = await store.listShareTokens(bucket);

  if (tokens.length === 0) return '暂无分享。';

  const start = (page - 1) * pageSize;
  const shown = tokens.slice(start, start + pageSize);
  if (shown.length === 0) return `第 ${page} 页无内容，共 ${tokens.length} 个分享。`;

  const totalPages = Math.ceil(tokens.length / pageSize);
  const header = totalPages > 1 ? `[第 ${page} 页 / ${totalPages} 页]\n` : '';

  const lines = shown.map(t => {
    const expired = t.expires_at && new Date(t.expires_at) < new Date() ? ' [已过期]' : '';
    const dl = t.max_downloads !== null ? ` (${t.download_count}/${t.max_downloads})` : ` (${t.download_count}次)`;
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
    buttons.push({ text: `« 第 ${page - 1} 页`, callback_data: `shares:${id}` });
  }
  if (hasNext) {
    const id = storeCallbackData(`${bucket || ''}\n${page + 1}`);
    buttons.push({ text: `第 ${page + 1} 页 »`, callback_data: `shares:${id}` });
  }
  return { text, keyboard: [buttons] };
}

async function revokeShareCmd(args: string[], chatId: string, env: Env): Promise<string | BotReply | null> {
  if (args.length < 1) return '用法: /revoke &lt;token&gt;';
  const store = new MetadataStore(env);
  const token = args[0];
  const existing = await store.getShareToken(token);
  if (!existing) return '分享 Token 不存在。';

  // 二次确认（与 /delete 行为一致）
  const shortId = generateShortId();
  pendingDeletes.set(shortId, { bucket: `__revoke__:${token}`, key: existing.key, ts: Date.now() });
  await sendMessageWithKeyboard(chatId,
    `确认撤销分享?\n\n🔗 ${escHtml(existing.key)}\nBucket: ${escHtml(existing.bucket)}\nToken: <code>${token.slice(0, 16)}...</code>\n\n⏱ 请在 5 分钟内确认`,
    [[
      { text: '确认撤销', callback_data: `del_yes:${shortId}` },
      { text: '取消', callback_data: `del_no:${shortId}` },
    ]],
    env,
  );
  return null;
}

async function statsCmd(env: Env): Promise<string> {
  const store = new MetadataStore(env);
  const buckets = await store.listBuckets();
  const totalFiles = buckets.reduce((s, b) => s + b.object_count, 0);
  const totalSize = buckets.reduce((s, b) => s + b.total_size, 0);

  return `<b>存储统计</b>
Bucket 数: ${buckets.length}
文件总数: ${totalFiles}
总大小: ${formatSize(totalSize)}`;
}

async function deleteCmd(args: string[], chatId: string, env: Env): Promise<string | null> {
  if (args.length < 2) return '用法: /delete &lt;bucket&gt; &lt;key&gt;';
  const bucket = args[0];
  const key = args.slice(1).join(' ');

  const store = new MetadataStore(env);
  const bucketExists = await store.getBucket(bucket);
  if (!bucketExists) return `Bucket <b>${escHtml(bucket)}</b> 不存在。使用 /buckets 查看已有 Bucket。`;
  const obj = await store.getObject(bucket, key);
  if (!obj) return '文件不存在。';

  // Send confirmation with inline keyboard
  // Use short ID to avoid TG 64-byte callback_data limit truncating long paths
  const shortId = generateShortId();
  pendingDeletes.set(shortId, { bucket, key, ts: Date.now() });
  const cbData = `del_yes:${shortId}`;
  const cbCancel = `del_no:${shortId}`;
  await sendMessageWithKeyboard(chatId,
    `确认删除?\n\n📄 ${escHtml(key)}\n大小: ${formatSize(obj.size)}\nBucket: ${escHtml(bucket)}\n\n⏱ 请在 5 分钟内确认，超时需重新操作`,
    [[
      { text: '确认删除', callback_data: cbData },
      { text: '取消', callback_data: cbCancel },
    ]],
    env,
  );
  return null; // Already sent the message with keyboard
}

async function searchCmd(args: string[], env: Env): Promise<string> {
  if (args.length < 2) return '用法: /search &lt;bucket&gt; &lt;关键词&gt;';
  const bucket = args[0];
  const query = args.slice(1).join(' ');

  const store = new MetadataStore(env);
  const bucketExists = await store.getBucket(bucket);
  if (!bucketExists) return `Bucket <b>${escHtml(bucket)}</b> 不存在。使用 /buckets 查看已有 Bucket。`;
  const results = await store.searchObjects(bucket, query, 21);

  if (results.length === 0) return `未找到匹配「${escHtml(query)}」的文件。`;

  const hasMore = results.length > 20;
  const shown = hasMore ? results.slice(0, 20) : results;
  const lines = shown.map(obj => {
    return `📄 ${escHtml(obj.key)} (${formatSize(obj.size)})`;
  });

  if (hasMore) lines.push('\n... 还有更多结果，请使用更精确的关键词缩小范围');
  return `<b>搜索结果</b> (${hasMore ? '20+' : shown.length} 个)\n\n` + lines.join('\n');
}

async function setBucketCmd(args: string[], chatId: string, env: Env): Promise<string> {
  const store = new MetadataStore(env);
  const buckets = await store.listBuckets();

  if (args.length < 1) {
    const current = await store.getUserPref(chatId, 'default_bucket');
    const currentStr = current ? `当前默认: <b>${escHtml(current)}</b>` : '未设置 (使用第一个 Bucket)';
    const bucketList = buckets.map(b => `  <code>${escHtml(b.name)}</code>`).join('\n');
    return `${currentStr}\n\n用法: /setbucket [bucket名]\n\n可用 Bucket:\n${bucketList}`;
  }

  const name = args[0];
  const exists = buckets.find(b => b.name === name);
  if (!exists) return `Bucket「${escHtml(name)}」不存在。使用 /buckets 查看可用列表。`;

  await store.setUserPref(chatId, 'default_bucket', name);
  return `已设置默认上传 Bucket: <b>${escHtml(name)}</b>`;
}

async function miniAppCmd(chatId: string, env: Env, baseUrl?: string): Promise<string | null> {
  if (baseUrl) {
    const miniAppUrl = `${baseUrl}/miniapp`;
    await sendMessageWithKeyboard(chatId, '点击下方按钮打开网盘管理面板。', [[
      { text: '打开 Mini App', web_app: { url: miniAppUrl } },
    ]], env);
    return null;
  }
  return '无法获取 Mini App 地址，请通过浏览器直接访问 /miniapp 路径。';
}

