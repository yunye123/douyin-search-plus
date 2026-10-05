// Playwright 夹具：每个测试一个加载了插件的独立浏览器 + 仿真站点。
// state(page) 通过测试通道读取内容脚本（隔离世界）里的状态快照。
'use strict';
const base = require('@playwright/test');
const { launch, urls, extensionId } = require('../sim/launch');

const test = base.test.extend({
  ext: async ({}, use) => {
    const ext = await launch({ viewport: { width: 1600, height: 900 } });
    await use(ext);
    await ext.close();
  },
  page: async ({ ext }, use) => {
    const page = await ext.context.newPage();
    page.errors = [];
    page.on('pageerror', (e) => page.errors.push(e.message));
    await use(page);
  },
});

async function state(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    // 打开测试通道（隔离世界只在 <html data-dsp-test="1"> 时响应）
    document.documentElement.dataset.dspTest = '1';
    const t = setTimeout(() => reject(new Error('content script did not answer')), 3000);
    const on = (ev) => {
      if (ev.data && ev.data.ns === 'dsp-test' && ev.data.type === 'state') {
        clearTimeout(t);
        window.removeEventListener('message', on);
        resolve(ev.data.state);
      }
    };
    window.addEventListener('message', on);
    window.postMessage({ ns: 'dsp-test', type: 'state?' }, location.origin);
  }));
}

// 轮询直到 pred(state) 为真
async function until(page, pred, { timeout = 10_000, label = '' } = {}) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < timeout) {
    s = await state(page);
    if (pred(s)) return s;
    await page.waitForTimeout(150);
  }
  throw new Error('等待超时 ' + label + '：' + JSON.stringify({ count: s && s.count, session: s && s.session, err: s && s.err }));
}

async function ready(page) {
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready);
}

module.exports = { test, expect: base.expect, state, until, ready, urls, extensionId };
