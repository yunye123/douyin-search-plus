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
    launcher: null, guide: null,
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
  // 页面注水完成前不往抖音的 React 树里插节点：数据桥读到 fiber 时会标记；读不到 fiber 的页面，load 后 2.5 秒兜底
  ui.loadAt = document.readyState === 'complete' ? Date.now() : 0;
  window.addEventListener('load', () => { ui.loadAt = Date.now(); schedule(); }, { once: true });
  const hydrated = () => document.documentElement.dataset.dspHydrated === '1' || (ui.loadAt > 0 && Date.now() - ui.loadAt > 2500);

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
    // 这些测量开销大（强制布局），由看门狗每秒做一次，主更新只读缓存；值变了才触发重画
    const theme = A.pageTheme();
    const headerTop = A.headerBottom();
    const blocked = A.blockingReason();
    const changed = theme !== ui.theme || headerTop !== ui.headerTop || blocked !== ui.blocked;
    ui.theme = theme; ui.headerTop = headerTop; ui.blocked = blocked;
    for (const x of [ui.root && ui.root.el, ui.dock && ui.dock.el, ui.cbar && ui.cbar.el]) if (x && x.dataset.theme !== theme) x.dataset.theme = theme;
    // 其余情况只在需要随时间变化时重画：识别中（6 秒后会变成"读不到"）、注水兜底计时、加载中；另外每 5 秒保底一次
    ui.tick = (ui.tick || 0) + 1;
    if (changed || ui.lastHealth === 'recognizing' || !ui.dock || listLoader.running || ui.tick % 5 === 0) schedule();
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
      ui.commentSig = '';
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
    ui.guide = null;
  }
  function setEnabled(on) {
    store.saveSettings({ enabled: on });
    applyEnabled();
  }

  // ---------------- 自动加载 ----------------
  const isProfile = () => S.route.type === 'profile';
  // 页面上实际的卡片数（加载器计数、上限预检都用它，和工具栏显示一致）
  const pageCount = () => (ui.listEl ? A.cardsOf(ui.listEl).length : S.videos.size);
  const capFor = () => (isProfile() ? Math.min(600, (S.settings.loadCap || 100) * 3) : (S.settings.loadCap || 100));
  const listLoader = L.create({
    // 以页面上实际的卡片数为准（回到搜过的关键词时，缓存里的旧数据不算"已加载"）
    count: pageCount,
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
    // 评论区没了（例如关掉了视频弹层）就停，绝不退回去滚动整个页面
    scroll: () => { const list = A.commentList(); const sc = list && A.scrollerOf(list); if (sc) sc.scrollTop = sc.scrollHeight; else if (list) list.lastElementChild && list.lastElementChild.scrollIntoView({ block: 'end' }); else commentLoader.stop('route'); },
    onChange: (st) => { schedule(); if (!st.running && st.reason && st.reason !== 'route') announce(st.reason === 'end' || st.reason === 'cap' ? '评论读完了，共 ' + A.commentRows().length + ' 条' : st.message(), st.reason === 'login' || st.reason === 'captcha' ? 'warn' : ''); },
    delay: [1200, 2600],
  });
  function stopLoaders(reason) { listLoader.stop(reason); commentLoader.stop(reason); }

  // ---------------- 提示 ----------------
  // 轻提示统一在视口底部，不盖住结果第一行
  function announce(msg, tone, action) {
    if (!msg) return;
    toast(ui.layer, msg, { tone, action });
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
    renderGuide(listState && listState.health);
  }

  function removeDock() {
    if (ui.dock) { ui.dock.el.remove(); ui.dock = null; ui.bar = null; }
    if (IP.S.applied) IP.restore();
    C.removeAll();
    ui.listEl = null;
  }

  // 工具栏宽度用 ResizeObserver 缓存（在写入 order 之后再读尺寸会强制整列表布局）
  let ro = null;
  function dockWidth() {
    if (!ui.dock) return 0;
    if (ui.roEl !== ui.dock.el) {
      if (ro) ro.disconnect();
      ro = new ResizeObserver((es) => { const w = Math.round(es[0].contentRect.width); if (w !== ui.dockW) { ui.dockW = w; schedule(); } });
      ro.observe(ui.dock.el);
      ui.roEl = ui.dock.el;
      ui.dockW = ui.dock.el.getBoundingClientRect().width;
    }
    return ui.dockW || 1200;
  }

  function observe(el) {
    if (ui.observed === el) return;
    if (ui.observer) ui.observer.disconnect();
    // 观察整棵列表子树，但只在两种情况下重画：卡片增减（列表的直接子节点变化），
    // 或 React 重渲染卡片内部时把插件的角标冲掉了。卡片里的预览视频、计数跳动等其他变化忽略
    ui.observer = new MutationObserver((records) => {
      for (const m of records) {
        if (m.target === el) return schedule();
        for (const n of m.removedNodes) if (n.nodeType === 1 && (n.classList.contains('dsp-ann') || (n.querySelector && n.querySelector('.dsp-ann')))) return schedule();
      }
    });
    ui.observer.observe(el, { childList: true, subtree: true });
    ui.observed = el;
  }

  function updateList(type) {
    const located = A.locateList(type);
    ui.listEl = located ? located.el : null;
    ui.strategy = located ? located.strategy : '';
    const cards = located ? A.cardsOf(located.el) : [];
    if (ui.blocked === undefined) ui.blocked = A.blockingReason();
    const blocked = ui.blocked;
    const health = P.health({ type, count: S.videos.size, located: !!(located && cards.length), sinceRouteMs: Date.now() - ui.routeAt, blocked: listLoader.running ? null : blocked });
    // 以页面上实际显示的卡片为准（原地重排只能排页面上有的卡片；会话里更早的数据只用于导出）
    const ids = cards.length ? cards.map((c) => c.id) : null;
    const view = store.viewOf(ids);
    const d = store.derived();
    const base = ids ? ids.map((id) => d.byId.get(id)).filter(Boolean) : d.list;
    const tiers = P.tierCounts(base);
    const sorted = S.view.sortKeys.length > 0;
    const active = S.view.active;
    const lens = P.matchLens(S.view);
    // 账号 Top10：第 11 名以后照样排序，但名次变灰、卡片变暗，不和前 10 混在一起
    const topN = lens && lens.key === 'top10' ? 10 : 0;
    const orderIds = view.sorted.map((x) => x.v.id);
    const dimIds = new Set(view.rest.map((v) => v.id));
    if (topN) orderIds.slice(topN).forEach((id) => dimIds.add(id));
    ui.orderIds = orderIds;

    // 工具栏挂载：列表的前一个兄弟节点；找不到列表时不挂（交给启动器显示状态）
    let docked = false;
    if (located && hydrated()) {
      ui.dock = host('dsp-dock', located.el.parentElement, located.el);
      if (!ui.bar || !ui.bar.bar.isConnected) {
        ui.bar = T.buildBar(barApi);
        const lay = ui.dock.root.querySelector('.dsp-layer') || ui.dock.root.appendChild(h('div', { class: 'dsp-layer' }));
        clear(lay).appendChild(ui.bar.bar);
      }
      // 顶栏高度和深浅色很少变：由看门狗每秒测一次，这里只用缓存值
      if (ui.headerTop == null) ui.headerTop = A.headerBottom();
      if (!ui.theme) ui.theme = A.pageTheme();
      // 吸顶位置紧贴抖音顶栏；8px 间距由宿主自己的实色内边距提供，滚动时卡片不会从缝里露出来
      const top = ui.headerTop + 'px';
      const bg = ui.theme === 'light' ? '#ffffff' : '#161722';
      if (ui.dock.el.style.getPropertyValue('--dsp-page-bg') !== bg) ui.dock.el.style.setProperty('--dsp-page-bg', bg);
      if (ui.dock.el.style.top !== top) ui.dock.el.style.top = top;
      if (ui.dock.el.dataset.theme !== ui.theme) ui.dock.el.dataset.theme = ui.theme;
      docked = true;
      observe(located.el);
    } else if (ui.dock && !located) {
      ui.dock.el.remove(); ui.dock = null; ui.bar = null;
    }
    if (!docked) {
      if (IP.S.applied && !located) IP.restore();
      ui.lastHealth = health;
      return { health, docked: false, count: S.videos.size };
    }

    // 原地重排 / 还原
    if (located && cards.length && active && IP.supports(located.el, cards)) {
      IP.apply(located.el, cards, { order: orderIds, dim: dimIds });
    } else if (IP.S.applied && (!active || !located)) {
      IP.restore();
    }

    // 卡片角标
    if (located && S.settings.badges) {
      const rank = new Map();
      if (sorted) orderIds.forEach((id, i) => rank.set(id, i + 1));
      const likes = type === 'profile' ? (S.profileStats || (S.profileStats = A.profileStats())) : null;
      const byEl = new Map(cards.map((c) => [c.id, c.el]));
      for (const card of cards) {
        const v = d.byId.get(card.id);
        if (!v) continue;
        const r = rank.get(card.id) || 0;
        C.render(card, {
          v, rank: r, rankMuted: !!(topN && r > topN), isCand: S.candidates.has(card.id),
          dimReason: active && dimIds.has(card.id) ? (topN && r > topN ? 'Top10 之外' : M.failReason(v, S.view.filter)) : '',
          onToggleCand: (id, btn) => toggleCandidate(id, btn),
          onDetail: (vv, anchor, pinned) => C.showDetail(ui.layer, vv, anchor, {
            isCand: S.candidates.has(vv.id), cardEl: card.el,
            share: likes && likes.likes ? vv.digg / likes.likes : null,
            onToggleCand: (id, b) => { toggleCandidate(id, b); C.hideDetail(true, true); },
            onCopyLink: (x) => { copy(E.videoUrl(x), '链接已复制'); C.hideDetail(true, true); },
          }, pinned),
          onLeave: () => C.scheduleHide(),
          // 键盘：在收藏率标签上按 ↑↓ 按名次跳到上一张/下一张
          onNav: (id, dir) => {
            const list = sorted ? orderIds : cards.map((c) => c.id);
            const i = list.indexOf(id);
            const next = list[i + dir];
            if (next && byEl.get(next)) C.focusChip(byEl.get(next));
          },
        });
      }
      C.prune();
    } else if (!S.settings.badges) {
      C.removeAll();
    }

    // 工具栏内容
    if (ui.bar) {
      const passCount = active ? Math.min(view.sorted.length, topN || Infinity) : base.length;
      // 选题看法自带的条件（例如真需求 = 收藏率≥80% + 只看视频）不算"用户设的达标线"，按钮只数额外加的
      const filterCount = Math.max(0, M.activeFilterCount(S.view.filter) - (lens && lens.filter ? M.activeFilterCount(lens.filter) : 0));
      const vm = {
        type, health, blocked, count: ids ? base.length : S.videos.size,
        width: dockWidth(),
        sorted, filterCount,
        loading: listLoader.running, cap: capFor(),
        candidates: S.candidates.size,
        tiers, tierFilter: S.view.filter.tier, layer: ui.layer,
        onTier: (k) => { store.setFilter(Object.assign({}, S.view.filter, { tier: S.view.filter.tier === k ? '' : k })); },
        sortShort: lens ? lens.label : sorted ? S.view.sortKeys.map((k) => M.METRICS[k].label).join('+') + (S.view.asc ? ' ↑' : '') : '',
      };
      vm.status = P.statusLine({
        health, blocked, count: vm.count, strongNeed: tiers.high, sorted: active,
        sortText: lens ? '按「' + lens.label + '」排序' : sorted ? P.sortText(S.view.sortKeys, S.view.asc) : '达标线：' + P.filterText(S.view.filter),
        shown: passCount, loading: vm.loading, cap: vm.cap,
      });
      if (active && passCount === 0 && vm.count) vm.status = [{ t: '没有结果过达标线', tone: 'warn' }, { t: P.filterText(S.view.filter) || '', tone: 'dim' }];
      if (topN && view.sorted.length > topN) vm.status.push({ t: '另有 ' + (view.sorted.length - topN) + ' 条在 Top10 之外', tone: 'dim' });
      T.renderBar(ui.bar, vm);
      ui.vm = Object.assign(vm, { passCount, view, base, lens });
    }
    if (health !== ui.lastHealth) { ui.lastHealth = health; }
    return { health, docked, count: S.videos.size };
  }

  // ---------------- 启动器（找不到挂载点 / 暂停 / 插件已更新） ----------------
  function renderLauncher(state) {
    // state：null（不需要）| 'recognizing' | 'fail' | 'blocked' | 'paused' | 'stale'
    // "识别中"不弹启动器（每次进页面都会闪一下）；只在读不到、被拦、暂停、插件已更新时出现
    const need = state && (state === 'paused' || state === 'stale' || ((S.route.type === 'search' || S.route.type === 'profile') && (state === 'fail' || state === 'blocked')));
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
      if (commentLoader.running) commentLoader.stop('route'); // 评论区收起或换了面板：停，绝不替用户滚页面
      return;
    }
    if (!hydrated()) return;
    ui.cbar = host('dsp-cbar', list.parentElement, list);
    // 评论在独立的滚动面板里：吸在面板顶部；评论在页面主滚动里：吸在抖音顶栏下面
    const ctop = A.isDocScroller(A.scrollerOf(list)) ? (ui.headerTop || 0) + 'px' : '0px';
    if (ui.cbar.el.style.top !== ctop) ui.cbar.el.style.top = ctop;
    if (!ui.theme) ui.theme = A.pageTheme();
    if (ui.cbar.el.dataset.theme !== ui.theme) ui.cbar.el.dataset.theme = ui.theme;
    if (!ui.cb || !ui.cb.box.isConnected) {
      ui.cb = CB.build(commentApi);
      const lay = ui.cbar.root.querySelector('.dsp-layer') || ui.cbar.root.appendChild(h('div', { class: 'dsp-layer' }));
      clear(lay).appendChild(ui.cb.box);
    }
    const rows = A.commentRows(list);
    if (CE.state.mode || CE.state.highlight) {
      const sig = rows.length + '|' + S.comments.version + '|' + CE.state.mode + '|' + CE.state.highlight;
      // 签名没变但评论区被还原过（暂停后恢复、列表重新挂载），也要重新应用
      if (sig !== ui.commentSig || !CE.state.applied || CE.state.list !== list) { ui.commentSig = sig; ui.commentHits = CE.apply().hits || 0; }
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

  // 高亮命中的评论行，按视觉顺序（CSS order，其次 DOM 顺序）
  function hitRows() {
    return [...document.querySelectorAll('.dsp-c-hit')].sort((a, b) => (+a.style.order || 0) - (+b.style.order || 0) || (a.compareDocumentPosition(b) & 4 ? -1 : 1));
  }
  function focusHit(i) {
    const el = hitRows()[i];
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: kit.reducedMotion() ? 'auto' : 'smooth' });
    el.classList.remove('dsp-c-focus'); void el.offsetWidth; el.classList.add('dsp-c-focus');
  }

  const commentApi = {
    layer: () => ui.layer,
    setMode: (m) => { CE.setMode(m); ui.commentSig = ''; schedule(); },
    // 点一格：高亮命中的评论，并把第 1 条滚到视野中间闪一下（"1/N"名副其实）
    setHighlight: (k) => {
      CE.setHighlight(CE.state.highlight === k ? null : k);
      ui.commentSig = ''; ui.commentCursor = 0;
      update();
      if (CE.state.highlight) focusHit(0);
    },
    toggleLoad: () => { if (commentLoader.running) commentLoader.stop('user'); else commentLoader.start(); },
    jump: (dir) => {
      const n = hitRows().length;
      if (!n) return;
      ui.commentCursor = (ui.commentCursor + dir + n) % n;
      focusHit(ui.commentCursor);
      schedule();
    },
    copyHits: (btn) => {
      const k = CE.state.highlight;
      const list = CE.collected().filter((c) => E.barrierHits(c.text).includes(k));
      copy(E.commentsText(list), '已复制 ' + list.length + ' 条原评论（一字未改）', btn);
    },
    openMore: (anchor) => {
      const item = (ic, label, run) => h('button', { class: 'mi', type: 'button', onclick: () => { closePop(true); run(); } }, icon(ic, 16), h('span', null, label));
      const panel = h('div', { class: 'pop-more' },
        item('copy', '复制前 20 条原评论（按当前排序）', () => { const l = CE.collected().slice(0, 20); copy(E.commentsText(l), '已复制 ' + l.length + ' 条原评论'); }),
        item('download', '下载全部评论 CSV', () => {
          const l = CE.collected();
          if (!l.length) return announce('还没读到评论数据，先往下滚一点', 'warn');
          E.download(E.safeName('抖音评论_' + (S.route.awemeId || S.route.modalId || '') + '_' + U.fmtDate(Date.now() / 1000)) + '.csv', E.commentsCsv(l));
          announce('已下载 ' + l.length + ' 条评论（不含昵称和 IP 属地）');
        }),
        h('div', { class: 'mi-foot' }, '导出默认不含评论者昵称和 IP 属地'));
      popover(anchor, panel, { layer: ui.layer, label: '复制或导出评论', placement: 'below-end' });
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
      if (blocked) return announce(L.REASONS[blocked === 'captcha' ? 'captcha' : 'login'](pageCount()), 'warn');
      if (pageCount() >= capFor()) return announce('已达到加载上限 ' + capFor() + ' 条，可以在插件弹窗里调高', 'warn');
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
      guideDone(); // 已经会用排序看法了，引导不再出现
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
    showGuide: () => { store.saveSettings({ guideDone: false }); if (ui.guide) { ui.guide.remove(); ui.guide = null; } schedule(); },
    toggleCustom: () => { ui.customOpen = !ui.customOpen; reopen(); },
    pause: () => {
      setEnabled(false);
      announce('插件已暂停，抖音页面已还原', '', { label: '撤销', run: () => setEnabled(true) });
    },
  };

  function openPanel(kind, anchor) {
    if (ui.pop && ui.pop.kind === kind && isOpen(ui.pop.panel)) { closePop(true); ui.pop = null; return; }
    C.hideDetail(true);
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
  // 面板内容变化后重画；焦点放回刚才操作的那个控件（键盘用户不用每次从头 Tab）
  function reopen() {
    if (!ui.pop) return;
    const { kind, anchor, panel } = ui.pop;
    const scroll = panel.scrollTop;
    const act = panel.getRootNode().activeElement;
    let key = null, bkIndex = -1;
    if (act && panel.contains(act)) {
      for (const a of ['data-quick', 'data-metric', 'data-lens', 'data-dir', 'data-tab', 'data-dsp', 'data-min']) {
        if (act.hasAttribute(a)) { key = '[' + a + '="' + act.getAttribute(a) + '"]'; break; }
      }
      if (!key && act.classList.contains('sw')) key = '.sw';
      if (!key && act.classList.contains('bk-x')) bkIndex = [...panel.querySelectorAll('.bk-x')].indexOf(act);
    }
    closePop(false);
    ui.pop = null;
    update();
    openPanel(kind, anchor);
    if (!ui.pop) return;
    const np = ui.pop.panel;
    np.scrollTop = scroll;
    if (key || bkIndex >= 0) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        let el = key ? np.querySelector(key) : null;
        if (!el && bkIndex >= 0) { const xs = np.querySelectorAll('.bk-x'); el = xs[Math.min(bkIndex, xs.length - 1)] || np.querySelector('[data-dsp="copy-md"]'); }
        if (el) el.focus({ preventScroll: true });
      }));
    }
  }
  function popVm() {
    const v = ui.vm || {};
    return {
      type: S.route.type, lens: v.lens ? v.lens.key : '', sortKeys: S.view.sortKeys, asc: S.view.asc, combo: ui.combo,
      filter: S.view.filter, passCount: v.passCount || 0, count: v.count || 0, badges: S.settings.badges,
      lowSample: (v.tiers && v.tiers.na) || 0, customOpen: !!ui.customOpen,
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
  // 工具栏下方的一条横条（在页面流里，不浮在卡片和弹层上）；点"知道了"或第一次用排序看法后不再出现
  function renderGuide(health) {
    const want = !S.settings.guideDone && health === 'ok' && ui.bar;
    const lay = ui.dock && ui.dock.root.querySelector('.dsp-layer');
    if (!want || !lay) { if (ui.guide) { ui.guide.remove(); ui.guide = null; } return; }
    if (ui.guide && ui.guide.isConnected) return;
    const step = (n, a, b) => h('li', null, h('i', null, String(n)), h('b', null, a), h('span', null, b));
    ui.guide = h('div', { class: 'guide', role: 'note', 'aria-label': '三步上手' },
      h('span', { class: 'guide-h' }, '三步上手'),
      h('ol', null,
        step(1, '继续加载', '先多读一些，排名才靠谱'),
        step(2, '排序 → 真需求', '收藏率 ≥80% 的视频按收藏数排好'),
        step(3, '☆ 候选 → 复制入库包', '攒好后一次性给 Agent')),
      h('button', { class: 'btn sm', type: 'button', 'data-dsp': 'guide-ok', onclick: () => guideDone() }, '知道了'));
    lay.appendChild(ui.guide);
  }
  function guideDone() {
    if (!S.settings.guideDone) store.saveSettings({ guideDone: true });
    if (ui.guide) { ui.guide.remove(); ui.guide = null; }
  }

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
.guide { display: flex; align-items: center; gap: 12px; margin-top: 8px; padding: 8px 8px 8px 14px; border-radius: 12px; background: var(--s1); box-shadow: inset 0 0 0 1px var(--line);
  font: 13px/20px var(--font); color: var(--t1); }
:host([data-theme="light"]) .guide { background: var(--s2); }
.guide-h { font-weight: 600; color: var(--red-text); white-space: nowrap; }
.guide ol { display: flex; gap: 18px; margin: 0; padding: 0; list-style: none; flex: 1; min-width: 0; overflow: hidden; }
.guide li { display: flex; align-items: center; gap: 6px; white-space: nowrap; min-width: 0; }
.guide li i { width: 18px; height: 18px; border-radius: 50%; background: var(--red-solid); color: #fff; font: 600 11px/18px var(--font); font-style: normal; text-align: center; flex: none; }
.guide li b { font-weight: 600; }
.guide li span { color: var(--t3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.guide .btn.sm { height: 28px; padding: 0 12px; box-shadow: inset 0 0 0 1px var(--line2); }
`;
  DSP.css = (DSP.css || '') + CSS;
})();
