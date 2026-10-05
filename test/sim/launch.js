// 启动加载了本插件的 Chromium，并把抖音域名接到本地仿真站点。
// E2E 测试和截图脚本共用。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('@playwright/test');
const { createSim } = require('./router');

const EXT_DIR = path.resolve(__dirname, '..', '..');

async function launch(opts = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-e2e-'));
  const ext = opts.extDir || EXT_DIR;
  const args = [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--lang=zh-CN'];
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: opts.headless !== false,
    viewport: opts.viewport || { width: 1600, height: 900 },
    deviceScaleFactor: opts.dpr || 1,
    locale: 'zh-CN',
    colorScheme: opts.colorScheme || 'dark',
    args,
  });
  const sim = createSim();
  await sim.install(context);
  // 扩展的 service worker（若有）用来拿扩展 ID，打开弹窗页
  let extensionId = null;
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 3000 });
    extensionId = sw.url().split('/')[2];
  } catch { /* 无后台脚本时拿不到，不影响内容脚本测试 */ }
  const close = async () => {
    await context.close();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  };
  return { context, sim, extensionId, close };
}

// 扩展 ID：本插件没有后台脚本，从扩展管理页读（只在测试里用）
async function extensionId(context) {
  const mgr = await context.newPage();
  try {
    await mgr.goto('chrome://extensions/');
    const list = await mgr.evaluate(() => new Promise((res) => chrome.developerPrivate.getExtensionsInfo(res)));
    return list.length ? list[0].id : null;
  } finally { await mgr.close(); }
}

const SITE = 'https://www.douyin.com';
const urls = {
  search: (kw = 'AI保姆级教程', q = '') => `${SITE}/search/${encodeURIComponent(kw)}?type=video${q ? '&' + q : ''}`,
  profile: (sec = 'MS4wLjABAAAA_sim_star', q = '') => `${SITE}/user/${sec}${q ? '?' + q : ''}`,
  video: (id = '7400000000000000001') => `${SITE}/video/${id}`,
  home: () => `${SITE}/`,
};

module.exports = { launch, urls, extensionId, EXT_DIR };
