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
  await page.getByRole('button', { name: /暂停插件/ }).click();
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

test('视频弹层里出现"登录后查看更多评论"不会被误判成登录墙', async ({ page }) => {
  await page.goto(urls.search('弹层', 'modal=1'));
  await ready(page);
  await page.waitForTimeout(1500);
  const s = await state(page);
  expect(s.ui.health).not.toBe('blocked');
});

test('只用键盘：聚焦收藏率不抢焦点；回车看详情并加入候选；↓ 按名次跳到下一张', async ({ page }) => {
  await page.goto(urls.search('键盘测试'));
  await ready(page);
  await page.getByRole('button', { name: '知道了' }).click();
  await dsp(page, 'sort').click();
  await page.locator('[data-lens="ratio"]').click();
  await until(page, (x) => x.view.active);
  // 第 1 名的收藏率标签
  const first = page.locator('.dsp-ann .chip[aria-label^="第 1 名"]');
  await first.focus();
  await page.waitForTimeout(600);
  await expect(page.locator('.dsp-detail')).toHaveCount(0); // 聚焦不自动弹详情
  await page.keyboard.press('Enter');
  await expect(page.locator('.dsp-detail')).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.locator('.dsp-detail')).toBeVisible(); // 钉住，不会自己消失
  await page.keyboard.press('Enter'); // 焦点在"加入候选"
  await until(page, (x) => x.candidates.length === 1);
  await expect(page.locator('.dsp-detail')).toHaveCount(0);
  const focusedLabel = await page.evaluate(() => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a && a.getAttribute('aria-label');
  });
  expect(focusedLabel).toMatch(/^第 1 名/); // 焦点回到标签
  await page.keyboard.press('ArrowDown');
  const next = await page.evaluate(() => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a && a.getAttribute('aria-label');
  });
  expect(next).toMatch(/^第 2 名/);
});

test('关键词带加号（AI+办公）照常读取', async ({ page }) => {
  await page.goto('https://www.douyin.com/search/AI%2B%E5%8A%9E%E5%85%AC?type=video');
  await ready(page);
  const s = await until(page, (x) => x.count >= 20 && x.ui.health === 'ok', { label: '加号关键词' });
  expect(s.route.kw).toBe('AI+办公');
});

test('轻提示出现在底部、不盖住第一行；按钮叫"达标线"', async ({ page }) => {
  await page.goto(urls.search('提示位置'));
  await ready(page);
  await expect(dsp(page, 'filter')).toContainText('达标线');
  await dsp(page, 'sort').click();
  await page.locator('[data-lens="need"]').click();
  const box = await page.locator('.dsp-toast').boundingBox();
  const vh = page.viewportSize().height;
  expect(box.y).toBeGreaterThan(vh - 120);
});

test('引导条在工具栏下方（不浮在卡片上）；滚动不会让它永久消失，点"知道了"才关', async ({ page }) => {
  await page.goto(urls.search('引导'));
  await ready(page);
  await expect(page.locator('.guide')).toBeVisible();
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(400);
  expect((await state(page)).settings.guideDone).toBe(false);
  await page.getByRole('button', { name: '知道了' }).click();
  await expect(page.locator('.guide')).toHaveCount(0);
  expect((await state(page)).settings.guideDone).toBe(true);
});

test('先排序再继续加载：主页 Top10 能继续读到更多作品', async ({ page }) => {
  await page.goto(urls.profile());
  await ready(page);
  await page.getByRole('button', { name: '知道了' }).click();
  await dsp(page, 'sort').click();
  await page.locator('[data-lens="top10"]').click();
  await until(page, (x) => x.view.active);
  await dsp(page, 'load').click();
  await until(page, (x) => x.count >= 60, { timeout: 40000, label: '排序后加载到底' });
});

test('先排序再继续加载：搜索页「收藏率最高」也能翻页', async ({ page }) => {
  await page.goto(urls.search('排序后加载'));
  await ready(page);
  await dismissCoach(page);
  await dsp(page, 'sort').click();
  await page.locator('[data-lens="ratio"]').click();
  await until(page, (x) => x.view.active);
  await dsp(page, 'load').click();
  await until(page, (x) => x.count >= 50, { timeout: 30000, label: '排序后翻页' });
});

