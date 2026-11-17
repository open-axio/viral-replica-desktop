// 「找爆款」内置浏览窗口
//
// 用户在这里用自己的账号正常浏览抖音 / 小红书 / B 站（平台要登录就扫码，登录状态保存在
// 独立的 persist:find-viral 分区，和工作台主窗口分开）。看到想做的视频，点顶栏「同款复刻」：
// 从当前页面读出配文、作者、数据、可见的评论，下载页面正在播放的那条视频，交给工作台
// 建一个新项目。
//
// 刻意不做的：不调平台的签名接口、不伪造身份、不在后台批量抓取。只读用户正在看的这一页。

const { BrowserWindow, WebContentsView, session, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const TOOLBAR_H = 56;
const MAX_BYTES = 1024 * 1024 * 1024;
const REFERER_MARK = 'x-viral-replica-referer';

const PLATFORMS = {
  douyin: {
    name: '抖音', home: 'https://www.douyin.com/',
    search: (kw) => `https://www.douyin.com/search/${encodeURIComponent(kw)}?type=video`,
    hosts: /(^|\.)(douyin\.com|iesdouyin\.com|douyinvod\.com)$/,
  },
  xiaohongshu: {
    name: '小红书', home: 'https://www.xiaohongshu.com/explore',
    search: (kw) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}&source=web_search_result_notes`,
    hosts: /(^|\.)(xiaohongshu\.com|xhslink\.com|xhscdn\.com|rednote\.com)$/,
  },
  bilibili: {
    name: 'B站', home: 'https://www.bilibili.com/',
    search: (kw) => `https://search.bilibili.com/video?keyword=${encodeURIComponent(kw)}`,
    hosts: /(^|\.)(bilibili\.com|b23\.tv|bilivideo\.com|bilivideo\.cn)$/,
  },
};

function platformOf(url) {
  try {
    const host = new URL(url).hostname;
    for (const [key, p] of Object.entries(PLATFORMS)) if (p.hosts.test(host)) return key;
  } catch (e) { /* noop */ }
  return 'other';
}

// 从分享文案里取链接：「3.89 复制打开抖音，看看【xx的作品】... https://v.douyin.com/abc/ xxx」
function urlFromShareText(text) {
  const m = String(text || '').match(/https?:\/\/[^\s，。,；;"'<>【】]+/);
  return m ? m[0] : '';
}

let ctx = { port: () => 8765, mainWindow: () => null };
let win = null;
let view = null;
let busy = false;
let lastKeyword = '';
let status = { kind: 'idle', text: '' };
const mediaSeen = new Map();   // webContents id -> [{ url, type, at }]

function init(options) { ctx = { ...ctx, ...options }; }

function chromeLikeUA() {
  // 默认 UA 带「Electron/xx」，部分网页会提示浏览器不支持；换成同版本 Chromium 的 UA
  return app.userAgentFallback.replace(/\s(Electron|viral-replica-desktop|ViralReplica)\/\S+/g, '');
}

function siteSession() {
  const ses = session.fromPartition('persist:find-viral');
  if (!ses.__findViralReady) {
    ses.__findViralReady = true;
    ses.setUserAgent(chromeLikeUA(), 'zh-CN,zh;q=0.9');
    // 下载视频时要带上「从哪个页面来」（Referer），和页面自己播放时一样，否则 CDN 返回 403。
    // Electron 不让 fetch 直接设 Referer，这里只把我们自己下载请求上的标记头换成 Referer，别的请求原样放行。
    ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (d, done) => {
      const h = d.requestHeaders;
      const key = Object.keys(h).find((k) => k.toLowerCase() === REFERER_MARK);
      if (key) {
        h.Referer = h[key];
        try { h.Origin = new URL(h[key]).origin; } catch (e) { /* noop */ }
        delete h[key];
      }
      done({ requestHeaders: h });
    });
    // 只记录「这一页自己播放的媒体地址」，用来找页面上正在放的那条视频
    ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (d) => {
      const type = String((d.responseHeaders && (d.responseHeaders['content-type'] || d.responseHeaders['Content-Type']) || [''])[0]).toLowerCase();
      const isMedia = /^(video|audio)\//.test(type) || /\.(mp4|m4s|m4a)(\?|$)/i.test(d.url);
      if (!isMedia || !d.webContentsId) return;
      const list = mediaSeen.get(d.webContentsId) || [];
      const url = d.url;
      const i = list.findIndex((x) => x.url === url);
      if (i >= 0) list.splice(i, 1);
      list.push({ url, type, at: Date.now() });
      while (list.length > 60) list.shift();
      mediaSeen.set(d.webContentsId, list);
    });
  }
  return ses;
}

