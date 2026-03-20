import type { Env } from '../types';
import { TelegramClient } from './client';
import { getRateLimiter } from '../rate-limit/limiter';
import { BOT_API_GETFILE_LIMIT, VPS_SINGLE_FILE_MAX } from '../constants';
import { formatSize } from '../utils/format';

export interface UploadResult {
  tgChatId: string;
  tgMessageId: number;
  tgFileId: string;
  tgFileUniqueId: string;
}

export async function uploadToTelegram(
  data: ArrayBuffer,
  chatId: string,
  filename: string,
  contentType: string,
  env: Env,
  messageThreadId?: number | null,
): Promise<UploadResult> {
  const size = data.byteLength;
  const maxSize = env.VPS_URL ? VPS_SINGLE_FILE_MAX : BOT_API_GETFILE_LIMIT;

  if (size > maxSize) {
    const limitStr = env.VPS_URL ? '2GB' : '20MB';
    throw new FileTooLargeError(size, maxSize, limitStr);
  }

  // <=20MB: Worker directly via Bot API
  if (size <= BOT_API_GETFILE_LIMIT) {
    return uploadDirect(data, chatId, filename, contentType, env, messageThreadId);
  }

  // 20MB - 2GB: VPS single file upload via Local Bot API
  return uploadViaVps(data, chatId, filename, contentType, env, messageThreadId);
}

async function uploadDirect(
  data: ArrayBuffer, chatId: string, filename: string, contentType: string,
  env: Env, messageThreadId?: number | null,
): Promise<UploadResult> {
  const limiter = getRateLimiter();
  if (!limiter.tryConsume(chatId)) {
    throw new RateLimitError(limiter.getRetryAfter(chatId));
  }

  const tg = new TelegramClient(env);
  const res = await tg.sendDocument(chatId, data, filename, contentType, undefined, messageThreadId);
  const doc = res.result.document;
  if (!doc) throw new Error('TG response missing document');

  return {
    tgChatId: chatId,
    tgMessageId: res.result.message_id,
    tgFileId: doc.file_id,
    tgFileUniqueId: doc.file_unique_id,
  };
}

async function uploadViaVps(
  data: ArrayBuffer, chatId: string, filename: string, contentType: string, env: Env,
  messageThreadId?: number | null,
): Promise<UploadResult> {
  const { VpsClient } = await import('../media/vps-client');
  const vps = new VpsClient(env);
  const res = await vps.proxyPut(data, chatId, filename, contentType, messageThreadId);
  return res.json();
}

export class RateLimitError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super('Rate limited');
    this.retryAfter = retryAfter;
  }
}

export class FileTooLargeError extends Error {
  size: number;
  maxSize: number;
  constructor(size: number, maxSize: number, limitStr: string) {
    super(`File size ${formatSize(size)} exceeds maximum ${limitStr}`);
    this.size = size;
    this.maxSize = maxSize;
  }
}

