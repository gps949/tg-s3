import type { Env } from '../types';
import { VPS_PROXY_TIMEOUT, VPS_LONG_TIMEOUT } from '../constants';

export interface MediaJobRequest {
  bucket: string;
  key: string;
  tgFileId: string;
  jobType: 'image_convert' | 'video_transcode' | 'live_photo';
}

export interface MediaJobResponse {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  results?: Array<{
    key: string;
    contentType: string;
    size: number;
    tgFileId: string;
    tgMessageId: number;
  }>;
  error?: string;
}

const VPS_MAX_RETRIES = 2;

export class VpsClient {
  private baseUrl: string;
  private secret: string;

  constructor(env: Env) {
    this.baseUrl = env.VPS_URL!;
    this.secret = env.VPS_SECRET!;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.secret}`,
      'Content-Type': 'application/json',
    };
  }

  /** Retry on fast transient failures (connection refused, DNS, quick 502/503). */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < VPS_MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e as Error;
        // Only retry on network/timeout errors (not HTTP 4xx application errors)
        const isNetworkError = e instanceof TypeError; // fetch() network failure
        const isTimeout = e instanceof DOMException && e.name === 'AbortError';
        if ((isNetworkError || isTimeout) && attempt < VPS_MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastError!;
  }

  async submitJob(job: MediaJobRequest): Promise<MediaJobResponse> {
    return this.withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/api/jobs`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          bucket: job.bucket,
          key: job.key,
          tg_file_id: job.tgFileId,
          job_type: job.jobType,
        }),
        signal: AbortSignal.timeout(VPS_PROXY_TIMEOUT),
      });
      if (!res.ok) throw new Error(`VPS job submit failed: ${res.status}`);
      return res.json();
    });
  }

  async getJobStatus(jobId: string): Promise<MediaJobResponse> {
    return this.withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/api/jobs/${jobId}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(VPS_PROXY_TIMEOUT),
      });
      if (!res.ok) throw new Error(`VPS job query failed: ${res.status}`);
      return res.json();
    });
  }

  async proxyGet(fileId: string): Promise<Response> {
    return this.withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/api/proxy/get`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ file_id: fileId }),
        signal: AbortSignal.timeout(VPS_PROXY_TIMEOUT),
      });
      if (!res.ok) throw new Error(`VPS proxy get failed: ${res.status}`);
      return res;
    });
  }

  async proxyRange(fileId: string, start: number, end: number): Promise<Response> {
    return this.withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/api/proxy/range`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ file_id: fileId, start, end }),
        signal: AbortSignal.timeout(VPS_PROXY_TIMEOUT),
      });
      if (!res.ok) throw new Error(`VPS proxy range failed: ${res.status}`);
      return res;
    });
  }

  async imageResize(fileId: string, width?: string | null, format?: string | null, quality?: string | null): Promise<Response> {
    return this.withRetry(async () => {
      const params = new URLSearchParams();
      params.set('tg_file_id', fileId);
      if (width) params.set('width', width);
      if (format) params.set('format', format);
      if (quality) params.set('quality', quality);
      const res = await fetch(`${this.baseUrl}/api/image/resize?${params}`, {
        headers: { 'Authorization': `Bearer ${this.secret}` },
        signal: AbortSignal.timeout(VPS_PROXY_TIMEOUT),
      });
      if (!res.ok) throw new Error(`VPS image resize failed: ${res.status}`);
      return res;
    });
  }

  /** Stream a large file directly to VPS for upload to TG (no Worker memory buffering). */
  async proxyPutFull(
    body: ReadableStream<Uint8Array>,
    chatId: string, filename: string, contentType: string,
    contentLength: number,
    options?: {
      messageThreadId?: number | null;
      sseKeyBase64?: string;
      sseS3KeyBase64?: string;
      contentMd5?: string;
    },
  ): Promise<Response> {
    // No retry: body stream can only be consumed once
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.secret}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': contentLength.toString(),
      'X-Chat-Id': chatId,
      'X-Filename': filename,
      'X-Content-Type': contentType,
    };
    if (options?.messageThreadId) headers['X-Message-Thread-Id'] = options.messageThreadId.toString();
    if (options?.sseKeyBase64) headers['X-SSE-Key'] = options.sseKeyBase64;
    if (options?.sseS3KeyBase64) headers['X-SSE-S3-Key'] = options.sseS3KeyBase64;
    if (options?.contentMd5) headers['X-Content-MD5'] = options.contentMd5;

    const res = await fetch(`${this.baseUrl}/api/proxy/put-full`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(VPS_LONG_TIMEOUT),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`VPS proxy put-full failed (${res.status}): ${text}`);
    }
    return res;
  }

  /** Download and decrypt an encrypted file on the VPS side (streaming, no Worker memory buffering). */
  async proxyGetDecrypt(fileId: string, keyBase64: string, rangeStart?: number, rangeEnd?: number): Promise<Response> {
    return this.withRetry(async () => {
      const body: Record<string, unknown> = { file_id: fileId, key_base64: keyBase64 };
      if (rangeStart !== undefined && rangeEnd !== undefined) {
        body.range_start = rangeStart;
        body.range_end = rangeEnd;
      }
      const res = await fetch(`${this.baseUrl}/api/proxy/get-decrypt`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(VPS_LONG_TIMEOUT),
      });
      if (!res.ok) throw new Error(`VPS proxy get-decrypt failed: ${res.status}`);
      return res;
    });
  }

  async proxyPut(data: ArrayBuffer, chatId: string, filename: string, contentType: string, messageThreadId?: number | null): Promise<Response> {
    return this.withRetry(async () => {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.secret}`,
        'Content-Type': contentType,
        'X-Chat-Id': chatId,
        'X-Filename': filename,
        'X-Content-Type': contentType,
      };
      if (messageThreadId) headers['X-Message-Thread-Id'] = messageThreadId.toString();
      const res = await fetch(`${this.baseUrl}/api/proxy/put`, {
        method: 'POST',
        headers,
        body: data,
        signal: AbortSignal.timeout(VPS_LONG_TIMEOUT),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`VPS proxy put failed (${res.status}): ${text}`);
      }
      return res;
    });
  }

  async consolidate(fileIds: string[], chatId: string, filename: string, contentType: string, messageThreadId?: number | null): Promise<Response> {
    return this.withRetry(async () => {
      const res = await fetch(`${this.baseUrl}/api/proxy/consolidate`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          file_ids: fileIds,
          chat_id: chatId,
          filename,
          content_type: contentType,
          message_thread_id: messageThreadId ?? undefined,
        }),
        signal: AbortSignal.timeout(VPS_LONG_TIMEOUT),
      });
      if (!res.ok) throw new Error(`VPS consolidate failed: ${res.status}`);
      return res;
    });
  }
}
