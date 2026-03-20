import type { ObjectRow, ShareTokenRow } from '../types';
import { formatSize } from '../utils/format';
import type { Lang } from '../i18n';
import { shareStrings } from '../i18n';

function st(lang: Lang, key: string, ...args: (string | number)[]): string {
  let s = (shareStrings[lang] || shareStrings.en)[key] || shareStrings.en[key] || key;
  for (let i = 0; i < args.length; i++) {
    s = s.replace(`{${i}}`, String(args[i]));
  }
  return s;
}

function langAttr(lang: Lang): string {
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'ja') return 'ja';
  if (lang === 'fr') return 'fr';
  return 'en';
}

export function renderSharePage(obj: ObjectRow, share: ShareTokenRow, baseUrl: string, lang: Lang = 'en'): string {
  const filename = obj.key.split('/').pop() || obj.key;
  const sizeStr = formatSize(obj.size);
  const expiresStr = share.expires_at ? new Date(share.expires_at).toLocaleString(langAttr(lang)) : st(lang, 'permanent');
  let countdownFallback = '';
  if (share.expires_at) {
    const diff = new Date(share.expires_at).getTime() - Date.now();
    if (diff <= 0) {
      countdownFallback = st(lang, 'expired');
    } else {
      const d = Math.floor(diff / 864e5);
      const h = Math.floor(diff % 864e5 / 36e5);
      const m = Math.floor(diff % 36e5 / 6e4);
      const s = Math.floor(diff % 6e4 / 1e3);
      const ds = st(lang, 'days'), hs = st(lang, 'hours'), ms = st(lang, 'minutes'), ss = st(lang, 'seconds');
      countdownFallback = (d > 0 ? d + ds : '') + (h > 0 ? h + hs : '') + (m > 0 ? m + ms : '') + s + ss;
    }
  }
  const downloadUrl = `${baseUrl}/share/${share.token}/download`;
  const inlineUrl = `${baseUrl}/share/${share.token}/inline`;
  const isImage = obj.content_type.startsWith('image/');
  const isVideo = obj.content_type.startsWith('video/');

  let isLivePhoto = false;
  let liveVideoUrl = '';
  if (obj.system_metadata) {
    try {
      const sysMeta = JSON.parse(obj.system_metadata);
      if (sysMeta._live_photo_video_key) {
        isLivePhoto = true;
        liveVideoUrl = `${baseUrl}/share/${share.token}/live-video`;
      }
    } catch { /* ignore */ }
  }

  const livePhotoHead = isLivePhoto ? `<script src="https://cdn.apple-livephotoskit.com/lpk/1/livephotoskit.js"></script>` : '';

  const isAudio = obj.content_type.startsWith('audio/');
  const isPdf = obj.content_type === 'application/pdf';
  const isText = obj.content_type.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(obj.content_type);

  let previewHtml = '';
  if (isLivePhoto) {
    previewHtml = `<div class="preview">
<div id="lp-apple" style="display:none"><div data-live-photo data-photo-src="${inlineUrl}" data-video-src="${liveVideoUrl}" style="width:100%;height:auto;aspect-ratio:4/3;border-radius:8px"></div></div>
<div id="lp-fallback" style="display:none"><img src="${inlineUrl}" style="max-width:100%;border-radius:8px;margin-bottom:8px" alt="${escapeHtml(filename)}"><video controls playsinline preload="metadata" src="${liveVideoUrl}" style="max-width:100%;border-radius:8px"></video></div>
<p style="font-size:12px;color:#888;margin-top:4px">${escapeHtml(st(lang, 'live_photo'))}</p>
<script>(function(){var a=/Mac|iPhone|iPad|iPod/.test(navigator.platform)||/Mac|iPhone|iPad|iPod/.test(navigator.userAgent);document.getElementById(a?'lp-apple':'lp-fallback').style.display='block'})()</script>
</div>`;
  } else if (isImage) {
    previewHtml = `<div class="preview"><img src="${inlineUrl}" alt="${escapeHtml(filename)}" loading="lazy"></div>`;
  } else if (isVideo) {
    previewHtml = `<div class="preview"><video controls playsinline preload="metadata" src="${inlineUrl}"></video></div>`;
  } else if (isAudio) {
    previewHtml = `<div class="preview"><audio controls preload="metadata" src="${inlineUrl}" style="width:100%"></audio></div>`;
  } else if (isPdf) {
    previewHtml = `<div class="preview"><embed src="${inlineUrl}" type="application/pdf" style="width:100%;height:min(480px,60vh);border-radius:8px;border:1px solid #eee"></div>`;
  } else if (isText && obj.size <= 512 * 1024) {
    previewHtml = `<div class="preview"><pre id="text-preview" style="max-height:min(400px,60vh);overflow:auto;background:#f5f5f5;padding:12px;border-radius:8px;font-size:13px;text-align:left;white-space:pre-wrap;word-break:break-all;color:#999;text-align:center">${escapeHtml(st(lang, 'loading_preview'))}</pre><p id="text-truncated" style="display:none;font-size:12px;color:#999;margin-top:4px;text-align:center">${escapeHtml(st(lang, 'content_truncated'))}</p></div>`;
  } else if (isText) {
    previewHtml = `<div class="preview"><p style="font-size:13px;color:#999;margin:16px 0">${escapeHtml(st(lang, 'text_too_large', sizeStr))}</p></div>`;
  } else {
    previewHtml = `<div class="preview"><svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:#999;margin:16px auto"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg></div>`;
  }

  // Escape translation strings for embedding in JS
  const expiredJs = escapeJsString(st(lang, 'expired'));
  const daysJs = escapeJsString(st(lang, 'days'));
  const hoursJs = escapeJsString(st(lang, 'hours'));
  const minutesJs = escapeJsString(st(lang, 'minutes'));
  const secondsJs = escapeJsString(st(lang, 'seconds'));
  const copyLinkJs = escapeJsString(st(lang, 'copy_link'));
  const copiedJs = escapeJsString(st(lang, 'copied'));
  const copyFailedJs = escapeJsString(st(lang, 'copy_failed'));
  const previewFailedJs = escapeJsString(st(lang, 'preview_failed'));

  return `<!DOCTYPE html>
<html lang="${langAttr(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(st(lang, 'page_title', filename))}</title>
${livePhotoHead}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#333;background:#fafafa}
h2{margin-bottom:16px;font-size:20px}
.card{background:#fff;padding:20px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);margin-bottom:16px}
.info-row{display:flex;flex-wrap:wrap;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0}
.info-row:last-child{border:none}
.label{color:#666;font-size:14px}
.value{font-weight:500;font-size:14px;overflow-wrap:break-word;word-break:break-all;max-width:60%}
.btn{display:block;text-align:center;background:#0088cc;color:#fff;padding:14px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:500;transition:background .2s}
.btn:hover{background:#006da3}
.preview{margin-bottom:16px;text-align:center}
.preview img{max-width:100%;border-radius:8px}
.preview video{max-width:100%;border-radius:8px}
.expired{color:#e53935;text-align:center;padding:40px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.actions .btn{flex:1}
.btn-secondary{background:#666}
.btn-secondary:hover{background:#555}
.countdown{font-variant-numeric:tabular-nums}
@media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#e0e0e0}h2{color:#e0e0e0}.card{background:#2d2d2d;box-shadow:0 1px 3px rgba(0,0,0,.4)}.info-row{border-color:#444}.label{color:#aaa}.btn{background:#0088cc}.btn:hover{background:#006da3}.btn-secondary{background:#555}.btn-secondary:hover{background:#444}pre{background:#333!important;color:#ddd}}
</style>
</head>
<body>
<h2>${escapeHtml(st(lang, 'file_share'))}</h2>
${previewHtml}
<div class="card">
<div class="info-row"><span class="label">${escapeHtml(st(lang, 'filename'))}</span><span class="value">${escapeHtml(filename)}</span></div>
<div class="info-row"><span class="label">${escapeHtml(st(lang, 'size'))}</span><span class="value">${sizeStr}</span></div>
<div class="info-row"><span class="label">${escapeHtml(st(lang, 'type'))}</span><span class="value">${escapeHtml(obj.content_type)}${isLivePhoto ? ' (Live Photo)' : ''}</span></div>
<div class="info-row"><span class="label">${escapeHtml(st(lang, 'expiry'))}</span><span class="value">${share.expires_at ? `<span class="countdown" id="countdown" data-expires="${share.expires_at}">${countdownFallback}</span>` : escapeHtml(st(lang, 'permanent'))}</span></div>
${share.max_downloads !== null ? `<div class="info-row"><span class="label">${escapeHtml(st(lang, 'downloads'))}</span><span class="value">${share.download_count} / ${share.max_downloads}</span></div>` : ''}
${share.note ? `<div class="info-row"><span class="label">${escapeHtml(st(lang, 'note'))}</span><span class="value">${escapeHtml(share.note)}</span></div>` : ''}
</div>
<div class="actions">
<a href="${downloadUrl}" class="btn" id="download-btn">${escapeHtml(st(lang, 'download_file'))}</a>
<a href="javascript:void(0)" class="btn btn-secondary" id="copy-btn" onclick="navigator.clipboard.writeText(location.href).then(()=>{this.textContent='${copiedJs}';setTimeout(()=>this.textContent='${copyLinkJs}',1500)}).catch(()=>{this.textContent='${copyFailedJs}';setTimeout(()=>this.textContent='${copyLinkJs}',1500)})">${escapeHtml(st(lang, 'copy_link'))}</a>
</div>
<script>
(function(){
  var el=document.getElementById('countdown');
  if(!el)return;
  var exp=new Date(el.dataset.expires).getTime();
  var serverNow=${Date.now()};
  var offset=serverNow-Date.now();
  var btn=document.getElementById('download-btn');
  var expiredText='${expiredJs}';
  function tick(){
    var d=exp-(Date.now()+offset);
    if(d<=0){el.textContent=expiredText;if(btn){btn.style.opacity='0.5';btn.style.pointerEvents='none';btn.setAttribute('tabindex','-1');btn.setAttribute('aria-disabled','true');btn.removeAttribute('href');btn.textContent=expiredText}return}
    var days=Math.floor(d/864e5),hrs=Math.floor(d%864e5/36e5),mins=Math.floor(d%36e5/6e4),secs=Math.floor(d%6e4/1e3);
    el.textContent=(days>0?days+'${daysJs}':'')+(hrs>0?hrs+'${hoursJs}':'')+(mins>0?mins+'${minutesJs}':'')+secs+'${secondsJs}';
    setTimeout(tick,1000);
  }
  tick();
})();
${isText && obj.size <= 512 * 1024 ? `fetch('${inlineUrl}').then(r=>r.text()).then(t=>{var el=document.getElementById('text-preview');if(el){el.style.color='';el.style.textAlign='left';el.textContent=t.slice(0,50000);if(t.length>50000){var tr=document.getElementById('text-truncated');if(tr)tr.style.display='block'}}}).catch(()=>{var el=document.getElementById('text-preview');if(el){el.textContent='${previewFailedJs}';el.style.color='#999';el.style.textAlign='center'}});` : ''}
</script>
</body>
</html>`;
}

