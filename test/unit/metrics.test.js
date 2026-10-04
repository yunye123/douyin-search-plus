'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../src/content/metrics.js');
const U = require('../../src/content/util.js');

const NOW = 1_790_000_000;
const mk = (id, o) => M.derive(Object.assign({ id: String(id), kind: 'video', digg: 0, comment: 0, collect: 0, share: 0, createTime: NOW - 10 * 86400 }, o), NOW);

test('派生指标：藏赞比、评赞比、日均赞、样本少', () => {
  const v = mk(1, { digg: 1000, collect: 900, comment: 50, createTime: NOW - 20 * 86400 });
  assert.equal(v.cr, 0.9);
  assert.equal(v.er, 0.05);
  assert.equal(Math.round(v.dpd), 50);
  assert.equal(v.lowSample, false);
  assert.equal(mk(2, { digg: 3, collect: 5 }).lowSample, true);
  assert.equal(mk(3, { digg: 0, collect: 5 }).cr, 0);
});

test('观察窗口 D+N 与转发率', () => {
  const v = mk(1, { digg: 1000, share: 200, createTime: NOW - 6.2 * 86400, capturedAt: NOW });
  assert.equal(M.fmtDn(v.dn), 'D+6.2');
  assert.equal(v.sr, 0.2);
  assert.equal(M.fmtDn(mk(2, { createTime: NOW - 400 * 86400, capturedAt: NOW }).dn), 'D+400');
  assert.equal(M.fmtDn(0), '');
});

test('组合排序同分时按第一个维度破', () => {
  // collect 名次 p1 q2；comment 名次 q1 p2 → 名次和都是 3，按第一维 collect 破 → p 在前
  const list = [mk('q', { collect: 100, comment: 50 }), mk('p', { collect: 200, comment: 10 })];
  assert.deepEqual(M.sortList(list, ['collect', 'comment']).map((x) => x.v.id), ['p', 'q']);
  assert.deepEqual(M.sortList(list, ['comment', 'collect']).map((x) => x.v.id), ['q', 'p']);
});

test('单维排序：从高到低，倒序翻转', () => {
  const list = [mk(1, { digg: 100 }), mk(2, { digg: 500 }), mk(3, { digg: 300 })];
  assert.deepEqual(M.sortList(list, ['digg']).map((x) => x.v.id), ['2', '3', '1']);
  assert.deepEqual(M.sortList(list, ['digg'], true).map((x) => x.v.id), ['1', '3', '2']);
});

test('比率排序：样本少的排在可靠结果之后', () => {
  const list = [mk(1, { digg: 3, collect: 9 }), mk(2, { digg: 1000, collect: 900 }), mk(3, { digg: 500, collect: 100 })];
  assert.deepEqual(M.sortList(list, ['cr']).map((x) => x.v.id), ['2', '3', '1']);
});

test('组合排序：名次和，量级悬殊不互相淹没；并列取平均名次', () => {
  const list = [
    mk('a', { digg: 100000, comment: 1 }),
    mk('b', { digg: 10, comment: 500 }),
    mk('c', { digg: 5000, comment: 200 }),
  ];
  // digg 名次 a1 c2 b3；comment 名次 b1 c2 a3 → 名次和全是 4，按第一维 digg 破
  assert.deepEqual(M.sortList(list, ['digg', 'comment']).map((x) => x.v.id), ['a', 'c', 'b']);
  const list2 = [mk('x', { digg: 10, comment: 0 }), mk('y', { digg: 20, comment: 0 }), mk('z', { digg: 5, comment: 3 })];
  const r = M.sortList(list2, ['digg', 'comment']);
  // comment 并列的 x,y 名次都是 2.5
  assert.equal(r.find((i) => i.v.id === 'x').score, 2 + 2.5);
  assert.equal(r[0].v.id, 'y');
});

test('无维度时保持原顺序', () => {
  const list = [mk(1, { digg: 1 }), mk(2, { digg: 9 })];
  assert.deepEqual(M.sortList(list, []).map((x) => x.v.id), ['1', '2']);
});