test('视频弹层评论还没撑满面板时点「加载全部」：背后的搜索页不动', async ({ page }) => {
  await page.goto(urls.search('弹层少评论'));
  await ready(page);
  await until(page, (x) => x.ui.docked && x.count >= 20);
  await dismissCoach(page);
  await page.evaluate(() => {
    const first = /(\d{15,})/.exec(document.querySelector('#search-result-container li a').getAttribute('href'))[1];
    history.pushState({}, '', location.pathname + location.search + '&modal_id=' + first);
    const m = document.createElement('div');
    m.id = 'sim-modal';
    m.style.cssText = 'position:fixed;inset:0;z-index:80;background:#111;display:flex;padding:40px';
    m.innerHTML = '<div style="flex:1"></div><div class="side" style="width:420px;height:calc(100vh - 80px);overflow:auto"><div data-e2e="comment-list"></div></div>';
    document.body.appendChild(m);
    const list = m.querySelector('[data-e2e="comment-list"]');
    xhrJson('/aweme/v1/web/comment/list/?aweme_id=' + first + '&cursor=0&count=6').then((j) => {
      for (const c of j.comments) { const w = document.createElement('div'); w.innerHTML = '<div data-e2e="comment-item"><div>' + escH(c.text) + '</div></div>'; list.appendChild(w); }
    });
  });
  await expect(dsp(page, 'c-load')).toBeVisible();
  await dsp(page, 'c-load').click();
  await page.waitForTimeout(7000);
  const after = await page.evaluate(() => ({ y: scrollY, total: window.__SIM__.total }));
  expect(after).toEqual({ y: 0, total: 20 });
});

test('主页排序后改变窗口宽度：网格跟着变，不出现横向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(urls.profile());
  await ready(page);
  await dismissCoach(page);
  await dsp(page, 'sort').click();
  await page.locator('[data-lens="top10"]').click();
  await until(page, (x) => x.view.active);
  await page.keyboard.press('Escape');
  for (const w of [1200, 1900]) {
    await page.setViewportSize({ width: w, height: 900 });
    await expect.poll(() => page.evaluate(() => {
      const ul = document.querySelector('[data-e2e="user-post-list"] ul');
      const r = ul.getBoundingClientRect();
      const maxRight = Math.max(...[...ul.children].map((li) => li.getBoundingClientRect().right));
      const de = document.documentElement;
      return de.scrollWidth <= de.clientWidth && maxRight <= r.right + 1 && r.right - maxRight < 4;
    }), { timeout: 3000, message: '宽度 ' + w }).toBe(true);
  }
});

test('主页：详情卡的"占账号总获赞"按当前页头现算（页头晚于地址更新也不留旧数）', async ({ page, ext }) => {
  await page.goto(urls.profile());
  await ready(page);
  await dismissCoach(page);
  await until(page, (x) => x.count >= 18);
  const card = page.locator('[data-e2e="user-post-list"] li').first();
  const id = await card.evaluate((li) => /(\d{15,})/.exec(li.querySelector('a').getAttribute('href'))[1]);
  const open = async () => { await card.locator('.dsp-ann .chip').focus(); await page.keyboard.press('Enter'); await expect(page.locator('.dd-share')).toBeVisible(); };
  await open();
  await page.keyboard.press('Escape');
  await page.evaluate((n) => { document.querySelector('[data-e2e="user-info-like"]').textContent = '获赞 ' + n; }, ext.sim.registry.get(id).digg * 4);
  await open();
  await expect(page.locator('.dd-share')).toContainText('25.0%');
});

test('回到搜过的关键词：扩展弹窗和工具栏说的是同一个条数', async ({ page }) => {
  await page.goto(urls.search('缓存甲'));
  await ready(page);
  await dismissCoach(page);
  await loadMore(page, 4);
  await until(page, (x) => x.count >= 40);
  const go = async (kw) => { await page.fill('#sim-q', kw); await page.press('#sim-q', 'Enter'); await until(page, (x) => x.route.kw === kw && x.ui.docked); };
  await go('缓存乙');
  await go('缓存甲');
  const s = await until(page, (x) => x.count >= 40 && x.popup.count === 20, { label: '弹窗按页面卡片计数' });
  await expect(page.locator('.bar-text')).toContainText('已读取 20 条');
  expect(s.popup.strongNeed).not.toBeNull();
});

