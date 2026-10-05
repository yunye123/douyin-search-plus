// 生成改版前后对比图（作品集用）：同一个仿真页面，分别加载旧版插件与当前版本截图。
// 用法：node scripts/before-after.js <旧版插件目录> [输出目录=docs/before-after]
// 旧版目录可以用 git worktree 取出，例如：git worktree add ../old-v071 f24bd58
'use strict';
const path = require('path');
const fs = require('fs');
const { launch, urls } = require('../test/sim/launch');
const { saveWebp } = require('./webp');

const OLD = process.argv[2];
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '..', 'docs', 'before-after'));
if (!OLD) { console.error('用法：node scripts/before-after.js <旧版插件目录> [输出目录]'); process.exit(1); }

async function capture(extDir, tag) {
  const ext = await launch({ extDir, viewport: { width: 1600, height: 900 } });
  const page = await ext.context.newPage();
  // 新版首次引导先标记为已看过，截图更干净
  await page.addInitScript(() => { try { localStorage.DSP_DEBUG = '0'; } catch (e) { /* 忽略 */ } });
  for (const [name, url] of [['search', urls.search('AI保姆级教程')], ['profile', urls.profile()]]) {
    await page.goto(url);
    await page.waitForFunction(() => window.__SIM__ && window.__SIM__.ready);
    await page.waitForTimeout(2500);
    const coach = page.getByRole('button', { name: '知道了' });
    if (await coach.count()) { await coach.click(); await page.waitForTimeout(300); }
    await page.mouse.move(5, 5);
    const file = path.join(OUT, `${tag}-${name}.webp`);
    await saveWebp(page, file);
    console.log('✓', path.relative(process.cwd(), file));
  }
  await ext.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await capture(path.resolve(OLD), 'before-v0.7.1');
  await capture(path.resolve(__dirname, '..'), 'after-v1.0');
})();
