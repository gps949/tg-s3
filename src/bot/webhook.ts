import type { Env } from '../types';
import { handleBotCommand, resolvePendingDelete, getDefaultBucket, storeCallbackData, resolveCallbackData, listObjectsDirect, listSharesDirect, type BotReply } from './commands';
import { MetadataStore } from '../storage/metadata';
import { BOT_API_GETFILE_LIMIT } from '../constants';
import { formatSize, escHtml } from '../utils/format';
import { computeEtag } from '../utils/crypto';
import { downloadFromTelegram } from '../telegram/download';

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; first_name: string; username?: string };
    text?: string;
    caption?: string;
    document?: { file_id: string; file_unique_id: string; file_name?: string; file_size?: number; mime_type?: string };
    photo?: Array<{ file_id: string; file_unique_id: string; file_size?: number; width: number; height: number }>;
    video?: { file_id: string; file_unique_id: string; file_name?: string; file_size?: number; mime_type?: string };
    audio?: { file_id: string; file_unique_id: string; file_name?: string; file_size?: number; mime_type?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const update = await request.json() as TgUpdate;

  // Handle callback queries (inline keyboard button presses)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return new Response('ok');
  }

  if (!update.message) return new Response('ok');

  const msg = update.message;
  const chatId = msg.chat.id.toString();

  // Only process commands from private chats (not from channels/groups)
  if (msg.chat.type !== 'private') return new Response('ok');

  if (msg.text && msg.text.startsWith('/')) {
    const baseUrl = new URL(request.url).origin;
    const response = await handleBotCommand(msg.text, chatId, env, baseUrl);
    if (response) {
      if (typeof response === 'string') {
        await sendMessage(chatId, response, env);
      } else {
        if (response.keyboard) {
          await sendMessageWithKeyboard(chatId, response.text, response.keyboard, env);
        } else {
          await sendMessage(chatId, response.text, env);
        }
      }
    }
    return new Response('ok');
  }

  // Handle file uploads (document, photo, video, audio)
  const file = extractFileInfo(msg);
  if (file) {
    const baseUrl = new URL(request.url).origin;
    const result = await handleFileUpload(file, chatId, env);
    if (result.keyboard) {
      await sendMessageWithKeyboard(chatId, result.text, result.keyboard, env);
    } else {
      await sendMessage(chatId, result.text, env);
    }
    return new Response('ok');
  }

  // Non-command text or unsupported message types (sticker, voice, location, etc.)
  if (!msg.text) {
    await sendMessage(chatId, '不支持此消息类型，请发送文件、图片、视频或音频。\n输入 /help 查看帮助。', env);
  } else {
    // Plain text that's not a command
    await sendMessage(chatId, '发送文件给我即可上传，或输入 /help 查看命令列表。', env);
  }

  return new Response('ok');
}

