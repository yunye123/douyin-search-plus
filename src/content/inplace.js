// 原地重排引擎：在抖音原生的结果列表上直接排序（CSS order），不另起一套网格。
// 适用于"普通文档流 / flex 换行"的列表（2026-10 新版搜索页、博主主页）。
// 规则（防止和抖音的 React 打架）：
//   · 只改列表与列表直接子节点（li）的 class、style.order、CSS 变量，不往 React 子树中间插节点
//   · 角标等注入元素只追加在 li 末尾、绝对定位，不改变卡片尺寸
//   · 未达标的结果变暗沉底（不隐藏）；没有数据的结果保持原相对顺序放在达标结果之后；
//     列表里不是作品卡的子节点（直播卡、骨架屏、加载占位）统一排在最后
//   · 关闭/还原时逐项撤销，抖音页面 100% 回到原样
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});

  const S = { list: null, applied: false, grid: false, gridW: 0 };

  // 列表是否适合原地排序：卡片不能是绝对定位（旧版瀑布流就是绝对定位 + 虚拟滚动）
  function supports(listEl, cards) {
    if (!listEl || !cards.length) return false;
    const pos = getComputedStyle(cards[0].el).position;
    return pos !== 'absolute' && pos !== 'fixed';
  }

  // 块级列表（例如主页的 inline-block 网格）改成固定列数的 CSS 网格：
  // 先量出原来的列数、行列间距，再用 grid 复刻（列宽按容器等分，跟着窗口变）。直接改 flex 的话，
  // 按 DOM 位置写的"每行最后一个去掉右边距"规则会在重排后错位，有的行只剩 5 张。
  function toGrid(listEl, cards) {
    const rects = cards.slice(0, 40).map((c) => c.el.getBoundingClientRect()).filter((r) => r.width > 0);
    if (!rects.length) return false;
    const top0 = rects[0].top;
    const row = rects.filter((r) => Math.abs(r.top - top0) < 4).sort((a, b) => a.left - b.left);
    const next = rects.find((r) => r.top > top0 + 4);
    const cols = Math.max(1, row.length);
    const cg = row.length > 1 ? Math.max(0, row[1].left - row[0].right) : 16;
    const rg = next ? Math.max(0, next.top - rects[0].bottom) : 16;
    listEl.style.setProperty('--dsp-cols', String(cols));
    listEl.style.setProperty('--dsp-cg', cg + 'px');
    listEl.style.setProperty('--dsp-rg', rg + 'px');
    listEl.classList.add('dsp-grid');
    S.gridW = listEl.clientWidth;
    return true;
  }

  // plan：{ order: [id...]（达标且已排序）, dim: Set<id>（未达标/Top10 之外） }
  function apply(listEl, cards, plan) {
    if (S.list && S.list !== listEl) restore();
    if (S.list !== listEl) {
      S.list = listEl;
      S.grid = !/flex|grid/.test(getComputedStyle(listEl).display) && toGrid(listEl, cards);
    } else if (S.grid && Math.abs(listEl.clientWidth - S.gridW) > 1) {
      // 窗口变宽变窄（宽度监听会触发重画走到这里）：去掉网格、按原生布局重新量列数和间距
      // （块级布局下 order 不起作用，量到的就是原生排版；同一帧内完成，不闪）
      listEl.classList.remove('dsp-grid');
      if (!toGrid(listEl, cards)) listEl.classList.add('dsp-grid');
    }
    listEl.classList.add('dsp-sorted');
    const pos = new Map(plan.order.map((id, i) => [id, i + 1]));
    const base = plan.order.length;
    let unknown = 0, dimmed = 0;
    cards.forEach((c, idx) => {
      let o;
      if (plan.dim.has(c.id)) { o = (pos.has(c.id) ? 50000 + pos.get(c.id) : 60000 + idx); dimmed++; }
      else if (pos.has(c.id)) o = pos.get(c.id);
      else { o = base + 1 + idx; unknown++; }
      const v = String(o);
      if (c.el.style.order !== v) c.el.style.order = v;
      c.el.classList.toggle('dsp-dim', plan.dim.has(c.id));
    });
    S.applied = true;
    return { unknown, dimmed };
  }

  function restore() {
    const listEl = S.list;
    if (!listEl) return;
    listEl.classList.remove('dsp-sorted', 'dsp-grid', 'dsp-flow');
    for (const k of ['--dsp-cols', '--dsp-cg', '--dsp-rg']) listEl.style.removeProperty(k);
    S.gridW = 0;
    for (const el of listEl.children) {
      if (el.style && el.style.order) el.style.order = '';
      if (el.classList) el.classList.remove('dsp-dim');
    }
    S.list = null;
    S.applied = false;
    S.grid = false;
  }

  DSP.inplace = { S, supports, apply, restore };
})();