function sendState() {
  if (!win || win.isDestroyed() || !view) return;
  const wc = view.webContents;
  const url = wc.getURL();
  win.webContents.send('browse:state', {
    url,
    platform: platformOf(url),
    canBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
    canForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
    loading: wc.isLoading(),
    keyword: lastKeyword,
    busy,
    status,
  });
}

function setStatus(kind, text, extra) {
  status = { kind, text, ...(extra || {}) };
  sendState();
}

function layout() {
  if (!win || !view) return;
  const [w, h] = win.getContentSize();
  view.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: Math.max(0, h - TOOLBAR_H) });
}

function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  const parent = ctx.mainWindow();
  const b = parent && !parent.isDestroyed() ? parent.getBounds() : { x: undefined, y: undefined };
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    x: b.x !== undefined ? b.x + 40 : undefined, y: b.y !== undefined ? b.y + 30 : undefined,
    title: '找爆款', backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'browse-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'browse.html'));
  view = new WebContentsView({
    webPreferences: { session: siteSession(), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.contentView.addChildView(view);
  layout();
  win.on('resize', layout);
  const wc = view.webContents;
  // 页面里「新窗口打开」的链接（比如搜索结果点进详情）留在这个窗口里打开
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
    wc.on(ev, () => {
      if (ev === 'did-navigate' && status.kind !== 'working') status = { kind: 'idle', text: '' };
      sendState();
    });
  }
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) setStatus('error', `页面没打开（${desc}）。检查一下网络，点刷新再试`);
  });
  win.on('closed', () => {
    if (view) mediaSeen.delete(view.webContents.id);
    win = null; view = null; busy = false; status = { kind: 'idle', text: '' };
  });
  return win;
}

function open(opts) {
  const o = opts || {};
  ensureWindow();
  let url = '';
  if (o.url) url = urlFromShareText(o.url) || (/^https?:/.test(o.url) ? o.url : '');
  if (!url && o.keyword) {
    const p = PLATFORMS[o.platform] || PLATFORMS.douyin;
    lastKeyword = String(o.keyword).trim().slice(0, 60);
    url = p.search(lastKeyword);
  }
  if (!url) url = (PLATFORMS[o.platform] || PLATFORMS.douyin).home;
  if (!o.keyword) lastKeyword = '';
  status = { kind: 'idle', text: '' };
  view.webContents.loadURL(url);
  win.show(); win.focus();
  sendState();
  return { ok: true, url };
}

// ---------- 读当前页面 ----------