async function handleCallbackQuery(
  cq: NonNullable<TgUpdate['callback_query']>, env: Env,
): Promise<void> {
  const data = cq.data || '';
  const chatId = cq.message?.chat.id.toString();
  const messageId = cq.message?.message_id;
  if (!chatId || !messageId) return;

  // Acknowledge callback immediately
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cq.id }),
  });

  if (data.startsWith('del_yes:')) {
    // Resolve short ID → {bucket, key} from in-memory pending map
    const shortId = data.slice(8);
    const target = resolvePendingDelete(shortId);
    if (!target) {
      await editMessage(chatId, messageId, '确认已过期，请重新操作。', env);
      return;
    }
    const { bucket, key } = target;

    // 撤销分享流程（bucket 以 __revoke__: 前缀标识）
    if (bucket.startsWith('__revoke__:')) {
      const revokeToken = bucket.slice('__revoke__:'.length);
      const store = new MetadataStore(env);
      await store.deleteShareToken(revokeToken);
      await editMessage(chatId, messageId, `已撤销分享: ${escHtml(key)}`, env);
      return;
    }

    const store = new MetadataStore(env);
    const obj = await store.getObject(bucket, key);
    if (!obj) {
      await editMessage(chatId, messageId, '文件已不存在。', env);
      return;
    }

    await store.deleteObject(bucket, key);
    const { cleanupDeletedObject } = await import('../handlers/delete-object');
    const baseUrl = env.WORKER_URL
      ? (env.WORKER_URL.startsWith('http') ? env.WORKER_URL : `https://${env.WORKER_URL}`)
      : '';
    await cleanupDeletedObject(bucket, key, obj, baseUrl, env, store);
    await editMessage(chatId, messageId, `已删除: ${escHtml(key)} (${formatSize(obj.size)})`, env);

  } else if (data.startsWith('del_no:')) {
    // Also clean up the pending entry
    const shortId = data.slice(7);
    resolvePendingDelete(shortId);
    await editMessage(chatId, messageId, '已取消删除。', env);

  } else if (data.startsWith('share:')) {
    // Quick share from upload success keyboard (resolved via shortId)
    // Directly create share instead of routing through command parser,
    // because keys with spaces would be split incorrectly by handleBotCommand.
    const resolved = resolveCallbackData(data.slice(6));
    if (!resolved) { await editMessage(chatId, messageId, '操作已过期，请重新上传。', env); return; }
    const nlIdx = resolved.indexOf('\n');
    if (nlIdx < 0) { await editMessage(chatId, messageId, '操作失败: 无效的回调数据。', env); return; }
    const bucket = resolved.slice(0, nlIdx);
    const key = resolved.slice(nlIdx + 1);
    const store = new MetadataStore(env);
    const obj = await store.getObject(bucket, key);
    if (!obj) { await editMessage(chatId, messageId, '文件不存在。', env); return; }
    const { createShareToken } = await import('../sharing/tokens');
    const share = await createShareToken({ bucket, key }, env);
    const baseUrl = env.WORKER_URL ? (env.WORKER_URL.startsWith('http') ? env.WORKER_URL : `https://${env.WORKER_URL}`) : undefined;
    const shareUrl = baseUrl ? `${baseUrl}/share/${share.token}` : `/share/${share.token}`;
    await editMessage(chatId, messageId, `<b>分享已创建</b>\nToken: <code>${share.token}</code>\n永久有效\n\n分享链接:\n${shareUrl}`, env);

  } else if (data.startsWith('info:')) {
    // Quick info from upload success keyboard — directly query DB to preserve
    // keys with consecutive whitespace (bypasses command parser split(/\s+/))
    const resolved = resolveCallbackData(data.slice(5));
    if (!resolved) { await editMessage(chatId, messageId, '操作已过期，请重新上传。', env); return; }
    const nlIdx = resolved.indexOf('\n');
    if (nlIdx < 0) { await editMessage(chatId, messageId, '操作失败: 无效的回调数据。', env); return; }
    const bucket = resolved.slice(0, nlIdx);
    const key = resolved.slice(nlIdx + 1);
    const store = new MetadataStore(env);
    const obj = await store.getObject(bucket, key);
    if (!obj) { await editMessage(chatId, messageId, '文件不存在。', env); return; }
    const text = `<b>文件信息</b>\n名称: ${escHtml(obj.key)}\nBucket: ${escHtml(obj.bucket)}\n大小: ${formatSize(obj.size)}\n类型: ${escHtml(obj.content_type)}\nETag: ${escHtml(obj.etag)}\n修改时间: ${obj.last_modified}`;
    await editMessage(chatId, messageId, text, env);

  } else if (data.startsWith('ls:')) {
    // Inline keyboard pagination — call listObjectsDirect with structured params
    // to avoid command parser collapsing empty prefix (page misinterpreted as prefix)
    const resolved = resolveCallbackData(data.slice(3));
    if (!resolved) return;
    const parts = resolved.split('\n');
    if (parts.length < 3) return;
    const bucket = parts[0];
    const prefix = parts[1];
    const page = parseInt(parts[2], 10);
    const response = await listObjectsDirect(bucket, prefix, page, env);
    if (typeof response === 'string') {
      await editMessage(chatId, messageId, response, env);
    } else {
      await editMessageWithKeyboard(chatId, messageId, response.text, response.keyboard || [], env);
    }

  } else if (data.startsWith('shares:')) {
    const resolved = resolveCallbackData(data.slice(7));
    if (!resolved) return;
    const parts = resolved.split('\n');
    if (parts.length < 2) return;
    const bucket = parts[0] || undefined;
    const page = parseInt(parts[1], 10);
    const baseUrl = env.WORKER_URL || undefined;
    const response = await listSharesDirect(bucket, page, env, baseUrl);
    if (typeof response === 'string') {
      await editMessage(chatId, messageId, response, env);
    } else {
      await editMessageWithKeyboard(chatId, messageId, response.text, response.keyboard || [], env);
    }
  }
}