test('账号 Top10：复制当前结果只复制前 10 条；一键把前 10 条加入候选', async ({ page, ext }) => {
  await ext.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.douyin.com' });
  await page.goto(urls.profile());
  await ready(page);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 5000); await page.waitForTimeout(500); }
  await until(page, (x) => x.count >= 40);
  await dsp(page, 'sort').click();
  await page.locator('[data-lens="top10"]').click();
  await until(page, (x) => x.view.active && x.sortedIds.length > 10);
  await dsp(page, 'more').click();
  await page.getByRole('button', { name: /复制当前结果/ }).click();
  const rows = (await page.evaluate(() => navigator.clipboard.readText())).split('\n');
  expect(rows.length).toBe(11); // 表头 + 10 行
  await dsp(page, 'more').click();
  await page.getByRole('button', { name: /把前 10 条加入候选/ }).click();
  await until(page, (x) => x.candidates.length === 10);
});

test('视频页：新开页面也能看到这条的收藏率，并能连同评论结论加入候选', async ({ page, ext }) => {
  await ext.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.douyin.com' });
  await page.goto(urls.search('视频页候选'));
  await ready(page);
  const s0 = await until(page, (x) => x.count >= 20);
  const id = s0.sortedIds[0] || [...ext.sim.registry.keys()][0];
  await page.waitForTimeout(5600); // 等"最近看过"的缓存写入本机
  await page.goto(urls.video(id));
  await ready(page);
  await expect(page.locator('.cb-vcr')).toBeVisible();
  await page.locator('[data-barrier="ask"]').click();
  await dsp(page, 'c-cand').click();
  await until(page, (x) => x.candidates.includes(id));
  // 回到搜索页复制入库包，里面有评论区结论
  await page.goto(urls.search('视频页候选'));
  await ready(page);
  await dsp(page, 'basket').click();
  await dsp(page, 'copy-md').click();
  const md = await page.evaluate(() => navigator.clipboard.readText());
  expect(md).toContain('- 评论区：');
});

test('视频页：直接打开分享链接（插件没见过这条）也能看到收藏率', async ({ page }) => {
  const id = '7499999999999990001';
  // 1) 抖音单独请求这条视频的详情接口
  await page.goto(urls.video(id));
  await ready(page);
  await expect(page.locator('.cb-vcr')).toContainText('%');
  await dsp(page, 'c-cand').click();
  await until(page, (x) => x.candidates.includes(id));
  // 2) 没有接口、数据在页面详情区里
  await page.goto(urls.video('7499999999999990002') + '?fiber=detail');
  await ready(page);
  await expect(page.locator('.cb-vcr')).toContainText('%');
  // 3) 两样都没有：说明怎么做，不显示空数据
  await page.goto(urls.video('7499999999999990003') + '?nodetail=1');
  await ready(page);
  await expect(page.locator('#dsp-cbar')).toContainText('从搜索结果或博主主页点进');
  await expect(page.locator('.cb-vcr')).toHaveCount(0);
});

test('候选篮：复制过的标"已复制"，下次默认只复制新加入的', async ({ page, ext }) => {
  await ext.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.douyin.com' });
  await page.goto(urls.search('只复制新的'));
  await ready(page);
  await page.getByRole('button', { name: '知道了' }).click();
  const add = async (n) => { const c = page.locator('#search-result-container li').nth(n); await c.hover(); await c.locator('.dsp-ann .cand').click(); };
  await add(0); await add(1);
  await until(page, (x) => x.candidates.length === 2);
  await dsp(page, 'basket').click();
  await dsp(page, 'copy-md').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('# 选题候选 · 2 条');
  await page.keyboard.press('Escape');
  await add(2);
  await until(page, (x) => x.candidates.length === 3);
  await dsp(page, 'basket').click();
  await expect(dsp(page, 'copy-md')).toContainText('1 条新的');
  await dsp(page, 'copy-md').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('# 选题候选 · 1 条');
});