export function renderPasswordPage(share: ShareTokenRow, baseUrl: string, wrongPassword?: boolean, lockedMinutes?: number, lang: Lang = 'en', remainingAttempts?: number): string {
  let messageHtml = '';
  let formDisabled = '';
  if (lockedMinutes && lockedMinutes > 0) {
    messageHtml = `<p class="error">${escapeHtml(st(lang, 'locked_msg', lockedMinutes))}</p>`;
    formDisabled = ' style="opacity:0.5;pointer-events:none"';
  } else if (wrongPassword) {
    const attemptsHint = remainingAttempts !== undefined && remainingAttempts > 0
      ? ` (${st(lang, 'remaining_attempts', remainingAttempts)})`
      : '';
    messageHtml = `<p class="error">${escapeHtml(st(lang, 'wrong_password') + attemptsHint)}</p>`;
  }
  return `<!DOCTYPE html>
<html lang="${langAttr(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(st(lang, 'password_title'))}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;max-width:400px;margin:80px auto;padding:0 16px;color:#333;background:#fafafa}
.card{background:#fff;padding:24px;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
h2{margin-bottom:16px;font-size:20px;text-align:center}
input{width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:16px;margin:12px 0}
button{width:100%;padding:14px;background:#0088cc;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:500}
button:hover{background:#006da3}
.error{color:#e53935;font-size:14px;margin-top:8px;text-align:center}
@media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#e0e0e0}.card{background:#2d2d2d;box-shadow:0 1px 3px rgba(0,0,0,.4)}input{background:#3a3a3a;border-color:#555;color:#e0e0e0}input::placeholder{color:#999}}
</style>
</head>
<body>
<div class="card">
<h2>${escapeHtml(st(lang, 'password_required'))}</h2>
${messageHtml}<form method="POST" action="${baseUrl}/share/${share.token}"${formDisabled}>
<input type="password" name="password" placeholder="${escapeHtml(st(lang, 'enter_password'))}" required autofocus autocomplete="off" id="pwd-input"${lockedMinutes ? ' disabled' : ''}>
<button type="submit"${lockedMinutes ? ' disabled' : ''}>${escapeHtml(st(lang, 'verify'))}</button>
</form>
${wrongPassword && !lockedMinutes ? `<script>var i=document.getElementById('pwd-input');if(i){i.value='';i.focus()}</script>` : ''}
</div>
</body>
</html>`;
}

export function renderExpiredPage(reason?: 'expired' | 'max_downloads' | 'not_found', lang: Lang = 'en'): string {
  const titleMap: Record<string, string> = {
    expired: st(lang, 'share_expired'),
    max_downloads: st(lang, 'share_max_downloads'),
    not_found: st(lang, 'share_not_found'),
  };
  const messageMap: Record<string, string> = {
    expired: st(lang, 'share_expired_msg'),
    max_downloads: st(lang, 'share_max_downloads_msg'),
    not_found: st(lang, 'share_not_found_msg'),
  };
  const title = titleMap[reason || ''] || st(lang, 'share_invalid');
  const message = messageMap[reason || ''] || st(lang, 'share_invalid_msg');

  return `<!DOCTYPE html>
<html lang="${langAttr(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui;max-width:400px;margin:80px auto;padding:0 16px;text-align:center;color:#666}
h2{color:#e53935;margin-bottom:12px}
@media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#aaa}}
</style>
</head>
<body>
<h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(message)}</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeJsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
