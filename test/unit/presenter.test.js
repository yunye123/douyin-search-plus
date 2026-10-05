'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../src/content/util.js');
const M = require('../../src/content/metrics.js');
const P = require('../../src/content/presenter.js');

test('数字输入：1w / 1万 / 1.5万 / 2k / 12,000', () => {
  assert.equal(P.parseCount('1w'), 10000);
  assert.equal(P.parseCount('1万'), 10000);
  assert.equal(P.parseCount('1.5万'), 15000);
  assert.equal(P.parseCount('2k'), 2000);
  assert.equal(P.parseCount('12,000'), 12000);
  assert.equal(P.parseCount(' '), 0);
  assert.ok(Number.isNaN(P.parseCount('很多')));
});

test('排序描述', () => {
  assert.equal(P.sortText(['cr']), '按收藏率从高到低');
  assert.equal(P.sortText(['cr'], true), '按收藏率从低到高');
  assert.equal(P.sortText(['collect', 'comment']), '综合排序（收藏 + 评论）');
  assert.equal(P.sortText([]), '');
});

test('视角：主页才有账号 Top10；当前视图能认出视角', () => {
  assert.ok(!P.lensesFor('search').some((l) => l.key === 'top10'));
  assert.ok(P.lensesFor('profile').some((l) => l.key === 'top10'));
  const view = { sortKeys: ['dpd'], asc: false, filter: M.normFilter({ maxAgeDays: 30 }) };
  assert.equal(P.matchLens(view).key, 'rising');
  assert.equal(P.matchLens({ sortKeys: ['dpd'], asc: false, filter: M.normFilter(null) }), null);
  assert.equal(P.matchLens({ sortKeys: ['cr'], asc: true, filter: M.normFilter(null) }), null);
});

test('门槛描述与快捷项开关', () => {
  assert.equal(P.filterText({ min: { digg: 10000 }, minCr: 0.8, maxAgeDays: 30, kind: 'video' }), '赞 ≥ 1万、收藏率 ≥ 80%、近 30 天、只看视频');
  const q = P.QUICK_FILTERS.find((x) => x.key === 'cr80');
  const f0 = M.normFilter(null);
  assert.deepEqual(q.patch(f0), { minCr: 0.8 });
  assert.deepEqual(q.patch(M.normFilter({ minCr: 0.8 })), { minCr: 0 });
});

test('健康度：识别中 → 正常 / 失败 / 被拦', () => {
  assert.equal(P.health({ type: 'search', count: 0, located: false, sinceRouteMs: 1000 }), 'recognizing');
  assert.equal(P.health({ type: 'search', count: 20, located: true, sinceRouteMs: 1000 }), 'ok');
  assert.equal(P.health({ type: 'search', count: 0, located: false, sinceRouteMs: 9000 }), 'fail');
  assert.equal(P.health({ type: 'search', count: 20, located: false, sinceRouteMs: 9000 }), 'partial');
  assert.equal(P.health({ type: 'profile', count: 0, located: true, sinceRouteMs: 9000, blocked: 'login' }), 'blocked');
  assert.equal(P.health({ type: 'video', count: 0 }), 'ok');
});

test('状态句', () => {
  const s = P.statusLine({ health: 'ok', count: 20, strongNeed: 3, sorted: false });
  assert.deepEqual(s.map((x) => x.t), ['已读取 20 条', '真需求 3 条', '样本较少，建议继续加载']);
  const t = P.statusLine({ health: 'ok', count: 120, sorted: true, shown: 86, excludedHigh: 2 });
  assert.deepEqual(t.map((x) => x.t), ['达标 86 条', '已读取 120 条', '另有 2 条真需求没过线']);
  // 结果（达标 N 条）放最前：窗口窄被截断时丢的是次要信息
  // 主页没读全：显示 18 / 60，并提示排名还不准
  const p = P.statusLine({ health: 'ok', count: 18, total: 60, sorted: true, shown: 10 });
  assert.deepEqual(p.map((x) => x.t), ['达标 10 条', '已读取 18 / 60 条，排名还不准']);
  assert.match(P.statusLine({ health: 'fail' })[0].t, /读不到/);
});