// 在页面里执行：只读 DOM 和页面自己已经加载好的数据，不发任何请求
const EXTRACT = `(() => {
  const txt = (el) => el ? String(el.innerText || el.textContent || '').replace(/\\s+\\n/g, '\\n').trim() : '';
  const meta = (n) => { const m = document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]'); return m ? m.content || '' : ''; };
  const pick = (...sels) => { for (const s of sels) { const el = document.querySelector(s); const t = txt(el); if (t) return t; } return ''; };
  const deepAll = (sel, root = document, out = [], depth = 0) => {
    if (depth > 8) return out;
    root.querySelectorAll(sel).forEach((el) => out.push(el));
    root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) deepAll(sel, el.shadowRoot, out, depth + 1); });
    return out;
  };
  // 页面上「正在看的那条」视频：优先在播放的，其次可见面积最大的
  const vids = [...document.querySelectorAll('video')].map((v) => {
    const r = v.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return { v, area: w * h, playing: !v.paused && !v.ended };
  }).filter((x) => x.area > 2000).sort((a, b) => (b.playing - a.playing) || (b.area - a.area));
  const v = vids[0] && vids[0].v;
  const sources = v ? [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)].filter((s) => /^https?:/.test(s || '')) : [];
  const host = location.hostname;
  const out = { url: location.href, title: '', desc: '', author: '', stats: {}, comments: [], sources, hasVideo: !!v, extra: {} };
  const comments = (items, userSel, textSel, likeSel) => items.slice(0, 20).map((el) => ({
    user: txt(el.querySelector(userSel)), text: txt(el.querySelector(textSel)) || '', likes: likeSel ? txt(el.querySelector(likeSel)) : '',
  })).filter((c) => c.text);
  if (/douyin\\.com$/.test(host)) {
    const modal = new URLSearchParams(location.search).get('modal_id');
    const idm = location.pathname.match(/\\/video\\/(\\d+)/);
    const id = modal || (idm && idm[1]) || '';
    if (id) out.url = 'https://www.douyin.com/video/' + id;
    out.desc = pick('[data-e2e="detail-video-info"] h1', '[data-e2e="video-desc"]', '[data-e2e="detail-video-info"]') || meta('description');
    out.author = pick('[data-e2e="detail-video-info"] [data-e2e="video-author-title"]', '[data-e2e="user-info"] a span', '[data-e2e="feed-video-nickname"]', '[data-e2e="video-author-title"]');
    out.stats = { likes: pick('[data-e2e="video-player-digg"]'), comments: pick('[data-e2e="feed-comment-icon"]', '[data-e2e="video-player-comment"]'), collects: pick('[data-e2e="video-player-collect"]'), shares: pick('[data-e2e="video-player-share"]') };
    out.comments = comments([...document.querySelectorAll('[data-e2e="comment-item"]')], '[data-e2e="comment-item"] a span, .comment-item-info-wrap a', '.comment-item-content, [data-e2e="comment-item"] p, span[class*="content"]', '');
  } else if (/(xiaohongshu|rednote)\\.com$/.test(host)) {
    out.title = pick('#detail-title', '.note-content .title');
    out.desc = pick('#detail-desc', '.note-content .desc') || meta('description');
    out.author = pick('.author-wrapper .username', '.author-container .name', '.author .name');
    out.stats = { likes: pick('.interact-container .like-wrapper .count', '.engage-bar .like-wrapper .count'), collects: pick('.interact-container .collect-wrapper .count'), comments: pick('.interact-container .chat-wrapper .count') };
    out.comments = comments([...document.querySelectorAll('.comment-item')], '.author .name, .name', '.content .note-text, .content', '.like .count');
    try {
      const st = window.__INITIAL_STATE__;
      const map = st && st.note && st.note.noteDetailMap;
      const nid = (location.pathname.match(/(?:explore|item)\\/([0-9a-f]+)/) || [])[1] || (st && st.note && st.note.currentNoteId);
      const note = map && nid && map[nid] && map[nid].note;
      const raw = note && (note.__v_raw || note);
      const h264 = raw && raw.video && raw.video.media && raw.video.media.stream && raw.video.media.stream.h264;
      if (h264 && h264.length) out.sources.push(...h264.map((s) => s.masterUrl).filter(Boolean));
      if (raw && !out.title) out.title = raw.title || '';
      if (raw && !out.desc) out.desc = raw.desc || '';
    } catch (e) { /* 页面结构变了就靠 DOM 和网络里看到的地址 */ }
  } else if (/bilibili\\.com$/.test(host)) {
    out.title = pick('h1.video-title', '.video-info-title h1') || meta('og:title');
    out.desc = pick('.basic-desc-info', '.desc-info-text') || meta('description');
    out.author = pick('.up-name', '.up-detail-top a');
    out.stats = { views: pick('.view-text', '.view.item'), likes: pick('.video-like-info'), coins: pick('.video-coin-info'), collects: pick('.video-fav-info'), shares: pick('.video-share-info-text') };
    try {
      const st = window.__INITIAL_STATE__ || {};
      out.extra.cid = String((st.videoData && st.videoData.cid) || st.cid || '');
      const pi = window.__playinfo__ && window.__playinfo__.data && window.__playinfo__.data.dash;
      if (pi) out.extra.dash = { video: (pi.video || []).map((x) => ({ url: x.baseUrl || x.base_url, id: x.id, codecid: x.codecid, height: x.height })), audio: (pi.audio || []).map((x) => ({ url: x.baseUrl || x.base_url, id: x.id })) };
    } catch (e) { /* noop */ }
    out.comments = deepAll('bili-comment-renderer').slice(0, 20).map((el) => {
      const r = el.shadowRoot || el;
      const rich = r.querySelector('bili-rich-text');
      const text = rich && rich.shadowRoot ? txt(rich.shadowRoot.querySelector('#contents')) : txt(rich);
      const user = r.querySelector('bili-comment-user-info');
      return { user: user && user.shadowRoot ? txt(user.shadowRoot.querySelector('#user-name')) : '', text, likes: '' };
    }).filter((c) => c.text);
  } else {
    out.title = meta('og:title') || document.title;
    out.desc = meta('og:description') || meta('description');
  }
  if (!out.title) out.title = (document.title || '').replace(/\\s*[-_|].{0,12}$/, '').trim();
  return out;
})()`;

