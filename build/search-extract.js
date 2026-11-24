'use strict';

// 从抖音 / 小红书搜索结果页当时能看到的内容收条目。
// 只读页面已有数据，不编造字段；平台改版时可能取不到。

function textOf(v) {
  if (v == null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function firstUrl(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^https?:/.test(v)) return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const u = firstUrl(v[i]);
      if (u) return u;
    }
    return '';
  }
  if (typeof v === 'object') {
    return firstUrl(v.url_list) || firstUrl(v.urlList) || firstUrl(v.urls) || firstUrl(v.url)
      || firstUrl(v.src) || firstUrl(v.uri) || firstUrl(v.thumbnail) || firstUrl(v.thumb)
      || firstUrl(v.info_list) || firstUrl(v.origin_cover) || firstUrl(v.originCover);
  }
  return '';
}

function firstText() {
  for (let i = 0; i < arguments.length; i++) {
    const t = textOf(arguments[i]);
    if (t) return t;
  }
  return '';
}

function statVal(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' && isFinite(v)) return String(v);
  return textOf(v);
}

function packStats(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const stats = {};
  const likes = statVal(raw.likes != null ? raw.likes : (raw.digg_count != null ? raw.digg_count : (raw.diggCount != null ? raw.diggCount : (raw.likedCount != null ? raw.likedCount : (raw.liked_count != null ? raw.liked_count : raw.like_count)))));
  const views = statVal(raw.views != null ? raw.views : (raw.play_count != null ? raw.play_count : (raw.playCount != null ? raw.playCount : raw.view_count)));
  const comments = statVal(raw.comments != null ? raw.comments : (raw.comment_count != null ? raw.comment_count : raw.commentCount));
  const collects = statVal(raw.collects != null ? raw.collects : (raw.collect_count != null ? raw.collect_count : (raw.collectCount != null ? raw.collectCount : raw.collectedCount)));
  if (likes) stats.likes = likes;
  if (views) stats.views = views;
  if (comments) stats.comments = comments;
  if (collects) stats.collects = collects;
  return Object.keys(stats).length ? stats : undefined;
}

function platformName(platform) {
  if (platform === 'xiaohongshu') return '小红书';
  if (platform === 'bilibili') return 'B站';
  return '抖音';
}

function itemFromDouyin(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const aweme = obj.aweme_info || obj.awemeInfo || ((obj.aweme_id || obj.awemeId) ? obj : null);
  if (!aweme || typeof aweme !== 'object') return null;
  const id = textOf(aweme.aweme_id || aweme.awemeId || aweme.id);
  if (!id || !/^\d{5,}$/.test(id)) return null;
  const authorObj = aweme.author;
  const author = authorObj && typeof authorObj === 'object'
    ? firstText(authorObj.nickname, authorObj.nick_name, authorObj.unique_id)
    : firstText(aweme.nickname, aweme.author);
  const video = aweme.video || {};
  const cover = firstUrl(video.cover) || firstUrl(video.origin_cover) || firstUrl(video.originCover) || firstUrl(aweme.cover);
  const title = firstText(aweme.desc, aweme.description, aweme.title, aweme.preview_title);
  const item = { id: id, url: 'https://www.douyin.com/video/' + id, platform: 'douyin', platformName: '抖音' };
  if (title) item.title = title;
  if (author) item.author = author;
  if (cover) item.cover = cover;
  const stats = packStats(aweme.statistics || aweme.stats || {});
  if (stats) item.stats = stats;
  if (!item.title && !item.author && !item.cover) return null;
  return item;
}

function itemFromXhs(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const note = obj.note_card || obj.noteCard || obj.note
    || ((obj.note_id || obj.noteId || (obj.id && (obj.display_title || obj.displayTitle || obj.title || obj.cover || obj.user))) ? obj : null);
  if (!note || typeof note !== 'object') return null;
  const id = textOf(note.note_id || note.noteId || note.id);
  if (!id || id.length < 8) return null;
  if (note.aweme_id || note.awemeId) return null;
  const user = note.user || note.author || {};
  const author = typeof user === 'object' ? firstText(user.nickname, user.nick_name, user.name) : firstText(user, note.nickname);
  const cover = firstUrl(note.cover) || firstUrl(note.images) || firstUrl(note.image_list) || firstUrl(note.img);
  const title = firstText(note.display_title, note.displayTitle, note.title, note.desc);
  const item = { id: id, url: 'https://www.xiaohongshu.com/explore/' + id, platform: 'xiaohongshu', platformName: '小红书' };
  if (title) item.title = title;
  if (author) item.author = author;
  if (cover) item.cover = cover;
  const interact = note.interact_info || note.interactInfo || {};
  const stats = packStats({
    likes: interact.liked_count || interact.likedCount || note.liked_count || note.likes,
    collects: interact.collected_count || note.collectedCount,
    comments: interact.comment_count || note.comments,
  });
  if (stats) item.stats = stats;
  if (!item.title && !item.author && !item.cover) return null;
  return item;
}

function walk(obj, visit, seen) {
  seen = seen || new Set();
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
  seen.add(obj);
  visit(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) walk(obj[i], visit, seen);
  } else {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) walk(obj[keys[i]], visit, seen);
  }
}

function tryParseJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { /* 再试别的形态 */ }
  try { return JSON.parse(decodeURIComponent(s)); } catch (_) { /* 再试赋值语句 */ }
  const assign = s.match(/(?:window\.)?(?:__INITIAL_STATE__|__INITIAL_SSR_STATE__|_ROUTER_DATA|__UNIVERSAL_DATA_FOR_REHYDRATION__|_SSR_HYDRATED_DATA)\s*=\s*(\{[\s\S]+)/);
  if (assign) {
    let body = assign[1];
    const end = body.lastIndexOf('}');
    if (end >= 0) body = body.slice(0, end + 1);
    try { return JSON.parse(body); } catch (_) { return null; }
  }
  return null;
}

