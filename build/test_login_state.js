// node build/test_login_state.js —— 三家登录态只根据页面结果判定，规则互不套用
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  detectLogin, detectDouyin, detectXiaohongshu, detectBilibili, INSPECT,
} = require('./login-state');

function assertOut(r, platform, reason) {
  assert.strictEqual(r.loggedIn, false, JSON.stringify(r));
  assert.strictEqual(r.platform, platform);
  if (reason) assert.strictEqual(r.reason, reason, JSON.stringify(r));
}
function assertIn(r, platform, reason) {
  assert.strictEqual(r.loggedIn, true, JSON.stringify(r));
  assert.strictEqual(r.platform, platform);
  if (reason) assert.strictEqual(r.reason, reason, JSON.stringify(r));
}

// 选择器互不共用：每家 inspect 脚本只出现自己的特征节点
assert.ok(INSPECT.douyin.includes('#login-pannel') && INSPECT.douyin.includes('#login-panel') && INSPECT.douyin.includes('/user/self'));
assert.ok(!INSPECT.douyin.includes('header-login-entry') && !INSPECT.douyin.includes('.login-modal') && !INSPECT.douyin.includes('/website-login'));
assert.ok(INSPECT.xiaohongshu.includes('.login-modal') && INSPECT.xiaohongshu.includes('.user-avatar'));
assert.ok(!INSPECT.xiaohongshu.includes('#login-pannel') && !INSPECT.xiaohongshu.includes('header-login-entry') && !INSPECT.xiaohongshu.includes('/user/self'));
assert.ok(INSPECT.bilibili.includes('.header-login-entry') && INSPECT.bilibili.includes('.header-avatar-wrap') && INSPECT.bilibili.includes('.header-entry-avatar'));
assert.ok(!INSPECT.bilibili.includes('#login-pannel') && !INSPECT.bilibili.includes('.login-modal') && !INSPECT.bilibili.includes('/user/self'));

// ---- 抖音 ----
assertOut(detectDouyin({ url: 'https://www.douyin.com/', headerLogin: true }), 'douyin', 'header-login');
assertOut(detectDouyin({ url: 'https://www.douyin.com/', loginPanel: true }), 'douyin', 'login-wall');
assertOut(detectDouyin({ url: 'https://www.douyin.com/?recommend=1', qrHint: true }), 'douyin', 'login-wall');
assertOut(detectLogin('douyin', { url: 'https://passport.douyin.com/login' }), 'douyin', 'login-host');
assertOut(detectDouyin({ url: 'https://www.douyin.com/login' }), 'douyin', 'login-path');
assertIn(detectDouyin({ url: 'https://www.douyin.com/', userSelfLink: true }), 'douyin', 'user-self');
assertIn(detectDouyin({ url: 'https://www.douyin.com/', userSelfLink: true, headerAvatar: true }), 'douyin', 'user-self');
// 只有右上角小图、没有 /user/self：不能当成已登录
assertOut(detectDouyin({ url: 'https://www.douyin.com/', headerAvatar: true }), 'douyin', 'uncertain');
assertOut(detectDouyin({ url: 'https://www.douyin.com/' }), 'douyin', 'uncertain');
// 首页推荐流在、但只有登录按钮：不能当成已登录
assertOut(detectDouyin({ url: 'https://www.douyin.com/?recommend=1', headerLogin: true, hasFeed: true }), 'douyin', 'header-login');

// ---- 小红书 ----
assertOut(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/login?redirectPath=%2Fexplore' }), 'xiaohongshu', 'login-path');
assertOut(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/website-login/captcha?redirectPath=/' }), 'xiaohongshu', 'login-path');
assertOut(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/explore', loginModal: true }), 'xiaohongshu', 'login-modal');
assertOut(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/explore', sidebarLogin: true }), 'xiaohongshu', 'sidebar-login');
assertIn(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/explore', userSideEntry: true }), 'xiaohongshu', 'user-side');
assertIn(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/explore', chromeAvatar: true }), 'xiaohongshu', 'chrome-avatar');
// 只有通用头像、没有个人主页入口：不能当成已登录（可能是信息流作者头像）
assertOut(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/explore', userAvatar: true }), 'xiaohongshu', 'uncertain');
assertOut(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/explore', userAvatar: true, hasCards: true }), 'xiaohongshu', 'uncertain');
assertOut(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/explore' }), 'xiaohongshu', 'uncertain');
// 侧栏/顶栏头像在、但当时还有登录按钮或弹层：仍当未登录
assertOut(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/explore', chromeAvatar: true, sidebarLogin: true }), 'xiaohongshu', 'sidebar-login');
assertOut(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/explore', userSideEntry: true, loginModal: true }), 'xiaohongshu', 'login-modal');
// 探索页已有卡片但弹出登录窗：不能当成已登录
assertOut(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/explore', loginModal: true, hasCards: true }), 'xiaohongshu', 'login-modal');
// 不能拿抖音的信号套到小红书
assertOut(detectXiaohongshu({ url: 'https://www.xiaohongshu.com/explore', headerLogin: true, userSelfLink: true }), 'xiaohongshu', 'uncertain');
// 已经打开个人主页（含登录小窗窄屏、无侧栏入口）必须判为已登录
assertIn(detectXiaohongshu({
  url: 'https://www.xiaohongshu.com/user/profile/64abc',
  userProfilePath: true,
  ownProfileHint: true,
}), 'xiaohongshu', 'user-profile');
assertIn(detectXiaohongshu({
  url: 'https://www.xiaohongshu.com/explore',
  ownProfileHint: true,
}), 'xiaohongshu', 'own-profile');
assertIn(detectXiaohongshu({
  url: 'https://www.xiaohongshu.com/explore',
  mobileMeTab: true,
}), 'xiaohongshu', 'mobile-me');
// 个人页上仍有登录墙时保持未登录
assertOut(detectXiaohongshu({
  url: 'https://www.xiaohongshu.com/user/profile/64abc',
  userProfilePath: true,
  loginModal: true,
}), 'xiaohongshu', 'login-modal');
assertOut(detectXiaohongshu({
  url: 'https://www.xiaohongshu.com/explore',
  chromeLogin: true,
}), 'xiaohongshu', 'chrome-login');

// ---- B 站：首页未登录也能看推荐，必须看顶栏 ----
assertOut(detectBilibili({ url: 'https://passport.bilibili.com/login' }), 'bilibili', 'login-host');
assertOut(detectBilibili({ url: 'https://www.bilibili.com/', headerLoginEntry: true, hasFeed: true }), 'bilibili', 'header-login-entry');
assertIn(detectBilibili({ url: 'https://www.bilibili.com/', headerAvatar: true }), 'bilibili', 'header-avatar');
assertOut(detectBilibili({ url: 'https://www.bilibili.com/' }), 'bilibili', 'uncertain');
// 不能拿小红书/抖音的选择器结果套到 B 站
assertOut(detectBilibili({ url: 'https://www.bilibili.com/', loginModal: true, userSelfLink: true, loginPanel: true }), 'bilibili', 'uncertain');

// 总入口
assertOut(detectLogin('douyin', { url: 'https://www.douyin.com/', headerLogin: true }), 'douyin', 'header-login');
assertOut(detectLogin('other', { url: 'https://example.com/' }), 'other', 'unsupported-platform');

// 源码层面也确认三套规则函数是分开的，没有一份共享选择器表
const src = fs.readFileSync(path.join(__dirname, 'login-state.js'), 'utf8');
assert.ok(src.includes('function detectDouyin') && src.includes('function detectXiaohongshu') && src.includes('function detectBilibili'));

console.log('login-state tests ok');