// 返回按优先级排好的候选：{ videos: [url...], audios: [url...] }。下载时依次试，前一个失败就用下一个。
function chooseMedia(platform, info, wcId) {
  const seen = (mediaSeen.get(wcId) || []).slice().reverse();   // 新的在前
  const pathOf = (u) => String(u || '').split('?')[0];
  const seenPaths = new Set(seen.map((x) => pathOf(x.url)));
  const uniq = (list) => [...new Set(list.filter(Boolean))];
  if (platform === 'bilibili') {
    const cid = info.extra && info.extra.cid;
    const forThis = (u) => !cid || u.includes(`/${cid}-`) || u.includes(`/${cid}/`);
    const played = (x) => seenPaths.has(pathOf(x.url));
    const dash = (info.extra && info.extra.dash) || {};
    // 视频：先用页面正在播的那一路；否则 1080p 以内、H.264 优先、画质高的在前
    const vids = (dash.video || []).filter((x) => x.url && forThis(x.url) && (!x.height || x.height <= 1080))
      .sort((a, b) => played(b) - played(a) || (b.codecid === 7) - (a.codecid === 7) || (b.height || 0) - (a.height || 0));
    // 音频：先用页面正在播的那一路；否则码率从低到高（高码率音轨有的网络/账号拿不到）
    const auds = (dash.audio || []).filter((x) => x.url && forThis(x.url)).sort((a, b) => played(b) - played(a) || a.id - b.id);
    const num = (u) => Number((u.match(/-1-(\d+)\.m4s/) || [])[1] || 0);
    const isAudio = (u) => num(u) >= 30200 && num(u) < 30300;
    const m4s = seen.map((x) => x.url).filter((u) => /\.m4s(\?|$)/.test(u) && forThis(u));
    const videos = uniq([...vids.map((x) => x.url), ...m4s.filter((u) => !isAudio(u))]);
    const audios = uniq([...auds.map((x) => x.url), ...m4s.filter(isAudio)]);
    return videos.length ? { videos, audios } : null;
  }
  const direct = (info.sources || []).filter((u) => /^https?:/.test(u));
  const heard = seen.filter((x) => /^video\//.test(x.type) || /\.mp4(\?|$)/i.test(x.url)).map((x) => x.url);
  const videos = uniq([...direct, ...heard]);
  return videos.length ? { videos, audios: [] } : null;
}

// 后台直接下载被拒时，改由页面自己去取（和它播放时发出的请求完全一样），再分块交给这边写文件。
// 只用 executeJavaScript 由这边逐块拉取，页面不能主动往应用里推任何东西。
async function downloadViaPage(wc, url, file, label) {
  const key = '__vrDl' + Math.random().toString(36).slice(2);
  const start = await wc.executeJavaScript(`(async () => {
    const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    if (!res.ok) return { ok: false, status: res.status };
    const buf = new Uint8Array(await res.arrayBuffer());
    window[${JSON.stringify(key)}] = buf;
    return { ok: true, size: buf.length };
  })()`, true);
  if (!start || !start.ok) throw new Error(`${label}下载失败（HTTP ${start && start.status}）`);
  if (start.size > MAX_BYTES) throw new Error('视频超过 1GB，换一条短一点的');
  const out = fs.openSync(file, 'w');
  try {
    const CHUNK = 4 * 1024 * 1024;
    for (let off = 0; off < start.size; off += CHUNK) {
      const b64 = await wc.executeJavaScript(`(() => {
        const b = window[${JSON.stringify(key)}].subarray(${off}, ${off + CHUNK});
        let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        return btoa(s);
      })()`, true);
      fs.writeSync(out, Buffer.from(b64, 'base64'));
      setStatus('working', `正在下载${label} ${Math.min(100, Math.floor(((off + CHUNK) / start.size) * 100))}%`);
    }
  } finally {
    fs.closeSync(out);
    wc.executeJavaScript(`delete window[${JSON.stringify(key)}]`, true).catch(() => {});
  }
  if (fs.statSync(file).size !== start.size) throw new Error(`${label}没下载完整，再点一次试试`);
}

async function downloadFirst(wc, urls, referer, file, label) {
  let last = null;
  for (const url of urls.slice(0, 4)) {
    try { await download(wc.session, url, referer, file, label); return url; } catch (err) { last = err; }
    try { await downloadViaPage(wc, url, file, label); return url; } catch (err) { last = err; }
  }
  throw last || new Error(`${label}下载失败`);
}

async function download(ses, url, referer, file, label) {
  const res = await ses.fetch(url, { headers: { [REFERER_MARK]: referer } });
  if (!res.ok) throw new Error(`${label}下载失败（HTTP ${res.status}）`);
  const total = Number(res.headers.get('content-length') || 0);
  if (total > MAX_BYTES) throw new Error('视频超过 1GB，换一条短一点的');
  let got = 0; let lastPct = -1;
  const src = Readable.fromWeb(res.body);
  src.on('data', (chunk) => {
    got += chunk.length;
    if (got > MAX_BYTES) src.destroy(new Error('视频超过 1GB，换一条短一点的'));
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct !== lastPct && (pct % 5 === 0 || pct < 0)) {
      lastPct = pct;
      setStatus('working', pct >= 0 ? `正在下载${label} ${pct}%` : `正在下载${label} ${(got / 1048576).toFixed(1)} MB`);
    }
  });
  await pipeline(src, fs.createWriteStream(file));
  if (fs.statSync(file).size <= 0) throw new Error('下载到的是空文件');
}

