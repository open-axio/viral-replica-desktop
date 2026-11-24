// 按「打开平台首页后的页面结果」判断登录态，不调平台私有接口、不读 cookie。
// 判定不准一律视为未登录，避免把登录墙当成已登录信息流。
// 三家规则分开写、分开测，不要复用同一套选择器。

function parseUrl(url) {
  try { return new URL(url); } catch (e) { return null; }
}

function out(platform, reason) {
  return { loggedIn: false, checking: false, platform, reason };
}

function inn(platform, reason) {
  return { loggedIn: true, checking: false, platform, reason };
}

// 抖音网页版没有稳定的独立 /login 入口：未登录常停在 www.douyin.com，右上角是「登录」，
// 或弹出 #login-pannel（官方历史拼写）/ 扫码文案。已登录必须看到可见的个人入口 /user/self。
// 右上角 24–72px 图片单独出现视为 uncertain，不能当成已登录。
// 不能因为已经落在首页就把推荐流当成已登录。
function detectDouyin(page) {
  const u = parseUrl(page.url || page.href || '');
  const host = String(page.host || (u && u.hostname) || '').toLowerCase();
  const pathname = String(page.pathname || (u && u.pathname) || '');
  if (/(^|\.)(passport|sso)\.douyin\.com$/.test(host)) return out('douyin', 'login-host');
  if (/^\/login(\/|$)/.test(pathname) || pathname.startsWith('/passport')) return out('douyin', 'login-path');
  if (page.loginPanel || page.qrHint) return out('douyin', 'login-wall');
  if (page.headerLogin && !page.userSelfLink) return out('douyin', 'header-login');
  if (page.userSelfLink) return inn('douyin', 'user-self');
  return out('douyin', 'uncertain');
}

// 小红书未登录会进 /login、/website-login（含滑块验证），或在探索页弹出 .login-modal。
// 已登录要有个人主页入口，或头像明确落在侧栏/顶栏个人区，且当时没有登录按钮或登录弹层。
// 通用 .user-avatar / .reds-avatar 可能命中信息流作者头像，单独出现视为 uncertain。
function detectXiaohongshu(page) {
  const u = parseUrl(page.url || page.href || '');
  const host = String(page.host || (u && u.hostname) || '').toLowerCase();
  const pathname = String(page.pathname || (u && u.pathname) || '');
  if (pathname === '/login' || pathname.startsWith('/login/') || pathname === '/website-login' || pathname.startsWith('/website-login/')) {
    return out('xiaohongshu', 'login-path');
  }
  if (page.loginModal) return out('xiaohongshu', 'login-modal');
  if (page.sidebarLogin) return out('xiaohongshu', 'sidebar-login');
  if (page.chromeLogin) return out('xiaohongshu', 'chrome-login');
  if (page.userSideEntry) return inn('xiaohongshu', 'user-side');
  if (page.chromeAvatar) return inn('xiaohongshu', 'chrome-avatar');
  // 登录小窗在窄屏常落到个人主页（无侧栏入口）。只要已经能看到个人页且没有登录墙，就视为已登录。
  if (page.userProfilePath) return inn('xiaohongshu', 'user-profile');
  if (page.ownProfileHint) return inn('xiaohongshu', 'own-profile');
  if (page.mobileMeTab) return inn('xiaohongshu', 'mobile-me');
  return out('xiaohongshu', 'uncertain');
}

// B 站首页未登录也能看推荐，必须看顶栏：.header-login-entry 为未登录，
// .header-avatar-wrap / .header-entry-avatar 为已登录。出现登录域视为未登录。
// 绝不能用「已经打开 www.bilibili.com 首页」当作已登录。
function detectBilibili(page) {
  const u = parseUrl(page.url || page.href || '');
  const host = String(page.host || (u && u.hostname) || '').toLowerCase();
  const pathname = String(page.pathname || (u && u.pathname) || '');
  if (/(^|\.)passport\.bilibili\.com$/.test(host)) return out('bilibili', 'login-host');
  if (host.endsWith('account.bilibili.com') && /login/.test(pathname)) return out('bilibili', 'login-path');
  if (page.headerLoginEntry) return out('bilibili', 'header-login-entry');
  if (page.headerAvatar) return inn('bilibili', 'header-avatar');
  return out('bilibili', 'uncertain');
}

function detectLogin(platform, page) {
  const p = platform || 'other';
  const src = page || {};
  if (p === 'douyin') return detectDouyin(src);
  if (p === 'xiaohongshu') return detectXiaohongshu(src);
  if (p === 'bilibili') return detectBilibili(src);
  return out(p, 'unsupported-platform');
}