test('筛选：阈值、藏赞比、近 N 天、类型', () => {
  const list = [
    mk(1, { digg: 2000, collect: 1800, createTime: NOW - 5 * 86400 }),
    mk(2, { digg: 2000, collect: 200, createTime: NOW - 5 * 86400 }),
    mk(3, { digg: 50, collect: 60, createTime: NOW - 5 * 86400 }),
    mk(4, { digg: 9000, collect: 9000, createTime: NOW - 200 * 86400, kind: 'note' }),
  ];
  assert.deepEqual(M.filterList(list, { min: { digg: 1000 } }).map((v) => v.id), ['1', '2', '4']);
  assert.deepEqual(M.filterList(list, { minCr: 0.8 }).map((v) => v.id), ['1', '4']); // 3 样本少被排除
  assert.deepEqual(M.filterList(list, { maxAgeDays: 30 }).map((v) => v.id), ['1', '2', '3']);
  assert.deepEqual(M.filterList(list, { kind: 'note' }).map((v) => v.id), ['4']);
  assert.equal(M.activeFilterCount({ min: { digg: 1 }, minCr: 0.8, kind: 'video' }), 3);
  assert.equal(M.activeFilterCount(M.EMPTY_FILTER), 0);
});

test('黑马标记：起飞（新且日均赞前 10%）与干货（藏赞比前 10%）', () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(mk(i, { digg: 1000 + i, collect: 300, createTime: NOW - 100 * 86400 }));
  list.push(mk('fast', { digg: 50000, collect: 1000, createTime: NOW - 3 * 86400 }));
  list.push(mk('gem', { digg: 1000, collect: 1500, createTime: NOW - 100 * 86400 }));
  const m = M.marks(list, NOW);
  assert.equal(m.get('fast').rising, true);
  assert.equal(m.get('gem').gem, true);
  assert.equal(m.has('3'), false);
  assert.equal(M.marks(list.slice(0, 5), NOW).size, 0); // 样本太少不评
});

test('藏赞比分级', () => {
  assert.equal(M.crTier(mk(1, { digg: 1000, collect: 900 })), 'high');
  assert.equal(M.crTier(mk(1, { digg: 1000, collect: 500 })), 'mid');
  assert.equal(M.crTier(mk(1, { digg: 1000, collect: 100 })), 'low');
  assert.equal(M.crTier(mk(1, { digg: 1000, collect: 400 })), 'low'); // ≤40% 属于门槛信号
  assert.equal(M.crTier(mk(1, { digg: 1000, collect: 50 })), 'show');
  assert.equal(M.crTier(mk(1, { digg: 10, collect: 100 })), 'na');
});

test('概况：中位数与真需求计数', () => {
  const list = [mk(1, { digg: 100, collect: 90 }), mk(2, { digg: 300, collect: 30 }), mk(3, { digg: 200, collect: 200 })];
  const s = M.summarize(list);
  assert.equal(s.count, 3);
  assert.equal(s.median.digg, 200);
  assert.equal(s.strongNeed, 2);
  assert.equal(M.summarize([]).count, 0);
});

test('格式化', () => {
  assert.equal(U.fmtNum(9999), '9999');
  assert.equal(U.fmtNum(12345), '1.2万');
  assert.equal(U.fmtNum(100000), '10万');
  assert.equal(U.fmtNum(12345678), '1235万');
  assert.equal(U.fmtNum(123456789), '1.2亿');
  assert.equal(U.fmtPct(1.117), '112%');
  assert.equal(U.fmtPct(0.017), '1.7%');
  assert.equal(U.fmtPct(0.05), '5%');
  assert.equal(U.fmtPct(0), '0%');
  assert.equal(U.fmtDuration(127199), '02:07');
  assert.equal(U.fmtDuration(3723000), '1:02:03');
  assert.equal(U.fmtAgo(NOW - 3 * 86400, NOW), '3天前');
  assert.equal(U.fmtAgo(NOW - 90 * 86400, NOW), '3个月前');
});
