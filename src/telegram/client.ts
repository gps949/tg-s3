import type { Env, TgFileResponse, TgMessageResponse, TgForumTopicResponse } from '../types';
import { TG_API_TIMEOUT } from '../constants';

const TG_API = 'https://api.telegram.org';
const MAX_RETRIES = 3;

export class TelegramClient {
  private token: string;
  private baseUrl: string;

  constructor(env: Env) {
    this.token = env.TG_BOT_TOKEN;
    this.baseUrl = `${TG_API}/bot${this.token}`;
  }

  async sendDocument(chatId: string, file: ArrayBuffer, filename: string, contentType: string, caption?: string, messageThreadId?: number | null): Promise<TgMessageResponse> {
    return this.withRetry(async () => {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('document', new Blob([file], { type: contentType }), filename);
      if (caption) form.append('caption', caption);
      if (messageThreadId) form.append('message_thread_id', messageThreadId.toString());

      const res = await fetch(`${this.baseUrl}/sendDocument`, {
        method: 'POST', body: form,
        signal: AbortSignal.timeout(TG_API_TIMEOUT),
      });
      await this.checkFloodWait(res);
      if (!res.ok) {
        const text = await res.text();
        throw new TgApiError(`TG sendDocument failed (${res.status}): ${text}`, res.status);
      }
      return res.json();
    });
  }

  async sendDocumentByFileId(chatId: string, fileId: string, messageThreadId?: number | null): Promise<TgMessageResponse> {
    return this.withRetry(async () => {
      const payload: Record<string, unknown> = { chat_id: chatId, document: fileId };
      if (messageThreadId) payload.message_thread_id = messageThreadId;
      const res = await fetch(`${this.baseUrl}/sendDocument`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TG_API_TIMEOUT),
      });
      await this.checkFloodWait(res);
      if (!res.ok) {
        const text = await res.text();
        throw new TgApiError(`TG sendDocument(file_id) failed (${res.status}): ${text}`, res.status);
      }
      return res.json();
    });
  }

  async getFile(fileId: string): Promise<TgFileResponse> {
    return this.withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/getFile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId }),
        signal: AbortSignal.timeout(TG_API_TIMEOUT),
      });
      await this.checkFloodWait(res);
      if (!res.ok) {
        const text = await res.text();
        throw new TgApiError(`TG getFile failed (${res.status}): ${text}`, res.status);
      }
      return res.json();
    });
  }

  getFileDownloadUrl(filePath: string): string {
    return `${TG_API}/file/bot${this.token}/${filePath}`;
  }

  async downloadFile(fileId: string): Promise<Response> {
    const fileInfo = await this.getFile(fileId);
    if (!fileInfo.ok || !fileInfo.result.file_path) {
      throw new Error('TG getFile returned no file_path');
    }
    const url = this.getFileDownloadUrl(fileInfo.result.file_path);
    const res = await fetch(url, { signal: AbortSignal.timeout(TG_API_TIMEOUT) });
    if (!res.ok) {
      throw new Error(`TG file download failed (${res.status})`);
    }
    return res;
  }

  async deleteMessage(chatId: string, messageId: number): Promise<boolean> {
    return this.withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
        signal: AbortSignal.timeout(TG_API_TIMEOUT),
      });
      await this.checkFloodWait(res);
      if (!res.ok) return false;
      const data = await res.json() as { ok: boolean };
      return data.ok;
    });
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: number, messageThreadId?: number | null): Promise<TgMessageResponse> {
    return this.withRetry(async () => {
      const payload: Record<string, unknown> = { chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId };
      if (messageThreadId) payload.message_thread_id = messageThreadId;
      const res = await fetch(`${this.baseUrl}/forwardMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TG_API_TIMEOUT),
      });
      await this.checkFloodWait(res);
      if (!res.ok) {
        const text = await res.text();
        throw new TgApiError(`TG forwardMessage failed (${res.status}): ${text}`, res.status);
      }
      return res.json();
    });
  }

  async createForumTopic(chatId: string, name: string): Promise<TgForumTopicResponse> {
    return this.withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/createForumTopic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, name }),
        signal: AbortSignal.timeout(TG_API_TIMEOUT),
      });
      await this.checkFloodWait(res);
      if (!res.ok) {
        const text = await res.text();
        throw new TgApiError(`TG createForumTopic failed (${res.status}): ${text}`, res.status);
      }
      return res.json();
    });
  }

  async deleteForumTopic(chatId: string, messageThreadId: number): Promise<boolean> {
    return this.withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/deleteForumTopic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_thread_id: messageThreadId }),
        signal: AbortSignal.timeout(TG_API_TIMEOUT),
      });
      await this.checkFloodWait(res);
      if (!res.ok) return false;
      const data = await res.json() as { ok: boolean };
      return data.ok;
    });
  }

  private async checkFloodWait(res: Response): Promise<void> {
    if (res.status === 429) {
      const body = await res.clone().json().catch(() => ({})) as { parameters?: { retry_after?: number } };
      const retryAfter = body?.parameters?.retry_after || 5;
      throw new FloodWaitError(retryAfter);
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e as Error;
        if (e instanceof FloodWaitError) {
          // Don't wait longer than 10s; CF Worker wall-time limit is 30s
          if (e.retryAfter > 10) throw e;
          const waitMs = (e.retryAfter + 1) * 1000;
          await sleep(waitMs);
          continue;
        }
        // Retry on timeout/network errors
        if (e instanceof DOMException && e.name === 'AbortError' && attempt < MAX_RETRIES - 1) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
    throw lastError!;
  }
}

export class TgApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class FloodWaitError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super(`FloodWait: retry after ${retryAfter}s`);
    this.retryAfter = retryAfter;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
