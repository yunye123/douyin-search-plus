// 界面端到端：用户的完整流程在仿真站上跑通（Playwright 的 CSS 选择器会自动穿透插件的 Shadow DOM）。
'use strict';
const { test, expect, state, until, ready, urls } = require('./fixtures');

const dsp = (page, name) => page.locator(`[data-dsp="${name}"]`);
async function dismissCoach(page) {
  const b = page.getByRole('button', { name: '知道了' });
  if (await b.count()) await b.click();
}
async function loadMore(page, n = 3) {
  for (let i = 0; i < n; i++) { await page.mouse.wheel(0, 3000); await page.waitForTimeout(400); }
  await page.evaluate(() => window.scrollTo(0, 0));
}
// 列表里按视觉顺序（CSS order）排好的卡片 id
const visualOrder = (page) => page.evaluate(() => {
  const ul = document.querySelector('#search-result-container ul, [data-e2e="user-post-list"] ul');
  return [...ul.children].filter((li) => li.querySelector('a[href*="/video/"], a[href*="/note/"]'))
    .map((li) => ({ id: (/(\d{15,})/.exec(li.querySelector('a').getAttribute('href')) || [])[1], o: +li.style.order || 0, dim: li.classList.contains('dsp-dim') }))
    .sort((a, b) => a.o - b.o);
});

test('搜索页：工具栏出现、卡片上有收藏率标签', async ({ page }) => {
  await page.goto(urls.search('界面测试'));
  await ready(page);
  await expect(page.locator('#dsp-dock')).toBeVisible();
  await expect(page.locator('.bar-text')).toContainText('已读取 20 条');
  await expect.poll(() => page.locator('.dsp-ann').count()).toBeGreaterThanOrEqual(18);
  const s = await state(page);
  expect(s.ui.docked).toBe(true);
  expect(s.ui.health).toBe('ok');
  expect(page.errors).toEqual([]);
});

test('排序「真需求」：只排收藏率 ≥80% 的视频、按收藏数，其余变暗沉底；恢复后完全还原', async ({ page }) => {
  await page.goto(urls.search('排序测试'));
  await ready(page);
  await loadMore(page);
  await until(page, (x) => x.count >= 40);
  await dismissCoach(page);
  await dsp(page, 'sort').click();
  await page.locator('[data-lens="need"]').click();
  const s = await until(page, (x) => x.view.active && x.sortedIds.length > 0);
  const order = await visualOrder(page);
  const ranked = order.filter((x) => !x.dim);
  expect(ranked.map((x) => x.id).slice(0, s.sortedIds.length)).toEqual(s.sortedIds.slice(0, ranked.length));
  expect(order.filter((x) => x.dim).length).toBe(s.restIds.length);
  // 名次牌
  await expect(page.locator('.dsp-ann').first()).toBeVisible();
  await expect(dsp(page, 'sort')).toContainText('真需求');
  await expect(dsp(page, 'filter').locator('.count')).toHaveText(''); // 看法自带的条件不算门槛
  // 恢复
  await dsp(page, 'reset').click();
  await until(page, (x) => !x.view.active);
  const after = await visualOrder(page);
  expect(after.every((x) => x.o === 0 && !x.dim)).toBe(true);
});

test('门槛：收藏率 ≥ 80% 一键开关，按钮显示 1 个门槛', async ({ page }) => {
  await page.goto(urls.search('门槛测试'));
  await ready(page);
  await dismissCoach(page);
  await dsp(page, 'filter').click();
  await page.locator('[data-quick="cr80"]').click();
  const s = await until(page, (x) => x.view.filter.minCr === 0.8);
  await expect(dsp(page, 'filter').locator('.count')).toHaveText('1');
  await expect(page.locator('.pf-n')).toHaveText(String(s.sortedIds.length));
  // 输入"1万"
  await page.locator('[data-min="digg"]').fill('1万');
  await until(page, (x) => x.view.filter.min.digg === 10000);
  await expect(page.locator('.in-hint').first()).toContainText('10,000');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pop-filter')).toHaveCount(0);
});

test('候选篮：卡片加入 → 复制入库包 → 刷新后仍在', async ({ page, ext }) => {
  await ext.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.douyin.com' });
  await page.goto(urls.search('候选测试'));
  await ready(page);
  await dismissCoach(page);
  const card = page.locator('#search-result-container li').nth(1);
  await card.hover();
  await card.locator('.dsp-ann').locator('.cand').click();
  await until(page, (x) => x.candidates.length === 1);
  await expect(dsp(page, 'basket').locator('.count')).toHaveText('1');
  await dsp(page, 'basket').click();
  await expect(page.locator('.pop-basket')).toBeVisible();
  await dsp(page, 'copy-md').click();
  const s = await state(page);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('# 选题候选 · 1 条');
  expect(clip).toContain('https://www.douyin.com/video/' + s.candidates[0]);
  expect(clip).toContain('发现于：搜索「候选测试」');
  await page.reload();
  await ready(page);
  await until(page, (x) => x.candidates.length === 1, { label: '刷新后候选篮' });
});