async function api(method, p, body) {
  const base = `http://127.0.0.1:${ctx.port()}/api/`;
  const st = await (await fetch(base + 'status')).json();
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Client-Build': st.build || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `工作台返回 ${res.status}`);
  return data;
}

async function capture() {
  if (!view || busy) return;
  busy = true;
  const files = [];
  try {
    setStatus('working', '正在读取这条视频…');
    const wc = view.webContents;
    const pageUrl = wc.getURL();
    const platform = platformOf(pageUrl);
    const info = await Promise.race([
      wc.executeJavaScript(EXTRACT, true),
      new Promise((_, reject) => setTimeout(() => reject(new Error('页面没有响应，等它加载完再点一次「同款复刻」')), 15000)),
    ]);
    if (!info.hasVideo && !(info.sources || []).length) {
      throw new Error('这一页没找到视频。先点开一条视频，看到它在播放了，再点「同款复刻」');
    }
    const media = chooseMedia(platform, info, wc.id);
    if (!media) {
      throw new Error('这条视频的播放地址拿不到。先让视频播放几秒再点；还不行，就用手机下载后拖进工作台');
    }
    const { dir } = await api('GET', 'import-video/dir');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    const vfile = path.join(dir, `v-${stamp}.${platform === 'bilibili' ? 'm4s' : 'mp4'}`);
    files.push(vfile);
    await downloadFirst(wc, media.videos, pageUrl, vfile, '视频');
    let afile = '';
    if (media.audios.length) {
      afile = path.join(dir, `a-${stamp}.m4s`);
      files.push(afile);
      await downloadFirst(wc, media.audios, pageUrl, afile, '音频');
    }
    setStatus('working', '正在建项目…');
    const origin = {
      platform, url: info.url || pageUrl, title: info.title, desc: info.desc, author: info.author,
      stats: info.stats, comments: info.comments, keyword: lastKeyword,
    };
    const project = await api('POST', 'import-video', { video: vfile, audio: afile || null, origin });
    files.length = 0;   // 工作台已接手（并清理）
    setStatus('done', `已建好项目「${project.name}」`, { projectId: project.id });
    const main = ctx.mainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send('browse:imported', project);
    }
  } catch (err) {
    setStatus('error', String((err && err.message) || err));
  } finally {
    for (const f of files) { try { fs.unlinkSync(f); } catch (e) { /* noop */ } }
    busy = false;
    sendState();
  }
}

function showProject() {
  const main = ctx.mainWindow();
  if (main && !main.isDestroyed()) {
    if (status.projectId) main.webContents.send('browse:imported', { id: status.projectId, focus: true });
    main.show(); main.focus();
  }
}

function register() {
  ipcMain.handle('browse:open', (_e, opts) => open(opts));
  ipcMain.handle('browse:toolbar', (e, action, arg) => {
    if (!win || e.sender !== win.webContents) return null;
    const wc = view && view.webContents;
    if (!wc) return null;
    const nav = wc.navigationHistory || wc;
    if (action === 'back' && nav.canGoBack()) nav.goBack();
    else if (action === 'forward' && nav.canGoForward()) nav.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'home') wc.loadURL((PLATFORMS[arg] || PLATFORMS.douyin).home);
    else if (action === 'search' && arg && arg.keyword) {
      lastKeyword = String(arg.keyword).trim().slice(0, 60);
      wc.loadURL((PLATFORMS[arg.platform] || PLATFORMS[platformOf(wc.getURL())] || PLATFORMS.douyin).search(lastKeyword));
    } else if (action === 'capture') capture();
    else if (action === 'show-project') showProject();
    else if (action === 'state') sendState();
    return true;
  });
}

module.exports = { mediaSeen, init, register, open, capture, platformOf, urlFromShareText, chooseMedia, PLATFORMS, EXTRACT };
