// node build/test_browse.js —— 「找爆款」窗口里不依赖 Electron 的部分：认平台、取分享链接、选视频地址
const assert = require('assert');
const Module = require('module');
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { userAgentFallback: '' }, ipcMain: { handle() {} }, session: {}, BrowserWindow: function () {}, WebContentsView: function () {} };
  return realLoad.call(this, request, ...rest);
};
const browse = require('./browse');

assert.strictEqual(browse.platformOf('https://www.douyin.com/video/7'), 'douyin');
assert.strictEqual(browse.platformOf('https://v.douyin.com/abc/'), 'douyin');
assert.strictEqual(browse.platformOf('http://xhslink.com/a/xyz'), 'xiaohongshu');
assert.strictEqual(browse.platformOf('https://www.xiaohongshu.com/explore/66aa'), 'xiaohongshu');
assert.strictEqual(browse.platformOf('https://b23.tv/x1'), 'bilibili');
assert.strictEqual(browse.platformOf('https://evil-douyin.com.example.org/'), 'other');
assert.strictEqual(browse.platformOf('not a url'), 'other');

assert.strictEqual(browse.urlFromShareText('3.89 复制打开抖音，看看【老王烤鱼的作品】长沙烤鱼天花板 https://v.douyin.com/iAbCdEf/ 07/12 a@B.xY'), 'https://v.douyin.com/iAbCdEf/');
assert.strictEqual(browse.urlFromShareText('【秋冬显白猫眼】http://xhslink.com/a/Q1w2E3，复制本条信息'), 'http://xhslink.com/a/Q1w2E3');
assert.strictEqual(browse.urlFromShareText('没有链接'), '');

// B 站：页面正在播的那一路排第一；音频没播过时从低码率往高试
const cid = '435';
const u = (n, host = 'a.bilivideo.com') => `https://${host}/upgcxcode/1/2/${cid}/${cid}-1-${n}.m4s?e=x`;
const info = { extra: { cid, dash: {
  video: [{ url: u(30080), id: 80, codecid: 7, height: 1080 }, { url: u(30032), id: 32, codecid: 7, height: 480 }, { url: u(30120), id: 120, codecid: 7, height: 2160 }, { url: u(30077), id: 80, codecid: 12, height: 1080 }],
  audio: [{ url: u(30280), id: 30280 }, { url: u(30216), id: 30216 }, { url: u(30232), id: 30232 }],
} } };
browse.mediaSeen.set(1, [{ url: u(30032), type: 'video/mp4' }]);
let m = browse.chooseMedia('bilibili', info, 1);
assert.strictEqual(m.videos[0], u(30032), '页面在播 480p 就先用它');
assert.ok(!m.videos.includes(u(30120)), '超过 1080p 的不要');
assert.deepStrictEqual(m.audios.slice(0, 3), [u(30216), u(30232), u(30280)]);
browse.mediaSeen.set(2, []);
m = browse.chooseMedia('bilibili', info, 2);
assert.strictEqual(m.videos[0], u(30080), '没播过时 1080p H.264 优先');
// 别的视频的分片不能混进来
m = browse.chooseMedia('bilibili', { extra: { cid: '999', dash: info.extra.dash } }, 2);
assert.strictEqual(m, null);

// 抖音 / 小红书：页面 <video> 的真实地址优先，其次网络里看到的视频
browse.mediaSeen.set(3, [{ url: 'https://v26-web.douyinvod.com/abc/?a=1', type: 'video/mp4' }, { url: 'https://www.douyin.com/aweme/v1/web/log', type: 'application/json' }]);
m = browse.chooseMedia('douyin', { sources: [] }, 3);
assert.deepStrictEqual(m, { videos: ['https://v26-web.douyinvod.com/abc/?a=1'], audios: [] });
m = browse.chooseMedia('xiaohongshu', { sources: ['https://sns-video-bd.xhscdn.com/x.mp4'] }, 3);
assert.strictEqual(m.videos[0], 'https://sns-video-bd.xhscdn.com/x.mp4');
assert.strictEqual(browse.chooseMedia('douyin', { sources: [] }, 99), null);

console.log('browse tests ok');
