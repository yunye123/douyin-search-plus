// 界面总控：把 store 的状态变成页面上的界面，把用户操作变成 store 的意图。
//   · 工具栏（#dsp-dock，插在结果列表上方、吸顶）
//   · 原地重排 + 卡片角标（inplace.js / ui-cards.js）
//   · 弹层、候选篮、详情卡、轻提示、引导、启动器（#dsp-root，固定层，挂在 <html> 上，不在抖音的 React 树里）
//   · 评论区工具条（#dsp-cbar）
// 调度：store 事件 / 列表 DOM 变化 / 低频看门狗 → requestAnimationFrame 合批 → update()
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  const { store, util: U, metrics: M, presenter: P, exporter: E, adapters: A, kit, cards: C, toolbar: T, basket: B, commentBar: CB, comments: CE, inplace: IP, loader: L } = DSP;
  const { h, icon, clear, host, popover, closePop, isOpen, toast, bindTip } = kit;
  const S = store.S;

  const ui = {
    root: null, layer: null,      // 固定层
    dock: null, bar: null,        // 工具栏
    cbar: null, cb: null,         // 评论工具条
    launcher: null, coach: null,
    listEl: null, strategy: '',
    routeAt: Date.now(),
    combo: false,
    pop: null,                    // 当前打开的弹层 { kind, anchor, panel }
    rendered: '',
    paused: false,
    stale: false,
    lastHealth: '',
    observer: null, observed: null,
    commentCursor: 0,
  };
  DSP.ui = ui;

  const version = () => { try { return chrome.runtime.getManifest().version; } catch (e) { return ''; } };

  // ---------------- 调度 ----------------
  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; U.trap('ui.update', update); });
  }
  ui.schedule = schedule;

  function mount() {
    const r = host('dsp-root', document.documentElement);
    ui.root = r;
    ui.layer = r.root.querySelector('.dsp-layer') || r.root.appendChild(h('div', { class: 'dsp-layer' }));
    r.el.dataset.theme = A.pageTheme();
    for (const ev of ['data', 'view', 'candidates', 'settings', 'comments', 'session']) store.on(ev, schedule);
    store.on('route', () => { ui.routeAt = Date.now(); stopLoaders('route'); closePop(); C.hideDetail(true); CE.state.mode = null; CE.state.highlight = null; schedule(); });
    store.on('settings', (p) => { if (p && p.enabledChanged) applyEnabled(); });
    setInterval(() => U.trap('ui.watch', watchdog), 1000);
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'D' || e.key === 'd') && ui.bar) { e.preventDefault(); ui.bar.els.sort.focus(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopLoaders('hidden'); });
    if (!S.settings.enabled) applyEnabled();
    schedule();
  }
  ui.mount = mount;

  function watchdog() {
    // 插件在扩展管理页被重载后，这个页面里的脚本已和扩展断开
    if (!ui.stale && DSP.alive && !DSP.alive()) { ui.stale = true; stopLoaders('route'); teardownPage(); schedule(); return; }
    const theme = A.pageTheme();
    for (const x of [ui.root && ui.root.el, ui.dock && ui.dock.el, ui.cbar && ui.cbar.el]) if (x && x.dataset.theme !== theme) x.dataset.theme = theme;
    schedule();
  }

  // ---------------- 总开关 ----------------
  function applyEnabled() {
    if (!S.settings.enabled) {
      ui.paused = true;
      stopLoaders('user');
      teardownPage();
      try { document.documentElement.dataset.dspOff = '1'; } catch (e) { /* 忽略 */ }
    } else {
      ui.paused = false;
      delete document.documentElement.dataset.dspOff;
      if (DSP.requestRescan) DSP.requestRescan();
    }
    schedule();
  }
  function teardownPage() {
    IP.restore();
    CE.restore();
    C.removeAll();
    C.hideDetail(true);
    closePop();
    if (ui.dock) { ui.dock.el.remove(); ui.dock = null; ui.bar = null; }
    if (ui.cbar) { ui.cbar.el.remove(); ui.cbar = null; ui.cb = null; }
    if (ui.observer) { ui.observer.disconnect(); ui.observed = null; }
    hideCoach();
  }
  function setEnabled(on) {
    store.saveSettings({ enabled: on });
    applyEnabled();
  }

  // ---------------- 自动加载 ----------------
  const isProfile = () => S.route.type === 'profile';
  const capFor = () => (isProfile() ? Math.min(600, (S.settings.loadCap || 100) * 3) : (S.settings.loadCap || 100));
  const listLoader = L.create({
    count: () => (isProfile() && ui.listEl ? A.cardsOf(ui.listEl).length : S.videos.size),
    cap: capFor,
    blocked: () => A.blockingReason(),
    hasMore: () => { const m = DSP.meta[isProfile() ? 'profile' : 'search']; return m ? m.hasMore : undefined; },
    scroll: (round) => { const cards = ui.listEl ? A.cardsOf(ui.listEl) : []; L.scrollToEnd(cards.length ? cards[cards.length - 1].el : null, round); },
    onChange: (st) => { schedule(); if (!st.running && st.reason && st.reason !== 'route') announce(st.message(), st.reason === 'login' || st.reason === 'captcha' || st.reason === 'stalled' ? 'warn' : ''); },
  });
  const commentLoader = L.create({
    count: () => A.commentRows().length,
    cap: () => 500,
    blocked: () => A.blockingReason(),
    hasMore: () => (DSP.meta.comments ? DSP.meta.comments.hasMore : undefined),
    scroll: () => { const list = A.commentList(); const sc = list && A.scrollerOf(list); if (sc) sc.scrollTop = sc.scrollHeight; else window.scrollTo(0, document.documentElement.scrollHeight); },
    onChange: (st) => { schedule(); if (!st.running && st.reason && st.reason !== 'route') announce(st.reason === 'end' || st.reason === 'cap' ? '评论读完了，共 ' + A.commentRows().length + ' 条' : st.message(), st.reason === 'login' || st.reason === 'captcha' ? 'warn' : ''); },
    delay: [1200, 2600],
  });
  function stopLoaders(reason) { listLoader.stop(reason); commentLoader.stop(reason); }

  // ---------------- 提示 ----------------
  function announce(msg, tone, action) {
    if (!msg) return;
    toast(ui.layer, msg, { tone, action, anchor: ui.bar && ui.dock && ui.dock.el.isConnected && inView(ui.dock.el) ? ui.bar.bar : null });
  }
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; };

  // ---------------- 主更新 ----------------
  function update() {
    if (!ui.root) return;
    if (ui.stale) return renderLauncher('stale');
    if (ui.paused) return renderLauncher('paused');
    const type = S.route.type;
    let listState = null;
    if (type === 'search' || type === 'profile') listState = updateList(type);
    else { removeDock(); }
    updateComments();
    renderLauncher(listState && !listState.docked ? listState.health : null);
    maybeCoach(listState);
  }

  function removeDock() {
    if (ui.dock) { ui.dock.el.remove(); ui.dock = null; ui.bar = null; }
    if (IP.S.applied) IP.restore();
    C.removeAll();
    ui.listEl = null;
  }

  function observe(el) {
    if (ui.observed === el) return;
    if (ui.observer) ui.observer.disconnect();
    ui.observer = new MutationObserver(() => schedule());
    ui.observer.observe(el, { childList: true });
    ui.observed = el;
  }

  function updateList(type) {
    const located = A.locateList(type);
    ui.listEl = located ? located.el : null;
    ui.strategy = located ? located.strategy : '';
    const cards = located ? A.cardsOf(located.el) : [];
    const blocked = A.blockingReason();
    const health = P.health({ type, count: S.videos.size, located: !!(located && cards.length), sinceRouteMs: Date.now() - ui.routeAt, blocked: listLoader.running ? null : blocked });
    // 主页以页面上实际显示的作品为准；搜索页用整个会话（列表可能有虚拟滚动）
    const ids = type === 'profile' && cards.length ? cards.map((c) => c.id) : null;
    const view = store.viewOf(ids);
    const d = store.derived();
    const base = ids ? ids.map((id) => d.byId.get(id)).filter(Boolean) : d.list;
    const tiers = P.tierCounts(base);
    const sorted = S.view.sortKeys.length > 0;
    const active = S.view.active;

    // 工具栏挂载：列表的前一个兄弟节点；找不到列表时不挂（交给启动器显示状态）
    let docked = false;
    if (located) {
      ui.dock = host('dsp-dock', located.el.parentElement, located.el);
      if (!ui.bar || !ui.bar.bar.isConnected) {
        ui.bar = T.buildBar(barApi);
        const lay = ui.dock.root.querySelector('.dsp-layer') || ui.dock.root.appendChild(h('div', { class: 'dsp-layer' }));
        clear(lay).appendChild(ui.bar.bar);
      }
      ui.dock.el.style.top = (A.headerBottom() + 8) + 'px';
      ui.dock.el.dataset.theme = A.pageTheme();
      docked = true;
      observe(located.el);
    } else if (ui.dock) {
      ui.dock.el.remove(); ui.dock = null; ui.bar = null;
    }

    // 原地重排 / 还原
    if (located && cards.length && active && IP.supports(located.el, cards)) {
      IP.apply(located.el, cards, { order: view.sorted.map((x) => x.v.id), dim: new Set(view.rest.map((v) => v.id)) });
    } else if (IP.S.applied && (!active || !located)) {
      IP.restore();
    }

    // 卡片角标
    if (located && S.settings.badges) {
      const rank = new Map();
      if (sorted) view.sorted.forEach((x, i) => rank.set(x.v.id, i + 1));
      const likes = type === 'profile' ? (S.profileStats || (S.profileStats = A.profileStats())) : null;
      for (const card of cards) {
        const v = d.byId.get(card.id);
        if (!v) continue;
        C.render(card, {
          v, rank: rank.get(card.id) || 0, isCand: S.candidates.has(card.id),
          onToggleCand: (id, btn) => toggleCandidate(id, btn),
          onDetail: (vv, anchor, immediate) => C.showDetail(ui.layer, vv, anchor, {
            isCand: S.candidates.has(vv.id), cardEl: card.el, focus: immediate,
            share: likes && likes.likes ? vv.digg / likes.likes : null,
            onToggleCand: (id, b) => { toggleCandidate(id, b); C.hideDetail(true); },
            onCopyLink: (x) => copy(E.videoUrl(x), '链接已复制'),
          }, immediate),
          onLeave: () => C.scheduleHide(),
        });
      }
      C.prune();
    } else if (!S.settings.badges) {
      C.removeAll();
    }

    // 工具栏内容
    if (ui.bar) {
      const lens = P.matchLens(S.view);
      const passCount = active ? view.sorted.length : base.length;
      // 选题看法自带的条件（例如真需求 = 收藏率≥80% + 只看视频）不算"用户设的门槛"，门槛按钮只数额外加的
      const filterCount = Math.max(0, M.activeFilterCount(S.view.filter) - (lens && lens.filter ? M.activeFilterCount(lens.filter) : 0));
      const vm = {
        type, health, blocked, count: ids ? base.length : S.videos.size,
        width: ui.dock.el.getBoundingClientRect().width,
        sorted, filterCount,
        loading: listLoader.running, cap: capFor(),
        candidates: S.candidates.size,
        tiers, tierFilter: S.view.filter.tier, layer: ui.layer,
        onTier: (k) => { store.setFilter(Object.assign({}, S.view.filter, { tier: S.view.filter.tier === k ? '' : k })); },
        sortShort: lens ? lens.label : sorted ? S.view.sortKeys.map((k) => M.METRICS[k].label).join('+') + (S.view.asc ? ' ↑' : '') : '',
      };
      vm.status = P.statusLine({
        health, blocked, count: vm.count, strongNeed: tiers.high, sorted: active,
        sortText: lens ? '按「' + lens.label + '」排序' : sorted ? P.sortText(S.view.sortKeys, S.view.asc) : '门槛：' + P.filterText(S.view.filter),
        shown: passCount, loading: vm.loading, cap: vm.cap,
      });
      if (active && passCount === 0 && vm.count) vm.status = [{ t: '没有结果达到门槛', tone: 'warn' }, { t: P.filterText(S.view.filter) || '', tone: 'dim' }];
      T.renderBar(ui.bar, vm);
      ui.vm = Object.assign(vm, { passCount, view, base, lens });
    }
    if (health !== ui.lastHealth) { ui.lastHealth = health; }
    return { health, docked, count: S.videos.size };
  }

  // ---------------- 启动器（找不到挂载点 / 暂停 / 插件已更新） ----------------
  function renderLauncher(state) {
    // state：null（不需要）| 'recognizing' | 'fail' | 'blocked' | 'paused' | 'stale'
    const need = state && (state === 'paused' || state === 'stale' || ((S.route.type === 'search' || S.route.type === 'profile') && state !== 'ok' && state !== 'partial'));
    if (!need) { if (ui.launcher) { ui.launcher.remove(); ui.launcher = null; } return; }
    const text = {
      recognizing: ['正在读取结果…', ''],
      fail: ['读不到结果：抖音页面可能刚更新', '复制诊断信息'],
      blocked: ['抖音要求登录或验证，处理后会自动恢复', ''],
      paused: ['插件已暂停 · 点击恢复', ''],
      stale: ['插件已更新，请刷新页面', '刷新'],
    }[state] || ['', ''];
    const sig = state + '|' + text[0];
    if (ui.launcher && ui.launcher.dataset.sig === sig) return;
    if (ui.launcher) ui.launcher.remove();
    const btn = h('button', { class: 'launcher l-' + state, type: 'button', 'data-dsp': 'launcher',
      onclick: () => {
        if (state === 'paused') { setEnabled(true); announce('插件已恢复'); }
        else if (state === 'stale') location.reload();
        else if (state === 'fail') copyDiagnostics(btn);
      } },
    kit.logo(26), h('span', { class: 'l-tx' }, h('b', null, text[0]), text[1] ? h('span', null, text[1]) : null));
    btn.dataset.sig = sig;
    ui.launcher = btn;
    ui.layer.appendChild(btn);
  }

  // ---------------- 评论区 ----------------
  function updateComments() {
    const list = A.commentList();
    if (!list) {
      if (ui.cbar) { ui.cbar.el.remove(); ui.cbar = null; ui.cb = null; }
      if (CE.state.applied) CE.restore();
      return;
    }
    ui.cbar = host('dsp-cbar', list.parentElement, list);
    ui.cbar.el.dataset.theme = A.pageTheme();
    if (!ui.cb || !ui.cb.box.isConnected) {
      ui.cb = CB.build(commentApi);
      const lay = ui.cbar.root.querySelector('.dsp-layer') || ui.cbar.root.appendChild(h('div', { class: 'dsp-layer' }));
      clear(lay).appendChild(ui.cb.box);
    }
    const rows = A.commentRows(list);
    if (CE.state.mode || CE.state.highlight) {
      const sig = rows.length + '|' + S.comments.version + '|' + CE.state.mode + '|' + CE.state.highlight;
      if (sig !== ui.commentSig) { ui.commentSig = sig; ui.commentHits = CE.apply().hits || 0; }
    }
    const all = [...S.comments.map.values()];
    const stats = E.barrierStats(all.length ? all : rows.map((r) => ({ text: r.item.textContent })));
    const m = DSP.meta.comments;
    CB.render(ui.cb, {
      mode: CE.state.mode, highlight: CE.state.highlight, hits: ui.commentHits || 0, cursor: ui.commentCursor,
      loaded: Math.max(rows.length, S.comments.map.size), total: S.comments.total,
      loading: commentLoader.running, done: !!(m && m.hasMore === false && !commentLoader.running && rows.length >= S.comments.map.size),
      stats,
    }, commentApi);
  }

  const commentApi = {
    layer: () => ui.layer,
    setMode: (m) => { CE.setMode(m); ui.commentSig = ''; schedule(); },
    setHighlight: (k) => { CE.setHighlight(CE.state.highlight === k ? null : k); ui.commentSig = ''; ui.commentCursor = 0; schedule(); },
    toggleLoad: () => { if (commentLoader.running) commentLoader.stop('user'); else commentLoader.start(); },
    jump: (dir) => {
      const hits = [...document.querySelectorAll('.dsp-c-hit')].sort((a, b) => (+a.style.order || 0) - (+b.style.order || 0) || (a.compareDocumentPosition(b) & 4 ? -1 : 1));
      if (!hits.length) return;
      ui.commentCursor = (ui.commentCursor + dir + hits.length) % hits.length;
      const el = hits[ui.commentCursor];
      el.scrollIntoView({ block: 'center', behavior: kit.reducedMotion() ? 'auto' : 'smooth' });
      el.classList.remove('dsp-c-focus'); void el.offsetWidth; el.classList.add('dsp-c-focus');
      schedule();
    },
    copyHits: (btn) => {
      const k = CE.state.highlight;
      const list = CE.collected().filter((c) => E.barrierHits(c.text).includes(k));
      copy(E.commentsText(list), '已复制 ' + list.length + ' 条原评论（一字未改）', btn);
    },
    openMore: (anchor) => {
      const item = (ic, label, run) => h('button', { class: 'mi', type: 'button', role: 'menuitem', onclick: () => { closePop(true); run(); } }, icon(ic, 16), h('span', null, label));
      const panel = h('div', { class: 'pop-more', role: 'menu' },
        item('copy', '复制前 20 条原评论（按当前排序）', () => { const l = CE.collected().slice(0, 20); copy(E.commentsText(l), '已复制 ' + l.length + ' 条原评论'); }),
        item('download', '下载全部评论 CSV', () => {
          const l = CE.collected();
          if (!l.length) return announce('还没读到评论数据，先往下滚一点', 'warn');
          E.download(E.safeName('抖音评论_' + (S.route.awemeId || S.route.modalId || '') + '_' + U.fmtDate(Date.now() / 1000)) + '.csv', E.commentsCsv(l));
          announce('已下载 ' + l.length + ' 条评论（不含昵称和 IP 属地）');
        }),
        h('div', { class: 'mi-foot' }, '导出默认不含评论者昵称和 IP 属地'));
      popover(anchor, panel, { layer: ui.layer, role: 'menu', label: '评论导出', placement: 'below-end' });
    },
  };

  // ---------------- 工具栏的操作 ----------------
  const barApi = {
    layer: () => ui.layer,
    anchor: () => ui.bar && ui.bar.els.more,
    version,
    loading: () => listLoader.running,
    cap: capFor,
    resetView: () => { store.resetView(); announce('已恢复抖音原来的顺序'); },
    retry: () => { ui.routeAt = Date.now(); if (DSP.requestRescan) DSP.requestRescan(); schedule(); },
    copyDiagnostics: (btn) => copyDiagnostics(btn),
    toggleLoad: () => {
      if (listLoader.running) { listLoader.stop('user'); return; }
      const blocked = A.blockingReason();
      if (blocked) return announce(L.REASONS[blocked === 'captcha' ? 'captcha' : 'login'](S.videos.size), 'warn');
      if (S.videos.size >= capFor()) return announce('已达到加载上限 ' + capFor() + ' 条，可以在插件弹窗里调高', 'warn');
      listLoader.start();
    },
    openSort: (anchor) => openPanel('sort', anchor),
    openFilter: (anchor) => openPanel('filter', anchor),
    openMore: (anchor) => openPanel('more', anchor),
    openBasket: (anchor) => openPanel('basket', anchor),
    refreshPop: () => { if (ui.pop) reopen(); },
    applyLens: (key) => {
      const l = P.LENSES.find((x) => x.key === key);
      if (!l) return;
      ui.combo = l.sort.length > 1;
      store.setFilter(l.filter || {});
      store.setSort(l.sort, false);
      announce('已按「' + l.label + '」排好：' + l.desc);
    },
    toggleMetric: (k) => {
      let keys = S.view.sortKeys.slice();
      if (!ui.combo) keys = keys.length === 1 && keys[0] === k ? [] : [k];
      else {
        const i = keys.indexOf(k);
        if (i >= 0) keys.splice(i, 1);
        else if (keys.length < 3) keys.push(k);
        else return announce('组合排序最多选 3 项', 'warn');
      }
      store.setSort(keys);
    },
    setCombo: (on) => { ui.combo = on; if (!on && S.view.sortKeys.length > 1) store.setSort(S.view.sortKeys.slice(0, 1)); reopen(); },
    setAsc: (asc) => { store.setSort(S.view.sortKeys.length ? S.view.sortKeys : ['collect'], asc); reopen(); },
    filter: () => S.view.filter,
    patchFilter: (p) => store.setFilter(Object.assign({}, S.view.filter, p)),
    clearFilter: () => store.setFilter({}),
    updateFilterHead: (panel) => { update(); T.updateFilterHead(panel, ui.vm || { passCount: 0, count: 0 }); },
    exportView: (fmt) => {
      const list = ui.vm ? (S.view.active ? ui.vm.view.sorted.map((x) => x.v) : ui.vm.base) : [];
      if (!list.length) return announce('还没有可导出的结果', 'warn');
      if (fmt === 'csv') { E.download(E.safeName('抖音_' + (S.sessionLabel || '结果')) + '_' + U.fmtDate(Date.now() / 1000) + '.csv', E.toCsv(list)); announce('已下载 ' + list.length + ' 条'); }
      else copy(E.toTsv(list), '已复制 ' + list.length + ' 条，可以直接粘贴到飞书或 Excel');
    },
    toggleBadges: () => { store.saveSettings({ badges: !S.settings.badges }); },
    showGuide: () => { store.saveSettings({ guideDone: false }); ui.coachShown = false; schedule(); },
    pause: () => {
      setEnabled(false);
      announce('插件已暂停，抖音页面已还原', '', { label: '撤销', run: () => setEnabled(true) });
    },
  };

  function openPanel(kind, anchor) {
    if (ui.pop && ui.pop.kind === kind && isOpen(ui.pop.panel)) { closePop(true); ui.pop = null; return; }
    C.hideDetail(true);
    if (ui.coach) { store.saveSettings({ guideDone: true }); hideCoach(); } // 已经开始用了，引导收起
    const vm = popVm();
    let panel, opts = { layer: ui.layer, onClose: () => { if (ui.pop && ui.pop.panel === panel) ui.pop = null; } };
    if (kind === 'sort') { panel = T.sortPanel(vm, barApi); opts.label = '排序'; }
    else if (kind === 'filter') { panel = T.filterPanel(vm, barApi); opts.label = '门槛'; }
    else if (kind === 'more') { panel = T.morePanel(vm, barApi); opts.label = '更多'; opts.role = 'menu'; opts.placement = 'below-end'; }
    else if (kind === 'basket') { panel = B.panel(basketApi); opts.label = '候选篮'; opts.placement = 'none'; }
    if (kind === 'sort' || kind === 'filter') opts.placement = 'below-end';
    popover(anchor, panel, opts);
    ui.pop = { kind, anchor, panel };
  }
  function reopen() {
    if (!ui.pop) return;
    const { kind, anchor, panel } = ui.pop;
    const scroll = panel.scrollTop;
    closePop(false);
    ui.pop = null;
    update();
    openPanel(kind, anchor);
    if (ui.pop) ui.pop.panel.scrollTop = scroll;
  }
  function popVm() {
    const v = ui.vm || {};
    return {
      type: S.route.type, lens: v.lens ? v.lens.key : '', sortKeys: S.view.sortKeys, asc: S.view.asc, combo: ui.combo,
      filter: S.view.filter, passCount: v.passCount || 0, count: v.count || 0, badges: S.settings.badges,
      lowSample: (v.tiers && v.tiers.na) || 0,
    };
  }

  // ---------------- 候选篮 ----------------
  function toggleCandidate(id, btn) {
    if (S.candidates.has(id)) {
      const keep = S.candidates.get(id);
      store.removeCandidate(id);
      announce('已移出候选篮', '', { label: '撤销', run: () => store.restoreCandidates([[id, keep]]) });
    } else if (store.addCandidate(id)) {
      announce('已加入候选篮 · 共 ' + S.candidates.size + ' 条', '', { label: '撤销', run: () => store.removeCandidate(id) });
    }
    schedule();
  }
  const basketApi = {
    candidates: () => store.candidateList(),
    removeCandidate: (id) => { store.removeCandidate(id); reopen(); },
    clearCandidates: () => {
      const backup = [...S.candidates.entries()];
      store.clearCandidates();
      reopen();
      announce('候选篮已清空', '', { label: '撤销', run: () => store.restoreCandidates(backup) });
    },
    markdown: () => E.toMarkdown(store.candidateList(), { now: Date.now() / 1000 }),
    copy: (fmt, btn) => {
      const list = store.candidateList();
      const text = fmt === 'md' ? E.toMarkdown(list, { now: Date.now() / 1000 }) : fmt === 'json' ? E.toJson(list, { now: Date.now() / 1000 }) : E.toTsv(list);
      copy(text, fmt === 'md' ? '入库包已复制：粘贴给 Agent，说「添加选题」' : fmt === 'json' ? '已复制 JSON' : '已复制，可以直接粘贴到飞书或 Excel', btn);
    },
    downloadCsv: () => { const list = store.candidateList(); E.download('选题候选_' + U.fmtDate(Date.now() / 1000) + '.csv', E.toCsv(list)); announce('已下载 ' + list.length + ' 条'); },
  };

  async function copy(text, msg, btn) {
    const ok = await E.copyText(text);
    announce(ok ? msg : '复制失败：浏览器没有给剪贴板权限，可以改用下载', ok ? '' : 'warn');
    if (ok && btn && btn.animate && !kit.reducedMotion()) btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(.96)' }, { transform: 'scale(1)' }], { duration: 180 });
  }

  function copyDiagnostics(btn) {
    const type = S.route.type === 'profile' ? 'profile' : 'search';
    const report = Object.assign({ version: version(), ua: navigator.userAgent.replace(/\s+/g, ' ').slice(0, 160), time: new Date().toISOString(), count: S.videos.size, bridge: DSP.meta.bridgeSeen, meta: { search: DSP.meta.search, profile: DSP.meta.profile } }, A.diagnose(type));
    copy('DouyinSearchPlus 诊断信息（不含任何内容和账号信息）\n' + JSON.stringify(report, null, 2), '诊断信息已复制，可以粘贴到 GitHub issue 或发给 Claude', btn);
  }

  // ---------------- 首次引导 ----------------
  function maybeCoach(listState) {
    if (S.settings.guideDone || ui.coachShown || !ui.bar || !listState || listState.health !== 'ok' || !inView(ui.dock.el)) return;
    ui.coachShown = true;
    const r = ui.bar.bar.getBoundingClientRect();
    const steps = [
      ['继续加载', '抖音一次只给 20 条，先多读一些，排名才靠谱'],
      ['排序 → 真需求', '收藏率 ≥ 80% 的视频按收藏数排好，一眼看到值得做的'],
      ['☆ 候选 → 复制入库包', '在卡片右上角加入候选，攒好后一键复制给 Agent'],
    ];
    const box = h('div', { class: 'coach', role: 'dialog', 'aria-label': '三步上手' },
      h('div', { class: 'coach-h' }, kit.logo(18), h('b', null, '三步上手')),
      h('ol', null, ...steps.map(([a, b]) => h('li', null, h('b', null, a), h('span', null, b)))),
      h('div', { class: 'coach-f' }, h('span', null, '随时可以在「⋯」里重看'),
        h('button', { class: 'btn primary', type: 'button', 'data-autofocus': '', onclick: () => { store.saveSettings({ guideDone: true }); hideCoach(); } }, '知道了')));
    box.style.left = Math.max(8, Math.round(r.right - 340)) + 'px';
    box.style.top = Math.round(r.bottom + 10) + 'px';
    ui.layer.appendChild(box);
    ui.coach = box;
    requestAnimationFrame(() => box.classList.add('dsp-in'));
  }
  function hideCoach() { if (ui.coach) { ui.coach.remove(); ui.coach = null; } }
  window.addEventListener('scroll', () => { if (ui.coach) { store.saveSettings({ guideDone: true }); hideCoach(); } }, { passive: true });

  // 测试用状态
  ui.health = () => ui.lastHealth || 'ok';
  ui.debugState = () => ({
    docked: !!(ui.dock && ui.dock.el.isConnected), strategy: ui.strategy, health: ui.lastHealth,
    loading: listLoader.running, loadReason: listLoader.reason, launcher: ui.launcher ? ui.launcher.dataset.sig : '',
    pop: ui.pop ? ui.pop.kind : '', paused: ui.paused, combo: ui.combo,
    comments: { mode: CE.state.mode, highlight: CE.state.highlight, hits: ui.commentHits || 0 },
  });

  const CSS = `
.launcher { position: fixed; right: 24px; bottom: 24px; display: inline-flex; align-items: center; gap: 10px; min-height: 48px; padding: 8px 16px 8px 10px; border-radius: 16px;
  background: var(--glass); backdrop-filter: blur(16px) saturate(150%); -webkit-backdrop-filter: blur(16px) saturate(150%); box-shadow: var(--sh-bar); color: var(--t1); text-align: left; }
.launcher:hover { background: var(--s2); }
.l-tx { display: flex; flex-direction: column; }
.l-tx b { font: 600 13px/20px var(--font); }
.l-tx span { color: var(--cyan-text); font-size: 12px; line-height: 18px; }
.l-fail .l-tx b, .l-blocked .l-tx b { color: var(--tier-low-text); }
.l-paused { opacity: .85; }
.l-paused .dsp-logo { filter: grayscale(1); opacity: .6; }
.l-recognizing .l-tx b { color: var(--t3); }
.coach { position: fixed; z-index: 45; width: 330px; padding: 14px 16px 12px; border-radius: 16px; background: var(--s2); box-shadow: var(--sh-pop);
  opacity: 0; transform: translateY(6px); transition: opacity 180ms var(--ease), transform 180ms var(--ease); }
.coach.dsp-in { opacity: 1; transform: none; }
.coach-h { display: flex; align-items: center; gap: 8px; }
.coach-h b { font: 600 14px/22px var(--font); }
.coach ol { margin: 10px 0 0; padding: 0; list-style: none; counter-reset: s; }
.coach li { counter-increment: s; position: relative; padding: 6px 0 6px 30px; display: flex; flex-direction: column; }
.coach li::before { content: counter(s); position: absolute; left: 0; top: 7px; width: 20px; height: 20px; border-radius: 50%; background: var(--red-solid); color: #fff; font: 600 11px/20px var(--font); text-align: center; }
.coach li b { font-weight: 600; }
.coach li span { color: var(--t2); font-size: 12px; line-height: 18px; }
.coach-f { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; padding-top: 10px; border-top: 1px solid var(--line); color: var(--t3); font-size: 12px; }
.coach-f .btn { height: 32px; }
@media (prefers-reduced-motion: reduce) { .coach { transform: none !important; transition: opacity 80ms linear; } }
`;
  DSP.css = (DSP.css || '') + CSS;
})();
