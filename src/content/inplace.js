// 原地重排引擎：在抖音原生的结果列表上直接排序（CSS order），不另起一套网格。
// 适用于"普通文档流 / flex 换行"的列表（2026-10 新版搜索页、博主主页）。
// 规则（防止和抖音的 React 打架）：
//   · 只改列表直接子节点（li）的 style.order 与 class，不往 React 子树中间插节点
//   · 角标等注入元素只追加在 li 末尾、绝对定位，不改变卡片尺寸
//   · 未达标的结果变暗沉到后面（不隐藏）；没有数据的结果保持原相对顺序放在达标结果之后
//   · 关闭/还原时逐项撤销，抖音页面 100% 回到原样
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});

  const S = { list: null, applied: false, flowAdded: false };

  // 列表是否适合原地排序：卡片不能是绝对定位（旧版瀑布流就是绝对定位 + 虚拟滚动，只能走兜底视图）
  function supports(listEl, cards) {
    if (!listEl || !cards.length) return false;
    const pos = getComputedStyle(cards[0].el).position;
    return pos !== 'absolute' && pos !== 'fixed';
  }

  // plan：{ order: [id...]（达标且已排序）, dim: Set<id>（未达标）, rank: Map<id, n> }
  function apply(listEl, cards, plan) {
    if (S.list && S.list !== listEl) restore();
    S.list = listEl;
    const disp = getComputedStyle(listEl).display;
    if (!/flex|grid/.test(disp)) { listEl.classList.add('dsp-flow'); S.flowAdded = true; }
    const pos = new Map(plan.order.map((id, i) => [id, i + 1]));
    const base = plan.order.length;
    let unknown = 0, dimmed = 0;
    cards.forEach((c, idx) => {
      let o;
      if (pos.has(c.id)) o = pos.get(c.id);
      else if (plan.dim.has(c.id)) { o = 100000 + idx; dimmed++; }
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
    listEl.classList.remove('dsp-flow');
    for (const el of listEl.children) {
      if (el.style && el.style.order) el.style.order = '';
      if (el.classList) el.classList.remove('dsp-dim');
    }
    S.applied = false;
    S.flowAdded = false;
  }

  DSP.inplace = { S, supports, apply, restore };
})();