test('暂停插件：页面完全还原；点启动器恢复', async ({ page }) => {
  await page.goto(urls.search('暂停测试'));
  await ready(page);
  await dismissCoach(page);
  await dsp(page, 'sort').click();
  await page.locator('[data-lens="ratio"]').click();
  await until(page, (x) => x.view.active);
  await dsp(page, 'more').click();
  await page.getByRole('menuitem', { name: /暂停插件/ }).click();
  await until(page, (x) => x.ui.paused);
  await expect(page.locator('#dsp-dock')).toHaveCount(0);
  await expect(page.locator('.dsp-ann')).toHaveCount(0);
  expect((await visualOrder(page)).every((x) => x.o === 0 && !x.dim)).toBe(true);
  await dsp(page, 'launcher').click();
  await until(page, (x) => !x.ui.paused && x.ui.docked);
  await expect.poll(() => page.locator('.dsp-ann').count()).toBeGreaterThan(10);
});

test('评论区：按赞排序第一条点赞最多；切回默认还原', async ({ page, ext }) => {
  await page.goto(urls.search('评论界面'));
  await ready(page);
  const id = [...ext.sim.registry.keys()][4];
  await page.goto(urls.video(id));
  await ready(page);
  await expect(page.locator('#dsp-cbar')).toBeVisible();
  await page.locator('[data-cmode="digg"]').click();
  const top = await page.evaluate(() => {
    const rows = [...document.querySelector('[data-e2e="comment-list"]').children].filter((r) => r.querySelector('[data-e2e="comment-item"]'));
    const digg = (r) => Number(r.querySelector('[data-e2e="comment-item"]').getAttribute('data-dsp-digg'));
    const sorted = rows.slice().sort((a, b) => (+a.style.order || 0) - (+b.style.order || 0));
    return { first: digg(sorted[0]), max: Math.max(...rows.map(digg)) };
  });
  expect(top.first).toBe(top.max);
  await page.locator('[data-cmode="none"]').click();
  const cleared = await page.evaluate(() => [...document.querySelector('[data-e2e="comment-list"]').children].every((r) => !r.style.order));
  expect(cleared).toBe(true);
  await page.locator('[data-barrier="cost"]').click();
  await expect(page.locator('.cb-hl')).toBeVisible();
});

test('继续加载：遇到登录墙立即停下并说明原因', async ({ page }) => {
  await page.goto(urls.search('登录墙测试', 'loginwall=20'));
  await ready(page);
  await dismissCoach(page);
  await dsp(page, 'load').click();
  const s = await until(page, (x) => x.ui.loadReason === 'login', { timeout: 20000, label: '登录墙停止' });
  expect(s.ui.loading).toBe(false);
  await expect(page.locator('.bar-text')).toContainText('登录');
});

test('React 反复重渲染：角标不丢、每张卡只有一个', async ({ page }) => {
  await page.goto(urls.search('混沌界面', 'chaos=1'));
  await ready(page);
  await dismissCoach(page);
  await dsp(page, 'sort').click();
  await page.locator('[data-lens="ratio"]').click();
  await page.waitForTimeout(4000);
  const dup = await page.evaluate(() => [...document.querySelectorAll('#search-result-container li')].map((li) => li.querySelectorAll(':scope > .dsp-ann').length));
  expect(Math.max(...dup)).toBe(1);
  expect(dup.filter((n) => n === 1).length).toBeGreaterThanOrEqual(18);
  expect(page.errors).toEqual([]);
});

test('1280 宽：工具栏不溢出', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(urls.search('窄屏'));
  await ready(page);
  const fit = await page.locator('.bar').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(fit.sw).toBeLessThanOrEqual(fit.cw + 1);
});

test('抖音改版（选择器与 fiber 全失效）：进入"读不到结果"并能复制诊断信息', async ({ page }) => {
  await page.goto(urls.search('改版', 'broken=1'));
  await ready(page);
  const s = await until(page, (x) => x.ui.health === 'fail', { timeout: 15000, label: '识别失败' });
  expect(s.count).toBe(0);
  await expect(page.locator('.bar-text, .launcher').first()).toContainText(/读不到/);
});
