// 在本地仿真站上按场景截图：设计自检、README / 商店素材都用它生成（不访问真实抖音，画面里没有真实用户内容）。
// 用法：node scripts/screenshots.js [输出目录=docs/screenshots] [场景名过滤] [宽=1600] [高=900]
'use strict';
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { launch, urls } = require('../test/sim/launch');
const { saveWebp } = require('./webp');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'docs', 'screenshots'));
const ONLY = process.argv[3] || '';
const W = Number(process.argv[4] || 1600), H = Number(process.argv[5] || 900);

// 在 shadow DOM 里按 data-dsp 找按钮
const q = (sel) => `(() => { for (const id of ['dsp-dock','dsp-root','dsp-cbar']) { const h = document.getElementById(id); const el = h && h.shadowRoot && h.shadowRoot.querySelector(${JSON.stringify(sel)}); if (el) return el; } return null; })()`;

async function click(page, sel) {
  const handle = await page.evaluateHandle(q(sel));
  const el = handle.asElement();
  if (!el) throw new Error('找不到 ' + sel);
  await el.click();
  await page.waitForTimeout(350);
}
async function ready(page) {
  await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready);
  await page.waitForTimeout(1600);
}
async function shot(page, name) {
  const file = path.join(OUT, name + '.webp');
  await saveWebp(page, file);
  console.log('✓', path.relative(process.cwd(), file));
}

const scenes = {
  async 'search-idle'(page) {
    await page.goto(urls.search('AI保姆级教程'));
    await ready(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, 'search-idle');
  },
  async 'search-sort-menu'(page) {
    await page.goto(urls.search('AI保姆级教程'));
    await ready(page);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 3000); await page.waitForTimeout(450); }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    await click(page, '[data-dsp="sort"]');
    await shot(page, 'search-sort-menu');
    await click(page, '[data-lens="need"]');
    await page.waitForTimeout(600);
    await page.mouse.move(10, 10);
    await shot(page, 'search-sorted');
  },
  async 'search-threshold'(page) {
    await page.goto(urls.search('AI保姆级教程'));
    await ready(page);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 3000); await page.waitForTimeout(450); }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await click(page, '[data-dsp="filter"]');
    await click(page, '[data-quick="cr80"]');
    await shot(page, 'search-threshold');
  },
  async basket(page) {
    await page.goto(urls.search('AI保姆级教程'));
    await ready(page);
    // 把前几张真需求卡加入候选
    await page.evaluate(() => {
      const anns = [...document.querySelectorAll('.dsp-ann')].filter((a) => a.shadowRoot.querySelector('.chip.high')).slice(0, 4);
      for (const a of anns) a.shadowRoot.querySelector('.cand').click();
    });
    await page.waitForTimeout(500);
    await click(page, '[data-dsp="basket"]');
    await page.waitForTimeout(300);
    await shot(page, 'basket');
  },
  async detail(page) {
    await page.goto(urls.search('AI保姆级教程'));
    await ready(page);
    const box = await page.evaluate(() => {
      const a = [...document.querySelectorAll('.dsp-ann')][2];
      const r = a.shadowRoot.querySelector('.chip').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(800);
    await shot(page, 'detail');
  },
  async profile(page) {
    await page.goto(urls.profile());
    await ready(page);
    await click(page, '[data-dsp="sort"]');
    await click(page, '[data-lens="top10"]');
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 280));
    await page.waitForTimeout(500);
    await shot(page, 'profile-top10');
  },
  async comments(page, ext) {
    await page.goto(urls.search('评论截图'));
    await ready(page);
    const id = [...ext.sim.registry.keys()][5];
    await page.goto(urls.video(id));
    await ready(page);
    await page.evaluate(() => { const s = document.querySelector('.sim-vside'); s.scrollTop = s.scrollHeight; });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { document.querySelector('.sim-vside').scrollTop = 0; });
    await click(page, '[data-cmode="replies"]');
    await click(page, '[data-barrier="cost"]');
    await page.waitForTimeout(400);
    await shot(page, 'comments');
  },
  async states(page) {
    await page.goto(urls.search('登录墙', 'loginwall=20'));
    await ready(page);
    await click(page, '[data-dsp="load"]');
    await page.waitForTimeout(6000);
    await shot(page, 'state-login');
  },
  async popup(page) {
    // 弹窗页是扩展内页面；这里用 file:// 打开并注入 chrome API 替身，只用于截图
    await page.setViewportSize({ width: 360, height: 640 });
    await page.addInitScript(() => {
      const store = { 'dsp.settings': { enabled: true, badges: true, loadCap: 100 }, 'dsp.candidates': [1, 2, 3, 4] };
      window.chrome = {
        runtime: { getManifest: () => ({ version: '1.0.0' }) },
        storage: { local: { get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : store), set: async (o) => Object.assign(store, o) } },
        tabs: {
          query: async () => [{ id: 1, url: 'https://www.douyin.com/search/AI' }],
          sendMessage: async () => ({ type: 'search', label: '搜索「AI保姆级教程」', count: 60, strongNeed: 10, sortLabel: '收藏', candidates: 4, health: 'ok' }),
          create: () => {}, reload: () => {},
        },
      };
    });
    await page.goto(pathToFileURL(path.join(__dirname, '..', 'src', 'popup', 'popup.html')).href);
    await page.waitForTimeout(400);
    const h = await page.evaluate(() => document.body.scrollHeight);
    await page.setViewportSize({ width: 360, height: h });
    await shot(page, 'popup');
  },
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, fn] of Object.entries(scenes)) {
    if (ONLY && !name.includes(ONLY)) continue;
    const ext = await launch({ viewport: { width: W, height: H } });
    const page = await ext.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try { await fn(page, ext); } catch (e) { console.log('✗', name, e.message); }
    const err = await page.evaluate(() => document.documentElement.dataset.dspErr || '').catch(() => '');
    if (err) console.log('  插件报错：', err.slice(0, 300));
    if (errors.length) console.log('  页面报错：', errors.join(' | ').slice(0, 300));
    await ext.close();
  }
})();
