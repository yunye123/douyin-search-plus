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
    // 这条视频本身：收藏率 + 加入候选（连同评论区诊断和挑出的原评论一起存进候选）
    els.video = h('div', { class: 'cb-video' });
    box.appendChild(els.video);
    const top = h('div', { class: 'cb-top' });
    els.seg = h('div', { class: 'seg-ctl', role: 'group', 'aria-label': '评论排序' });
    for (const [k, label, tip] of [['', '默认', '抖音原本的顺序'], ['digg', '按赞', '点赞多的在前：大家最认同的说法'], ['replies', '按回复', '回复多的在前：卡点和争议通常在这里（选题 SOP 推荐）']]) {
      const b = h('button', { type: 'button', 'data-cmode': k || 'none', onclick: () => api.setMode(k || null) }, label);
      bindTip(b, () => ({ title: label, body: tip }), api.layer());
      els.seg.appendChild(b);
    }
    els.load = h('button', { class: 'btn sm', type: 'button', 'data-dsp': 'c-load', onclick: () => api.toggleLoad() }, icon('down', 14), els.loadText = h('span', null, '加载全部'));
    els.more = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': '复制或导出评论', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => api.openMore(els.more) }, icon('more', 16));
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

  function renderVideo(t, vm, api) {
    const { els } = t;
    const v = vm.video;
    const sig = v ? [v.id, v.cr, vm.isCand, vm.candHasComments].join('|') : 'none';
    if (t.videoSig === sig) return;
    t.videoSig = sig;
    clear(els.video);
    if (!v) {
      els.video.appendChild(h('span', { class: 'cb-vhint' }, '从搜索结果或博主主页点进这条视频，这里会显示它的收藏率，并能连同评论结论一起加入候选'));
      return;
    }
    const tier = DSP.metrics.crTier(v);
    els.video.append(
      h('span', { class: 'cb-vcr c-' + tier }, tier === 'na' ? '—' : DSP.util.fmtPct(v.cr)),
      h('span', { class: 'tier tier-' + tier }, DSP.metrics.tierLabel(v)),
      h('span', { class: 'cb-vmeta' }, '赞 ' + DSP.util.fmtNum(v.digg) + ' · 藏 ' + DSP.util.fmtNum(v.collect) + (v.dn ? ' · ' + DSP.metrics.fmtDn(v.dn) : '')),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm cb-cand' + (vm.isCand ? ' on' : ''), type: 'button', 'data-dsp': 'c-cand', onclick: () => api.addVideo() },
        icon('star', 14), vm.isCand ? (vm.candHasComments ? '更新评论结论' : '补上评论结论') : '加入候选'));
  }

  function render(t, vm, api) {
    const { els } = t;
    renderVideo(t, vm, api);
    for (const b of els.seg.children) {
      const on = (b.dataset.cmode === 'none' && !vm.mode) || b.dataset.cmode === vm.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const countText = vm.total ? '已读 ' + vm.loaded + ' / 共 ' + vm.total + ' 条' : '已读 ' + vm.loaded + ' 条';
    if (els.count.textContent !== countText) els.count.textContent = countText;
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
    // 高亮条只在内容变化时重建（每秒重建会把键盘焦点从"下一条"按钮上弄丢）
    const hlSig = (vm.highlight || '') + '|' + vm.hits + '|' + vm.cursor;
    if (t.hlSig === hlSig) return;
    t.hlSig = hlSig;
    const focusedCls = (() => { const a = els.hl.getRootNode().activeElement; return a && els.hl.contains(a) ? (a.getAttribute('aria-label') || a.textContent) : ''; })();
    clear(els.hl);
    els.hl.hidden = !vm.highlight;
    if (vm.highlight) {
      const label = (E.BARRIERS.find((b) => b.key === vm.highlight) || {}).label;
      DSP.kit.append(els.hl, [
        vm.hits ? h('span', null, '已高亮 ', h('b', null, String(vm.hits)), ' 条「' + label + '」') : h('span', null, '已读的评论里没人提到「' + label + '」'),
        vm.hits ? h('button', { class: 'icon-btn xs', type: 'button', 'aria-label': '上一条', onclick: () => api.jump(-1) }, icon('arrowUp', 14)) : null,
        vm.hits ? h('button', { class: 'icon-btn xs', type: 'button', 'aria-label': '下一条', onclick: () => api.jump(1) }, icon('arrowDown', 14)) : null,
        vm.hits ? h('span', { class: 'cb-pos' }, (vm.cursor + 1) + '/' + vm.hits) : null,
        h('span', { class: 'grow' }),
        vm.hits ? h('button', { class: 'link', type: 'button', onclick: (e) => api.copyHits(e.currentTarget) }, icon('copy', 14), '复制这 ' + vm.hits + ' 条') : null]);
      if (focusedCls) { const f = [...els.hl.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.textContent) === focusedCls); if (f) f.focus({ preventScroll: true }); }
    }
  }

  const CSS = `
.cbar { position: relative; margin: 0 0 8px; padding: 10px 10px 12px; border-radius: 14px; background: var(--s1); box-shadow: 0 0 0 1px var(--line);
  font: 13px/20px var(--font); color: var(--t1); font-variant-numeric: tabular-nums; }
:host([data-theme="light"]) .cbar { background: var(--s2); }
.cb-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cb-video { display: flex; align-items: center; gap: 8px; margin: -2px 0 10px; padding: 0 2px 10px; border-bottom: 1px solid var(--line); }
.cb-vcr { font: 700 18px/24px var(--font); }
.cb-vmeta { color: var(--t3); font-size: 12px; white-space: nowrap; }
.cb-vhint { color: var(--t3); font-size: 12px; line-height: 18px; }
.cb-cand svg { color: var(--gold); }
.cb-cand.on { color: var(--t1); background: rgba(255,197,61,.14); box-shadow: inset 0 0 0 1px rgba(255,197,61,.4); }
.cb-cand.on svg { fill: var(--gold); }
.cb-count { color: var(--t3); font-size: 12px; white-space: nowrap; }
.btn.sm { height: 28px; padding: 0 8px; font-size: 12px; gap: 4px; }
.btn.sm.on { background: var(--red-soft); color: var(--red-text); box-shadow: inset 0 0 0 1px var(--red-line); }
.icon-btn.xs { width: 24px; height: 24px; border-radius: 6px; }
.cb-h { display: flex; justify-content: space-between; align-items: baseline; margin: 10px 2px 6px; color: var(--t3); font: 600 12px/18px var(--font); }
.cb-note { font-weight: 400; color: var(--t3); }
.cb-tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
.cb-tile { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 52px; border-radius: 10px; background: var(--s2); color: var(--t2); font-size: 12px; line-height: 16px; transition: background 120ms; }
:host([data-theme="light"]) .cb-tile { background: var(--s1); box-shadow: inset 0 0 0 1px var(--line); }
.cb-tile:hover { background: var(--s3); }
.cb-n { font: 700 18px/22px var(--font); color: var(--t1); }
.cb-tile[data-barrier="cost"]:not(.zero) .cb-n, .cb-tile[data-barrier="access"]:not(.zero) .cb-n, .cb-tile[data-barrier="hard"]:not(.zero) .cb-n, .cb-tile[data-barrier="english"]:not(.zero) .cb-n { color: var(--tier-low-text); }
.cb-tile[data-barrier="ask"]:not(.zero) .cb-n { color: var(--cyan-text); }
.cb-tile.zero .cb-n { color: var(--t3); }
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
