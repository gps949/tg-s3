import type { Env } from '../types';
import { VPS_PROXY_TIMEOUT } from '../constants';

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

  async submitJob(job: MediaJobRequest): Promise<MediaJobResponse> {
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
  }

  async getJobStatus(jobId: string): Promise<MediaJobResponse> {
    const res = await fetch(`${this.baseUrl}/api/jobs/${jobId}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(VPS_PROXY_TIMEOUT),
    });
    if (!res.ok) throw new Error(`VPS job query failed: ${res.status}`);
    return res.json();
  }

  async proxyGet(fileId: string): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/api/proxy/get`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(VPS_PROXY_TIMEOUT),
    });
    if (!res.ok) throw new Error(`VPS proxy get failed: ${res.status}`);
    return res;
  }

  async proxyRange(fileId: string, start: number, end: number): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/api/proxy/range`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ file_id: fileId, start, end }),
      signal: AbortSignal.timeout(VPS_PROXY_TIMEOUT),
    });
    if (!res.ok) throw new Error(`VPS proxy range failed: ${res.status}`);
    return res;
  }

  async imageResize(fileId: string, width?: string | null, format?: string | null): Promise<Response> {
    const params = new URLSearchParams();
    params.set('tg_file_id', fileId);
    if (width) params.set('width', width);
    if (format) params.set('format', format);
    const res = await fetch(`${this.baseUrl}/api/image/resize?${params}`, {
      headers: { 'Authorization': `Bearer ${this.secret}` },
      signal: AbortSignal.timeout(VPS_PROXY_TIMEOUT),
    });
    if (!res.ok) throw new Error(`VPS image resize failed: ${res.status}`);
    return res;
  }

  async proxyPut(data: ArrayBuffer, chatId: string, filename: string, contentType: string, messageThreadId?: number | null): Promise<Response> {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('filename', filename);
    form.append('content_type', contentType);
    form.append('file', new Blob([data], { type: contentType }), filename);
    if (messageThreadId) form.append('message_thread_id', messageThreadId.toString());
    const res = await fetch(`${this.baseUrl}/api/proxy/put`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.secret}` },
      body: form,
      signal: AbortSignal.timeout(VPS_PROXY_TIMEOUT),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`VPS proxy put failed (${res.status}): ${text}`);
    }
    return res;
  }

  async consolidate(fileIds: string[], chatId: string, filename: string, contentType: string, messageThreadId?: number | null): Promise<Response> {
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
      signal: AbortSignal.timeout(VPS_PROXY_TIMEOUT),
    });
    if (!res.ok) throw new Error(`VPS consolidate failed: ${res.status}`);
    return res;
  }
}