interface FileInfo {
  fileId: string;
  fileUniqueId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

function extractFileInfo(msg: TgUpdate['message']): FileInfo | null {
  if (!msg) return null;
  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      fileUniqueId: msg.document.file_unique_id,
      fileName: msg.document.file_name || 'document',
      fileSize: msg.document.file_size || 0,
      mimeType: msg.document.mime_type || 'application/octet-stream',
    };
  }
  if (msg.photo && msg.photo.length > 0) {
    // Use the largest photo
    const photo = msg.photo[msg.photo.length - 1];
    return {
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      fileName: `photo_${Date.now()}.jpg`,
      fileSize: photo.file_size || 0,
      mimeType: 'image/jpeg',
    };
  }
  if (msg.video) {
    return {
      fileId: msg.video.file_id,
      fileUniqueId: msg.video.file_unique_id,
      fileName: msg.video.file_name || `video_${Date.now()}.mp4`,
      fileSize: msg.video.file_size || 0,
      mimeType: msg.video.mime_type || 'video/mp4',
    };
  }
  if (msg.audio) {
    return {
      fileId: msg.audio.file_id,
      fileUniqueId: msg.audio.file_unique_id,
      fileName: msg.audio.file_name || `audio_${Date.now()}.mp3`,
      fileSize: msg.audio.file_size || 0,
      mimeType: msg.audio.mime_type || 'audio/mpeg',
    };
  }
  return null;
}

interface UploadResponse {
  text: string;
  keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>;
}

