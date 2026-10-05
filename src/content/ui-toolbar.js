// 结果工具栏：插在抖音结果列表上方、随滚动吸顶。左边一句状态 + 收藏率分布条，右边少量按钮，
// 复杂选项都收进贴着按钮弹出的弹层（排序 / 达标线 / 更多）。
// 只负责"画"和"把用户操作转成意图"，状态与业务逻辑在 ui.js 里。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  const { h, icon, clear, logo, popover, closePop, bindTip } = DSP.kit;
  const U = DSP.util, M = DSP.metrics, P = DSP.presenter;

  const TIER_ORDER = ['high', 'mid', 'low', 'show', 'na'];
  const TIER_NAME = { high: '真需求', mid: '一般', low: '有门槛', show: '展示型', na: '样本少' };
  const TIER_RANGE = { high: '≥80%', mid: '40%~80%', low: '10%~40%', show: '<10%', na: '点赞<100' };

  // ---------------- 工具栏 ----------------
  function buildBar(api) {
    const els = {};
    const bar = h('div', { class: 'bar', role: 'toolbar', 'aria-label': '抖音搜索增强' });

    const status = h('div', { class: 'bar-status' });
    els.logo = h('span', { class: 'bar-logo' }, logo(22));
    els.text = h('span', { class: 'bar-text', role: 'status', 'aria-live': 'polite' });
    els.reset = h('button', { class: 'link', type: 'button', 'data-dsp': 'reset', onclick: () => api.resetView() }, icon('refresh', 14), '恢复原顺序');
    els.retry = h('button', { class: 'link', type: 'button', 'data-dsp': 'retry', onclick: () => api.retry() }, icon('refresh', 14), '重试');
    els.diag = h('button', { class: 'link', type: 'button', 'data-dsp': 'diag', onclick: () => api.copyDiagnostics(els.diag) }, icon('bug', 14), '复制诊断信息');
    status.append(els.logo, els.text, els.reset, els.retry, els.diag);

    // 收藏率分布条：点分段 = 只看这一档（再点取消）
    els.dist = h('div', { class: 'dist', role: 'group', 'aria-label': '收藏率分布，点一段只看这一档' });
    els.distBar = h('div', { class: 'dist-bar' });
    els.distLegend = h('div', { class: 'dist-legend' });
    els.dist.append(els.distBar, els.distLegend);

    const actions = h('div', { class: 'bar-actions' });
    els.sort = h('button', { class: 'btn', type: 'button', 'data-dsp': 'sort', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => api.openSort(els.sort) },
      icon('sort', 16), h('span', { class: 'btn-k' }, '排序'), els.sortVal = h('b', { class: 'btn-v' }), icon('chevron', 14, 'chev'));
    // "达标线"是用户自己设的筛选线；"门槛 / 有门槛"只保留选题 SOP 里的意思（内容太难、太贵、进不去）
    els.filter = h('button', { class: 'btn', type: 'button', 'data-dsp': 'filter', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => api.openFilter(els.filter) },
      icon('filter', 16), h('span', null, '达标线'), els.filterN = h('span', { class: 'count' }));
    els.loadIcon = h('span', { class: 'ic-slot' }, icon('loadMore', 16));
    els.load = h('button', { class: 'btn btn-load', type: 'button', 'data-dsp': 'load', onclick: () => api.toggleLoad() },
      els.loadIcon, els.loadText = h('span', { class: 'keep' }, '继续加载'));
    els.basket = h('button', { class: 'btn', type: 'button', 'data-dsp': 'basket', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => api.openBasket(els.basket) },
      icon('star', 16), h('span', null, '候选'), els.basketN = h('span', { class: 'count' }));
    els.more = h('button', { class: 'icon-btn', type: 'button', 'data-dsp': 'more', 'aria-label': '更多', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => api.openMore(els.more) }, icon('more', 18));
    actions.append(els.sort, els.filter, els.load, h('span', { class: 'sep', 'aria-hidden': 'true' }), els.basket, els.more);

    els.progress = h('div', { class: 'progress', 'aria-hidden': 'true' }, els.progressFill = h('i'));
    bar.append(status, els.dist, actions, els.progress);

    bindTip(els.sort, () => ({ title: '排序', body: '选一个看法重排结果：真需求、起飞中、热议，或任意指标的组合。' }), api.layer());
    bindTip(els.filter, () => ({ title: '达标线', body: '只看过线的结果，例如收藏率 ≥ 80%、近 30 天、赞 ≥ 1万。没过线的会变暗沉到最后，不会消失。' }), api.layer());
    bindTip(els.load, () => (api.loading()
      ? { title: '停止加载', body: '停在这里，已读到的都还在。' }
      : { title: '继续加载', body: '替你往下滚动，让抖音多加载一些结果（上限 ' + api.cap() + ' 条）。随机间隔，遇到登录或验证会立即停。' }), api.layer());
    bindTip(els.basket, () => ({ title: '候选篮', body: '卡片右上角点 ☆ 加入。攒好后一键复制入库包，粘贴给 Agent 说「添加选题」。' }), api.layer());

    // 方向键在控件间移动（roving 焦点）
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const items = [...bar.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
      const i = items.indexOf(e.composedPath()[0]);
      if (i < 0) return;
      e.preventDefault();
      items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length].focus();
    });
    return { bar, els };
  }

  // vm：ui.js 算好的界面状态
  function renderBar(t, vm) {
    const { els, bar } = t;
    bar.dataset.health = vm.health;
    bar.classList.toggle('is-active', vm.sorted || vm.filterCount > 0);
    bar.classList.toggle('is-loading', vm.loading);
    bar.classList.toggle('is-compact', vm.width < 1060);
    bar.classList.toggle('is-tight', vm.width < 880);
    // 状态句：内容变了才重写（这里是 live region，每秒重写会让读屏反复朗读同一句）
    const sig = vm.status.map((s) => s.tone + ':' + s.t).join('|');
    if (t.statusSig !== sig) {
      t.statusSig = sig;
      clear(els.text);
      vm.status.forEach((s, i) => {
        if (i) els.text.appendChild(h('span', { class: 'dot-sep', 'aria-hidden': 'true' }, '·'));
        els.text.appendChild(h('span', { class: s.tone ? 'tone-' + s.tone : '' }, s.t));
      });
    }
    const okish = vm.health === 'ok' || vm.health === 'partial';
    els.reset.hidden = !(okish && (vm.sorted || vm.filterCount > 0));
    els.retry.hidden = vm.health !== 'fail';
    els.diag.hidden = vm.health !== 'fail';
    els.dist.hidden = !okish || !vm.count;
    els.sort.disabled = !okish;
    els.filter.disabled = !okish;
    els.load.disabled = vm.health === 'recognizing' || vm.health === 'fail' || vm.type === 'video';
    // 排序按钮显示当前视角/指标
    els.sortVal.textContent = vm.sortShort || '';
    els.sort.classList.toggle('on', vm.sorted);
    els.filterN.textContent = vm.filterCount ? String(vm.filterCount) : '';
    els.filter.classList.toggle('on', vm.filterCount > 0);
    const loadText = vm.loading ? '停止 ' + vm.count + '/' + vm.cap : '继续加载';
    if (els.loadText.textContent !== loadText) els.loadText.textContent = loadText;
    els.load.classList.toggle('primary', !vm.loading && vm.count > 0 && vm.count < P.SAMPLE_LOW && okish);
    els.load.classList.toggle('on', vm.loading);
    if (els.loadIcon.dataset.k !== String(vm.loading)) { els.loadIcon.dataset.k = String(vm.loading); clear(els.loadIcon).appendChild(icon(vm.loading ? 'pause' : 'loadMore', 16)); }
    els.basketN.textContent = vm.candidates ? String(vm.candidates) : '';
    els.basket.classList.toggle('has', vm.candidates > 0);
    els.progressFill.style.width = vm.loading ? Math.min(100, (vm.count / Math.max(1, vm.cap)) * 100) + '%' : '0%';
    renderDist(t, els, vm);
  }

  // 分布条只在各档数量或选中档变化时重建（每秒重建会把键盘焦点从分段上弄丢）
  function renderDist(t, els, vm) {
    const c = vm.tiers || {};
    const total = TIER_ORDER.reduce((s, k) => s + (c[k] || 0), 0);
    const sig = TIER_ORDER.map((k) => c[k] || 0).join(',') + '|' + (vm.tierFilter || '');
    if (t.distSig === sig) return;
    t.distSig = sig;
    const root = els.distBar.getRootNode();
    const focusedTier = root.activeElement && root.activeElement.dataset ? root.activeElement.dataset.tier : '';
    clear(els.distBar);
    clear(els.distLegend);
    if (!total) return;
    for (const k of TIER_ORDER) {
      const n = c[k] || 0;
      if (!n) continue;
      const seg = h('button', {
        class: 'seg seg-' + k + (vm.tierFilter === k ? ' on' : ''), type: 'button', 'data-tier': k,
        style: { flexGrow: String(n) },
        'aria-pressed': vm.tierFilter === k ? 'true' : 'false',
        'aria-label': TIER_NAME[k] + ' ' + n + ' 条（' + TIER_RANGE[k] + '）',
        onclick: () => vm.onTier(k),
      });
      bindTip(seg, () => ({ title: TIER_NAME[k] + ' · ' + n + ' 条', body: '收藏率 ' + TIER_RANGE[k] + '。点一下只看这一档，再点取消。' }), vm.layer);
      els.distBar.appendChild(seg);
    }
    // 图例只列真需求和有门槛两个最常看的数（其余在悬停里）
    els.distLegend.append(
      h('span', { class: 'lg lg-high' }, h('i'), '真需求 ', h('b', null, String(c.high || 0))),
      h('span', { class: 'lg lg-low' }, h('i'), '有门槛 ', h('b', null, String(c.low || 0))),
    );
    if (focusedTier) { const f = els.distBar.querySelector('[data-tier="' + focusedTier + '"]'); if (f) f.focus({ preventScroll: true }); }
  }

  // ---------------- 排序弹层 ----------------
  const LENS_ICON = { need: 'star', ratio: 'layers', rising: 'arrowUp', talk: 'comment', top10: 'table' };
  function sortPanel(vm, api) {
    const panel = h('div', { class: 'pop-sort' });
    panel.appendChild(h('div', { class: 'pop-h' }, '选题看法'));
    const lensBox = h('div', { class: 'lens-list', role: 'group', 'aria-label': '选题看法' });
    for (const l of P.lensesFor(vm.type)) {
      const on = vm.lens === l.key;
      lensBox.appendChild(h('button', {
        class: 'lens' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', 'data-lens': l.key,
        'data-autofocus': on || (!vm.lens && l.key === 'need') ? '' : null,
        onclick: () => { api.applyLens(l.key); closePop(true); },
      },
      h('span', { class: 'lens-ic' }, icon(LENS_ICON[l.key] || 'sort', 16)),
      h('span', { class: 'lens-tx' }, h('b', null, l.label), h('span', null, l.desc)),
      on ? icon('check', 16, 'lens-ck') : null));
    }
    panel.appendChild(lensBox);

    // 自定义排序：单项指标 / 组合 / 方向，默认折叠（最常用的是上面几种看法）
    const open = vm.customOpen || (!vm.lens && vm.sortKeys.length > 0);
    const toggle = h('button', { class: 'custom-toggle', type: 'button', 'aria-expanded': open ? 'true' : 'false', 'data-dsp': 'custom', onclick: () => api.toggleCustom() },
      icon('chevron', 14, 'tg-ic'), h('b', null, '自定义排序'), h('span', { class: 'pop-hint' }, '任选指标、组合、方向'));
    panel.appendChild(h('div', { class: 'custom-row' }, toggle,
      h('button', { class: 'link', type: 'button', 'data-dsp': 'pop-reset', onclick: () => { api.resetView(); closePop(true); } }, icon('refresh', 14), '原顺序')));
    if (!open) {
      if (vm.lowSample) panel.appendChild(h('div', { class: 'pop-note' }, '点赞不足 100 的 ' + vm.lowSample + ' 条，比率波动太大，不参与比率排名，排在最后。'));
      return panel;
    }

    panel.appendChild(h('div', { class: 'pop-h' }, '单项指标', h('span', { class: 'pop-hint' }, vm.combo ? '依次点 2~3 项' : '点一下就排')));
    const grid = h('div', { class: 'metric-grid' });
    for (const k of ['digg', 'comment', 'collect', 'share', 'cr', 'sr', 'er', 'dpd']) {
      const m = M.METRICS[k];
      const idx = vm.sortKeys.indexOf(k);
      const on = idx >= 0;
      const b = h('button', {
        class: 'metric' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', 'data-metric': k,
        onclick: () => { api.toggleMetric(k); if (!vm.combo) closePop(true); else api.refreshPop(); },
      }, vm.combo && on ? h('span', { class: 'ord' }, '①②③'[idx] || String(idx + 1)) : null, h('span', null, m.label), m.formula ? h('span', { class: 'fx' }, m.formula.replace(/ /g, '')) : null);
      bindTip(b, () => ({ title: m.label, body: m.tip }), api.layer());
      grid.appendChild(b);
    }
    panel.appendChild(grid);

    const comboRow = h('label', { class: 'switch-row' },
      h('span', { class: 'sw-tx' }, h('b', null, '组合排序'), h('span', null, '各项名次相加，越小越靠前；同分按第一项。收藏 ① + 评论 ② 就是账号 Top10 口径')),
      h('input', { type: 'checkbox', class: 'sw', role: 'switch', checked: vm.combo ? '' : null, onchange: (e) => api.setCombo(e.target.checked) }));
    panel.appendChild(comboRow);
    if (vm.combo && vm.sortKeys.length > 1) {
      panel.appendChild(h('div', { class: 'formula' }, '综合名次 = ' + vm.sortKeys.map((k) => M.METRICS[k].label + '名次').join(' + ')));
    }
    const dir = h('div', { class: 'seg-ctl', role: 'group', 'aria-label': '方向' },
      h('button', { type: 'button', 'aria-pressed': !vm.asc ? 'true' : 'false', 'data-dir': 'desc', class: !vm.asc ? 'on' : '', onclick: () => api.setAsc(false) }, '高 → 低'),
      h('button', { type: 'button', 'aria-pressed': vm.asc ? 'true' : 'false', 'data-dir': 'asc', class: vm.asc ? 'on' : '', onclick: () => api.setAsc(true) }, '低 → 高'));
    panel.appendChild(h('div', { class: 'pop-foot' }, h('span', { class: 'pop-k' }, '方向'), dir));
    if (vm.lowSample) panel.appendChild(h('div', { class: 'pop-note' }, '点赞不足 100 的 ' + vm.lowSample + ' 条，比率波动太大，不参与比率排名，排在最后。'));
    return panel;
  }

  // ---------------- 达标线弹层 ----------------
  function filterPanel(vm, api) {
    const f = vm.filter;
    const panel = h('div', { class: 'pop-filter' });
    const head = h('div', { class: 'pf-head' },
      h('div', { class: 'pf-big' }, h('b', { class: 'pf-n' }, String(vm.passCount)), h('span', null, ' / ' + vm.count + ' 条过线')),
      h('div', { class: 'pf-meter' }, h('i', { style: { width: (vm.count ? (vm.passCount / vm.count) * 100 : 0) + '%' } })));
    panel.appendChild(head);
    panel.appendChild(h('div', { class: 'pop-h' }, '常用'));
    const quick = h('div', { class: 'quick' });
    for (const q of P.QUICK_FILTERS) {
      const on = q.on(f);
      quick.appendChild(h('button', { class: 'qchip' + (on ? ' on' : ''), type: 'button', 'aria-pressed': on ? 'true' : 'false', 'data-quick': q.key,
        'data-autofocus': q.key === 'cr80' ? '' : null,
        onclick: () => { api.patchFilter(q.patch(f)); api.refreshPop(); } }, on ? icon('check', 14) : null, q.label));
    }
    panel.appendChild(quick);
    panel.appendChild(h('div', { class: 'pop-h' }, '至少', h('span', { class: 'pop-hint' }, '可以写 1万、1.5w、2000')));
    for (const [k, label] of [['digg', '点赞'], ['collect', '收藏'], ['comment', '评论']]) {
      const hid = 'dsp-hint-' + k;
      const hint = h('span', { class: 'in-hint', id: hid, 'aria-live': 'polite' });
      const inp = h('input', { class: 'in', type: 'text', inputmode: 'decimal', placeholder: '不限', value: f.min[k] ? U.fmtNum(f.min[k]) : '', 'aria-label': label + '至少', 'aria-describedby': hid, 'data-min': k });
      let t = 0;
      const commit = () => {
        const n = P.parseCount(inp.value);
        if (Number.isNaN(n)) { hint.textContent = '看不懂这个数，可以写 1万、1.5w、2000'; hint.className = 'in-hint bad'; inp.setAttribute('aria-invalid', 'true'); return; }
        inp.removeAttribute('aria-invalid');
        hint.textContent = n >= 10000 ? '= ' + n.toLocaleString('zh-CN') : '';
        hint.className = 'in-hint';
        api.patchFilter({ min: Object.assign({}, api.filter().min, { [k]: n }) });
        api.updateFilterHead(panel);
      };
      inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(commit, 150); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); closePop(true); } });
      panel.appendChild(h('label', { class: 'in-row' }, h('span', { class: 'in-k' }, label), inp, hint));
    }
    panel.appendChild(h('div', { class: 'pop-foot' },
      h('button', { class: 'link', type: 'button', onclick: () => { api.clearFilter(); api.refreshPop(); } }, '清除达标线'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => closePop(true) }, '完成')));
    panel.appendChild(h('div', { class: 'pop-note' }, '没过线的结果会变暗、沉到最后，鼠标移上去可以看清，不会被删掉。'));
    return panel;
  }
  function updateFilterHead(panel, vm) {
    const n = panel.querySelector('.pf-n');
    if (n) n.textContent = String(vm.passCount);
    const i = panel.querySelector('.pf-meter i');
    if (i) i.style.width = (vm.count ? (vm.passCount / vm.count) * 100 : 0) + '%';
    const q = panel.querySelector('.pf-big span');
    if (q) q.textContent = ' / ' + vm.count + ' 条达标';
  }

  // ---------------- 更多菜单 ----------------
  function morePanel(vm, api) {
    const item = (ic, label, run, extra) => h('button', { class: 'mi', type: 'button', onclick: () => { closePop(true); run(); } }, icon(ic, 16), h('span', null, label), extra || null);
    const panel = h('div', { class: 'pop-more' });
    panel.append(
      item('copy', '复制当前结果（表格）', () => api.exportView('tsv'), h('span', { class: 'mi-k' }, vm.passCount + ' 条')),
      item('download', '下载当前结果 CSV', () => api.exportView('csv')),
      h('div', { class: 'mi-sep' }),
      item('layers', vm.badges ? '隐藏卡片上的收藏率' : '显示卡片上的收藏率', () => api.toggleBadges()),
      item('info', '看一遍新手引导', () => api.showGuide()),
      item('bug', '复制诊断信息', () => api.copyDiagnostics(api.anchor())),
      h('div', { class: 'mi-sep' }),
      item('power', '暂停插件（页面还原）', () => api.pause()),
      item('external', '使用说明与反馈', () => window.open('https://github.com/yunye123/douyin-search-plus#readme', '_blank', 'noopener')),
    );
    panel.appendChild(h('div', { class: 'mi-foot' }, '抖音搜索增强 v' + api.version() + ' · 非官方 · 数据只在本机'));
    return panel;
  }

  const CSS = `
.bar { position: relative; display: flex; align-items: center; gap: 12px; height: 48px; padding: 0 8px 0 12px; border-radius: var(--r-bar);
  background: var(--glass); backdrop-filter: blur(16px) saturate(150%); -webkit-backdrop-filter: blur(16px) saturate(150%); box-shadow: var(--sh-bar);
  font: 13px/20px var(--font); color: var(--t1); font-variant-numeric: tabular-nums; }
.bar-status { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; }
.bar-logo { display: inline-flex; }
.bar-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--t2); }
.bar-text .tone-em { color: var(--t1); font-weight: 600; }
.bar-text .tone-warn { color: var(--tier-low-text); font-weight: 600; }
.bar-text .tone-dim { color: var(--t3); }
.dot-sep { margin: 0 6px; color: var(--t4); }
.bar[data-health="recognizing"] .bar-text { color: var(--t3); }
.link { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 8px; border-radius: 8px; color: var(--t2); white-space: nowrap; flex: none; }
.link:hover { color: var(--t1); background: var(--line); }
.link[hidden], .dist[hidden] { display: none; }
.dist { flex: 0 1 230px; min-width: 120px; display: flex; flex-direction: column; gap: 4px; }
/* 分段：按钮本身是 24px 高的透明点击区（WCAG 2.5.8），8px 色条画在中间 */
.dist-bar { display: flex; gap: 2px; height: 24px; margin: -8px 0; }
.seg { position: relative; min-width: 24px; height: 24px; padding: 0; background: none; }
.seg::before { content: ""; position: absolute; left: 0; right: 0; top: 8px; height: 8px; border-radius: 2px; transition: transform 120ms, opacity 120ms; }
.seg:hover::before { transform: scaleY(1.4); }
.seg-high::before { background: var(--tier-high); } .seg-mid::before { background: var(--tier-mid); } .seg-low::before { background: var(--tier-low); } .seg-show::before { background: var(--tier-show); }
.seg-na::before { background: repeating-linear-gradient(135deg, #5A5B6C 0 3px, #3A3B4A 3px 6px); }
.dist-bar:has(.seg.on) .seg:not(.on)::before { opacity: .3; }
.seg.on::before { box-shadow: 0 0 0 1.5px var(--t1); }
.dist-legend { display: flex; gap: 12px; font-size: 11px; line-height: 14px; color: var(--t3); white-space: nowrap; }
.lg i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 4px; vertical-align: 1px; }
.lg b { color: var(--t1); font-weight: 600; }
.lg-high i { background: var(--tier-high); } .lg-high b { color: var(--tier-high-text); }
.lg-low i { background: var(--tier-low); }
.bar-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 10px; border-radius: var(--r-btn); color: var(--t1); white-space: nowrap; transition: background 120ms; }
.btn:hover:not(:disabled) { background: var(--line); }
.btn:disabled { color: var(--t4); cursor: default; }
.btn .btn-k { color: var(--t2); }
.btn .btn-v { font-weight: 600; }
.btn .btn-v:empty { display: none; }
.btn .chev { color: var(--t3); }
.btn.on { background: var(--red-soft); box-shadow: inset 0 0 0 1px var(--red-line); }
.btn.on .btn-k, .btn.on .btn-v, .btn.on svg { color: var(--red-text); }
.btn.on:hover { background: rgba(254, 44, 85, 0.22); }
.btn.primary { background: var(--red-solid); color: #fff; font-weight: 600; }
.btn.primary:hover { background: #F0254D; }
.count { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--s3); color: var(--t1); font: 600 11px/18px var(--font); text-align: center; }
.count:empty { display: none; }
.btn.on .count { background: var(--red-solid); color: #fff; }
.btn.has .count { background: var(--gold); color: #2A1E00; }
.btn.has svg { color: var(--gold); fill: var(--gold); }
.icon-btn { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-btn); color: var(--t2); }
.icon-btn:hover { background: var(--line); color: var(--t1); }
.sep { width: 1px; height: 20px; background: var(--line2); margin: 0 4px; }
.progress { position: absolute; left: 14px; right: 14px; bottom: 0; height: 2px; border-radius: 1px; overflow: hidden; pointer-events: none; }
.progress i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--red), var(--red) calc(100% - 3px), var(--cyan) 0); transition: width 400ms var(--ease); }
.bar.is-compact .dist-legend, .bar.is-compact .btn .btn-k { display: none; }
.bar.is-tight .dist { display: none; }
.bar.is-tight .btn > span:not(.count):not(.btn-v):not(.keep):not(.ic-slot) { display: none; }
.ic-slot { display: inline-flex; }
.bar.is-tight .btn { padding: 0 8px; }

/* 弹层通用 */
.pop-sort, .pop-filter { width: 340px; padding: 8px; }
.pop-more { width: 260px; padding: 6px; }
.pop-h { display: flex; align-items: baseline; justify-content: space-between; padding: 10px 10px 6px; color: var(--t3); font: 600 12px/18px var(--font); }
.pop-hint { font-weight: 400; color: var(--t3); }
.pop-foot { display: flex; align-items: center; gap: 8px; padding: 10px 6px 4px; margin-top: 6px; border-top: 1px solid var(--line); }
.pop-foot .link { margin-left: auto; }
.custom-row { display: flex; align-items: center; gap: 4px; margin: 6px 2px 0; padding-top: 6px; border-top: 1px solid var(--line); }
.custom-toggle { flex: 1; display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 8px; border-radius: 8px; text-align: left; }
.custom-toggle:hover { background: var(--line); }
.custom-toggle b { font-weight: 600; }
.custom-toggle .tg-ic { transform: rotate(-90deg); transition: transform 160ms var(--ease); color: var(--t3); }
.custom-toggle[aria-expanded="true"] .tg-ic { transform: none; }
.pop-k { color: var(--t3); font-size: 12px; }
.pop-note { margin: 6px 6px 2px; color: var(--t3); font-size: 12px; line-height: 18px; }
.lens-list { display: flex; flex-direction: column; gap: 2px; }
.lens { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 8px 10px; border-radius: 10px; text-align: left; }
.lens:hover { background: var(--line); }
.lens.on { background: var(--red-soft); }
.lens-ic { width: 30px; height: 30px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: var(--s3); color: var(--t2); flex: none; }
.lens.on .lens-ic { background: var(--red-solid); color: #fff; }
.lens-tx { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.lens-tx b { font: 600 14px/20px var(--font); }
.lens-tx span { color: var(--t2); font-size: 12px; line-height: 18px; }
.lens-ck { color: var(--red-text); }
.metric-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; padding: 0 2px; }
.metric { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 44px; border-radius: 8px; background: var(--s1); font-size: 13px; line-height: 18px; }
:host([data-theme="light"]) .metric { background: var(--s2); }
.metric:hover { background: var(--s3); }
.metric .fx { color: var(--t3); font-size: 10px; line-height: 14px; }
.metric.on { background: var(--red-soft); color: var(--red-text); box-shadow: inset 0 0 0 1px var(--red-line); font-weight: 600; }
.metric.on .fx { color: var(--red-text); opacity: .8; }
.ord { position: absolute; top: 3px; left: 5px; font-size: 11px; line-height: 12px; }
.switch-row { display: flex; align-items: center; gap: 12px; margin: 10px 2px 0; padding: 10px; border-radius: 10px; background: var(--s1); cursor: pointer; }
:host([data-theme="light"]) .switch-row { background: var(--s2); }
.sw-tx { display: flex; flex-direction: column; flex: 1; }
.sw-tx b { font-weight: 600; }
.sw-tx span { color: var(--t3); font-size: 12px; line-height: 18px; }
.sw { appearance: none; -webkit-appearance: none; width: 36px; height: 20px; border-radius: 10px; background: var(--s3); position: relative; cursor: pointer; flex: none; margin: 0; transition: background 120ms; }
.sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 160ms var(--ease); }
.sw:checked { background: var(--red-solid); }
.sw:checked::after { transform: translateX(16px); }
.formula { margin: 8px 6px 0; padding: 6px 10px; border-radius: 8px; background: var(--red-soft); color: var(--red-text); font-size: 12px; }
.seg-ctl { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--s1); }
:host([data-theme="light"]) .seg-ctl { background: var(--s2); }
.seg-ctl button { height: 28px; padding: 0 12px; border-radius: 6px; color: var(--t2); font-size: 12px; }
.seg-ctl button.on { background: var(--s3); color: var(--t1); font-weight: 600; }
.pf-head { padding: 8px 10px 4px; }
.pf-big { font-size: 13px; color: var(--t2); }
.pf-big b { font: 700 24px/28px var(--font); color: var(--t1); }
.pf-meter { height: 4px; border-radius: 2px; background: var(--s3); margin-top: 8px; overflow: hidden; }
.pf-meter i { display: block; height: 100%; background: var(--tier-high); transition: width 200ms var(--ease); }
.quick { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 6px; }
.qchip { display: inline-flex; align-items: center; gap: 4px; height: 30px; padding: 0 12px; border-radius: 15px; background: var(--s1); color: var(--t1); font-size: 13px; }
:host([data-theme="light"]) .qchip { background: var(--s2); }
.qchip:hover { background: var(--s3); }
.qchip.on { background: var(--tier-high-soft); color: var(--tier-high-text); box-shadow: inset 0 0 0 1px rgba(37,244,238,.4); font-weight: 600; }
.in-row { display: flex; align-items: center; gap: 10px; padding: 4px 6px; }
.in-k { width: 40px; color: var(--t2); flex: none; }
.in { width: 120px; height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line2); background: var(--bg); color: var(--t1); font: 13px var(--font); outline: none; }
.in:focus { border-color: var(--cyan); }
.in-hint { color: var(--t3); font-size: 12px; }
.in-hint.bad { color: var(--tier-low-text); }
.mi { display: flex; align-items: center; gap: 10px; width: 100%; height: 36px; padding: 0 10px; border-radius: 8px; text-align: left; color: var(--t1); }
.mi:hover, .mi:focus-visible { background: var(--line); }
.mi svg { color: var(--t2); }
.mi span:first-of-type { flex: 1; }
.mi-k { color: var(--t3); font-size: 12px; }
.mi-sep { height: 1px; background: var(--line); margin: 4px 6px; }
.mi-foot { padding: 8px 10px 4px; color: var(--t3); font-size: 11px; line-height: 16px; }
`;
  DSP.css = (DSP.css || '') + CSS;

  DSP.toolbar = { buildBar, renderBar, sortPanel, filterPanel, updateFilterHead, morePanel, popover, closePop, TIER_NAME };
})();
