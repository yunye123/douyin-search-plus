'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../src/content/loader.js');

function run(seq, extra) {
  let st = { last: -1, still: 0 };
  for (let i = 0; i < seq.length; i++) {
    const r = L.decide(st, Object.assign({ count: seq[i], cap: 200, blocked: null }, extra && extra(i)));
    st = r.st;
    if (r.action === 'stop') return { at: i, reason: r.reason };
  }
  return { at: -1 };
}

test('数量持续增长就继续', () => {
  assert.deepEqual(run([20, 30, 40, 50, 60]), { at: -1 });
});

test('达到上限即停', () => {
  assert.deepEqual(run([20, 100, 200]), { at: 2, reason: 'cap' });
});

test('连续 6 轮没有新数据算卡住（不误报"到底了"）', () => {
  const r = run([20, 30, 30, 30, 30, 30, 30, 30]);
  assert.equal(r.reason, 'stalled');
  assert.equal(r.at, 1 + L.STALL_TICKS);
});

test('接口说没有更多 + 数量不再变化 → 到底', () => {
  const r = run([20, 30, 30, 30], () => ({ hasMore: false }));
  assert.equal(r.reason, 'end');
});

test('登录墙 / 验证码立即停', () => {
  assert.deepEqual(run([20, 30], (i) => ({ blocked: i === 1 ? 'login' : null })), { at: 1, reason: 'login' });
  assert.deepEqual(run([20], () => ({ blocked: 'captcha' })), { at: 0, reason: 'captcha' });
});

test('结束原因文案', () => {
  assert.match(L.REASONS.login(63), /登录/);
  assert.match(L.REASONS.stalled(63), /手动/);
  assert.match(L.REASONS.end(286), /286/);
});
