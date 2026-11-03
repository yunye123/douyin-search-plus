'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function el(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    attrs: {},
    children: [],
    style: {},
    dataset: {},
    parentElement: null,
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); if (c && typeof c === 'object') c.parentElement = this; return c; },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) {
      const want = sel.startsWith('.') ? sel.slice(1) : '';
      const walk = (n) => {
        if (!n || typeof n !== 'object') return null;
        if (want && String(n.className || '').split(/\s+/).includes(want)) return n;
        for (const c of n.children || []) {
          const found = walk(c);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(node, 'textContent', {
    get() {
      if (!this.children.length) return this._text || '';
      return this.children.map((c) => (typeof c === 'string' ? c : c.textContent || '')).join('');
    },
    set(v) { this._text = String(v); this.children = []; },
  });
  return node;
}

const M = require('../../src/content/metrics.js');
require('../../src/content/util.js');

const documentStub = {
  createElement: (tag) => el(tag),
  createElementNS: (_ns, tag) => el(tag),
  createTextNode: (s) => ({ textContent: String(s), children: [] }),
  addEventListener() {},
  removeEventListener() {},
  documentElement: { dataset: {} },
};
const windowStub = { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800 };
const g = globalThis;
const saved = { document: g.document, window: g.window };
g.document = documentStub;
g.window = windowStub;

require('../../src/content/ui-kit.js');
require('../../src/content/ui-cards.js');
const C = globalThis.DSP.cards;

const NOW = 1_790_000_000;
const opts = { isCand: false, onToggleCand() {}, onCopyLink() {} };

test('缺数据的详情判读不写成点赞不足 100', () => {
  const v = M.derive({
    id: '7400000000000000009', kind: 'video', desc: 'x',
    digg: 500, collect: null, comment: 3, share: 1, createTime: NOW - 86400, capturedAt: NOW,
  }, NOW);
  assert.equal(M.tierLabel(v), '缺数据');
  const box = C.detailCard(null, v, opts);
  const verdict = box.querySelector('.dd-verdict').textContent;
  assert.equal(verdict.includes('< 100'), false);
  assert.equal(verdict.includes('点赞 < 100'), false);
  assert.match(verdict, /收藏数没读到/);
});

test('样本少的详情判读仍写点赞不足 100', () => {
  const v = M.derive({
    id: '7400000000000000010', kind: 'video', desc: 'x',
    digg: 50, collect: 40, comment: 1, share: 1, createTime: NOW - 86400, capturedAt: NOW,
  }, NOW);
  assert.equal(M.tierLabel(v), '样本少');
  const verdict = C.detailCard(null, v, opts).querySelector('.dd-verdict').textContent;
  assert.match(verdict, /点赞 < 100/);
});

test.after(() => {
  if (saved.document === undefined) delete g.document; else g.document = saved.document;
  if (saved.window === undefined) delete g.window; else g.window = saved.window;
});
