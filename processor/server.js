import express from 'express';
import { createReadStream, createWriteStream, unlinkSync, existsSync, mkdirSync } from 'fs';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const AUTH_SECRET = process.env.AUTH_SECRET;
const TG_API = process.env.TG_LOCAL_API || 'https://api.telegram.org';
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/tg-s3-processor';

// Validate required env vars at startup to fail fast
const REQUIRED_ENV = { TG_BOT_TOKEN: BOT_TOKEN, AUTH_SECRET };
for (const [name, value] of Object.entries(REQUIRED_ENV)) {
  if (!value) { console.error(`FATAL: ${name} is not set`); process.exit(1); }
}

if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });

// Auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${AUTH_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(express.json({ limit: '50mb' }));
app.use(authMiddleware);

// --- Job queue (in-memory) ---
const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Periodically purge completed/failed jobs older than TTL
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if ((job.status === 'completed' || job.status === 'failed') && job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000); // Every 5 minutes

app.post('/api/jobs', async (req, res) => {
  const { bucket, key, tg_file_id, job_type } = req.body;
  const jobId = randomUUID();

  jobs.set(jobId, { status: 'queued', bucket, key, tg_file_id, job_type, results: null, error: null });
  res.json({ jobId, status: 'queued' });

  // Process async
  processJob(jobId).catch(err => {
    const job = jobs.get(jobId);
    if (job) { job.status = 'failed'; job.error = err.message; job.finishedAt = Date.now(); }
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ jobId: req.params.id, ...job });
});

// --- Proxy endpoints ---

// Download file from TG via Local Bot API
app.post('/api/proxy/get', async (req, res) => {
  try {
    const { file_id } = req.body;
    const filePath = await getFilePath(file_id);
    const url = `${TG_API}/file/bot${BOT_TOKEN}/${filePath}`;
    const tgRes = await fetch(url);
    if (!tgRes.ok) return res.status(502).json({ error: `TG download failed: ${tgRes.status}` });

    res.set('Content-Type', tgRes.headers.get('content-type') || 'application/octet-stream');
    if (tgRes.headers.get('content-length')) res.set('Content-Length', tgRes.headers.get('content-length'));

    const reader = tgRes.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); return; }
        res.write(Buffer.from(value));
      }
    };
    await pump();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload file to TG via Local Bot API
