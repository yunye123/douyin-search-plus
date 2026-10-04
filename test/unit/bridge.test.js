'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../../src/page/bridge.js');
const data = require('../sim/data.js');

test('接口形状（snake_case）归一化', () => {
  const [v] = data.makeVideos(1, 1);
  const r = bridge.normalizeAweme(data.toApiAweme(v));
  assert.equal(r.id, v.id);
  assert.equal(r.digg, v.digg);
  assert.equal(r.collect, v.collect);
  assert.equal(r.comment, v.comment);
  assert.equal(r.share, v.share);
  assert.equal(r.createTime, v.createTime);
  assert.equal(r.author, v.author);
  assert.equal(r.kind, v.isNote ? 'note' : 'video');
  assert.ok(r.cover.startsWith('https://'));
});

test('搜索页 fiber 形状（awemeInfo.stats，camelCase，cover 为字符串）', () => {
  const [v] = data.makeVideos(2, 1);
  const f = data.toSearchFiber(v).awemeInfo;
  const r = bridge.normalizeAweme(f);
  assert.equal(r.id, v.id);
  assert.equal(r.digg, v.digg);
  assert.equal(r.collect, v.collect);
  assert.equal(r.authorId, v.secUid);
  assert.ok(r.cover.includes(v.id));
});

test('主页 fiber 形状（statistics camelCase）与毫秒时间戳', () => {
  const [v] = data.makeVideos(3, 1);
  const f = data.toProfileFiber(v);
  f.createTime = v.createTime * 1000;
  const r = bridge.normalizeAweme(f);
  assert.equal(r.createTime, v.createTime);
  assert.equal(r.share, v.share);
});

test('非法输入返回 null，数字容错', () => {
  assert.equal(bridge.normalizeAweme(null), null);
  assert.equal(bridge.normalizeAweme({ aweme_id: 'abc', statistics: {} }), null);
  assert.equal(bridge.normalizeAweme({ aweme_id: '7400000000000000001' }), null);
  const r = bridge.normalizeAweme({ aweme_id: '7400000000000000001', statistics: { digg_count: '1,234', collect_count: -5, comment_count: 'x' } });
  assert.equal(r.digg, 1234);
  assert.equal(r.collect, 0);
  assert.equal(r.comment, 0);
});

test('时长为秒时自动换算成毫秒；图文识别', () => {
  const r = bridge.normalizeAweme({ aweme_id: '7400000000000000002', statistics: {}, video: { duration: 95 } });
  assert.equal(r.durationMs, 95000);
  const n = bridge.normalizeAweme({ aweme_id: '7400000000000000003', aweme_type: 68, statistics: {}, images: [{ url_list: ['https://x/1.jpg'] }] });
  assert.equal(n.kind, 'note');
  assert.equal(n.cover, 'https://x/1.jpg');
});

test('流式多段 JSON 解析（含字符串里的花括号与转义）', () => {
  const text = '{"a":1,"s":"x{y}\\"z"}\n{"b":[1,2,{"c":"}"}]}garbage{bad}';
  const out = bridge.parseJsonChunks(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].s, 'x{y}"z');
  assert.equal(out[1].b[2].c, '}');
});

test('extractVideos 兼容 data[].aweme_info / aweme_list / 合集', () => {
  const vs = data.makeVideos(4, 3);
  const json = { data: [{ aweme_info: data.toApiAweme(vs[0]) }, { aweme_mix_info: { mix_items: [data.toApiAweme(vs[1])] } }, { foo: 1 }] };
  assert.deepEqual(bridge.extractVideos(json).map((r) => r.id), [vs[0].id, vs[1].id]);
  assert.deepEqual(bridge.extractVideos({ aweme_list: [data.toApiAweme(vs[2])] }).map((r) => r.id), [vs[2].id]);
});

test('接口分类', () => {
  assert.equal(bridge.classify('https://www.douyin.com/aweme/v1/web/search/item/?keyword=x'), 'search');
  assert.equal(bridge.classify('/aweme/v1/web/general/search/stream/?a=1'), 'search');
  assert.equal(bridge.classify('/aweme/v1/web/aweme/post/?sec_user_id=1'), 'profile');
  assert.equal(bridge.classify('/aweme/v1/web/aweme/favorite/?sec_user_id=1'), 'profile');
  assert.equal(bridge.classify('/aweme/v1/web/comment/list/?aweme_id=1'), 'comments');
  assert.equal(bridge.classify('/aweme/v1/web/comment/list/reply/?x=1'), null);
  assert.equal(bridge.classify('/aweme/v1/web/hot/search/list/'), null);
});

test('fiber 收割：沿 return 链按 id 匹配', () => {
  const [v, w] = data.makeVideos(5, 2);
  const el = { __reactFiber$abc: { memoizedProps: { x: 1 }, return: { memoizedProps: { itemInfo: data.toSearchFiber(v) } } } };
  assert.equal(bridge.fiberRecord(el, v.id).digg, v.digg);
  assert.equal(bridge.fiberRecord(el, w.id), null); // id 不匹配不收
  assert.equal(bridge.fiberRecord({}, v.id), null);
});

test('评论 fiber：有界广度搜索找到 cid + 点赞', () => {
  const [c] = data.makeComments(11, 1);
  const el = { __reactFiber$x: { memoizedProps: { className: 'c' }, return: { memoizedProps: { wrapper: { data: { comment: data.toApiComment(c) } } } } } };
  const r = bridge.fiberComment(el);
  assert.equal(r.cid, c.cid);
  assert.equal(r.digg, c.digg);
  // 循环引用不死循环
  const loop = { a: {} };
  loop.a.b = loop;
  assert.equal(bridge.fiberComment({ __reactFiber$y: { memoizedProps: loop } }), null);
});

test('评论归一化', () => {
  const [c] = data.makeComments(9, 1);
  const r = bridge.normalizeComment(data.toApiComment(c));
  assert.equal(r.cid, c.cid);
  assert.equal(r.digg, c.digg);
  assert.equal(r.replies, c.replies);
  assert.equal(r.ip, c.ip);
  assert.equal(bridge.normalizeComment({ cid: 'x' }), null);
});
