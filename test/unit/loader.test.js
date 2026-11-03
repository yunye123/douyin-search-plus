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

test('滚动不伪造滚轮或鼠标事件，默认间隔仍在 1800–3600ms（每 5 轮另加停顿）', () => {
  const g = globalThis;
  const saved = {
    document: g.document, window: g.window, setTimeout: g.setTimeout, clearTimeout: g.clearTimeout,
    WheelEvent: g.WheelEvent, MouseEvent: g.MouseEvent, random: Math.random,
  };
  const constructed = [];
  const dispatched = [];
  function Spy(label) {
    function Ctor(type) { constructed.push(label + ':' + type); this.type = type; }
    return Ctor;
  }
  g.WheelEvent = Spy('wheel');
  g.MouseEvent = Spy('mouse');
  const sc = {
    scrollTop: 0, scrollHeight: 5000, clientHeight: 800,
    dispatchEvent(e) { dispatched.push((e && e.type) || 'sc'); return true; },
  };
  const last = {
    isConnected: true,
    scrollIntoView() {},
    dispatchEvent(e) { dispatched.push((e && e.type) || 'last'); return true; },
  };
  g.document = {
    scrollingElement: sc, documentElement: sc,
    dispatchEvent() { dispatched.push('doc'); return true; },
  };
  g.window = {
    scrollTo() {}, WheelEvent: g.WheelEvent, MouseEvent: g.MouseEvent,
    dispatchEvent() { dispatched.push('win'); return true; },
  };
  const prevAdapters = g.DSP && g.DSP.adapters;
  if (g.DSP) g.DSP.adapters = { scrollerOf() { return sc; } };
  try {
    g.setTimeout = (fn) => { fn(); return 0; };
    g.clearTimeout = () => {};
    L.scrollToEnd(last, 0);
    L.scrollToEnd(last, 1);
    assert.deepEqual(constructed, []);
    assert.deepEqual(dispatched, []);

    const delays = [];
    const jobs = [];
    g.setTimeout = (fn, ms) => { delays.push(ms); jobs.push(fn); return jobs.length; };
    const seq = [0, 0.5, 0.999999, 0, 0, 0.999999, 0.25];
    let ri = 0;
    Math.random = () => seq[ri++];
    const loader = L.create({
      count: () => 1, cap: () => 100, blocked: () => null, hasMore: () => true, scroll() {},
    });
    loader.start();
    let guard = 0;
    while (jobs.length && guard++ < 20) jobs.shift()();
    assert.equal(delays.length, 6);
    for (const i of [0, 1, 2, 3, 5]) assert.ok(delays[i] >= 1800 && delays[i] <= 3600, 'tick ' + i + '=' + delays[i]);
    assert.ok(delays[4] >= 3300 && delays[4] <= 6600, 'pause ' + delays[4]);
    assert.ok(delays[4] > 3600);
    assert.equal(loader.running, false);
    assert.equal(loader.reason, 'stalled');
  } finally {
    g.document = saved.document;
    g.window = saved.window;
    g.setTimeout = saved.setTimeout;
    g.clearTimeout = saved.clearTimeout;
    if (saved.WheelEvent === undefined) delete g.WheelEvent; else g.WheelEvent = saved.WheelEvent;
    if (saved.MouseEvent === undefined) delete g.MouseEvent; else g.MouseEvent = saved.MouseEvent;
    Math.random = saved.random;
    if (g.DSP) g.DSP.adapters = prevAdapters;
  }
});

test('评论加载间隔锁在 1200–2600ms（每 5 轮另加停顿）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../../src/content/ui.js'), 'utf8');
  const found = /delay:\s*\[(\d+),\s*(\d+)\]/.exec(src);
  assert.ok(found, 'ui.js 里要有评论加载的 delay');
  assert.deepEqual([Number(found[1]), Number(found[2])], [1200, 2600]);

  const g = globalThis;
  const saved = { setTimeout: g.setTimeout, clearTimeout: g.clearTimeout, random: Math.random };
  const delays = [];
  const jobs = [];
  try {
    g.setTimeout = (fn, ms) => { delays.push(ms); jobs.push(fn); return jobs.length; };
    g.clearTimeout = () => {};
    const seq = [0, 0.5, 0.999999, 0, 0, 0.999999, 0.25];
    let ri = 0;
    Math.random = () => seq[ri++];
    const loader = L.create({
      delay: [1200, 2600],
      count: () => 1, cap: () => 100, blocked: () => null, hasMore: () => true, scroll() {},
    });
    loader.start();
    let guard = 0;
    while (jobs.length && guard++ < 20) jobs.shift()();
    assert.equal(delays.length, 6);
    for (const i of [0, 1, 2, 3, 5]) assert.ok(delays[i] >= 1200 && delays[i] <= 2600, 'tick ' + i + '=' + delays[i]);
    assert.ok(delays[4] >= 2700 && delays[4] <= 5600, 'pause ' + delays[4]);
    assert.equal(loader.running, false);
    assert.equal(loader.reason, 'stalled');
  } finally {
    g.setTimeout = saved.setTimeout;
    g.clearTimeout = saved.clearTimeout;
    Math.random = saved.random;
  }
});

test('结束原因文案', () => {
  assert.match(L.REASONS.login(63), /登录/);
  assert.match(L.REASONS.stalled(63), /手动/);
  assert.match(L.REASONS.end(286), /286/);
});