app.post('/api/proxy/put', express.raw({ type: '*/*', limit: '2gb' }), async (req, res) => {
  try {
    const chatId = req.headers['x-chat-id'] || req.query.chat_id;
    const filename = req.headers['x-filename'] || req.query.filename || 'file';
    const contentType = req.headers['x-content-type'] || req.query.content_type || 'application/octet-stream';
    const messageThreadId = req.headers['x-message-thread-id'] || req.query.message_thread_id;

    // Upload via multipart form
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', new Blob([req.body], { type: contentType }), filename);
    if (messageThreadId) form.append('message_thread_id', messageThreadId);

    const tgRes = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: form,
    });

    if (!tgRes.ok) {
      const text = await tgRes.text();
      return res.status(502).json({ error: `TG upload failed: ${text}` });
    }

    const data = await tgRes.json();
    const doc = data.result.document;

    res.json({
      tgChatId: chatId,
      tgMessageId: data.result.message_id,
      tgFileId: doc.file_id,
      tgFileUniqueId: doc.file_unique_id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Range read from TG file
app.post('/api/proxy/range', async (req, res) => {
  try {
    const { file_id, start, end } = req.body;
    const filePath = await getFilePath(file_id);
    const url = `${TG_API}/file/bot${BOT_TOKEN}/${filePath}`;

    const tgRes = await fetch(url, {
      headers: { 'Range': `bytes=${start}-${end}` },
    });

    res.status(tgRes.status);
    res.set('Content-Type', tgRes.headers.get('content-type') || 'application/octet-stream');
    if (tgRes.headers.get('content-length')) res.set('Content-Length', tgRes.headers.get('content-length'));
    if (tgRes.headers.get('content-range')) res.set('Content-Range', tgRes.headers.get('content-range'));

    const reader = tgRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      res.write(Buffer.from(value));
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Consolidate multipart parts: download all parts from TG, combine, upload as single file
app.post('/api/proxy/consolidate', async (req, res) => {
  const tempPath = join(TEMP_DIR, `consolidate-${randomUUID()}`);
  try {
    const { file_ids, chat_id, filename, content_type, message_thread_id } = req.body;
    if (!file_ids || !Array.isArray(file_ids) || !chat_id) {
      return res.status(400).json({ error: 'Missing file_ids or chat_id' });
    }

    // Download all parts and stream to temp file
    const writeStream = createWriteStream(tempPath);
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5');

    for (const fileId of file_ids) {
      const filePath = await getFilePath(fileId);
      const url = `${TG_API}/file/bot${BOT_TOKEN}/${filePath}`;
      const tgRes = await fetch(url);
      if (!tgRes.ok) throw new Error(`Download part failed: ${tgRes.status}`);

      const reader = tgRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        writeStream.write(buf);
        hash.update(buf);
      }
    }

    await new Promise((resolve, reject) => {
      writeStream.end(resolve);
      writeStream.on('error', reject);
    });

    const etag = hash.digest('hex');

    // Upload combined file via Local Bot API
    const fileBuffer = await readFile(tempPath);
    const form = new FormData();
    form.append('chat_id', chat_id);
    form.append('document', new Blob([fileBuffer], { type: content_type }), filename);
    if (message_thread_id) form.append('message_thread_id', message_thread_id.toString());

    const tgRes = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: form,
    });

    if (!tgRes.ok) {
      const text = await tgRes.text();
      return res.status(502).json({ error: `TG upload failed: ${text}` });
    }

    const data = await tgRes.json();
    const doc = data.result.document;

    res.json({
      tgChatId: chat_id,
      tgMessageId: data.result.message_id,
      tgFileId: doc.file_id,
      tgFileUniqueId: doc.file_unique_id,
      etag,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { unlinkSync(tempPath); } catch {}
  }
});

// Image resize endpoint (synchronous, for Worker to call directly)
app.get('/api/image/resize', async (req, res) => {
  try {
    const { tg_file_id, width, format } = req.query;
    const filePath = await getFilePath(tg_file_id);
    const url = `${TG_API}/file/bot${BOT_TOKEN}/${filePath}`;
    const tgRes = await fetch(url);
    if (!tgRes.ok) return res.status(502).json({ error: 'TG download failed' });

    const inputBuffer = Buffer.from(await tgRes.arrayBuffer());
    let pipeline = sharp(inputBuffer);

    if (width) {
      pipeline = pipeline.resize(parseInt(width, 10), null, { withoutEnlargement: true });
    }

    const fmt = format || 'jpeg';
    switch (fmt) {
      case 'webp': pipeline = pipeline.webp({ quality: 80 }); break;
      case 'png': pipeline = pipeline.png(); break;
      case 'avif': pipeline = pipeline.avif({ quality: 65 }); break;
      default: pipeline = pipeline.jpeg({ quality: 90, mozjpeg: true }); break;
    }

    const output = await pipeline.toBuffer();
    const mimeMap = { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png', avif: 'image/avif' };

    res.set('Content-Type', mimeMap[fmt] || 'image/jpeg');
    res.set('Content-Length', output.length.toString());
    res.send(output);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Job processing ---

async function processJob(jobId) {
  const job = jobs.get(jobId);
  job.status = 'processing';

  // Download source file from TG
  const filePath = await getFilePath(job.tg_file_id);
  const url = `${TG_API}/file/bot${BOT_TOKEN}/${filePath}`;
  const tgRes = await fetch(url);
  if (!tgRes.ok) throw new Error(`TG download failed: ${tgRes.status}`);
  const inputBuffer = Buffer.from(await tgRes.arrayBuffer());

  const results = [];

  switch (job.job_type) {
    case 'image_convert': {
      // HEIC -> JPEG full size
      const fullJpeg = await sharp(inputBuffer).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
      results.push(await uploadDerivative(job, 'full.jpg', fullJpeg, 'image/jpeg'));

      // WebP thumbnail 400px
      const thumb400 = await sharp(inputBuffer)
        .resize(400, null, { withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      results.push(await uploadDerivative(job, 'thumb_400.webp', thumb400, 'image/webp'));

      // WebP thumbnail 200px
      const thumb200 = await sharp(inputBuffer)
        .resize(200, null, { withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
      results.push(await uploadDerivative(job, 'thumb_200.webp', thumb200, 'image/webp'));

      // Extract metadata
      const metadata = await sharp(inputBuffer).metadata();
      const metaJson = JSON.stringify({
        width: metadata.width, height: metadata.height,
        format: metadata.format, density: metadata.density,
        hasAlpha: metadata.hasAlpha, space: metadata.space,
      });
      results.push(await uploadDerivative(job, 'metadata.json', Buffer.from(metaJson), 'application/json'));
      break;
    }

    case 'video_transcode': {
      const inputPath = join(TEMP_DIR, `${jobId}-input`);
      const outputPath = join(TEMP_DIR, `${jobId}-output.mp4`);
      const posterPath = join(TEMP_DIR, `${jobId}-poster.jpg`);

      await writeFile(inputPath, inputBuffer);

      // Transcode to H.264 MP4
      await execFileAsync('ffmpeg', [
        '-i', inputPath,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-y', outputPath,
      ]);

      // Extract poster frame
      await execFileAsync('ffmpeg', [
        '-i', inputPath,
        '-ss', '00:00:01', '-vframes', '1',
        '-y', posterPath,
      ]);

      const mp4Buffer = await readFile(outputPath);
      results.push(await uploadDerivative(job, 'video.mp4', mp4Buffer, 'video/mp4'));

      if (existsSync(posterPath)) {
        const posterBuffer = await readFile(posterPath);
        results.push(await uploadDerivative(job, 'poster.jpg', posterBuffer, 'image/jpeg'));
      }

      // Cleanup temp files
      for (const p of [inputPath, outputPath, posterPath]) {
        try { unlinkSync(p); } catch {}
      }
      break;
    }

    case 'live_photo': {
      // Input expected as HEIC; MOV should be uploaded separately with a paired key
      const jpeg = await sharp(inputBuffer).jpeg({ quality: 90 }).toBuffer();
      results.push(await uploadDerivative(job, 'still.jpg', jpeg, 'image/jpeg'));

      const thumb = await sharp(inputBuffer)
        .resize(400, null, { withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      results.push(await uploadDerivative(job, 'thumb_400.webp', thumb, 'image/webp'));
      break;
    }
  }

  job.status = 'completed';
  job.results = results;
  job.finishedAt = Date.now();
}

async function uploadDerivative(job, derivativeName, buffer, contentType) {
  const key = `${job.key}._derivatives/${derivativeName}`;

  const form = new FormData();
  form.append('chat_id', process.env.DEFAULT_CHAT_ID || '');
  form.append('document', new Blob([buffer], { type: contentType }), derivativeName);
  form.append('caption', key);

  const tgRes = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: form,
  });

  if (!tgRes.ok) {
    const text = await tgRes.text();
    throw new Error(`Failed to upload derivative ${derivativeName}: ${text}`);
  }

  const data = await tgRes.json();
  const doc = data.result.document;

  return {
    key,
    contentType,
    size: buffer.length,
    tgFileId: doc.file_id,
    tgMessageId: data.result.message_id,
  };
}

async function getFilePath(fileId) {
  const res = await fetch(`${TG_API}/bot${BOT_TOKEN}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) throw new Error(`getFile failed: ${res.status}`);
  const data = await res.json();
  if (!data.ok || !data.result.file_path) throw new Error('No file_path in getFile response');
  return data.result.file_path;
}

app.listen(PORT, () => {
  console.log(`tg-s3-processor running on port ${PORT}`);
});