// 注入到平台页里采集「这一页看得到的信号」。三家选择器互不共用。
const INSPECT = {
  douyin: `(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const bodyText = (document.body && document.body.innerText) || '';
    let headerLogin = false, headerAvatar = false, userSelfLink = false;
    const nodes = document.querySelectorAll('a, button, span');
    for (let i = 0; i < nodes.length && i < 500; i++) {
      const el = nodes[i];
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top > 96) continue;
      const own = (el.childNodes && el.childNodes.length <= 2) ? String(el.textContent || '').trim() : '';
      if (own === '登录') headerLogin = true;
      const href = el.getAttribute && el.getAttribute('href') || '';
      if (href.indexOf('/user/self') !== -1) userSelfLink = true;
    }
    const self = document.querySelector('a[href*="/user/self"]');
    if (self && visible(self)) userSelfLink = true;
    // headerAvatar 只作观测，判定已登录必须有 /user/self，不能单靠右上角小图。
    const imgs = document.querySelectorAll('header img, #root img, body img');
    for (let i = 0; i < imgs.length && i < 80; i++) {
      const el = imgs[i];
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top < 96 && r.left > (window.innerWidth - 240) && r.width >= 24 && r.width <= 72) headerAvatar = true;
    }
    return {
      host: location.hostname,
      pathname: location.pathname,
      href: location.href,
      loginPanel: visible(document.querySelector('#login-pannel')) || visible(document.querySelector('#login-panel')),
      qrHint: /打开「抖音APP」扫描二维码登录|扫描二维码登录|登录后免费畅享/.test(bodyText),
      headerLogin,
      userSelfLink,
      headerAvatar,
    };
  })()`,
  xiaohongshu: `(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const bodyText = (document.body && document.body.innerText) || '';
    const loginModal = visible(document.querySelector('.login-modal')) ||
      visible(document.querySelector('.reds-modal-open .login-container'));
    let sidebarLogin = false;
    const sideBtns = document.querySelectorAll('.side-bar-component, .reds-sidebar, [class*="side-bar"] a, [class*="side-bar"] span');
    for (let i = 0; i < sideBtns.length && i < 200; i++) {
      const el = sideBtns[i];
      if (visible(el) && String(el.textContent || '').trim() === '登录') sidebarLogin = true;
    }
    let chromeLogin = false;
    const chromeLoginNodes = document.querySelectorAll('header a, header button, header span, nav a, nav button, nav span, [class*="tab-bar"] a, [class*="tab-bar"] span, [class*="tabbar"] a, [class*="tabbar"] span');
    for (let i = 0; i < chromeLoginNodes.length && i < 200; i++) {
      const el = chromeLoginNodes[i];
      if (visible(el) && String(el.textContent || '').trim() === '登录') chromeLogin = true;
    }
    const userAvatar = visible(document.querySelector('.user-avatar, .reds-avatar'));
    const userSideEntry = visible(document.querySelector('a[href*="/user/profile"], a[href*="/user/profile/"]'));
    let chromeAvatar = false;
    const chromeRoots = document.querySelectorAll('.side-bar-component, .reds-sidebar, header, [class*="side-bar"]');
    for (let i = 0; i < chromeRoots.length && i < 40; i++) {
      const root = chromeRoots[i];
      const av = root.querySelector('img.avatar, .user-avatar, .reds-avatar');
      if (!visible(av)) continue;
      const r = av.getBoundingClientRect();
      if (r.top < 120 || r.left < 200) chromeAvatar = true;
    }
    const userProfilePath = /^\/user\/profile(\/|$)/.test(location.pathname || '');
    const ownProfileHint = /仅自己可见|编辑资料/.test(bodyText) ||
      (/小红书号/.test(bodyText) && /笔记/.test(bodyText) && /收藏/.test(bodyText) && /点赞/.test(bodyText));
    let mobileMeTab = false;
    const tabNodes = document.querySelectorAll('a, span, button, div');
    const vh = window.innerHeight || 0;
    for (let i = 0; i < tabNodes.length && i < 400; i++) {
      const el = tabNodes[i];
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (vh && r.top < vh - 140) continue;
      const own = (el.childNodes && el.childNodes.length <= 2) ? String(el.textContent || '').trim() : '';
      if (own === '我' || own === '个人') mobileMeTab = true;
    }
    return {
      host: location.hostname,
      pathname: location.pathname,
      href: location.href,
      loginModal,
      sidebarLogin,
      chromeLogin,
      userAvatar,
      userSideEntry,
      chromeAvatar,
      userProfilePath,
      ownProfileHint,
      mobileMeTab,
    };
  })()`,
  bilibili: `(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const headerLoginEntry = visible(document.querySelector('.header-login-entry')) ||
      visible(document.querySelector('.header-avatar-unlogin-entry')) ||
      visible(document.querySelector('.go-login-btn'));
    const headerAvatar = visible(document.querySelector('.header-avatar-wrap')) ||
      visible(document.querySelector('.header-entry-avatar'));
    return {
      host: location.hostname,
      pathname: location.pathname,
      href: location.href,
      headerLoginEntry,
      headerAvatar,
    };
  })()`,
};

module.exports = {
  detectLogin, detectDouyin, detectXiaohongshu, detectBilibili, INSPECT,
};
