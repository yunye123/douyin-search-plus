// 数据层端到端：数据桥（MAIN 世界）→ 内容脚本 store（隔离世界）在各种页面形态下都能拿到正确数据。
'use strict';
const { test, expect, state, until, ready, urls } = require('./fixtures');

test('搜索页：首屏 fiber 收割 20 条，滚动翻页后接口数据并入同一会话', async ({ page }) => {
  await page.goto(urls.search('AI保姆级教程'));
  await ready(page);
  let s = await until(page, (x) => x.count >= 20, { label: '首屏' });
  expect(s.route.type).toBe('search');
  expect(s.session).toBe('search|AI保姆级教程|');
  expect(s.label).toBe('搜索「AI保姆级教程」');
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 4000); await page.waitForTimeout(500); }
  s = await until(page, (x) => x.count >= 40, { label: '翻页' });
  expect(s.meta.search.hasMore).toBe(true);
  expect(s.err).toBe('');
});

test('搜索页：纯接口兜底（页面上没有 fiber）', async ({ page }) => {
  await page.goto(urls.search('纯接口', 'nofiber=1'));
  await ready(page);
  // 首屏没有 fiber 也没有接口 → 0 条；翻页后靠接口拿到数据
  for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 4000); await page.waitForTimeout(500); }
  const s = await until(page, (x) => x.count >= 10, { label: '接口兜底' });
  expect(s.session).toBe('search|纯接口|');
});

test('搜索页：切官方筛选开新会话，迟到的旧数据不混入', async ({ page }) => {
  await page.goto(urls.search('筛选测试'));
  await ready(page);
  await until(page, (x) => x.count >= 20);
  await page.click('.sim-filter-label');
  await page.click('[data-k="publish_time"][data-v="180"]');
  const s = await until(page, (x) => x.session.endsWith('publish_time=180'), { label: '筛选会话' });
  expect(s.count).toBeLessThanOrEqual(20);
  expect(s.count).toBeGreaterThan(0);
});

test('搜索页：SPA 换关键词后只保留新关键词的数据', async ({ page }) => {
  await page.goto(urls.search('第一个词'));
  await ready(page);
  await until(page, (x) => x.count >= 20);
  await page.fill('#sim-q', '第二个词');
  await page.press('#sim-q', 'Enter');
  const s = await until(page, (x) => x.session === 'search|第二个词|' && x.count >= 20, { label: '新关键词' });
  expect(s.route.kw).toBe('第二个词');
});

test('搜索页：React 重渲染混沌下数据不丢、不重复', async ({ page }) => {
  await page.goto(urls.search('混沌', 'chaos=1'));
  await ready(page);
  await until(page, (x) => x.count >= 20);
  await page.waitForTimeout(3000);
  const s = await state(page);
  expect(s.count).toBe(20);
  expect(page.errors).toEqual([]);
});

test('主页：首屏服务端直出（无接口）靠 fiber 收割，翻页走接口', async ({ page, ext }) => {
  await page.goto(urls.profile());
  await ready(page);
  let s = await until(page, (x) => x.count >= 18, { label: '主页首屏' });
  expect(s.route.type).toBe('profile');
  expect(ext.sim.counters.post).toBe(0); // 首屏确实没发接口
  expect(s.label).toBe('@星辰ai');
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 5000); await page.waitForTimeout(500); }
  s = await until(page, (x) => x.count >= 36, { label: '主页翻页' });
  expect(ext.sim.counters.post).toBeGreaterThan(0);
});

test('视频页：评论数据（接口 + fiber 盖章）归到当前视频', async ({ page, ext }) => {
  await page.goto(urls.search('评论来源'));
  await ready(page);
  const id = [...ext.sim.registry.keys()][2];
  await page.goto(urls.video(id));
  await ready(page);
  const s = await until(page, (x) => x.comments.count >= 20, { label: '评论' });
  expect(s.comments.awemeId).toBe(id);
  expect(s.comments.total).toBe(160);
  await expect.poll(() => page.locator('[data-e2e="comment-item"][data-dsp-cid]').count()).toBeGreaterThanOrEqual(20);
  expect(s.count).toBe(0); // 视频页不收视频列表数据
});

test('首页等无关页面：不收数据、不报错', async ({ page }) => {
  await page.goto(urls.home());
  await page.waitForTimeout(800);
  const s = await state(page);
  expect(s.route.type).toBe('other');
  expect(s.count).toBe(0);
  expect(s.err).toBe('');
});
