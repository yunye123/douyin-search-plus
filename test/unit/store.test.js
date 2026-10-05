'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../src/content/util.js');
require('../../src/content/metrics.js');
const St = require('../../src/content/store.js');

const loc = (pathname, search = '') => ({ pathname, search });
const rec = (id, o) => Object.assign({ id: String(id), kind: 'video', digg: 100, comment: 1, collect: 50, share: 2, createTime: 1_780_000_000 }, o);

test('路由解析与关键词规范化', () => {
  assert.deepEqual(St.routeOf(loc('/search/AI%20%E6%95%99%E7%A8%8B', '?type=video')), { type: 'search', kw: 'AI 教程', modalId: '' });
  assert.equal(St.routeOf(loc('/search/AI+%E6%95%99%E7%A8%8B')).kw, 'AI+教程'); // 路径里的 + 就是加号
  assert.equal(St.routeOf(loc('/user/MS4w_x', '?modal_id=7400000000000000001')).modalId, '7400000000000000001');
  assert.equal(St.routeOf(loc('/video/7400000000000000001')).type, 'video');
  assert.equal(St.routeOf(loc('/jingxuan')).type, 'other');
  assert.equal(St.normFilter('{"publish_time":"7","sort_type":"0"}'), 'publish_time=7');
  assert.equal(St.normFilter('{"sort_type":"2","publish_time":"7"}'), St.normFilter('{"publish_time":"7","sort_type":"2"}'));
});

test('搜索会话：同关键词收数据，迟到的旧关键词响应被丢弃，切官方筛选开新会话', () => {
  St.setRoute(St.routeOf(loc('/search/AI%E6%95%99%E7%A8%8B')));
  assert.equal(St.intakeVideos({ source: 'fiber', path: '/search/AI%E6%95%99%E7%A8%8B', kw: 'AI教程', filter: '' }, [rec(1), rec(2)]), 2);
  assert.equal(St.S.videos.size, 2);
  // 旧关键词迟到
  assert.equal(St.intakeVideos({ source: 'api', endpoint: 'search', kw: '别的词', filter: '' }, [rec(9)]), 0);
  assert.equal(St.S.videos.size, 2);
  // 切官方筛选 → 新会话
  St.intakeVideos({ source: 'api', endpoint: 'search', kw: 'AI教程', filter: '{"publish_time":"7"}' }, [rec(3)]);
  assert.equal(St.S.videos.size, 1);
  assert.ok(St.S.session.endsWith('publish_time=7'));
  // 清掉筛选回到原会话：从最近会话缓存恢复
  St.intakeVideos({ source: 'api', endpoint: 'search', kw: 'AI教程', filter: '' }, [rec(4)]);
  assert.deepEqual([...St.S.videos.keys()].sort(), ['1', '2', '4']);
});

test('合并：fiber 与接口互补，计数更新刷新采集时间', () => {
  St.setRoute(St.routeOf(loc('/search/merge')));
  St.intakeVideos({ kw: 'merge' }, [rec(1, { cover: '', digg: 100 })]);
  St.intakeVideos({ kw: 'merge' }, [rec(1, { cover: 'https://x/c.jpg', digg: 100 })]);
  assert.equal(St.S.videos.get('1').cover, 'https://x/c.jpg');
  const v0 = St.S.version;
  assert.equal(St.intakeVideos({ kw: 'merge' }, [rec(1, { cover: '', digg: 100 })]), 0); // 无变化不涨版本
  assert.equal(St.S.version, v0);
  St.intakeVideos({ kw: 'merge' }, [rec(1, { digg: 150 })]);
  assert.equal(St.S.videos.get('1').digg, 150);
  assert.equal(St.S.videos.get('1').cover, 'https://x/c.jpg');
});

test('主页：/user/self 接受接口里的真实 secUid；别人的主页数据被拒', () => {
  St.setRoute(St.routeOf(loc('/user/self')));
  assert.equal(St.intakeVideos({ source: 'api', endpoint: 'profile', secUid: 'MS4w_real' }, [rec(1)]), 1);
  St.setRoute(St.routeOf(loc('/user/MS4w_a')));
  assert.equal(St.intakeVideos({ source: 'api', endpoint: 'profile', secUid: 'MS4w_b' }, [rec(2)]), 0);
  assert.equal(St.intakeVideos({ source: 'fiber', path: '/user/MS4w_a', secUid: 'MS4w_a' }, [rec(3, { author: '星辰ai' })]), 1);
  assert.equal(St.S.sessionLabel, '@星辰ai');
});