function itemsFromJson(data, platform) {
  const items = [];
  const seen = new Set();
  const pick = platform === 'xiaohongshu' ? itemFromXhs : itemFromDouyin;
  walk(data, (obj) => {
    const item = pick(obj);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  });
  return items;
}

function itemFromCard(card, platform) {
  if (!card) return null;
  const href = textOf(card.href || card.url);
  let id = textOf(card.id);
  if (!id && href) {
    const m = href.match(/\/video\/(\d+)/) || href.match(/\/explore\/([0-9a-zA-Z]+)/) || href.match(/\/discovery\/item\/([0-9a-zA-Z]+)/);
    if (m) id = m[1];
  }
  if (!id) return null;
  if (platform === 'douyin' && !/^\d{5,}$/.test(id)) return null;
  const url = href && /^https?:/.test(href)
    ? href.split('?')[0]
    : (platform === 'xiaohongshu' ? 'https://www.xiaohongshu.com/explore/' + id : 'https://www.douyin.com/video/' + id);
  const item = { id: id, url: url, platform: platform, platformName: platformName(platform) };
  const title = firstText(card.title, card.desc, card.text);
  const author = firstText(card.author);
  const cover = firstUrl(card.cover);
  if (title) item.title = title;
  if (author) item.author = author;
  if (cover) item.cover = cover;
  const stats = packStats(card.stats || {});
  if (stats) item.stats = stats;
  if (!item.title && !item.author && !item.cover) return null;
  return item;
}

function guessPlatform(page) {
  const host = (page && page.host) || '';
  const url = (page && page.url) || '';
  if (/xiaohongshu|rednote/.test(host) || /xiaohongshu|rednote/.test(url)) return 'xiaohongshu';
  if (/bilibili/.test(host) || /bilibili/.test(url)) return 'bilibili';
  return 'douyin';
}

function parseSearchPage(page, platform) {
  const p = platform || guessPlatform(page);
  const items = [];
  const seen = new Set();
  const add = (item) => {
    if (item && item.id && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  };
  const blobs = [];
  if (page && page.renderData) blobs.push(page.renderData);
  if (page && Array.isArray(page.scripts)) {
    for (let i = 0; i < page.scripts.length; i++) blobs.push(page.scripts[i]);
  }
  if (page && page.state) blobs.push(page.state);
  for (let i = 0; i < blobs.length; i++) {
    const raw = blobs[i];
    const data = typeof raw === 'string' ? tryParseJson(raw) : raw;
    if (data) {
      const found = itemsFromJson(data, p);
      for (let j = 0; j < found.length; j++) add(found[j]);
    }
  }
  if (page && Array.isArray(page.cards)) {
    for (let i = 0; i < page.cards.length; i++) add(itemFromCard(page.cards[i], p));
  }
  return { items: items.slice(0, 40), hasMore: false };
}

function collectSearchDom() {
  const cards = [];
  const push = (a) => {
    if (!a) return;
    const href = a.href || (a.getAttribute && a.getAttribute('href')) || '';
    if (!href || href === '#') return;
    const img = a.querySelector && a.querySelector('img');
    const text = String(a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
    let cover = '';
    if (img) cover = img.src || (img.getAttribute && (img.getAttribute('src') || img.getAttribute('data-src'))) || '';
    const abs = /^https?:/.test(href) ? href : ((typeof location !== 'undefined' && location.origin) ? location.origin + href : href);
    cards.push({ href: abs, title: text.slice(0, 120), cover: cover });
  };
  if (typeof document !== 'undefined' && document.querySelectorAll) {
    const dy = document.querySelectorAll('a[href*="/video/"]');
    for (let i = 0; i < dy.length; i++) push(dy[i]);
    const xhs = document.querySelectorAll('a[href*="/explore/"], a[href*="/discovery/item/"]');
    for (let i = 0; i < xhs.length; i++) push(xhs[i]);
  }
  const scripts = [];
  if (typeof document !== 'undefined' && document.querySelectorAll) {
    const nodes = document.querySelectorAll('script');
    for (let i = 0; i < nodes.length; i++) {
      const t = nodes[i].textContent || '';
      if (t && t.length > 40 && t.length < 4000000 && (/__INITIAL_STATE__|_ROUTER_DATA|RENDER_DATA|aweme|__UNIVERSAL_DATA/.test(t) || nodes[i].id === 'RENDER_DATA' || t.trim().charAt(0) === '{')) {
        scripts.push(t);
      }
    }
  }
  const renderEl = (typeof document !== 'undefined' && document.getElementById) ? document.getElementById('RENDER_DATA') : null;
  return {
    url: (typeof location !== 'undefined' && location.href) || '',
    host: (typeof location !== 'undefined' && location.hostname) || '',
    renderData: renderEl ? (renderEl.textContent || '') : '',
    scripts: scripts.slice(0, 20),
    cards: cards.slice(0, 60),
  };
}

function extractSearchFromPage() {
  return parseSearchPage(collectSearchDom());
}

function extractSearchSource() {
  return [
    textOf, firstUrl, firstText, statVal, packStats, platformName,
    itemFromDouyin, itemFromXhs, walk, tryParseJson, itemsFromJson,
    itemFromCard, guessPlatform, parseSearchPage, collectSearchDom,
    extractSearchFromPage,
  ].map((fn) => fn.toString()).join(';\n') + ';\nextractSearchFromPage();';
}

module.exports = {
  parseSearchPage,
  itemFromDouyin,
  itemFromXhs,
  extractSearchFromPage,
  extractSearchSource,
};
