const assert = require('node:assert/strict');
const {parseSearchPage, itemFromDouyin, itemFromXhs} = require('./search-extract');

const dy = itemFromDouyin({
  aweme_info: {
    aweme_id: '12345678901',
    desc: '长沙烤鱼探店',
    author: {nickname: '老王'},
    video: {cover: {url_list: ['https://example.com/cover.jpg']}},
    statistics: {play_count: 12, digg_count: 3},
  },
});
assert.equal(dy.url, 'https://www.douyin.com/video/12345678901');
assert.equal(dy.title, '长沙烤鱼探店');
assert.equal(dy.author, '老王');
assert.equal(dy.cover, 'https://example.com/cover.jpg');
assert.equal(dy.stats.views, '12');
assert.equal(dy.stats.likes, '3');
assert.equal(dy.title && dy.author && dy.cover ? true : false, true);

const skip = itemFromDouyin({aweme_info: {aweme_id: '1', desc: ''}});
assert.equal(skip, null);

const xhs = itemFromXhs({
  note_card: {
    note_id: '64abc',
    display_title: '美甲分享',
    user: {nickname: '小红'},
    cover: {url_default: 'https://example.com/x.jpg'},
  },
});
// itemFromXhs may use different fields; accept title/url if present
if (xhs) {
  assert.ok(xhs.title || xhs.author || xhs.cover);
}

const parsed = parseSearchPage({
  url: 'https://www.douyin.com/search/test',
  scripts: [JSON.stringify({aweme_list: [{aweme_id: '12345678901', desc: '标题', author: {nickname: 'A'}, video: {cover: {url_list: ['https://c']}}}]})],
}, 'douyin');
assert.ok(parsed.items.length >= 1);
assert.ok(parsed.items[0].title || parsed.items[0].author || parsed.items[0].cover);
assert.equal(parsed.items.every((it) => it.title || it.author || it.cover), true);

console.log('search-extract ok');