test('非搜索/主页页面不收视频数据', () => {
  St.setRoute(St.routeOf(loc('/video/7400000000000000001')));
  assert.equal(St.intakeVideos({ source: 'fiber', path: '/video/7400000000000000001' }, [rec(1)]), 0);
});

test('视图：筛选 + 排序 + 未达标的单独列出', () => {
  St.setRoute(St.routeOf(loc('/search/view')));
  St.intakeVideos({ kw: 'view' }, [rec(1, { digg: 1000, collect: 900 }), rec(2, { digg: 1000, collect: 100 }), rec(3, { digg: 2000, collect: 1700 })]);
  St.setFilter({ minCr: 0.8 });
  St.setSort(['collect']);
  const v = St.viewOf();
  assert.deepEqual(v.sorted.map((x) => x.v.id), ['3', '1']);
  assert.deepEqual(v.rest.map((x) => x.id), ['2']);
  assert.equal(v.total, 3);
  assert.equal(St.S.view.active, true);
  St.resetView();
  assert.equal(St.S.view.active, false);
});

test('候选篮：加入、去重、移除、带来源', () => {
  St.setRoute(St.routeOf(loc('/search/cand')));
  St.intakeVideos({ kw: 'cand' }, [rec(7, { desc: '保姆级教程', digg: 1000, collect: 900 })]);
  assert.equal(St.addCandidate('7'), true);
  assert.equal(St.addCandidate('7'), true);
  assert.equal(St.S.candidates.size, 1);
  const [c] = St.candidateList();
  assert.equal(c.desc, '保姆级教程');
  assert.equal(c.source, '搜索「cand」');
  assert.equal(Math.round(c.cr * 100), 90);
  assert.equal(St.addCandidate('nope'), false);
  St.removeCandidate('7');
  assert.equal(St.S.candidates.size, 0);
});

test('评论：按视频归属，换视频清空', () => {
  St.setRoute(St.routeOf(loc('/video/7400000000000000001')));
  St.intakeComments({ awemeId: '7400000000000000001', total: 30, items: [{ cid: '1', digg: 3 }, { cid: '2', digg: 9 }] });
  assert.equal(St.S.comments.map.size, 2);
  assert.equal(St.intakeComments({ awemeId: '7400000000000000002', items: [{ cid: '3', digg: 1 }] }), 0);
  St.setRoute(St.routeOf(loc('/video/7400000000000000002')));
  St.intakeComments({ awemeId: '7400000000000000002', items: [{ cid: '3', digg: 1 }] });
  assert.equal(St.S.comments.map.size, 1);
});

test('关键词含加号（AI+办公、C++）时数据照常收下', () => {
  St.setRoute(St.routeOf(loc('/search/AI%2B%E5%8A%9E%E5%85%AC')));
  assert.equal(St.S.route.kw, 'AI+办公');
  assert.equal(St.intakeVideos({ source: 'api', endpoint: 'search', kw: 'AI+办公', filter: '', offset: 0 }, [rec(1)]), 1);
  assert.equal(St.intakeVideos({ source: 'fiber', path: '/search/AI%2B%E5%8A%9E%E5%85%AC', kw: 'AI+办公', filter: '' }, [rec(2)]), 1);
  St.setRoute(St.routeOf(loc('/search/C%2B%2B')));
  assert.equal(St.intakeVideos({ source: 'api', endpoint: 'search', kw: 'C++', offset: 0 }, [rec(3)]), 1);
});

test('切官方筛选后，旧筛选晚到的翻页响应被丢弃、不把会话切回去', () => {
  St.setRoute(St.routeOf(loc('/search/late')));
  St.intakeVideos({ source: 'api', endpoint: 'search', kw: 'late', filter: '{"publish_time":"180"}', offset: 0 }, [rec(1)]);
  const s = St.S.session;
  assert.equal(St.intakeVideos({ source: 'api', endpoint: 'search', kw: 'late', filter: '', offset: 20 }, [rec(2)]), 0);
  assert.equal(St.S.session, s);
  // 第一页（offset=0）的响应可以切会话（用户真的清掉了筛选）
  assert.equal(St.intakeVideos({ source: 'api', endpoint: 'search', kw: 'late', filter: '', offset: 0 }, [rec(3)]), 1);
  assert.notEqual(St.S.session, s);
});
