// 卡片增强：原生卡片封面右上角的收藏率标签（排序时带名次牌），悬停卡片时露出"☆ 候选"，
// 悬停/聚焦标签时弹出详情卡。
// 防冲突规则：每张卡只追加一个绝对定位的宿主节点（li 末尾），自身样式在 Shadow DOM 里；
// 只有当 li 是 static 定位时才补 position:relative（绝不覆盖抖音给卡片设的定位方式）。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  const { h, icon, clear } = DSP.kit;
  const U = DSP.util, M = DSP.metrics;

  const CARD_CSS = `
:host { all: initial; position: absolute !important; top: 8px; right: 8px; z-index: 6; display: block; pointer-events: none;
  font: 600 12px/22px "PingFang SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif; font-variant-numeric: tabular-nums; }
.row { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
.rank { pointer-events: auto; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 7px; text-align: center; color: #fff;
  background: rgba(12, 13, 20, 0.62); backdrop-filter: blur(8px); box-shadow: inset 0 0 0 1px rgba(255,255,255,.13); }
.rank.top { background: #E3173F; box-shadow: none; }
.chip { pointer-events: auto; display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 7px; color: #EDEDF0;
  background: rgba(12, 13, 20, 0.62); backdrop-filter: blur(8px); box-shadow: inset 0 0 0 1px rgba(255,255,255,.13); cursor: default; border: 0; font: inherit; white-space: nowrap; }
.chip:focus-visible { outline: none; box-shadow: 0 0 0 2px #161722, 0 0 0 4px #25F4EE; }
.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.lbl { color: rgba(237,237,240,.72); font-weight: 500; }
.high { background: #25F4EE; color: #04262B; box-shadow: none; }
.high .lbl { color: rgba(4,38,43,.72); }
.mid .dot { background: #A9ACC2; }
.low .dot { background: #FFB547; } .low .v { color: #FFC670; }
.show .dot { background: #B597FF; } .show .v { color: #C9B3FF; }
.na { color: #9495A0; } .na .dot { background: transparent; box-shadow: inset 0 0 0 1.5px #6E6F7B; }
.cand { pointer-events: auto; display: none; align-items: center; gap: 4px; height: 22px; padding: 0 8px 0 6px; border-radius: 7px; border: 0; font: inherit; cursor: pointer;
  color: #EDEDF0; background: rgba(12, 13, 20, 0.72); backdrop-filter: blur(8px); box-shadow: inset 0 0 0 1px rgba(255,255,255,.13); }
.cand svg { width: 14px; height: 14px; }
.cand:hover { background: rgba(12, 13, 20, 0.88); }
.cand.on { display: inline-flex; color: #FFC53D; }
.cand.on svg { fill: #FFC53D; }
:host(.hover) .cand { display: inline-flex; }
.cand:focus-visible { display: inline-flex; outline: none; box-shadow: 0 0 0 2px #161722, 0 0 0 4px #25F4EE; }
@media (prefers-reduced-motion: no-preference) { .cand { transition: background 120ms; } }
`;
  let cardSheet = null;
  function styleCard(root) {
    try {
      if (!cardSheet) { cardSheet = new CSSStyleSheet(); cardSheet.replaceSync(CARD_CSS); }
      root.adoptedStyleSheets = [cardSheet];
    } catch (e) { root.appendChild(h('style', null, CARD_CSS)); }
  }

  const TIER_TEXT = { high: '真需求', mid: '收藏率', low: '收藏率', show: '收藏率', na: '样本少' };

  // 每张卡的增强节点：WeakMap 记录卡片 → { host, root, sig }
  const anns = new WeakMap();
  const live = new Set();

  function ensureHost(card) {
    let a = anns.get(card.el);
    if (a && a.host.isConnected && a.host.parentNode === card.el) return a;
    if (getComputedStyle(card.el).position === 'static') card.el.classList.add('dsp-rel');
    const host = document.createElement('div');
    host.className = 'dsp-ann';
    host.setAttribute('data-dsp-own', '');
    const root = host.attachShadow({ mode: 'open' });
    styleCard(root);
    card.el.appendChild(host);
    if (!card.el.__dspHover) {
      card.el.__dspHover = true;
      card.el.addEventListener('pointerenter', () => { const x = anns.get(card.el); if (x) x.host.classList.add('hover'); });
      card.el.addEventListener('pointerleave', () => { const x = anns.get(card.el); if (x) x.host.classList.remove('hover'); });
    }
    a = { host, root, sig: '' };
    anns.set(card.el, a);
    live.add(card.el);
    return a;
  }

  // ctx：{ v（派生记录）, rank（名次或 0）, isCand, onToggleCand(id), onDetail(el, v, anchor), onLeave() }
  function render(card, ctx) {
    const v = ctx.v;
    const a = ensureHost(card);
    const tier = M.crTier(v);
    const sig = [v.id, tier, v.cr, ctx.rank, ctx.isCand].join('|');
    if (a.sig === sig && a.root.childNodes.length > 0) return;
    a.sig = sig;
    clear(a.root);
    const row = h('div', { class: 'row' });
    if (ctx.rank) row.appendChild(h('span', { class: 'rank' + (ctx.rank <= 3 ? ' top' : ''), 'aria-label': '第 ' + ctx.rank + ' 名' }, String(ctx.rank)));
    const cand = h('button', {
      class: 'cand' + (ctx.isCand ? ' on' : ''), type: 'button',
      'aria-pressed': ctx.isCand ? 'true' : 'false',
      'aria-label': ctx.isCand ? '已在候选篮，点击移出' : '加入候选篮',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); ctx.onToggleCand(v.id, cand); },
    }, icon('star', 14), ctx.isCand ? '已加入' : '候选');
    row.appendChild(cand);
    const chip = h('button', {
      class: 'chip ' + tier, type: 'button',
      'aria-label': tier === 'na' ? '点赞不足 100，收藏率不参与分档' : '收藏率 ' + U.fmtPct(v.cr) + '，' + M.CR_TIERS[tier].label + '。按回车看详情',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); ctx.onDetail(v, chip, true); },
    });
    chip.appendChild(h('span', { class: 'dot' }));
    if (tier === 'na') chip.appendChild(h('span', null, '样本少'));
    else {
      chip.appendChild(h('span', { class: 'lbl' }, TIER_TEXT[tier]));
      chip.appendChild(h('span', { class: 'v' }, U.fmtPct(v.cr)));
    }
    chip.addEventListener('pointerenter', () => ctx.onDetail(v, chip, false));
    chip.addEventListener('pointerleave', () => ctx.onLeave());
    chip.addEventListener('focus', () => { if (chip.matches(':focus-visible')) ctx.onDetail(v, chip, true); });
    chip.addEventListener('blur', () => ctx.onLeave());
    // 在 li 上的点击不会穿透到抖音（按钮已阻止冒泡），整卡点击仍交给抖音打开视频
    row.appendChild(chip);
    a.root.appendChild(row);
  }

  function removeAll() {
    for (const el of live) {
      const a = anns.get(el);
      if (a && a.host.isConnected) a.host.remove();
      el.classList.remove('dsp-rel');
      anns.delete(el);
    }
    live.clear();
  }
  // 清掉不再在列表里的卡片的记录
  function prune() {
    for (const el of live) if (!el.isConnected) { live.delete(el); anns.delete(el); }
  }

  // ---------------- 详情卡 ----------------
  // 放在主界面层（固定定位）；优先放在卡片左边，放不下放右边
  const detail = { el: null, t: 0, hideT: 0, cur: null };
  function detailCard(layer, v, opts) {
    const tier = M.crTier(v);
    const T = M.CR_TIERS[tier];
    const box = h('div', { class: 'dsp-detail', role: 'dialog', 'aria-label': '数据详情' });
    box.appendChild(h('div', { class: 'dd-head' },
      h('div', { class: 'dd-main c-' + tier }, tier === 'na' ? '—' : U.fmtPct(v.cr)),
      h('span', { class: 'tier tier-' + tier }, T.label),
      h('span', { class: 'dd-dn' }, icon('clock', 12), v.dn ? M.fmtDn(v.dn) : '')));
    box.appendChild(h('div', { class: 'dd-formula' }, tier === 'na' && v.digg != null && v.digg < M.RATIO_MIN_DIGG
      ? '点赞不足 ' + M.RATIO_MIN_DIGG + '，收藏率波动太大，不参与分档'
      : '收藏率 = 收藏 ' + U.fmtNum(v.collect) + ' ÷ 点赞 ' + U.fmtNum(v.digg)));
    const grid = h('div', { class: 'dd-grid' });
    for (const [k, label] of [['digg', '点赞'], ['comment', '评论'], ['collect', '收藏'], ['share', '转发']]) {
      grid.appendChild(h('div', { class: 'dd-cell' }, h('div', { class: 'dd-k' }, label), h('div', { class: 'dd-v' }, U.fmtNum(v[k]))));
    }
    box.appendChild(grid);
    box.appendChild(h('div', { class: 'dd-rates' },
      h('span', null, '转发率 ', h('b', null, U.fmtPct(v.sr))),
      h('span', null, '评论率 ', h('b', null, U.fmtPct(v.er))),
      h('span', null, '日均赞 ', h('b', null, U.fmtNum(Math.round(v.dpd || 0))))));
    if (opts.share != null) box.appendChild(h('div', { class: 'dd-share' }, '占账号总获赞 ', h('b', null, U.fmtPct(opts.share))));
    const verdicts = {
      high: '≥80% 真需求：观众存着回看，选题成立。',
      mid: '40%~80%：有一定收藏价值，看内容形态再判断。',
      low: '≤40% 有门槛：可能太难、太贵或进不去，去评论区看看卡在哪。',
      show: '<10% 展示型：好看但不实用，教程类慎跟。',
      na: '样本太少，先看评论和同类视频再判断。',
    };
    box.appendChild(h('div', { class: 'dd-verdict v-' + tier }, verdicts[tier]));
    const isCand = opts.isCand;
    const candBtn = h('button', { class: 'dd-btn' + (isCand ? ' on' : ''), type: 'button', 'data-autofocus': '', 'aria-pressed': isCand ? 'true' : 'false',
      onclick: () => { opts.onToggleCand(v.id, candBtn); } }, icon('star', 16), isCand ? '已在候选篮' : '加入候选');
    const copyBtn = h('button', { class: 'dd-btn ghost', type: 'button', onclick: () => opts.onCopyLink(v) }, icon('copy', 16), '复制链接');
    box.appendChild(h('div', { class: 'dd-actions' }, candBtn, copyBtn));
    box.appendChild(h('div', { class: 'dd-foot' },
      (v.createTime ? U.fmtDate(v.createTime) + ' 发布' : '发布时间未知') + (v.kind === 'note' ? ' · 图文' : v.durationMs ? ' · 时长 ' + U.fmtDuration(v.durationMs) : '') +
      (v.capturedAt ? ' · ' + new Date(v.capturedAt * 1000).toTimeString().slice(0, 5) + ' 采集' : '')));
    return box;
  }
  function showDetail(layer, v, anchor, opts, immediate) {
    clearTimeout(detail.t);
    clearTimeout(detail.hideT);
    detail.t = setTimeout(() => {
      if (!anchor.isConnected) return;
      hideDetail(true);
      const box = detailCard(layer, v, opts);
      box.addEventListener('pointerenter', () => clearTimeout(detail.hideT));
      box.addEventListener('pointerleave', () => scheduleHide());
      layer.appendChild(box);
      const r = anchor.getBoundingClientRect();
      const card = (opts.cardEl || anchor).getBoundingClientRect();
      const w = box.offsetWidth, hh = box.offsetHeight;
      let left = card.left - w - 12;
      if (left < 8) left = card.right + 12;
      if (left + w > window.innerWidth - 8) left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      let top = Math.min(Math.max(8, r.top - 8), window.innerHeight - hh - 8);
      box.style.left = Math.round(left) + 'px';
      box.style.top = Math.round(top) + 'px';
      requestAnimationFrame(() => box.classList.add('dsp-in'));
      detail.el = box;
      detail.cur = v.id;
      if (immediate && opts.focus) { const f = box.querySelector('[data-autofocus]'); if (f) f.focus({ preventScroll: true }); }
    }, immediate ? 0 : 400);
  }
  function scheduleHide() {
    clearTimeout(detail.t);
    clearTimeout(detail.hideT);
    detail.hideT = setTimeout(() => hideDetail(), 220);
  }
  function hideDetail(now) {
    clearTimeout(detail.t);
    if (detail.el) { detail.el.remove(); detail.el = null; detail.cur = null; }
    if (now) clearTimeout(detail.hideT);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && detail.el) hideDetail(true); }, true);
  window.addEventListener('scroll', () => { if (detail.el) hideDetail(true); }, { passive: true, capture: true });

  const DETAIL_CSS = `
.dsp-detail { position: fixed; z-index: 35; width: 300px; padding: 16px; background: var(--s2); border-radius: var(--r-pop); box-shadow: var(--sh-pop);
  opacity: 0; transform: translateY(4px); transition: opacity 160ms var(--ease), transform 160ms var(--ease); }
.dsp-detail.dsp-in { opacity: 1; transform: none; }
.dd-head { display: flex; align-items: center; gap: 8px; }
.dd-main { font: 700 26px/30px var(--font); letter-spacing: -0.3px; }
.dd-dn { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; color: var(--t3); font-size: 12px; }
.dd-formula { margin-top: 4px; color: var(--t2); font-size: 12px; line-height: 18px; }
.dd-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; padding: 12px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.dd-k { color: var(--t3); font-size: 12px; line-height: 18px; }
.dd-v { font: 600 15px/22px var(--font); }
.dd-rates { display: flex; gap: 14px; margin-top: 10px; color: var(--t2); font-size: 12px; }
.dd-rates b, .dd-share b { color: var(--t1); font-weight: 600; }
.dd-share { margin-top: 6px; color: var(--t2); font-size: 12px; }
.dd-verdict { margin-top: 12px; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 18px; }
.v-high { color: var(--tier-high-text); background: var(--tier-high-soft); }
.v-mid { color: var(--tier-mid-text); background: var(--tier-mid-soft); }
.v-low { color: var(--tier-low-text); background: var(--tier-low-soft); }
.v-show { color: var(--tier-show-text); background: var(--tier-show-soft); }
.v-na { color: var(--t2); background: rgba(128,129,145,.12); }
.dd-actions { display: flex; gap: 8px; margin-top: 12px; }
.dd-btn { flex: 1; height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: var(--r-btn); background: var(--s3); font-weight: 600; }
.dd-btn:hover { background: #44465A; }
.dd-btn.on { color: var(--gold); }
.dd-btn.on svg { fill: var(--gold); }
.dd-btn.ghost { background: transparent; box-shadow: inset 0 0 0 1px var(--line2); font-weight: 500; color: var(--t2); }
.dd-btn.ghost:hover { color: var(--t1); background: var(--line); }
:host([data-theme="light"]) .dd-btn:hover { background: #DDDDE4; }
.dd-foot { margin-top: 10px; color: var(--t3); font-size: 11px; line-height: 16px; }
@media (prefers-reduced-motion: reduce) { .dsp-detail { transform: none !important; transition: opacity 80ms linear; } }
`;
  DSP.css = (DSP.css || '') + DETAIL_CSS;

  DSP.cards = { render, removeAll, prune, showDetail, scheduleHide, hideDetail, detail };
})();
