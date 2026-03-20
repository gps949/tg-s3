import { miniappStrings } from '../i18n';

export function renderMiniApp(origin: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tg-s3 Drive</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root {
  --bg: var(--tg-theme-bg-color, #fff);
  --text: var(--tg-theme-text-color, #222);
  --hint: var(--tg-theme-hint-color, #999);
  --link: var(--tg-theme-link-color, #2678b6);
  --btn: var(--tg-theme-button-color, #2678b6);
  --btn-text: var(--tg-theme-button-text-color, #fff);
  --secondary-bg: var(--tg-theme-secondary-bg-color, #f0f0f0);
  --destructive: var(--tg-theme-destructive-text-color, #e53935);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg); color: var(--text); font-size: 14px;
  min-height: 100vh; padding-bottom: 70px;
}
.header {
  padding: 12px 16px; background: var(--secondary-bg);
  display: flex; align-items: center; justify-content: space-between;
  position: sticky; top: 0; z-index: 10;
}
.header h1 { font-size: 16px; font-weight: 600; }
.header-right { display: flex; align-items: center; gap: 8px; }
.stats { font-size: 12px; color: var(--hint); }
.lang-select {
  padding: 2px 4px; border: 1px solid var(--hint); border-radius: 4px;
  font-size: 11px; background: var(--bg); color: var(--text); cursor: pointer;
}
.tabs {
  display: flex; border-bottom: 1px solid var(--secondary-bg);
  position: sticky; top: 44px; z-index: 9; background: var(--bg);
}
.tab {
  flex: 1; padding: 10px; text-align: center; font-size: 13px;
  color: var(--hint); cursor: pointer; border-bottom: 2px solid transparent;
  transition: all 0.2s;
}
.tab.active { color: var(--link); border-bottom-color: var(--link); font-weight: 600; }
.view { display: none; padding: 8px 12px; }
.view.active { display: block; }
.bucket-card {
  padding: 14px; margin: 6px 0; border-radius: 10px;
  background: var(--secondary-bg); cursor: pointer; transition: opacity 0.2s;
}
.bucket-card:active { opacity: 0.7; }
.bucket-name { font-weight: 600; }
.bucket-meta { font-size: 12px; color: var(--hint); margin-top: 4px; }
.file-item {
  display: flex; align-items: center; padding: 10px 6px;
  border-bottom: 1px solid var(--secondary-bg); cursor: pointer;
}
.file-item:active { background: var(--secondary-bg); }
.file-icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; font-size: 24px; flex-shrink: 0; }
.file-info { flex: 1; min-width: 0; margin-left: 10px; }
.file-name { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-meta { font-size: 12px; color: var(--hint); margin-top: 2px; }
.file-check { width: 0; overflow: hidden; transition: width 0.2s; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.batch-mode .file-check { width: 32px; }
.file-item.selected { background: color-mix(in srgb, var(--link) 10%, transparent); }
.toolbar { display: flex; gap: 6px; align-items: center; padding: 8px 0; flex-wrap: wrap; }
.search-bar { display: flex; gap: 4px; align-items: center; }
.search-bar input { flex: 1; padding: 8px 10px; border: 1px solid var(--secondary-bg); border-radius: 8px; font-size: 16px; background: var(--bg); color: var(--text); min-width: 100px; }
.breadcrumb { padding: 6px 0; font-size: 13px; color: var(--hint); }
.breadcrumb span { cursor: pointer; color: var(--link); }
.btn { padding: 8px 16px; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; background: var(--btn); color: var(--btn-text); transition: opacity 0.2s; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn:active { opacity: 0.8; }
.btn-sm { padding: 10px 14px; font-size: 13px; min-height: 36px; }
.btn-outline { background: transparent; border: 1px solid var(--btn); color: var(--btn); }
.btn-danger { background: var(--destructive); color: #fff; }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 12px; color: var(--hint); margin-bottom: 4px; }
.form-group input, .form-group select, .form-group textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--secondary-bg); border-radius: 8px; font-size: 16px; background: var(--bg); color: var(--text); }
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; display: none; align-items: flex-end; justify-content: center; }
.modal-overlay.show { display: flex; }
.modal { background: var(--bg); border-radius: 16px 16px 0 0; padding: 20px; width: 100%; max-width: 480px; max-height: 80vh; overflow-y: auto; position: relative; }
.modal-close { position: absolute; top: 4px; right: 8px; font-size: 24px; cursor: pointer; color: var(--hint); line-height: 1; padding: 10px; min-width: 44px; min-height: 44px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
.share-item { padding: 12px; margin: 6px 0; border-radius: 10px; background: var(--secondary-bg); }
.share-token { font-family: monospace; font-size: 13px; }
.share-meta { font-size: 12px; color: var(--hint); margin-top: 4px; line-height: 1.6; }
.toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 10px 20px; border-radius: 20px; font-size: 13px; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 200; max-width: 90%; text-align: center; }
.toast.show { opacity: 1; }
.skeleton { height: 48px; margin: 6px 0; border-radius: 10px; background: linear-gradient(90deg, var(--secondary-bg) 25%, color-mix(in srgb, var(--secondary-bg) 50%, var(--bg)) 50%, var(--secondary-bg) 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
@keyframes shimmer { to { background-position: -200% 0; } }
.empty { text-align: center; padding: 32px 16px; color: var(--hint); }
.progress-bar { height: 6px; border-radius: 3px; background: var(--secondary-bg); margin: 8px 0; overflow: hidden; }
.progress-bar-fill { height: 100%; background: var(--btn); border-radius: 3px; transition: width 0.3s; }
.upload-zone {
  border: 2px dashed var(--hint); border-radius: 12px; padding: 24px;
  text-align: center; color: var(--hint); cursor: pointer; margin: 8px 0;
  transition: all 0.2s;
}
.upload-zone.dragover { border-color: var(--link); color: var(--link); background: color-mix(in srgb, var(--link) 5%, transparent); }
#filesView.dragover { background: color-mix(in srgb, var(--link) 5%, transparent); outline: 2px dashed var(--link); outline-offset: -4px; border-radius: 8px; }
.auth-error {
  background: color-mix(in srgb, var(--destructive) 10%, transparent);
  border: 1px solid var(--destructive); border-radius: 10px;
  padding: 16px; margin: 8px 0; text-align: center;
}
.auth-error h3 { color: var(--destructive); margin-bottom: 8px; }
.cred-item { padding: 12px; margin: 6px 0; border-radius: 10px; background: var(--secondary-bg); }
.cred-name { font-weight: 600; font-size: 14px; }
.cred-key { font-family: monospace; font-size: 12px; word-break: break-all; color: var(--hint); margin-top: 4px; }
.cred-meta { font-size: 12px; color: var(--hint); margin-top: 4px; line-height: 1.6; }
.cred-actions { display: flex; gap: 6px; margin-top: 8px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.badge-active { background: color-mix(in srgb, #4caf50 15%, transparent); color: #4caf50; }
.badge-inactive { background: color-mix(in srgb, var(--destructive) 15%, transparent); color: var(--destructive); }
.badge-perm { background: color-mix(in srgb, var(--link) 15%, transparent); color: var(--link); }
.secret-reveal { background: var(--bg); border: 1px solid var(--secondary-bg); border-radius: 8px; padding: 12px; margin: 12px 0; word-break: break-all; font-family: monospace; font-size: 13px; }
.secret-warning { background: color-mix(in srgb, #ff9800 10%, transparent); border: 1px solid #ff9800; border-radius: 8px; padding: 10px; margin: 8px 0; font-size: 13px; color: #e65100; }
</style>
</head>
<body>
<div class="header">
  <h1 id="appTitle"></h1>
  <div class="header-right">
    <span class="stats" id="globalStats"></span>
    <select class="lang-select" id="langSelect" onchange="setLang(this.value)">
      <option value="en">EN</option>
      <option value="zh">中文</option>
      <option value="ja">日本語</option>
      <option value="fr">FR</option>
    </select>
  </div>
</div>
<div class="tabs">
  <div class="tab active" data-view="buckets" id="tabBucket"></div>
  <div class="tab" data-view="files" id="tabFiles"></div>
  <div class="tab" data-view="shares" id="tabShares"></div>
  <div class="tab" data-view="keys" id="tabKeys"></div>
</div>

<div id="bucketsView" class="view active"></div>
<div id="filesView" class="view"></div>
<div id="sharesView" class="view"></div>
<div id="keysView" class="view"></div>

<div class="modal-overlay" id="modalOverlay">
  <div class="modal" id="modalContent"></div>
</div>
<div class="toast" id="toast"></div>
<input type="file" id="fileInput" multiple style="display:none">

<script>
var _i18n = ${JSON.stringify(miniappStrings)};
var currentLang = localStorage.getItem('tgs3_lang') || 'en';

function t(key) {
  var args = Array.prototype.slice.call(arguments, 1);
  var s = (_i18n[currentLang] || _i18n.en)[key] || _i18n.en[key] || key;
  for (var i = 0; i < args.length; i++) {
    s = s.replace('{' + i + '}', args[i]);
  }
  return s;
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem('tgs3_lang', lang);
  document.getElementById('langSelect').value = lang;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang === 'ja' ? 'ja' : lang === 'fr' ? 'fr' : 'en';
  applyStaticLabels();
  // Re-render current view
  var activeTab = document.querySelector('.tab.active');
  if (activeTab) {
    var view = activeTab.dataset.view;
    if (view === 'buckets') loadBuckets();
    else if (view === 'files' && currentBucket) loadFiles();
    else if (view === 'shares') loadShares();
    else if (view === 'keys') loadKeys();
  }
}

function applyStaticLabels() {
  document.getElementById('appTitle').textContent = t('app_title');
  document.getElementById('tabBucket').textContent = t('tab_bucket');
  document.getElementById('tabFiles').textContent = t('tab_files');
  document.getElementById('tabShares').textContent = t('tab_shares');
  document.getElementById('tabKeys').textContent = t('tab_keys');
  document.title = t('app_title');
}

const API = '${origin}';
let authHeader = '';
let authOk = false;
let currentBucket = '';
let currentPrefix = '';
let buckets = [];
let batchMode = false;
let selectedFiles = new Set();
let loadedObjects = new Map();
let lastStartAfter = '';
let hasMore = false;
let searchQuery = '';
let sortBy = 'date_desc';
let detailGeneration = 0;
let fileListGeneration = 0;

// Init
(function init() {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
    authHeader = 'Bearer ' + (tg.initData || '');
  }
  const params = new URLSearchParams(location.search);
  if (params.get('token')) {
    authHeader = 'Bearer ' + params.get('token');
  }
  if (params.get('lang') && _i18n[params.get('lang')]) {
    currentLang = params.get('lang');
    localStorage.setItem('tgs3_lang', currentLang);
  }
  document.getElementById('langSelect').value = currentLang;
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : currentLang === 'ja' ? 'ja' : currentLang === 'fr' ? 'fr' : 'en';

  applyStaticLabels();
  setupTabs();
  loadBuckets();
  loadStats();
})();

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      const viewId = tab.dataset.view + 'View';
      document.getElementById(viewId).classList.add('active');
      window.scrollTo(0, 0);
      if (tab.dataset.view === 'shares') loadShares();
      if (tab.dataset.view === 'keys') loadKeys();
    });
  });
}

async function apiFetch(path, opts = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...opts,
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      signal: opts.signal || AbortSignal.timeout(30000),
    });
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      throw new Error(t('err_timeout'));
    }
    throw new Error(t('err_network'));
  }
  if (res.status === 403) {
    authOk = false;
    showAuthError();
    throw new Error(t('err_auth'));
  }
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  authOk = true;
  if (res.status === 204) return null;
  return res.json();
}

function showAuthError() {
  const views = ['bucketsView', 'filesView', 'sharesView', 'keysView'];
  for (const id of views) {
    const el = document.getElementById(id);
    if (el.classList.contains('active')) {
      el.innerHTML = \`<div class="auth-error">
        <h3>\${esc(t('auth_failed'))}</h3>
        <p>\${esc(t('auth_failed_desc'))}</p>
      </div>\`;
    }
  }
}

// Stats
async function loadStats() {
  try {
    const stats = await apiFetch('/api/miniapp/stats');
    document.getElementById('globalStats').textContent =
      t('stats_fmt', stats.bucketCount, stats.totalFiles, formatSize(stats.totalSize));
  } catch {
    const el = document.getElementById('globalStats');
    if (el) el.textContent = t('stats_error') || 'Failed to load stats';
  }
}

// Buckets
async function loadBuckets() {
  const el = document.getElementById('bucketsView');
  showSkeleton(el, 3);
  try {
    buckets = await apiFetch('/api/miniapp/buckets');
    const createBtn = '<div style="padding:4px 0 8px"><button class="btn btn-sm" onclick="showCreateBucket()">' + esc(t('create_bucket_btn')) + '</button></div>';
    if (buckets.length === 0) {
      el.innerHTML = createBtn +
        '<div class="bucket-card" style="cursor:default;text-align:center;padding:24px 14px">' +
        '<div class="bucket-name">' + esc(t('no_buckets')) + '</div>' +
        '<div class="bucket-meta" style="margin-top:8px">' + esc(t('no_buckets_hint')) + '</div>' +
        '</div>';
      return;
    }
    el.innerHTML = createBtn + buckets.map(b => \`
      <div class="bucket-card" onclick="openBucket('\${escJs(b.name)}')">
        <div class="bucket-name">\${esc(b.name)}</div>
        <div class="bucket-meta">\${esc(t('bucket_files_fmt', b.object_count, formatSize(b.total_size)))}</div>
      </div>
    \`).join('');
  } catch (e) {
    if (!authOk) return;
    el.innerHTML = '<div class="empty">' + esc(t('load_failed', e.message)) + '<br><br><button class="btn btn-sm btn-outline" onclick="loadBuckets()">' + esc(t('retry')) + '</button></div>';
  }
}

function showCreateBucket() {
  showModal(\`
    <span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>
    <h3>\${esc(t('new_bucket_title'))}</h3>
    <div class="form-group">
      <label>\${esc(t('bucket_name_label'))}</label>
      <input type="text" id="newBucketName" placeholder="my-bucket" pattern="[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]">
      <div style="font-size:11px;color:var(--hint);margin-top:4px">\${esc(t('bucket_name_hint'))}</div>
    </div>
    <button class="btn" style="width:100%;margin-top:8px" onclick="doCreateBucket()">\${esc(t('create'))}</button>
  \`);
}

async function doCreateBucket() {
  const name = (document.getElementById('newBucketName').value || '').trim();
  if (!name) { toast(t('enter_bucket_name')); return; }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)) {
    toast(t('bucket_name_invalid'));
    return;
  }
  const btn = event && event.target; if (btn) { btn.disabled = true; btn.textContent = t('creating'); }
  try {
    await apiFetch('/api/miniapp/bucket', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    toast(t('bucket_created', name));
    closeModal();
    loadBuckets();
    loadStats();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = t('create'); }
    toast(t('create_failed', e.message));
  }
}

function openBucket(name) {
  currentBucket = name;
  currentPrefix = '';
  searchQuery = '';
  sortBy = 'date_desc';
  exitBatchMode();
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelector('[data-view="files"]').classList.add('active');
  document.getElementById('filesView').classList.add('active');
  loadFiles();
}

// Files
let loadingMore = false;
async function loadFiles(append) {
  if (append && loadingMore) return;
  const el = document.getElementById('filesView');
  if (!append) {
    lastStartAfter = '';
    hasMore = false;
    fileListGeneration++;
    showSkeleton(el, 4);
  } else {
    loadingMore = true;
  }
  const gen = fileListGeneration;
  try {
    let items = [];
    let commonPrefixes = [];
    let isTruncated = false;

    if (searchQuery) {
      items = await apiFetch('/api/miniapp/search?bucket=' + encodeURIComponent(currentBucket) + '&q=' + encodeURIComponent(searchQuery));
    } else {
      const params = new URLSearchParams({
        bucket: currentBucket, prefix: currentPrefix, maxKeys: '100',
      });
      params.set('delimiter', '/');
      if (append && lastStartAfter) params.set('startAfter', lastStartAfter);
      const result = await apiFetch('/api/miniapp/objects?' + params);
      items = result.contents.filter(o => !o.key.includes('._derivatives/'));
      commonPrefixes = result.commonPrefixes;
      isTruncated = result.isTruncated;
    }

    if (gen !== fileListGeneration) return;

    if (!append) loadedObjects.clear();
    for (const obj of items) loadedObjects.set(obj.key, obj);

    items = sortItems(items, sortBy);

    let html = '';
    if (!append) {
      html += renderToolbar();
      html += renderBreadcrumb();
    }

    if (!append && commonPrefixes.length === 0 && items.length === 0) {
      if (searchQuery) {
        html += '<div class="empty">' + esc(t('no_match', searchQuery)) + '</div>';
      } else {
        html += '<div class="empty">' + esc(t('empty_dir')) + '<br><small style="color:var(--hint)">' + esc(t('empty_dir_hint')) + '</small><br><br>' +
          '<button class="btn" onclick="triggerUpload()">' + esc(t('upload_file')) + '</button> ' +
          '<button class="btn btn-outline" onclick="showCreateFolder()" style="margin-left:8px">' + esc(t('new_folder')) + '</button></div>';
      }
    }

    if (!searchQuery) {
      for (const cp of commonPrefixes) {
        const dirName = cp.slice(currentPrefix.length).replace(/\\/$/, '');
        html += \`
          <div class="file-item" onclick="navigateDir('\${escJs(cp)}')">
            <div class="file-check"></div>
            <div class="file-icon">\u{1F4C1}</div>
            <div class="file-info">
              <div class="file-name">\${esc(dirName)}/</div>
            </div>
          </div>\`;
      }
    }

    for (const obj of items) {
      const name = searchQuery ? obj.key : obj.key.slice(currentPrefix.length);
      const isImg = obj.content_type && obj.content_type.startsWith('image/') && !obj.content_type.includes('svg');
      const iconHtml = isImg
        ? '<img loading="lazy" width="40" height="40" class="thumb-lazy" style="object-fit:cover;border-radius:4px;background:var(--secondary-bg)" data-bucket="' + esc(currentBucket) + '" data-key="' + esc(obj.key) + '" onerror="this.outerHTML=\\'<span style=font-size:24px>\u{1F5BC}\u{FE0F}</span>\\'"/>'
        : fileIcon(obj.content_type);
      const sel = selectedFiles.has(obj.key) ? ' selected' : '';
      html += \`
        <div class="file-item\${sel}" data-key="\${esc(obj.key)}" onclick="onFileClick(event, '\${escJs(obj.bucket)}', '\${escJs(obj.key)}')">
          <div class="file-check">\${selectedFiles.has(obj.key) ? '\u2713' : ''}</div>
          <div class="file-icon">\${iconHtml}</div>
          <div class="file-info">
            <div class="file-name" title="\${esc(name)}">\${esc(name)}</div>
            <div class="file-meta">\${formatSize(obj.size)} / \${new Date(obj.last_modified).toLocaleString(currentLang === 'zh' ? 'zh-CN' : currentLang === 'ja' ? 'ja-JP' : currentLang === 'fr' ? 'fr-FR' : 'en-US',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
          </div>
        </div>\`;
    }

    hasMore = isTruncated;
    if (items.length > 0) {
      lastStartAfter = items[items.length - 1].key;
    }

    if (hasMore) {
      html += '<div style="text-align:center;padding:12px"><button class="btn btn-outline btn-sm" onclick="loadFiles(true)">' + esc(t('load_more')) + '</button></div>';
    }

    if (append) {
      const existing = el.innerHTML.replace(/<div style="text-align:center;padding:12px">.*?<\\/div>$/, '');
      el.innerHTML = existing + html;
    } else {
      el.innerHTML = html;
    }

    updateBatchToolbar();
    observeThumbnails();
  } catch (e) {
    if (!authOk) return;
    if (!append) el.innerHTML = '<div class="empty">' + esc(t('load_failed', e.message)) + '<br><br><button class="btn btn-sm btn-outline" onclick="loadFiles()">' + esc(t('retry')) + '</button></div>';
    else toast(t('load_failed', e.message));
  } finally {
    loadingMore = false;
  }
}

function renderToolbar() {
  return \`<div class="toolbar">
    <div class="search-bar" style="flex:1">
      <input type="text" id="searchInput" placeholder="\${esc(t('search_placeholder'))}" value="\${esc(searchQuery)}" onkeydown="if(event.key==='Enter')doSearch()">
      <button onclick="\${searchQuery?'clearSearch()':'doSearch()'}" style="padding:6px 12px;border:1px solid var(--secondary-bg);border-radius:8px;background:var(--btn);color:var(--btn-text);font-size:13px;cursor:pointer;white-space:nowrap">\${searchQuery?esc(t('clear')):esc(t('search_btn'))}</button>
    </div>
    <select style="padding:5px 8px;border:1px solid var(--secondary-bg);border-radius:6px;font-size:12px;background:var(--bg);color:var(--text)" onchange="changeSort(this.value)">
      <option value="date_desc" \${sortBy==='date_desc'?'selected':''}>\${esc(t('sort_newest'))}</option>
      <option value="date_asc" \${sortBy==='date_asc'?'selected':''}>\${esc(t('sort_oldest'))}</option>
      <option value="name_asc" \${sortBy==='name_asc'?'selected':''}>\${esc(t('sort_name_az'))}</option>
      <option value="name_desc" \${sortBy==='name_desc'?'selected':''}>\${esc(t('sort_name_za'))}</option>
      <option value="size_desc" \${sortBy==='size_desc'?'selected':''}>\${esc(t('sort_largest'))}</option>
      <option value="size_asc" \${sortBy==='size_asc'?'selected':''}>\${esc(t('sort_smallest'))}</option>
    </select>
    <button class="btn btn-sm" onclick="triggerUpload()">\${esc(t('upload'))}</button>
    <button class="btn btn-sm btn-outline" onclick="showCreateFolder()">\${esc(t('new_folder'))}</button>
    <button class="btn btn-sm btn-outline" id="batchBtn" onclick="toggleBatchMode()">\${batchMode ? esc(t('cancel')) : esc(t('batch'))}</button>
  </div>
  <div id="batchToolbar" style="display:none;padding:4px 0">
    <div class="toolbar">
      <span id="batchCount" style="font-size:12px;color:var(--hint)">\${esc(t('selected_count', '0'))}</span>
      <button class="btn btn-sm btn-outline" onclick="selectAll()">\${esc(t('select_all'))}</button>
      <button class="btn btn-sm btn-danger" onclick="batchDelete()">\${esc(t('batch_delete'))}</button>
      <button class="btn btn-sm btn-outline" onclick="batchShare()">\${esc(t('batch_share'))}</button>
    </div>
  </div>\`;
}

function renderBreadcrumb() {
  const parts = currentPrefix.split('/').filter(Boolean);
  let html = '<div class="breadcrumb"><span onclick="navigateDir(\\'\\')">' + esc(currentBucket) + '</span>';
  let path = '';
  for (const p of parts) {
    path += p + '/';
    const pathCopy = path;
    html += ' / <span onclick="navigateDir(\\'' + escJs(pathCopy) + '\\')">' + esc(p) + '</span>';
  }
  html += '</div>';
  return html;
}

function navigateDir(prefix) {
  currentPrefix = prefix;
  searchQuery = '';
  exitBatchMode();
  window.scrollTo(0, 0);
  loadFiles();
}

function doSearch() {
  const input = document.getElementById('searchInput');
  if (input) searchQuery = input.value.trim();
  loadFiles();
}

function clearSearch() {
  searchQuery = '';
  const input = document.getElementById('searchInput');
  if (input) input.value = '';
  loadFiles();
}

function changeSort(val) {
  sortBy = val;
  loadFiles();
}

function sortItems(items, sort) {
  const copy = items.slice();
  switch (sort) {
    case 'name_asc': return copy.sort((a, b) => a.key.localeCompare(b.key));
    case 'name_desc': return copy.sort((a, b) => b.key.localeCompare(a.key));
    case 'size_asc': return copy.sort((a, b) => a.size - b.size);
    case 'size_desc': return copy.sort((a, b) => b.size - a.size);
    case 'date_asc': return copy.sort((a, b) => new Date(a.last_modified) - new Date(b.last_modified));
    case 'date_desc': return copy.sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
    default: return copy;
  }
}

function fileIcon(ct) {
  if (!ct) return '\u{1F4C4}';
  if (ct.startsWith('image/')) return '\u{1F5BC}\u{FE0F}';
  if (ct.startsWith('video/')) return '\u{1F3AC}';
  if (ct.startsWith('audio/')) return '\u{1F3B5}';
  if (ct.includes('pdf')) return '\u{1F4D5}';
  if (ct.includes('zip') || ct.includes('tar') || ct.includes('gz')) return '\u{1F4E6}';
  if (ct.includes('text') || ct.includes('json') || ct.includes('xml')) return '\u{1F4DD}';
  return '\u{1F4C4}';
}

function encodeURIPath(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

// Batch mode
function toggleBatchMode() {
  batchMode = !batchMode;
  selectedFiles.clear();
  document.getElementById('filesView').classList.toggle('batch-mode', batchMode);
  const btn = document.getElementById('batchBtn');
  if (btn) btn.textContent = batchMode ? t('cancel') : t('batch');
  updateBatchToolbar();
  document.querySelectorAll('.file-item').forEach(el => {
    el.classList.remove('selected');
    const chk = el.querySelector('.file-check');
    if (chk) chk.textContent = '';
  });
}

function exitBatchMode() {
  batchMode = false;
  selectedFiles.clear();
  const fv = document.getElementById('filesView');
  if (fv) fv.classList.remove('batch-mode');
  updateBatchToolbar();
  document.querySelectorAll('.file-item.selected').forEach(el => {
    el.classList.remove('selected');
    const chk = el.querySelector('.file-check');
    if (chk) chk.textContent = '';
  });
}

function updateBatchToolbar() {
  const tb = document.getElementById('batchToolbar');
  if (tb) tb.style.display = batchMode ? 'block' : 'none';
  const cnt = document.getElementById('batchCount');
  if (cnt) cnt.textContent = t('selected_count', selectedFiles.size);
}

function selectAll() {
  document.querySelectorAll('.file-item[data-key]').forEach(el => {
    const key = el.dataset.key;
    if (key) {
      selectedFiles.add(key);
      el.classList.add('selected');
      const chk = el.querySelector('.file-check');
      if (chk) chk.textContent = '\u2713';
    }
  });
  updateBatchToolbar();
}

function onFileClick(event, bucket, key) {
  if (batchMode) {
    event.stopPropagation();
    const el = event.currentTarget;
    if (selectedFiles.has(key)) {
      selectedFiles.delete(key);
      el.classList.remove('selected');
      el.querySelector('.file-check').textContent = '';
    } else {
      selectedFiles.add(key);
      el.classList.add('selected');
      el.querySelector('.file-check').textContent = '\u2713';
    }
    updateBatchToolbar();
    return;
  }
  showFileDetail(bucket, key);
}

async function batchDelete() {
  if (selectedFiles.size === 0) { toast(t('select_files_first')); return; }
  const keys = [...selectedFiles];
  let totalSize = 0;
  const fileListHtml = keys.slice(0, 10).map(k => {
    const obj = loadedObjects.get(k);
    const name = k.split('/').pop() || k;
    const size = obj ? formatSize(obj.size) : '';
    if (obj) totalSize += obj.size;
    return '<div style="font-size:12px;padding:2px 0;color:var(--text)">\u{1F4C4} ' + esc(name) + (size ? ' <span style="color:var(--hint)">(' + size + ')</span>' : '') + '</div>';
  }).join('');
  const moreHtml = keys.length > 10 ? '<div style="font-size:12px;color:var(--hint)">' + esc(t('more_files', keys.length - 10)) + '</div>' : '';
  const sizeHtml = totalSize > 0 ? '<div style="font-size:12px;color:var(--hint);margin-top:4px">' + esc(t('total_label', formatSize(totalSize))) + '</div>' : '';
  showModal(\`
    <span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>
    <h3>\${esc(t('batch_delete_title'))}</h3>
    <p style="margin:8px 0">\${esc(t('batch_delete_msg', keys.length))}</p>
    <div style="max-height:150px;overflow-y:auto;margin:8px 0;padding:8px;background:var(--bg);border-radius:8px">\${fileListHtml}\${moreHtml}\${sizeHtml}</div>
    <p style="margin:8px 0;font-size:13px">\${esc(t('batch_delete_confirm_hint', t('confirm_word')))}</p>
    <input id="deleteConfirmInput" type="text" placeholder="\${esc(t('confirm_word_placeholder'))}" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:14px;box-sizing:border-box" />
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button class="btn btn-sm btn-outline" onclick="closeModal()">\${esc(t('cancel'))}</button>
      <button class="btn btn-sm btn-danger" id="batchDeleteConfirmBtn" onclick="confirmBatchDelete()" disabled>\${esc(t('delete'))}</button>
    </div>
  \`);
  const inp = document.getElementById('deleteConfirmInput');
  const btn = document.getElementById('batchDeleteConfirmBtn');
  if (inp && btn) inp.addEventListener('input', function() { btn.disabled = this.value.trim() !== t('confirm_word'); });
}

function confirmBatchDelete() {
  const inp = document.getElementById('deleteConfirmInput');
  if (!inp || inp.value.trim() !== t('confirm_word')) return;
  doBatchDelete();
}

async function doBatchDelete() {
  closeModal();
  const keys = [...selectedFiles];
  let done = 0;
  const failed = [];
  const total = keys.length;
  let lastToast = 0;
  toast(t('deleting_progress', '0', total));
  for (const key of keys) {
    try {
      await apiFetch('/api/miniapp/object?bucket=' + encodeURIComponent(currentBucket) + '&key=' + encodeURIComponent(key), { method: 'DELETE' });
      done++;
    } catch (e) {
      failed.push(key.split('/').pop() || key);
    }
    var now = Date.now();
    if (now - lastToast >= 500 || done + failed.length >= total) {
      toast(t('deleting_progress', done, total));
      lastToast = now;
    }
  }
  if (failed.length > 0) {
    toast(t('deleted_with_failures', done, total, failed.join(', ')));
  } else {
    toast(t('deleted_count', done, total));
  }
  exitBatchMode();
  loadFiles();
  loadStats();
}

async function batchShare() {
  if (selectedFiles.size === 0) { toast(t('select_files_first')); return; }
  const keys = [...selectedFiles];
  showModal(\`
    <span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>
    <h3>\${esc(t('batch_share_title', keys.length))}</h3>
    <div class="form-group">
      <label>\${esc(t('expiry_label'))}</label>
      <select id="shareExpiry">
        <option value="">\${esc(t('permanent'))}</option>
        <option value="3600">\${esc(t('hour_1'))}</option>
        <option value="86400" selected>\${esc(t('day_1'))}</option>
        <option value="604800">\${esc(t('days_7'))}</option>
        <option value="2592000">\${esc(t('days_30'))}</option>
      </select>
    </div>
    <div class="form-group">
      <label>\${esc(t('password_all'))}</label>
      <input type="text" id="sharePassword" placeholder="\${esc(t('password_placeholder'))}">
    </div>
    <div class="form-group">
      <label>\${esc(t('max_downloads_each'))}</label>
      <input type="number" id="shareMaxDl" min="1" placeholder="\${esc(t('unlimited_hint'))}">
    </div>
    <button class="btn" style="width:100%;margin-top:8px" id="batchShareBtn" onclick="doBatchShare()">\${esc(t('create_share'))}</button>
  \`);
  window._batchShareKeys = keys;
}

async function doBatchShare() {
  const keys = window._batchShareKeys || [];
  if (keys.length === 0) return;
  const expiresIn = parseInt(document.getElementById('shareExpiry').value) || undefined;
  const password = document.getElementById('sharePassword').value || undefined;
  const maxDownloads = parseInt(document.getElementById('shareMaxDl').value) || undefined;
  const btn = document.getElementById('batchShareBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('creating'); }

  const results = [];
  for (const key of keys) {
    try {
      const share = await apiFetch('/api/miniapp/share', {
        method: 'POST',
        body: JSON.stringify({ bucket: currentBucket, key, expiresIn, password, maxDownloads }),
      });
      results.push({ key, url: share.url, ok: true });
    } catch (e) {
      results.push({ key, error: e.message, ok: false });
    }
  }

  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  let html = '<span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span><h3>' + esc(t('batch_share_result')) + '</h3>';
  if (ok.length > 0) {
    html += '<div class="form-group"><label>' + esc(t('success_count', ok.length, results.length)) + '</label>';
    const allUrls = ok.map(r => r.url).join('\\n');
    html += '<textarea readonly style="width:100%;height:' + Math.min(ok.length * 24 + 16, 160) + 'px;font-size:12px;padding:8px;border:1px solid var(--secondary-bg);border-radius:6px;background:var(--bg);color:var(--text);resize:none" onclick="this.select()">' + esc(allUrls) + '</textarea></div>';
    html += '<button class="btn btn-sm" style="margin-bottom:12px" onclick="copyText(\\'';
    html += allUrls.replace(/'/g, "\\\\'").replace(/\\n/g, '\\\\n');
    html += '\\')">' + esc(t('copy_all_links')) + '</button>';
  }
  if (fail.length > 0) {
    html += '<div class="form-group"><label style="color:var(--destructive)">' + esc(t('failure_count', fail.length)) + '</label>';
    html += '<div style="font-size:12px">' + fail.map(r => esc((r.key.split('/').pop() || r.key) + ': ' + r.error)).join('<br>') + '</div></div>';
  }
  showModal(html);
  exitBatchMode();
  loadShares();
}

// Upload
function triggerUpload() {
  document.getElementById('fileInput').click();
}

document.getElementById('fileInput').addEventListener('change', async function() {
  const files = this.files;
  if (!files || files.length === 0) return;
  this.value = '';
  await uploadFiles(files);
});

let uploadCancelled = false;

async function uploadFiles(files) {
  const total = files.length;
  let done = 0;
  const failedFiles = [];
  uploadCancelled = false;
  var totalBytes = 0;
  for (var fi = 0; fi < files.length; fi++) totalBytes += files[fi].size;
  var uploadedBytes = 0;

  showModal(\`
    <h3>\${esc(t('uploading_title'))}</h3>
    <div id="uploadStatus" style="margin:12px 0">\${esc(t('preparing_upload', total))}</div>
    <div class="progress-bar"><div class="progress-bar-fill" id="uploadProgress" style="width:0%"></div></div>
    <div id="uploadDetail" style="font-size:12px;color:var(--hint)"></div>
    <div style="text-align:center;margin-top:12px"><button class="btn btn-sm btn-outline" onclick="uploadCancelled=true">\${esc(t('cancel'))}</button></div>
  \`);

  for (let i = 0; i < files.length; i++) {
    if (uploadCancelled) break;
    const file = files[i];
    const key = currentPrefix + file.name;
    const detail = document.getElementById('uploadDetail');
    const status = document.getElementById('uploadStatus');
    const progress = document.getElementById('uploadProgress');
    if (detail) detail.textContent = t('uploading_file', file.name, formatSize(file.size));
    if (status) status.textContent = t('uploading_progress', i + 1, total);

    if (file.size > 20 * 1024 * 1024) {
      toast(t('large_file_warning'));
    }

    try {
      const presign = await apiFetch('/api/miniapp/presign', {
        method: 'POST',
        body: JSON.stringify({ bucket: currentBucket, key, method: 'PUT', expiresIn: 600 }),
      });

      const putRes = await fetch(presign.url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });

      if (!putRes.ok) throw new Error('PUT failed: ' + putRes.status);
      done++;
    } catch (e) {
      var reason = e && e.message ? e.message : '';
      failedFiles.push(reason ? file.name + ' (' + reason + ')' : file.name);
    }

    uploadedBytes += file.size;
    var pct = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : Math.round(((i + 1) / total) * 100);
    if (progress) progress.style.width = pct + '%';
  }

  closeModal();
  if (uploadCancelled) {
    toast(t('upload_cancelled', done, total));
  } else if (failedFiles.length > 0) {
    const summary = failedFiles.length <= 3
      ? failedFiles.join(', ')
      : failedFiles.slice(0, 3).join(', ') + t('and_more', failedFiles.length);
    toast(t('upload_done_fail', done, total, summary));
  } else {
    toast(t('upload_done', done, total));
  }
  loadFiles();
  loadStats();
}

// Create folder
function showCreateFolder() {
  showModal(\`
    <h3>\${esc(t('new_folder_title'))}</h3>
    <div style="margin:12px 0">
      <label style="font-size:13px;color:var(--hint)">\${esc(t('folder_name_label'))}</label>
      <input type="text" id="folderNameInput" style="width:100%;padding:8px;margin-top:4px;border:1px solid var(--secondary-bg);border-radius:6px;font-size:14px;background:var(--bg);color:var(--text)" onkeydown="if(event.key==='Enter')createFolder()">
    </div>
    <div style="text-align:right">
      <button class="btn btn-sm btn-outline" onclick="closeModal()">\${esc(t('cancel'))}</button>
      <button class="btn btn-sm" onclick="createFolder()" style="margin-left:8px">\${esc(t('confirm'))}</button>
    </div>
  \`);
  setTimeout(() => { var inp = document.getElementById('folderNameInput'); if (inp) inp.focus(); }, 100);
}

async function createFolder() {
  var inp = document.getElementById('folderNameInput');
  var name = (inp ? inp.value : '').trim().replace(/\\/+$/g, '');
  if (!name) { toast(t('folder_name_empty')); return; }
  if (name.includes('/')) { toast(t('folder_name_no_slash')); return; }
  var key = currentPrefix + name + '/';
  try {
    var presign = await apiFetch('/api/miniapp/presign', {
      method: 'POST',
      body: JSON.stringify({ bucket: currentBucket, key: key, method: 'PUT', expiresIn: 60 }),
    });
    var putRes = await fetch(presign.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/x-directory' },
      body: new ArrayBuffer(0),
    });
    if (!putRes.ok) throw new Error('PUT failed: ' + putRes.status);
    closeModal();
    toast(t('folder_created', name));
    loadFiles();
  } catch (e) {
    toast(t('folder_create_failed'));
  }
}

// File detail modal
async function showFileDetail(bucket, key) {
  const gen = ++detailGeneration;
  try {
    const obj = await apiFetch('/api/miniapp/object?bucket=' + encodeURIComponent(bucket) + '&key=' + encodeURIComponent(key));
    if (gen !== detailGeneration) return;
    const name = key.split('/').pop() || key;
    const isImg = obj.content_type && obj.content_type.startsWith('image/');
    const isVideo = obj.content_type && obj.content_type.startsWith('video/');
    const isAudio = obj.content_type && obj.content_type.startsWith('audio/');
    const isPdf = obj.content_type && obj.content_type.includes('pdf');
    const isText = obj.content_type && (obj.content_type.startsWith('text/') || obj.content_type.includes('json') || obj.content_type.includes('xml') || obj.content_type.includes('javascript'));
    const needsPresign = isImg || isVideo || isAudio || (isPdf && obj.size <= 10 * 1024 * 1024);
    let mediaUrl = '';
    if (needsPresign) {
      try { mediaUrl = await getPresignedUrl(bucket, key); } catch (e) { /* preview unavailable */ }
      if (gen !== detailGeneration) return;
    }
    let previewHtml = '';
    if (isImg && mediaUrl) {
      previewHtml = '<div style="text-align:center;margin:8px 0"><img src="' + esc(mediaUrl) + '" style="max-width:100%;max-height:200px;border-radius:8px" onerror="this.style.display=\\'none\\'"></div>';
    } else if (isVideo && mediaUrl) {
      previewHtml = '<div style="text-align:center;margin:8px 0"><video controls preload="metadata" style="max-width:100%;max-height:200px;border-radius:8px" src="' + esc(mediaUrl) + '"></video></div>';
    } else if (isAudio && mediaUrl) {
      previewHtml = '<div style="margin:8px 0"><audio controls preload="metadata" style="width:100%" src="' + esc(mediaUrl) + '"></audio></div>';
    } else if (isPdf && mediaUrl) {
      previewHtml = '<div style="margin:8px 0"><embed src="' + esc(mediaUrl) + '" type="application/pdf" style="width:100%;height:200px;border-radius:8px;border:1px solid var(--secondary-bg)"></div>';
    } else if (isText && obj.size <= 512 * 1024) {
      previewHtml = '<div style="margin:8px 0"><pre id="textPreview" style="max-height:200px;overflow:auto;padding:8px;border:1px solid var(--secondary-bg);border-radius:8px;font-size:12px;white-space:pre-wrap;word-break:break-all;background:var(--secondary-bg)">' + esc(t('loading')) + '</pre></div>';
    }

    showModal(\`
      <span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>
      <h3>\${esc(name)}</h3>
      \${previewHtml}
      <div class="form-group">
        <label>\${esc(t('path_label'))}</label>
        <div style="word-break:break-all;font-size:13px">\${esc(key)}</div>
      </div>
      <div class="form-group">
        <label>\${esc(t('bucket_label'))}</label>
        <div>\${esc(bucket)}</div>
      </div>
      <div class="form-group">
        <label>\${esc(t('size_label'))}</label>
        <div>\${formatSize(obj.size)}</div>
      </div>
      <div class="form-group">
        <label>\${esc(t('type_label'))}</label>
        <div>\${esc(obj.content_type)}</div>
      </div>
      <div class="form-group">
        <label>\${esc(t('etag_label'))}</label>
        <div style="font-family:monospace;font-size:12px">\${esc(obj.etag)}</div>
      </div>
      <div class="form-group">
        <label>\${esc(t('modified_label'))}</label>
        <div>\${new Date(obj.last_modified).toLocaleString()}</div>
      </div>
      \${(function() {
        if (!obj.user_metadata) return '';
        try {
          const meta = JSON.parse(obj.user_metadata);
          const entries = Object.entries(meta);
          if (entries.length === 0) return '';
          return '<div class="form-group"><label>' + esc(t('custom_metadata')) + '</label><div style="font-size:12px">' +
            entries.map(function(e) { return '<div><span style="color:var(--hint)">x-amz-meta-' + esc(e[0]) + ':</span> ' + esc(String(e[1])) + '</div>'; }).join('') +
            '</div></div>';
        } catch(e) { return ''; }
      })()}
      <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
        <button class="btn btn-sm" onclick="downloadFile('\${escJs(bucket)}', '\${escJs(key)}')">\${esc(t('download'))}</button>
        <button class="btn btn-sm btn-outline" onclick="showShareForm('\${escJs(bucket)}', '\${escJs(key)}')">\${esc(t('share'))}</button>
        <button class="btn btn-sm btn-outline" onclick="copyPresignUrl('\${escJs(bucket)}', '\${escJs(key)}')">\${esc(t('presigned_url'))}</button>
        <button class="btn btn-sm btn-outline" onclick="showRenameForm('\${escJs(bucket)}', '\${escJs(key)}')">\${esc(t('rename'))}</button>
        <button class="btn btn-sm btn-danger" onclick="confirmDelete('\${escJs(bucket)}', '\${escJs(key)}')">\${esc(t('delete'))}</button>
      </div>
    \`);
    // Async load text preview content (guarded by generation counter)
    if (isText && obj.size <= 512 * 1024) {
      try {
        const presign = await apiFetch('/api/miniapp/presign', {
          method: 'POST',
          body: JSON.stringify({ bucket, key, method: 'GET', expiresIn: 300 }),
        });
        if (gen !== detailGeneration) return;
        const textRes = await fetch(presign.url);
        if (!textRes.ok) throw new Error('HTTP ' + textRes.status);
        const text = await textRes.text();
        if (gen !== detailGeneration) return;
        const pre = document.getElementById('textPreview');
        if (pre) {
          pre.textContent = text.slice(0, 100000);
          if (text.length > 100000) pre.textContent += '\\n\\n' + t('content_truncated');
        }
      } catch(err) {
        if (gen !== detailGeneration) return;
        const pre = document.getElementById('textPreview');
        if (pre) pre.textContent = t('preview_failed');
      }
    }
  } catch (e) {
    toast(t('load_failed', e.message));
  }
}

async function downloadFile(bucket, key) {
  try {
    const data = await apiFetch('/api/miniapp/presign', {
      method: 'POST',
      body: JSON.stringify({ bucket, key, method: 'GET', expiresIn: 300 }),
    });
    window.open(data.url, '_blank');
    closeModal();
  } catch (e) {
    toast(t('download_link_failed'));
  }
}

async function copyPresignUrl(bucket, key) {
  try {
    const data = await apiFetch('/api/miniapp/presign', {
      method: 'POST',
      body: JSON.stringify({ bucket, key, method: 'GET', expiresIn: 3600 }),
    });
    await navigator.clipboard.writeText(data.url);
    toast(t('presigned_copied'));
  } catch (e) {
    toast(t('presigned_failed'));
  }
}

// Rename/Move
function showRenameForm(bucket, key) {
  const name = key.split('/').pop() || key;
  showModal(\`
    <span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>
    <h3>\${esc(t('rename_move'))}</h3>
    <div class="form-group">
      <label>\${esc(t('current_path'))}</label>
      <div style="word-break:break-all;font-size:12px;color:var(--hint)">\${esc(key)}</div>
    </div>
    <div class="form-group">
      <label>\${esc(t('new_path'))}</label>
      <input type="text" id="renameInput" value="\${esc(key)}">
    </div>
    <button class="btn" style="width:100%;margin-top:8px" onclick="doRename('\${escJs(bucket)}', '\${escJs(key)}')">\${esc(t('confirm'))}</button>
  \`);
}

async function doRename(bucket, oldKey) {
  const btn = document.querySelector('#renameInput + button, .modal button:last-child');
  const newKey = document.getElementById('renameInput').value.trim();
  if (!newKey || newKey === oldKey) { closeModal(); return; }
  if (btn) { btn.disabled = true; btn.textContent = t('renaming'); }
  try {
    await apiFetch('/api/miniapp/rename', {
      method: 'POST',
      body: JSON.stringify({ bucket, oldKey, newKey }),
    });
    toast(t('renamed'));
    closeModal();
    loadFiles();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = t('confirm'); }
    toast(t('rename_failed', e.message));
  }
}

function confirmDelete(bucket, key) {
  const name = key.split('/').pop() || key;
  showModal(\`
    <span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>
    <h3>\${esc(t('confirm_delete'))}</h3>
    <p style="margin:12px 0">\${esc(t('confirm_delete_msg', name))}</p>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-sm btn-outline" onclick="closeModal()">\${esc(t('cancel'))}</button>
      <button class="btn btn-sm btn-danger" onclick="doDelete('\${escJs(bucket)}', '\${escJs(key)}')">\${esc(t('delete'))}</button>
    </div>
  \`);
}

async function doDelete(bucket, key) {
  const btn = event && event.target; if (btn) { btn.disabled = true; btn.textContent = t('deleting'); }
  try {
    await apiFetch('/api/miniapp/object?bucket=' + encodeURIComponent(bucket) + '&key=' + encodeURIComponent(key), { method: 'DELETE' });
    toast(t('deleted'));
    closeModal();
    loadFiles();
    loadStats();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = t('delete'); }
    toast(t('delete_failed', e.message));
  }
}

// Share form
function showShareForm(bucket, key) {
  const name = key.split('/').pop() || key;
  showModal(\`
    <span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>
    <h3>\${esc(t('share_file', name))}</h3>
    <div class="form-group">
      <label>\${esc(t('expiry_label'))}</label>
      <select id="shareExpiry">
        <option value="">\${esc(t('permanent'))}</option>
        <option value="3600">\${esc(t('hour_1'))}</option>
        <option value="86400" selected>\${esc(t('day_1'))}</option>
        <option value="604800">\${esc(t('days_7'))}</option>
        <option value="2592000">\${esc(t('days_30'))}</option>
      </select>
    </div>
    <div class="form-group">
      <label>\${esc(t('password_optional'))}</label>
      <input type="text" id="sharePassword" placeholder="\${esc(t('password_placeholder'))}">
    </div>
    <div class="form-group">
      <label>\${esc(t('max_downloads_optional'))}</label>
      <input type="number" id="shareMaxDl" min="1" placeholder="\${esc(t('unlimited_hint'))}">
    </div>
    <button class="btn" style="width:100%;margin-top:8px" onclick="doShare('\${escJs(bucket)}', '\${escJs(key)}')">\${esc(t('create_share'))}</button>
  \`);
}

async function doShare(bucket, key) {
  const expiresIn = parseInt(document.getElementById('shareExpiry').value) || undefined;
  const password = document.getElementById('sharePassword').value || undefined;
  const maxDownloads = parseInt(document.getElementById('shareMaxDl').value) || undefined;
  const btn = event && event.target; if (btn) { btn.disabled = true; btn.textContent = t('creating'); }
  try {
    const share = await apiFetch('/api/miniapp/share', {
      method: 'POST',
      body: JSON.stringify({ bucket, key, expiresIn, password, maxDownloads }),
    });
    showModal(\`
      <span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>
      <h3>\${esc(t('share_created'))}</h3>
      <div class="form-group">
        <label>\${esc(t('share_link'))}</label>
        <input type="text" readonly value="\${esc(share.url)}" onclick="this.select()">
      </div>
      \${share.expires_at ? '<div class="form-group"><label>' + esc(t('expires_at')) + '</label><div>' + new Date(share.expires_at).toLocaleString() + '</div></div>' : ''}
      <button class="btn" style="width:100%;margin-top:8px" onclick="copyText('\${escJs(share.url)}')">\${esc(t('copy_link'))}</button>
    \`);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = t('create_share'); }
    toast(t('create_share_failed', e.message));
  }
}

// Shares list
async function loadShares() {
  const el = document.getElementById('sharesView');
  showSkeleton(el, 3);
  try {
    const tokens = await apiFetch('/api/miniapp/shares');
    if (tokens.length === 0) {
      el.innerHTML = '<div class="empty">' + esc(t('no_shares')) + '<br><small style="color:var(--hint)">' + esc(t('no_shares_hint')) + '</small></div>';
      return;
    }
    el.innerHTML = tokens.map(tk => {
      const expired = tk.expires_at && new Date(tk.expires_at) < new Date();
      const maxed = tk.max_downloads !== null && tk.download_count >= tk.max_downloads;
      const dlInfo = tk.max_downloads !== null
        ? t('downloads_of_fmt', tk.download_count, tk.max_downloads)
        : t('downloads_fmt', tk.download_count);
      const statusTag = expired
        ? ' <b style="color:var(--destructive)">' + esc(t('expired_tag')) + '</b>'
        : maxed ? ' <b style="color:var(--destructive)">' + esc(t('maxed_tag')) + '</b>' : '';
      return \`
        <div class="share-item">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="share-token">\${esc(tk.token.slice(0, 12))}...</div>
            <button class="btn btn-sm btn-danger" onclick="revokeShare('\${escJs(tk.token)}')">\${esc(t('revoke'))}</button>
          </div>
          <div class="share-meta">
            \${esc(tk.bucket)}/\${esc(tk.key)}<br>
            \${dlInfo}\${statusTag}
            \${tk.expires_at ? '<br>' + esc(t('expires_prefix')) + new Date(tk.expires_at).toLocaleString() : ' ' + esc(t('permanent_label'))}
            \${tk.password_hash ? '<br>' + esc(t('password_set')) : ''}
          </div>
          <div style="margin-top:6px">
            <button class="btn btn-sm btn-outline" onclick="copyText('\${escJs(API + '/share/' + tk.token)}')">\${esc(t('copy_link'))}</button>
          </div>
        </div>\`;
    }).join('');
  } catch (e) {
    if (!authOk) return;
    el.innerHTML = '<div class="empty">' + esc(t('load_failed', e.message)) + '<br><br><button class="btn btn-sm btn-outline" onclick="loadShares()">' + esc(t('retry')) + '</button></div>';
  }
}

async function revokeShare(token) {
  showModal(\`
    <span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>
    <h3>\${esc(t('revoke_share'))}</h3>
    <p style="margin:8px 0">\${esc(t('revoke_confirm'))}</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
      <button class="btn btn-sm btn-outline" onclick="closeModal()">\${esc(t('cancel'))}</button>
      <button class="btn btn-sm btn-danger" onclick="doRevokeShare('\${escJs(token)}')">\${esc(t('revoke'))}</button>
    </div>
  \`);
}

async function doRevokeShare(token) {
  closeModal();
  try {
    await apiFetch('/api/miniapp/share?token=' + encodeURIComponent(token), { method: 'DELETE' });
    toast(t('revoked'));
    loadShares();
  } catch (e) {
    toast(t('revoke_failed'));
  }
}

// Utils
function formatSize(bytes) {
  if (bytes == null) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\\\\/g, '&#92;');
}

// JS string escaping for use inside onclick="func('...')" HTML attribute contexts.
// HTML parser decodes entities BEFORE JS eval, so esc() is wrong for this context.
// escJs: (1) JSON.stringify handles \\ and control chars, (2) escape ' for JS,
// (3) HTML-encode &, ", <, > for attribute safety.
function escJs(s) {
  if (!s) return '';
  var j = JSON.stringify(String(s)).slice(1, -1);
  return j.replace(/'/g, "\\\\'").replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showModal(html) {
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('modalOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('show');
  document.body.style.overflow = '';
}

document.getElementById('modalOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('modalOverlay').classList.contains('show')) {
    closeModal();
  }
  // Enter key submits modal forms: find the primary action button and click it
  if (e.key === 'Enter' && document.getElementById('modalOverlay').classList.contains('show')) {
    var active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) {
      e.preventDefault();
      var btns = document.querySelectorAll('#modalContent .btn:not(.btn-outline):not(.btn-secondary)');
      if (btns.length) btns[btns.length - 1].click();
    }
  }
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('copied'));
  } catch {
    toast(t('copy_failed'));
  }
}

function toast(msg, duration) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  var errPat = new RegExp(t('err_regex'), 'i');
  const ms = duration || (errPat.test(msg) ? 5000 : 2500);
  el._timer = setTimeout(() => el.classList.remove('show'), ms);
}

function showSkeleton(container, count) {
  count = count || 3;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += '<div class="skeleton"></div>';
  }
  container.innerHTML = html;
}

// Lazy thumbnail loading via presigned URLs
var thumbObserver = new IntersectionObserver(function(entries) {
  entries.forEach(function(entry) {
    if (entry.isIntersecting) {
      thumbObserver.unobserve(entry.target);
      loadThumb(entry.target);
    }
  });
}, { rootMargin: '200px' });

function observeThumbnails() {
  document.querySelectorAll('.thumb-lazy:not([src])').forEach(function(img) {
    thumbObserver.observe(img);
  });
}

async function loadThumb(img) {
  var gen = fileListGeneration;
  try {
    var data = await apiFetch('/api/miniapp/presign', {
      method: 'POST',
      body: JSON.stringify({ bucket: img.dataset.bucket, key: img.dataset.key, expiresIn: 3600 }),
    });
    if (gen !== fileListGeneration) return;
    img.src = data.url;
  } catch (e) {
    if (gen !== fileListGeneration) return;
    img.outerHTML = '<span style="font-size:24px">\u{1F5BC}\u{FE0F}</span>';
  }
}

async function getPresignedUrl(bucket, key) {
  var data = await apiFetch('/api/miniapp/presign', {
    method: 'POST',
    body: JSON.stringify({ bucket: bucket, key: key, expiresIn: 300 }),
  });
  return data.url;
}

// Drag & drop upload on files view
let dragCounter = 0;
document.addEventListener('dragover', function(e) {
  e.preventDefault();
});
document.addEventListener('dragenter', function(e) {
  dragCounter++;
  const fv = document.getElementById('filesView');
  if (fv.classList.contains('active') && currentBucket) {
    fv.classList.add('dragover');
  }
});
document.addEventListener('dragleave', function(e) {
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    document.getElementById('filesView').classList.remove('dragover');
  }
});
document.addEventListener('drop', function(e) {
  e.preventDefault();
  dragCounter = 0;
  document.getElementById('filesView').classList.remove('dragover');
  if (!e.dataTransfer.files.length) {
    if (e.dataTransfer.items && e.dataTransfer.items.length) { toast(t('folder_drop_unsupported')); }
    return;
  }
  var hasFolder = false;
  for (var di = 0; di < e.dataTransfer.items.length; di++) {
    var entry = e.dataTransfer.items[di].webkitGetAsEntry && e.dataTransfer.items[di].webkitGetAsEntry();
    if (entry && entry.isDirectory) { hasFolder = true; break; }
  }
  if (hasFolder) { toast(t('folder_drop_unsupported')); return; }
  var files = [];
  for (var fi = 0; fi < e.dataTransfer.files.length; fi++) {
    if (e.dataTransfer.files[fi].size > 0 || e.dataTransfer.files[fi].type) files.push(e.dataTransfer.files[fi]);
  }
  if (!files.length) return;
  const fv = document.getElementById('filesView');
  if (fv.classList.contains('active') && currentBucket) {
    uploadFiles(files);
  } else if (!currentBucket) {
    toast(t('select_bucket_first'));
  } else {
    toast(t('switch_to_files'));
  }
});

// ── Keys (Credential management) ─────────────────────────────────────
async function loadKeys() {
  var el = document.getElementById('keysView');
  showSkeleton(el, 3);
  try {
    var creds = await apiFetch('/api/miniapp/credentials');
    var createBtn = '<div style="padding:4px 0 8px"><button class="btn btn-sm" onclick="showCreateKey()">' + esc(t('key_create_btn')) + '</button></div>';
    if (creds.length === 0) {
      el.innerHTML = createBtn +
        '<div class="empty">' + esc(t('key_no_keys')) + '<br><small style="color:var(--hint)">' + esc(t('key_no_keys_hint')) + '</small></div>';
      return;
    }
    el.innerHTML = createBtn + creds.map(function(c) {
      var statusClass = c.status === 'active' ? 'badge-active' : 'badge-inactive';
      var statusLabel = c.status === 'active' ? t('key_status_active') : t('key_status_inactive');
      var toggleLabel = c.status === 'active' ? t('key_deactivate') : t('key_activate');
      var lastUsed = c.last_used_at ? new Date(c.last_used_at).toLocaleString() : t('key_never_used');
      var bucketsDisplay = c.buckets === '*' ? t('key_all_buckets') : esc(c.buckets);
      return '<div class="cred-item">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<div class="cred-name">' + esc(c.name) + '</div>' +
          '<span class="badge ' + statusClass + '">' + esc(statusLabel) + '</span>' +
        '</div>' +
        '<div class="cred-key">' + esc(c.access_key_id) + '</div>' +
        '<div class="cred-key">' + esc(t('key_secret_label')) + ': ' + esc(c.secret_access_key) + '</div>' +
        '<div class="cred-meta">' +
          '<span class="badge badge-perm">' + esc(c.permission) + '</span>' +
          ' &middot; ' + esc(t('key_buckets_label')) + ': ' + bucketsDisplay +
          '<br>' + esc(t('key_last_used')) + ': ' + esc(lastUsed) +
        '</div>' +
        '<div class="cred-actions">' +
          '<button class="btn btn-sm btn-outline" onclick="toggleKeyStatus(\\'' + escJs(c.access_key_id) + '\\', \\'' + escJs(c.status === 'active' ? 'inactive' : 'active') + '\\')">' + esc(toggleLabel) + '</button>' +
          '<button class="btn btn-sm btn-danger" onclick="confirmDeleteKey(\\'' + escJs(c.access_key_id) + '\\', \\'' + escJs(c.name) + '\\')">' + esc(t('delete')) + '</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    if (!authOk) return;
    el.innerHTML = '<div class="empty">' + esc(t('load_failed', e.message)) + '<br><br><button class="btn btn-sm btn-outline" onclick="loadKeys()">' + esc(t('retry')) + '</button></div>';
  }
}

function showCreateKey() {
  showModal(
    '<span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>' +
    '<h3>' + esc(t('key_create_title')) + '</h3>' +
    '<div class="form-group">' +
      '<label>' + esc(t('key_name_label')) + '</label>' +
      '<input type="text" id="keyName" placeholder="' + esc(t('key_name_placeholder')) + '">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>' + esc(t('key_permission_label')) + '</label>' +
      '<select id="keyPermission">' +
        '<option value="admin">' + esc(t('key_perm_admin')) + '</option>' +
        '<option value="readwrite" selected>' + esc(t('key_perm_readwrite')) + '</option>' +
        '<option value="readonly">' + esc(t('key_perm_readonly')) + '</option>' +
      '</select>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>' + esc(t('key_buckets_input_label')) + '</label>' +
      '<input type="text" id="keyBuckets" value="*" placeholder="*">' +
      '<div style="font-size:11px;color:var(--hint);margin-top:4px">' + esc(t('key_buckets_hint')) + '</div>' +
    '</div>' +
    '<button class="btn" style="width:100%;margin-top:8px" id="createKeyBtn" onclick="doCreateKey()">' + esc(t('create')) + '</button>'
  );
}

async function doCreateKey() {
  var name = (document.getElementById('keyName').value || '').trim();
  if (!name) { toast(t('key_name_required')); return; }
  var permission = document.getElementById('keyPermission').value;
  var buckets = (document.getElementById('keyBuckets').value || '*').trim();
  var btn = document.getElementById('createKeyBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('creating'); }
  try {
    var result = await apiFetch('/api/miniapp/credential', {
      method: 'POST',
      body: JSON.stringify({ name: name, permission: permission, buckets: buckets }),
    });
    showModal(
      '<span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>' +
      '<h3>' + esc(t('key_created_title')) + '</h3>' +
      '<div class="form-group">' +
        '<label>' + esc(t('key_akid_label')) + '</label>' +
        '<div class="secret-reveal">' + esc(result.access_key_id) + '</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>' + esc(t('key_sk_label')) + '</label>' +
        '<div class="secret-reveal">' + esc(result.secret_access_key) + '</div>' +
      '</div>' +
      '<div class="secret-warning">' + esc(t('key_secret_warning')) + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
        '<button class="btn" style="flex:1" onclick="copyText(\\'' + escJs(result.access_key_id + '\\n' + result.secret_access_key) + '\\')">' + esc(t('key_copy_both')) + '</button>' +
      '</div>'
    );
    loadKeys();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = t('create'); }
    toast(t('create_failed', e.message));
  }
}

async function toggleKeyStatus(accessKeyId, newStatus) {
  try {
    await apiFetch('/api/miniapp/credential', {
      method: 'PATCH',
      body: JSON.stringify({ access_key_id: accessKeyId, status: newStatus }),
    });
    toast(t('key_status_updated'));
    loadKeys();
  } catch (e) {
    toast(t('key_update_failed', e.message));
  }
}

function confirmDeleteKey(accessKeyId, name) {
  showModal(
    '<span class="modal-close" role="button" aria-label="Close" onclick="closeModal()">&times;</span>' +
    '<h3>' + esc(t('key_delete_title')) + '</h3>' +
    '<p style="margin:12px 0">' + esc(t('key_delete_confirm', name)) + '</p>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="btn btn-sm btn-outline" onclick="closeModal()">' + esc(t('cancel')) + '</button>' +
      '<button class="btn btn-sm btn-danger" onclick="doDeleteKey(\\'' + escJs(accessKeyId) + '\\')">' + esc(t('delete')) + '</button>' +
    '</div>'
  );
}

async function doDeleteKey(accessKeyId) {
  closeModal();
  try {
    await apiFetch('/api/miniapp/credential?access_key_id=' + encodeURIComponent(accessKeyId), { method: 'DELETE' });
    toast(t('deleted'));
    loadKeys();
  } catch (e) {
    toast(t('delete_failed', e.message));
  }
}
</script>
</body>
</html>`;
}
