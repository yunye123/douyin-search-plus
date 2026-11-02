'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../../src/content/store.js');
require('../../src/content/export.js');

function classList() {
  const set = new Set();
  return {
    add(c) { set.add(c); },
    remove(c) { set.delete(c); },
    toggle(c, on) { if (on) set.add(c); else set.delete(c); },
    contains(c) { return set.has(c); },
  };
}

const VID = '7499999999999990021';
const list = { classList: classList(), children: [] };
let domDigg = 80;
const rows = [];

function row(opts) {
  const el = { style: { order: '' }, classList: classList() };
  const item = {
    textContent: opts.text || '',
    getAttribute(k) {
      if (k === 'data-dsp-cid') return opts.cid || null;
      if (k === 'data-dsp-digg') return opts.diggAttr == null ? null : String(opts.diggAttr);
      if (k === 'data-dsp-replies') return opts.replies == null ? null : String(opts.replies);
      return null;
    },
    querySelectorAll() { return []; },
  };
  return { el, item };
}

globalThis.DSP.adapters = {
  commentList() { return list; },
  commentRows() { return rows; },
  normText(s) { return String(s || '').replace(/\s+/g, '').slice(0, 24); },
  domCommentDigg() { return domDigg; },
};
require('../../src/content/comments.js');
const CE = globalThis.DSP.comments;

test('按时间：只有 DOM 的行沉底，同一时间按赞；collected 同样按时间再按赞', () => {
  store.setRoute(store.routeOf({ pathname: '/video/' + VID, search: '' }));
  store.intakeComments({
    awemeId: VID,
    items: [
      { cid: 'a', text: '较早', digg: 5, replies: 0, createTime: 100 },
      { cid: 'b', text: '同时少赞', digg: 1, replies: 0, createTime: 200 },
      { cid: 'c', text: '同时多赞', digg: 9, replies: 0, createTime: 200 },
      { cid: 'z', text: '没有时间', digg: 100, replies: 0, createTime: 0 },
    ],
  });
  rows.splice(0, rows.length,
    row({ cid: 'a', diggAttr: 5, replies: 0, text: '较早' }),
    row({ cid: 'b', diggAttr: 1, replies: 0, text: '同时少赞' }),
    row({ cid: 'c', diggAttr: 9, replies: 0, text: '同时多赞' }),
    row({ text: '页面上才有', diggAttr: null }),
  );

  const byDigg = CE.collected().map((c) => c.cid);
  assert.deepEqual(byDigg, ['z', 'c', 'a', 'b']);

  CE.setMode('time');
  const orderOf = (text) => rows.find((r) => r.item.textContent === text).el.style.order;
  assert.equal(orderOf('同时多赞'), '1');
  assert.equal(orderOf('同时少赞'), '2');
  assert.equal(orderOf('较早'), '3');
  assert.equal(orderOf('页面上才有'), '4');
  assert.equal(rows[3].item.getAttribute('data-dsp-cid'), null);
  assert.deepEqual(CE.collected().map((c) => c.cid), ['c', 'b', 'a', 'z']);

  CE.setMode(null);
});
