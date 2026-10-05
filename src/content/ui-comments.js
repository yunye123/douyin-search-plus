// 评论区工具条：插在评论列表上方、在评论区里吸顶。
// 排序（默认 / 按赞 / 按回复）、加载全部、门槛词诊断（点一格高亮对应评论，可逐条跳转、复制原文）。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  const { h, icon, clear, bindTip } = DSP.kit;
  const E = DSP.exporter;

  function build(api) {
    const els = {};
    const box = h('div', { class: 'cbar', role: 'region', 'aria-label': '评论区工具' });
    const top = h('div', { class: 'cb-top' });
    els.seg = h('div', { class: 'seg-ctl', role: 'radiogroup', 'aria-label': '评论排序' });
    for (const [k, label, tip] of [['', '默认', '抖音原本的顺序'], ['digg', '按赞', '点赞多的在前：大家最认同的说法'], ['replies', '按回复', '回复多的在前：卡点和争议通常在这里（选题 SOP 推荐）']]) {
      const b = h('button', { type: 'button', role: 'radio', 'data-cmode': k || 'none', onclick: () => api.setMode(k || null) }, label);
      bindTip(b, () => ({ title: label, body: tip }), api.layer());
      els.seg.appendChild(b);
    }
    els.load = h('button', { class: 'btn sm', type: 'button', 'data-dsp': 'c-load', onclick: () => api.toggleLoad() }, icon('down', 14), els.loadText = h('span', null, '加载全部'));
    els.more = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': '复制或导出评论', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => api.openMore(els.more) }, icon('more', 16));
    top.append(els.seg, h('span', { class: 'grow' }), els.load, els.more);
    box.appendChild(top);

    els.count = h('span', { class: 'cb-count', role: 'status', 'aria-live': 'polite' });
    box.appendChild(h('div', { class: 'cb-h' }, h('span', null, '门槛词诊断'), h('span', { class: 'cb-note' }, els.count, els.diagNote = h('span'))));
    els.tiles = h('div', { class: 'cb-tiles', role: 'group', 'aria-label': '门槛词，点一格高亮对应评论' });
    for (const b of E.BARRIERS) {
      const t = h('button', { class: 'cb-tile', type: 'button', 'data-barrier': b.key, 'aria-pressed': 'false', onclick: () => api.setHighlight(b.key) },
        h('b', { class: 'cb-n' }, '0'), h('span', null, b.label));
      bindTip(t, () => ({ title: b.label, body: b.tip + '。点一下高亮这些评论，再点取消。只做计数，结论请看原文。' }), api.layer());
      els.tiles.appendChild(t);
    }
    box.appendChild(els.tiles);
    els.hl = h('div', { class: 'cb-hl', hidden: true });
    box.appendChild(els.hl);
    els.progress = h('div', { class: 'progress', 'aria-hidden': 'true' }, els.progressFill = h('i'));
    box.appendChild(els.progress);
    return { box, els };
  }

  function render(t, vm, api) {
    const { els } = t;
    for (const b of els.seg.children) {
      const on = (b.dataset.cmode === 'none' && !vm.mode) || b.dataset.cmode === vm.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    els.count.textContent = vm.total ? '已读 ' + vm.loaded + ' / 共 ' + vm.total + ' 条' : '已读 ' + vm.loaded + ' 条';
    els.loadText.textContent = vm.loading ? '停止' : vm.done ? '已读完' : '加载全部';
    els.load.disabled = !vm.loading && vm.done;
    els.load.classList.toggle('on', vm.loading);
    els.progressFill.style.width = vm.loading && vm.total ? Math.min(100, (vm.loaded / vm.total) * 100) + '%' : '0%';
    const stats = vm.stats || {};
    const hitTotal = Object.keys(stats).filter((k) => k !== 'ask').reduce((s, k) => s + stats[k], 0);
    els.diagNote.textContent = vm.loaded ? (hitTotal ? ' · ' + hitTotal + ' 次提到门槛' : ' · 没人提到门槛') : '';
    for (const tile of els.tiles.children) {
      const k = tile.dataset.barrier;
      tile.querySelector('.cb-n').textContent = String(stats[k] || 0);
      tile.classList.toggle('on', vm.highlight === k);
      tile.classList.toggle('zero', !stats[k]);
      tile.setAttribute('aria-pressed', vm.highlight === k ? 'true' : 'false');
    }
    clear(els.hl);
    els.hl.hidden = !vm.highlight;
    if (vm.highlight) {
      const label = (E.BARRIERS.find((b) => b.key === vm.highlight) || {}).label;
      els.hl.append(
        vm.hits ? h('span', null, '已高亮 ', h('b', null, String(vm.hits)), ' 条「' + label + '」') : h('span', null, '已读的评论里没人提到「' + label + '」'),
        vm.hits ? h('button', { class: 'icon-btn xs', type: 'button', 'aria-label': '上一条', onclick: () => api.jump(-1) }, icon('arrowUp', 14)) : null,
        vm.hits ? h('button', { class: 'icon-btn xs', type: 'button', 'aria-label': '下一条', onclick: () => api.jump(1) }, icon('arrowDown', 14)) : null,
        vm.hits ? h('span', { class: 'cb-pos' }, (vm.cursor + 1) + '/' + vm.hits) : null,
        h('span', { class: 'grow' }),
        vm.hits ? h('button', { class: 'link', type: 'button', onclick: (e) => api.copyHits(e.currentTarget) }, icon('copy', 14), '复制这 ' + vm.hits + ' 条') : null);
    }
  }

  const CSS = `
.cbar { position: relative; margin: 0 0 8px; padding: 10px 10px 12px; border-radius: 14px; background: var(--s1); box-shadow: 0 0 0 1px var(--line);
  font: 13px/20px var(--font); color: var(--t1); font-variant-numeric: tabular-nums; }
:host([data-theme="light"]) .cbar { background: var(--s2); }
.cb-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cb-count { color: var(--t3); font-size: 12px; white-space: nowrap; }
.btn.sm { height: 28px; padding: 0 8px; font-size: 12px; gap: 4px; }
.btn.sm.on { background: var(--red-soft); color: var(--red-text); box-shadow: inset 0 0 0 1px var(--red-line); }
.icon-btn.xs { width: 24px; height: 24px; border-radius: 6px; }
.cb-h { display: flex; justify-content: space-between; align-items: baseline; margin: 10px 2px 6px; color: var(--t3); font: 600 12px/18px var(--font); }
.cb-note { font-weight: 400; color: var(--t4); }
.cb-tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.cb-tile { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 52px; border-radius: 10px; background: var(--s2); color: var(--t2); font-size: 12px; line-height: 16px; transition: background 120ms; }
:host([data-theme="light"]) .cb-tile { background: var(--s1); box-shadow: inset 0 0 0 1px var(--line); }
.cb-tile:hover { background: var(--s3); }
.cb-n { font: 700 18px/22px var(--font); color: var(--t1); }
.cb-tile[data-barrier="cost"]:not(.zero) .cb-n, .cb-tile[data-barrier="access"]:not(.zero) .cb-n, .cb-tile[data-barrier="hard"]:not(.zero) .cb-n, .cb-tile[data-barrier="english"]:not(.zero) .cb-n { color: var(--tier-low-text); }
.cb-tile[data-barrier="ask"]:not(.zero) .cb-n { color: var(--cyan-text); }
.cb-tile.zero { opacity: .55; }
.cb-tile.on { background: var(--tier-low-soft); box-shadow: inset 0 0 0 1.5px var(--tier-low); opacity: 1; }
.cb-tile[data-barrier="ask"].on { background: var(--cyan-soft); box-shadow: inset 0 0 0 1.5px var(--cyan); }
.cb-hl { display: flex; align-items: center; gap: 4px; margin-top: 8px; padding: 4px 4px 4px 10px; border-radius: 10px; background: var(--s2); color: var(--t2); font-size: 12px; }
.cb-hl[hidden] { display: none; }
.cb-hl b { color: var(--t1); }
.cb-pos { color: var(--t3); min-width: 32px; }
.cbar .progress { left: 12px; right: 12px; }
`;
  DSP.css = (DSP.css || '') + CSS;

  // 评论行高亮/变淡的样式在 light DOM（评论行是抖音的节点），见 page.css
  DSP.commentBar = { build, render };
})();
