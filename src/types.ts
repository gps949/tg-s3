// Environment bindings
export interface Env {
  DB: D1Database;
  TG_BOT_TOKEN: string;
  VPS_URL?: string;
  VPS_SECRET?: string;
  DEFAULT_CHAT_ID: string;
  S3_REGION: string;
  // Optional R2 bucket for hot file caching
  CACHE?: R2Bucket;
  // Worker public URL for CDN cache purging in cron (e.g. https://tg-s3.example.com)
  WORKER_URL?: string;
  // SSE-S3 master key (base64-encoded 32 bytes, generated with: openssl rand -base64 32)
  SSE_MASTER_KEY?: string;
}

// D1 row types
export interface ObjectRow {
  bucket: string;
  key: string;
  size: number;
  etag: string;
  content_type: string;
  last_modified: string;
  storage_class: string;
  tg_chat_id: string;
  tg_message_id: number;
  tg_file_id: string;
  tg_file_unique_id: string;
  user_metadata: string | null;
  system_metadata: string | null;
  derived_from: string | null;
}

export interface BucketRow {
  name: string;
  created_at: string;
  tg_chat_id: string;
  tg_topic_id: number | null;
  description: string | null;
  object_count: number;
  total_size: number;
  is_public: number;
  optimize_config: string | null;  // JSON: OptimizeConfig
  default_encryption: number;      // 0 or 1: auto-encrypt uploads with SSE-S3
}

export interface OptimizeConfig {
  enabled: boolean;
  format: 'auto' | 'webp' | 'avif';
  quality: number;    // 1-100
  maxWidth: number;   // max px, e.g. 2048
}

export interface MultipartUploadRow {
  upload_id: string;
  bucket: string;
  key: string;
  created_at: string;
  content_type: string | null;
  user_metadata: string | null;
  system_metadata: string | null;
}

export interface MultipartPartRow {
  upload_id: string;
  part_number: number;
  size: number;
  etag: string;
  tg_chat_id: string;
  tg_message_id: number;
  tg_file_id: string;
  created_at?: string;
}

export interface ShareTokenRow {
  token: string;
  bucket: string;
  key: string;
  created_at: string;
  expires_at: string | null;
  password_hash: string | null;
  max_downloads: number | null;
  download_count: number;
  creator: string | null;
  note: string | null;
}

export interface ChunkRow {
  bucket: string;
  key: string;
  chunk_index: number;
  offset: number;
  size: number;
  tg_chat_id: string;
  tg_message_id: number;
  tg_file_id: string;
}

// S3 API credential with per-bucket permissions
export interface CredentialRow {
  access_key_id: string;
  secret_access_key: string;
  name: string;
  buckets: string;       // '*' or comma-separated bucket names
  permission: string;    // 'admin' | 'readwrite' | 'readonly'
  created_at: string;
  last_used_at: string | null;
  is_active: number;
}

// Resolved credential context for authorization
export interface AuthContext {
  accessKeyId: string;
  permission: 'admin' | 'readwrite' | 'readonly';
  buckets: string[];     // ['*'] means all buckets
}

// Auth failure details (for differentiated S3 auth error responses)
export interface AuthFailure {
  code: string;
  message: string;
  status: number;
}

// S3 parsed request
export interface S3Request {
  method: string;
  bucket: string;
  key: string;
  query: URLSearchParams;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  url: URL;
}

export type S3Operation =
  | 'ListBuckets'
  | 'CreateBucket'
  | 'DeleteBucket'
  | 'HeadBucket'
  | 'GetBucketLocation'
  | 'GetBucketVersioning'
  | 'ListObjectsV2'
  | 'ListObjects'
  | 'GetObject'
  | 'PutObject'
  | 'HeadObject'
  | 'DeleteObject'
  | 'CopyObject'
  | 'DeleteObjects'
  | 'CreateMultipartUpload'
  | 'UploadPart'
  | 'UploadPartCopy'
  | 'CompleteMultipartUpload'
  | 'AbortMultipartUpload'
  | 'ListParts'
  | 'ListMultipartUploads'
  | 'GetObjectTagging'
  | 'PutObjectTagging'
  | 'DeleteObjectTagging'
  | 'GetBucketLifecycleConfiguration'
  | 'PutBucketLifecycleConfiguration'
  | 'DeleteBucketLifecycleConfiguration';

// Telegram API types
export interface TgFileResponse {
  ok: boolean;
  result: {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    file_path?: string;
  };
}

export interface TgMessageResponse {
  ok: boolean;
  result: {
    message_id: number;
    document?: {
      file_id: string;
      file_unique_id: string;
      file_size?: number;
      file_name?: string;
      mime_type?: string;
    };
  };
}

export interface TgForumTopicResponse {
  ok: boolean;
  result: {
    message_thread_id: number;
    name: string;
    icon_color: number;
  };
}

// Share types
export interface ShareOptions {
  bucket: string;
  key: string;
  expiresIn?: number;
  password?: string;
  maxDownloads?: number;
  note?: string;
}