async function handleFileUpload(file: FileInfo, chatId: string, env: Env): Promise<UploadResponse> {
  const store = new MetadataStore(env);
  const buckets = await store.listBuckets();
  if (buckets.length === 0) {
    return { text: '请先创建一个 Bucket 再上传文件。可通过 S3 API 或 Mini App 创建。' };
  }

  // Use user's preferred bucket, or fall back to the first bucket
  const preferred = await getDefaultBucket(chatId, env);
  const bucket = (preferred && buckets.find(b => b.name === preferred)) || buckets[0];

  // Size precheck: reject files >20MB when VPS is not configured (can't be downloaded via S3 API)
  if (file.fileSize > BOT_API_GETFILE_LIMIT && !env.VPS_URL) {
    return { text: '⚠️ 文件超过 20MB 且未配置 VPS，无法通过 S3 API 下载，已拒绝记录。\n如需支持大文件，请配置 VPS_URL。' };
  }

  // Check if the same file content already exists by tg_file_unique_id (content dedup)
  const dupByUid = await store.findByFileUniqueId(file.fileUniqueId);
  if (dupByUid) {
    return { text: `文件已存在（内容重复）:\n📄 ${escHtml(dupByUid.key)}\nBucket: ${escHtml(dupByUid.bucket)}` };
  }

  // Generate a unique key if file with same name exists
  const existing = await store.getObject(bucket.name, file.fileName);
  let key = file.fileName;
  if (existing) {
    const ext = file.fileName.lastIndexOf('.');
    const name = ext > 0 ? file.fileName.slice(0, ext) : file.fileName;
    const extStr = ext > 0 ? file.fileName.slice(ext) : '';
    key = `${name}_${Date.now()}${extStr}`;
  }

  // Compute ETag for S3 consistency.
  // For ≤20MB: download via TG getFile and compute real MD5.
  // For >20MB: use SHA-256 of file_unique_id to avoid downloading the entire file
  // into Worker memory (CF Workers have 128MB limit, large files would OOM).
  let etag: string;
  if (file.fileSize <= BOT_API_GETFILE_LIMIT) {
    try {
      const fileRes = await downloadFromTelegram(file.fileId, env);
      const fileData = await fileRes.arrayBuffer();
      etag = computeEtag(fileData);
    } catch {
      etag = `"${file.fileUniqueId}"`;
    }
  } else {
    // Deterministic ETag from file_unique_id (no download needed)
    const uidBytes = new TextEncoder().encode(file.fileUniqueId);
    const hash = await crypto.subtle.digest('SHA-256', uidBytes);
    const hex = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
    etag = `"${hex.slice(0, 32)}"`;
  }

  try {
    await store.putObject({
      bucket: bucket.name, key, size: file.fileSize, etag,
      contentType: file.mimeType,
      tgChatId: bucket.tg_chat_id, tgMessageId: 0,
      tgFileId: file.fileId, tgFileUniqueId: file.fileUniqueId,
    });

    const sizeStr = formatSize(file.fileSize);
    return {
      text: `已上传到 <b>${escHtml(bucket.name)}</b>\n文件: ${escHtml(key)}\n大小: ${sizeStr}`,
      keyboard: [[
        { text: '分享', callback_data: `share:${storeCallbackData(`${bucket.name}\n${key}`)}` },
        { text: '详情', callback_data: `info:${storeCallbackData(`${bucket.name}\n${key}`)}` },
      ]],
    };
  } catch (e) {
    return { text: `上传失败: ${escHtml((e as Error).message)}` };
  }
}


export async function sendMessage(chatId: string, text: string, env: Env, parseMode = 'HTML'): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`sendMessage failed (${res.status}): ${body}`);
  }
}

export async function sendMessageWithKeyboard(
  chatId: string, text: string, keyboard: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>, env: Env,
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`sendMessageWithKeyboard failed (${res.status}): ${body}`);
  }
}

async function editMessage(chatId: string, messageId: number, text: string, env: Env): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`editMessage failed (${res.status}): ${body}`);
  }
}

async function editMessageWithKeyboard(
  chatId: string, messageId: number, text: string,
  keyboard: Array<Array<{ text: string; callback_data?: string }>>, env: Env,
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`editMessageWithKeyboard failed (${res.status}): ${body}`);
  }
}

export async function registerWebhook(workerUrl: string, env: Env): Promise<boolean> {
  const webhookUrl = `${workerUrl}/bot/webhook`;
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ['message', 'callback_query'],
      secret_token: env.BEARER_TOKEN,
    }),
  });
  const data = await res.json() as { ok: boolean };
  if (!data.ok) return false;

  // Register bot commands for autocomplete in Telegram client
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'buckets', description: '列出所有 Bucket' },
        { command: 'ls', description: '列出文件 - /ls <bucket> [prefix]' },
        { command: 'info', description: '文件详情 - /info <bucket> <key>' },
        { command: 'search', description: '搜索文件 - /search <bucket> <关键词>' },
        { command: 'share', description: '创建分享 - /share <bucket> <key> [秒数] [口令] [次数]' },
        { command: 'shares', description: '列出分享 - /shares [bucket]' },
        { command: 'revoke', description: '撤销分享 - /revoke <token>' },
        { command: 'delete', description: '删除文件 - /delete <bucket> <key>' },
        { command: 'stats', description: '存储统计' },
        { command: 'setbucket', description: '设置默认上传 Bucket - /setbucket [name]' },
        { command: 'miniapp', description: '打开网盘管理面板' },
        { command: 'help', description: '帮助信息' },
      ],
    }),
  });

  return true;
}
