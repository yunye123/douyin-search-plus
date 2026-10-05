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
    // 换页面 / 换视频：评论区的排序和变暗一起还原（不只是清掉工具条上的状态）
    store.on('route', () => { ui.routeAt = Date.now(); stopLoaders('route'); closePop(); C.hideDetail(true); if (CE.state.applied) CE.restore(); CE.state.mode = null; CE.state.highlight = null; schedule(); });
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
    // 列表页还没挂上工具栏（识别中）才需要每秒重画；视频页、精选页没有工具栏，不必每秒重画（注水前除外）
    const onList = S.route.type === 'search' || S.route.type === 'profile';
    if (changed || ui.lastHealth === 'recognizing' || (onList && !ui.dock) || !hydrated() || listLoader.running || CE.state.mode || CE.state.highlight || ui.tick % 5 === 0) schedule();
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
    observeComments(null);
    if (ui.guideHost) { ui.guideHost.el.remove(); ui.guideHost = null; }
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
    // 排过序时 DOM 里最后一张卡不一定在屏幕最下面：滚向视觉上最低的那张，才能触发抖音翻页
    scroll: (round) => {
      const cards = ui.listEl ? A.cardsOf(ui.listEl) : [];
      let last = cards.length ? cards[cards.length - 1].el : null;
      if (IP.S.applied && cards.length) {
        let maxB = -Infinity;
        for (const c of cards) { const b = c.el.getBoundingClientRect().bottom; if (b > maxB) { maxB = b; last = c.el; } }
      }
      L.scrollToEnd(last, round);
    },
    onChange: (st) => {
      schedule();
      if (st.running || !st.reason || st.reason === 'route') return;
      const tone = st.reason === 'login' || st.reason === 'captcha' || st.reason === 'stalled' ? 'warn' : '';
      // 加载器把页面拖到了最底下。排过序、而且是读完或到上限：自动回到第 1 名（底下是排名最靠后的）；
      // 其他停止原因（被拦、手动停）不替用户跳走，给一个"看排名"
      if (S.view.active && (st.reason === 'end' || st.reason === 'cap') && pageCount() > st.startCount) {
        requestAnimationFrame(() => { update(); scrollToListTop(); });
        return announce(st.message() + '，已回到第 1 名', tone);
      }
      announce(st.message(), tone, S.view.active ? { label: '看排名', run: scrollToListTop } : null);
    },
  });
  const COMMENT_CAP = 500;
  const commentLoader = L.create({
    count: () => A.commentRows().length,
    cap: () => COMMENT_CAP,
    blocked: () => A.blockingReason(),
    hasMore: () => { const m = commentMeta(); return m ? m.hasMore : undefined; },
    // 评论区没了（例如关掉了视频弹层）就停，绝不退回去滚动整个页面
    // 只滚评论所在的那个容器；评论在弹层里时 scrollerOf 不会越过弹层，背后的页面不动
    scroll: () => { const list = A.commentList(); if (!list) return commentLoader.stop('route'); const sc = A.scrollerOf(list); if (sc) sc.scrollTop = sc.scrollHeight; },
    onChange: (st) => {
      schedule();
      if (st.running || !st.reason || st.reason === 'route') return;
      const n = A.commentRows().length;
      const done = st.reason === 'end' || st.reason === 'cap';
      // 读到上限 ≠ 读完：说清楚门槛词只按已读的统计
      const total = currentComments().total;
      const msg = st.reason === 'cap' ? '评论读了 ' + n + ' 条，到了上限' + (total > n ? '（共 ' + total + ' 条），门槛词只按已读的统计' : '')
        : st.reason === 'end' ? '评论读完了，共 ' + n + ' 条' : st.message();
      const tone = st.reason === 'login' || st.reason === 'captcha' || st.reason === 'cap' ? 'warn' : '';
      // 和搜索页一致：按赞 / 按回复排着时读完，自动回到第 1 条（这一轮确实读到了新评论才跳）；没排序就给一个"回到第 1 条"
      if (done && CE.state.mode && n > st.startCount) {
        requestAnimationFrame(() => { update(); scrollToCommentTop(); });
        return announce(msg + '，已回到第 1 条', tone);
      }
      announce(msg, tone, done ? { label: '回到第 1 条', run: scrollToCommentTop } : null);
    },
    delay: [1200, 2600],
  });
  // 当前这条视频的评论翻页信息（换视频后，上一条的不算）
  function commentMeta() {
    const m = DSP.meta.comments;
    return m && (!m.awemeId || m.awemeId === S.comments.awemeId) ? m : null;
  }
  // 当前这条视频的评论数据（接口或 fiber 读到的）；读到的是别的视频的就当没有
  function currentComments() {
    const vid = S.route.modalId || S.route.awemeId || '';
    return !vid || S.comments.awemeId === vid ? S.comments : { awemeId: vid, map: new Map(), total: 0 };
  }
  function stopLoaders(reason) { listLoader.stop(reason); commentLoader.stop(reason); }

  // ---------------- 提示 ----------------
  // 轻提示统一在视口底部，不盖住结果第一行
  function announce(msg, tone, action) {
    if (!msg) return;
    toast(ui.layer, msg, { tone, action });
  }
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; };

  // 把结果列表的顶部（第 1 名）滚到吸顶工具栏下方
  function dockBottom() { return ui.dock && ui.dock.el.isConnected ? ui.dock.el.getBoundingClientRect().bottom : (ui.headerTop || 0); }
  function scrollToListTop() {
    if (!ui.listEl || !ui.listEl.isConnected) return;
    const delta = ui.listEl.getBoundingClientRect().top - (Math.max(dockBottom(), (ui.headerTop || 0) + 56) + 8);
    if (Math.abs(delta) < 4) return;
    A.scrollByIn(ui.listEl, delta, kit.reducedMotion() ? 'auto' : 'smooth');
  }
  // 切到搜索结果的"视频"标签：点抖音自己的标签（和用户手点一样）；找不到就改地址
  function switchToVideoTab() {
    const tab = [...document.querySelectorAll('span, div, a')].find((el) => {
      if (el.children.length || (el.textContent || '').trim() !== '视频') return false;
      const bar = el.parentElement && el.parentElement.parentElement;
      const t = bar ? bar.textContent || '' : '';
      return t.indexOf('综合') >= 0 && t.indexOf('用户') >= 0 && el.getClientRects().length > 0;
    });
    if (tab) { tab.click(); return; }
    const u = new URL(location.href);
    u.searchParams.set('type', 'video');
    location.assign(u.toString());
  }

  // 评论区：把视觉上的第 1 条滚到评论工具条下方（评论在面板里滚动时滚面板，在页面里滚动时滚页面）
  function scrollToCommentTop() {
    const list = A.commentList();
    if (!list || !list.isConnected) return;
    const rows = A.commentRows(list);
    if (!rows.length) return;
    let first = rows[0].el, top = first.getBoundingClientRect().top;
    for (const r of rows) { const t = r.el.getBoundingClientRect().top; if (t < top) { top = t; first = r.el; } }
    const bar = ui.cbar && ui.cbar.el.isConnected ? ui.cbar.el.getBoundingClientRect().bottom : (ui.headerTop || 0);
    const delta = top - (bar + 8);
    if (Math.abs(delta) < 4) return;
    A.scrollByIn(list, delta, kit.reducedMotion() ? 'auto' : 'smooth');
  }
  // 名次跳转：按键时现查卡片和视觉顺序（不用闭包里的旧顺序），焦点不被吸顶工具栏挡住
  ui.nav = (id, dir) => {
    if (!ui.listEl) return;
    const cards = A.cardsOf(ui.listEl);
    if (IP.S.applied) cards.sort((a, b) => (+a.el.style.order || 0) - (+b.el.style.order || 0));
    const i = cards.findIndex((c) => c.id === id);
    const next = cards[i + dir];
    if (!next) return;
    C.focusChip(next.el);
    const r = next.el.getBoundingClientRect();
    const db = dockBottom();
    if (r.top < db + 8) A.scrollByIn(next.el, r.top - db - 12);
  };

  // ---------------- 主更新 ----------------
  function update() {
    if (!ui.root) return;
    if (ui.stale) return renderLauncher('stale');
    if (ui.paused) return renderLauncher('paused');
    const type = S.route.type;
    let listState = null;
    if (type === 'search' || type === 'profile') listState = updateList(type);
    else { removeDock(); ui.lastHealth = ''; } // 离开列表页：读取状态清掉，不沿用上一个列表页的
    updateComments();
    renderLauncher(listState && !listState.docked ? listState.health : null);
    renderGuide(listState && listState.health);
  }

  function removeDock() {
    if (ui.dock) { ui.dock.el.remove(); ui.dock = null; ui.bar = null; }
    if (ui.guideHost) { ui.guideHost.el.remove(); ui.guideHost = null; ui.guide = null; }
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

  function observeComments(list) {
    if (ui.cObserved === list) return;
    if (ui.cObserver) ui.cObserver.disconnect();
    ui.cObserved = list;
    if (!list) return;
    ui.cObserver = new MutationObserver(() => schedule());
    ui.cObserver.observe(list, { childList: true });
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
    // 给扩展弹窗用的计数（和工具栏同一口径），带上会话签名，换关键词后不会读到旧数
    ui.counts = { session: S.session, count: ids ? base.length : S.videos.size, strongNeed: tiers.high };
    // 能不能原地重排：抖音"综合"标签是绝对定位的瀑布流，插件排不动。排不动时不显示名次、不变暗，
    // 免得卡片上写着第 3 名、位置却没变；排序和达标线引导用户切到"视频"标签
    const canSort = !located || !cards.length || IP.supports(located.el, cards);
    const sorted = canSort && S.view.sortKeys.length > 0;
    const active = canSort && S.view.active;
    const lens = canSort ? P.matchLens(S.view) : null;
    // 账号 Top10：第 11 名以后照样排序，但名次变灰、卡片变暗，不和前 10 混在一起
    const topN = lens && lens.key === 'top10' ? 10 : 0;
    const orderIds = view.sorted.map((x) => x.v.id);
    const dimIds = new Set(view.rest.map((v) => v.id));
    if (topN) orderIds.slice(topN).forEach((id) => dimIds.add(id));
    ui.orderIds = orderIds;

    // 工具栏挂载：列表的前一个兄弟节点；找不到列表时不挂（交给启动器显示状态）
    let docked = false;
    if (located && hydrated()) {
      const before = ui.guideHost && ui.guideHost.el.isConnected && ui.guideHost.el.parentNode === located.el.parentElement ? ui.guideHost.el : located.el;
      ui.dock = host('dsp-dock', located.el.parentElement, before);
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

    // 主页页头的账号数据每次现读：SPA 换博主时页头可能晚于地址更新，缓存会留下上一位的获赞
    if (type === 'profile') S.profileStats = A.profileStats();

    // 卡片角标
    const rank = new Map();
    if (sorted) orderIds.forEach((id, i) => rank.set(id, i + 1));
    ui.rank = rank;
    ui.topN = topN;
    if (located && S.settings.badges) {
      for (const card of cards) {
        const v = d.byId.get(card.id);
        if (!v) continue;
        const r = rank.get(card.id) || 0;
        C.render(card, {
          v, rank: r, rankMuted: !!(topN && r > topN), isCand: S.candidates.has(card.id),
          dimReason: active && dimIds.has(card.id) ? (topN && r > topN ? 'Top10 之外' : M.failReason(v, S.view.filter)) : '',
          onToggleCand: (id, btn) => toggleCandidate(id, btn),
          onDetail: (vv, anchor, pinned, dimReason) => {
            const ps = type === 'profile' ? A.profileStats() : null; // 打开时现读
            C.showDetail(ui.layer, vv, anchor, {
            isCand: S.candidates.has(vv.id), cardEl: card.el, dimReason,
            share: ps && ps.likes && vv.digg != null ? vv.digg / ps.likes : null,
            onToggleCand: (id, b) => { toggleCandidate(id, b); C.hideDetail(true, true); },
            onCopyLink: (x) => { copy(E.videoUrl(x), '链接已复制'); C.hideDetail(true, true); },
            }, pinned);
          },
          onLeave: () => C.scheduleHide(),
          // 键盘：在收藏率标签上按 ↑↓ 按名次跳到上一张/下一张（按键时现查顺序）
          onNav: (id, dir) => ui.nav(id, dir),
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
      const filterCount = !canSort ? 0 : Math.max(0, M.activeFilterCount(S.view.filter) - (lens && lens.filter ? M.activeFilterCount(lens.filter) : 0));
      const vm = {
        type, health, blocked, count: ids ? base.length : S.videos.size,
        width: dockWidth(),
        sorted, filterCount,
        loading: listLoader.running, cap: capFor(),
        candidates: S.candidates.size,
        tiers, tierFilter: S.view.filter.tier, layer: ui.layer,
        onTier: (k) => onTier(k),
        sortShort: lens ? lens.label : sorted ? S.view.sortKeys.map((k) => M.METRICS[k].label).join('+') + (S.view.asc ? ' ↑' : '') : '',
      };
      // 主页：账号作品总数（"已读取 18 / 60 条"）；真需求里有多少没过达标线（例如图文）
      const works = type === 'profile' && S.profileStats ? S.profileStats.works : 0;
      const passSet = new Set(view.sorted.map((x) => x.v.id));
      const excludedHigh = active ? base.filter((v) => M.crTier(v) === 'high' && !passSet.has(v.id)).length : 0;
      vm.status = P.statusLine({
        health, blocked, count: vm.count, total: works, strongNeed: tiers.high, sorted: active,
        shown: passCount, loading: vm.loading, cap: vm.cap, excludedHigh, noSort: !canSort,
      });
      // 看法写在"排序"按钮上、达标线条件在按钮角标和弹层里，状态句不重复；悬停状态句看全文和条件
      vm.statusTitle = vm.status.map((s) => s.t).filter(Boolean).join(' · ') +
        (vm.filterCount ? '\n达标线：' + P.filterText(S.view.filter) : '') + (lens ? '\n看法：' + lens.label + '（' + lens.desc + '）' : '');
      if (active && passCount === 0 && vm.count) vm.status = [{ t: '没有结果过达标线', tone: 'warn' }, { t: P.filterText(S.view.filter) || '', tone: 'dim' }];
      T.renderBar(ui.bar, vm);
      ui.vm = Object.assign(vm, { passCount, view, base, lens, topN, canSort, active });
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
      observeComments(null);
      return;
    }
    if (!hydrated()) return;
    observeComments(list);
    ui.cbar = host('dsp-cbar', list.parentElement, list);
    // 评论在独立的滚动面板里：吸在面板顶部；评论在页面主滚动里：吸在抖音顶栏下面
    const ctop = A.isDocScroller(A.scrollerOf(list)) ? (ui.headerTop || 0) + 'px' : '0px';
    if (ui.cbar.el.style.top !== ctop) ui.cbar.el.style.top = ctop;
    if (!ui.theme) ui.theme = A.pageTheme();
    if (ui.cbar.el.dataset.theme !== ui.theme) ui.cbar.el.dataset.theme = ui.theme;
    // 吸顶时上方留 8px，用评论面板自己的底色填满（不被顶栏压住边框，滚动的评论也不会从缝里露出来）
    if (ui.cbarBgList !== list || ui.cbarBgTheme !== ui.theme || !ui.cbar.el.style.getPropertyValue('--dsp-cbar-bg')) {
      ui.cbarBgList = list; ui.cbarBgTheme = ui.theme;
      ui.cbar.el.style.setProperty('--dsp-cbar-bg', A.bgOf(list.parentElement) || (ui.theme === 'light' ? '#ffffff' : '#161722'));
    }
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
    const cc = currentComments();
    const all = [...cc.map.values()];
    const stats = E.barrierStats(all.length ? all : rows.map((r) => ({ text: r.item.textContent })));
    ui.commentStatsBase = all.length || rows.length; // 门槛词是按多少条统计的
    const m = commentMeta();
    const vid = S.route.modalId || S.route.awemeId || '';
    const raw = store.findVideo(vid);
    const video = raw ? M.derive(raw, Date.now() / 1000) : null;
    const cand = S.candidates.get(vid);
    ui.commentStats = stats;
    CB.render(ui.cb, {
      video, isCand: !!cand, candHasComments: !!(cand && cand.extra && cand.extra.comments),
      mode: CE.state.mode, highlight: CE.state.highlight, hits: ui.commentHits || 0, cursor: ui.commentCursor,
      loaded: Math.max(rows.length, cc.map.size), total: cc.total,
      loading: commentLoader.running, done: !!(m && m.hasMore === false && !commentLoader.running && rows.length >= cc.map.size),
      atCap: !commentLoader.running && rows.length >= COMMENT_CAP,
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
    // 从视频页加入候选：连同评论区门槛词计数和挑出的原评论（高亮中的命中，否则当前排序前 5 条）
    addVideo: () => {
      const vid = S.route.modalId || S.route.awemeId || '';
      const had = S.candidates.has(vid);
      const cc = currentComments();
      // 这条视频的评论还没读到（刚换视频、接口还在路上）：只加视频，不附评论结论，绝不用上一条的评论
      if (!cc.map.size) {
        if (!store.addCandidate(vid)) return announce('没找到这条视频的数据：从搜索结果或博主主页点进来再试', 'warn');
        announce((had ? '已在候选篮' : '已加入候选篮 · 共 ' + S.candidates.size + ' 条') + '。评论还没读到，读到后再点一次可补上评论结论');
        return schedule();
      }
      const k = CE.state.highlight;
      const all = CE.collected();
      const picks = (k ? all.filter((c) => E.barrierHits(c.text).includes(k)) : all).slice(0, 5).map((c) => c.text);
      const rows = A.commentRows().length;
      const comments = { stats: ui.commentStats || {}, loaded: ui.commentStatsBase || Math.max(rows, cc.map.size), total: cc.total, picks };
      if (!store.addCandidate(vid, { comments })) return announce('没找到这条视频的数据：从搜索结果或博主主页点进来再试', 'warn');
      announce(had ? '已更新这条候选的评论结论' : '已加入候选篮（含评论结论）· 共 ' + S.candidates.size + ' 条');
      schedule();
    },
    // 换排序后回到第 1 条（加载中不滚，免得和加载器抢）
    setMode: (m) => {
      CE.setMode(m); ui.commentSig = ''; schedule();
      if (!commentLoader.running) requestAnimationFrame(() => { update(); scrollToCommentTop(); });
    },
    // 点一格：高亮命中的评论，并把第 1 条滚到视野中间闪一下（"1/N"名副其实）
    setHighlight: (k) => {
      CE.setHighlight(CE.state.highlight === k ? null : k);
      ui.commentSig = ''; ui.commentCursor = 0;
      update();
      if (CE.state.highlight) focusHit(0);
    },
    toggleLoad: () => {
      if (commentLoader.running) return commentLoader.stop('user');
      if (A.commentRows().length >= COMMENT_CAP) return announce('评论已经读到上限，门槛词只按已读的统计', 'warn');
      commentLoader.start();
    },
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
    resetView: () => { store.resetView(); announce('已恢复抖音原来的顺序'); requestAnimationFrame(() => { update(); scrollToListTop(); }); },
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
      requestAnimationFrame(() => { update(); scrollToListTop(); }); // 第 1 名滚到工具栏下面
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
      let list = ui.vm ? (ui.vm.active ? ui.vm.view.sorted.map((x) => x.v) : ui.vm.base) : [];
      if (ui.vm && ui.vm.topN) list = list.slice(0, ui.vm.topN); // 账号 Top10 只导出前 10（序号即名次）
      if (!list.length) return announce('还没有可导出的结果', 'warn');
      if (fmt === 'csv') { E.download(E.safeName('抖音_' + (S.sessionLabel || '结果')) + '_' + U.fmtDate(Date.now() / 1000) + '.csv', E.toCsv(list)); announce('已下载 ' + list.length + ' 条'); }
      else copy(E.toTsv(list), '已复制 ' + list.length + ' 条，可以直接粘贴到飞书或 Excel');
    },
    toggleBadges: () => { store.saveSettings({ badges: !S.settings.badges }); },
    // 把排在前面的 N 条一次加入候选（带上名次和看法）
    // 已在篮子里的更新名次；同一来源、同一看法、这次掉出前 N 的标成"已不在前 N 名"——同一账号只留一套名次
    addTop: (n) => {
      const top = (ui.vm ? ui.vm.view.sorted.map((x) => x.v.id) : []).slice(0, n);
      if (!top.length) return;
      const lens = P.matchLens(S.view);
      const label = lens ? lens.label : P.sortText(S.view.sortKeys, S.view.asc);
      const keep = new Set(top);
      const before = []; // [id, 改动前的条目拷贝；新加的为 null]，撤销用
      const snap = (id) => { const c = S.candidates.get(id); return c ? JSON.parse(JSON.stringify(c)) : null; };
      let stale = 0, added = 0, moved = 0, other = 0;
      // 只有"这个会话（含官方筛选）、这个看法下、作为前 N 加入过"的，掉出前 N 才标"已不在"；手动点 ☆ 加的不动
      for (const [id, c] of S.candidates) {
        const x = c.extra || {};
        if (keep.has(id) || !x.topN || x.rankSession !== S.session || x.lensLabel !== label) continue;
        before.push([id, snap(id)]);
        store.addCandidate(id, { rank: 0, rankWas: x.rank, rankStale: x.topN, rankOf: null, topN: 0 });
        stale++;
      }
      for (const id of top) {
        const old = snap(id);
        // 从别的来源（别的关键词、别的筛选、别的博主）加进来的：名次属于那个来源，不改
        if (old && old.srcSession !== S.session) { other++; continue; }
        before.push([id, old]);
        store.addCandidate(id, Object.assign(extraFor(id), { topN: n }));
        if (!old) added++;
        else if ((old.extra || {}).rank !== ui.rank.get(id) || (old.extra || {}).lensLabel !== label) moved++;
      }
      const parts = [];
      if (added) parts.push('加入 ' + added + ' 条');
      if (moved) parts.push(moved + ' 条更新了名次');
      if (stale) parts.push(stale + ' 条已不在前 ' + n + ' 名');
      if (other) parts.push(other + ' 条之前从别处加过，名次不改');
      if (!added && !moved && !stale) return announce('前 ' + n + ' 条都已经在候选篮里了' + (other ? '（' + other + ' 条来自别处）' : '，名次没变'));
      const works = S.route.type === 'profile' && S.profileStats ? S.profileStats.works : 0;
      const count = ui.vm ? ui.vm.count : 0;
      const partial = works > count ? '（只按已读 ' + count + ' / ' + works + ' 条，读完后可以再加一次更新名次）' : '';
      announce(parts.join('，') + ' · 共 ' + S.candidates.size + ' 条' + partial, '', { label: '撤销', run: () => {
        store.removeCandidates(before.filter((e) => !e[1]).map((e) => e[0]));
        store.restoreCandidates(before.filter((e) => e[1]));
      } });
    },
    showGuide: () => { store.saveSettings({ guideDone: false }); schedule(); },
    toggleCustom: (open) => { ui.customOpen = open; reopen(); },
    pause: () => {
      setEnabled(false);
      announce('插件已暂停，抖音页面已还原', '', { label: '撤销', run: () => setEnabled(true) });
    },
  };

  function openPanel(kind, anchor) {
    if (ui.pop && ui.pop.kind === kind && isOpen(ui.pop.panel)) { closePop(true); ui.pop = null; return; }
    if ((kind === 'sort' || kind === 'filter') && ui.vm && ui.vm.canSort === false) {
      return announce('「综合」标签是瀑布流，插件没法重新排列。切到「视频」标签就能按收藏率排序、设达标线', '', { label: '切到视频', run: switchToVideoTab });
    }
    C.hideDetail(true);
    const vm = popVm();
    let panel, opts = { layer: ui.layer, onClose: () => { if (ui.pop && ui.pop.panel === panel) ui.pop = null; } };
    if (kind === 'sort') { panel = T.sortPanel(vm, barApi); opts.label = '排序'; }
    else if (kind === 'filter') { panel = T.filterPanel(vm, barApi); opts.label = '达标线'; }
    else if (kind === 'more') { panel = T.morePanel(vm, barApi); opts.label = '更多'; opts.placement = 'below-end'; }
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
      type: S.route.type, lens: v.lens ? v.lens.key : '', sortKeys: S.view.sortKeys, sorted: S.view.sortKeys.length > 0, asc: S.view.asc, combo: ui.combo,
      filter: S.view.filter, passCount: v.passCount || 0, count: v.count || 0, badges: S.settings.badges,
      works: S.route.type === 'profile' && S.profileStats ? S.profileStats.works : 0,
      lowSample: (v.tiers && v.tiers.na) || 0, customOpen: ui.customOpen == null ? null : ui.customOpen,
    };
  }

  // 点分布条的一段：只看这一档。和当前看法自带的收藏率条件冲突时（例如真需求要求 ≥80%，却点了"一般"），
  // 去掉那条收藏率条件并说清楚，不叠加出一个必然为空的结果
  function onTier(k) {
    const f = S.view.filter;
    if (f.tier === k) { store.setFilter(Object.assign({}, f, { tier: '' })); return; }
    const patch = { tier: k };
    let note = '';
    if (f.minCr && k !== 'high') { patch.minCr = 0; note = '，已去掉「收藏率 ≥ 80%」'; }
    store.setFilter(Object.assign({}, f, patch));
    announce('只看「' + M.CR_TIERS[k].label + '」档' + note);
    scrollToListTop();
  }

  // ---------------- 候选篮 ----------------
  // 加入候选时记下上下文：名次与看法、账号快照、占账号总获赞（入库包里会写出来）
  function extraFor(id) {
    const x = {};
    const r = ui.rank && ui.rank.get(id);
    if (r && S.view.sortKeys.length) {
      x.rank = r;
      x.rankStale = 0;
      x.rankWas = 0;
      x.topN = 0; // 手动加入；"把前 N 条加入候选"会改成 N
      x.rankSession = S.session;
      const lens = P.matchLens(S.view);
      x.lensLabel = lens ? lens.label : P.sortText(S.view.sortKeys, S.view.asc);
      // 名次是在"当时读到的这些"里排的：记下读了多少、账号一共多少
      x.rankOf = { count: ui.vm ? ui.vm.count : 0, total: S.route.type === 'profile' && S.profileStats ? S.profileStats.works : 0 };
    }
    if (S.route.type === 'profile') {
      const ps = A.profileStats();
      if (ps) {
        x.account = Object.assign({ at: Date.now() / 1000 }, ps);
        const v = store.derived().byId.get(id);
        if (v && ps.likes && v.digg != null) x.share = v.digg / ps.likes;
      }
    }
    return x;
  }
  function toggleCandidate(id, btn) {
    if (S.candidates.has(id)) {
      const keep = S.candidates.get(id);
      store.removeCandidate(id);
      announce('已移出候选篮', '', { label: '撤销', run: () => store.restoreCandidates([[id, keep]]) });
    } else if (store.addCandidate(id, extraFor(id))) {
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
    markdown: () => E.toMarkdown(toCopy(), { now: Date.now() / 1000 }),
    // 默认只复制还没复制过的；all=true 时全部再复制一次。复制后标记"已复制"，提示里可以一键移出
    // 入库包默认只给还没交给 Agent 的（新加的、有更新的），并记下"已复制"；
    // 表格和 JSON 一律复制全部（和预览、下载 CSV 一致），也不改"已复制"标记
    copy: async (fmt, btn, all) => {
      const list = fmt === 'md' && !all ? toCopy() : store.candidateList();
      const text = fmt === 'md' ? E.toMarkdown(list, { now: Date.now() / 1000 }) : fmt === 'json' ? E.toJson(list, { now: Date.now() / 1000 }) : E.toTsv(list);
      const ok = await copy(text, null, btn);
      if (!ok) return;
      const ids = list.map((v) => v.id);
      if (fmt === 'md') store.markCopied(ids);
      reopen();
      const what = fmt === 'md' ? '入库包已复制（' + ids.length + ' 条）：粘贴给 Agent，说「添加选题」' : fmt === 'json' ? '已复制 JSON（' + ids.length + ' 条）' : '已复制 ' + ids.length + ' 条，可以直接粘贴到飞书或 Excel';
      announce(what, '', { label: '移出这 ' + ids.length + ' 条', run: () => {
        const backup = ids.map((id) => [id, S.candidates.get(id)]).filter((e) => e[1]);
        store.removeCandidates(ids);
        reopen();
        announce('已移出 ' + backup.length + ' 条', '', { label: '撤销', run: () => { store.restoreCandidates(backup); reopen(); } });
      } });
    },
    downloadCsv: () => { const list = store.candidateList(); E.download('选题候选_' + U.fmtDate(Date.now() / 1000) + '.csv', E.toCsv(list)); announce('已下载 ' + list.length + ' 条'); },
  };
  function toCopy() {
    const all = store.candidateList();
    const fresh = all.filter((c) => c.fresh);
    return fresh.length ? fresh : all;
  }

  async function copy(text, msg, btn) {
    const ok = await E.copyText(text);
    if (!ok) announce('复制失败：浏览器没有给剪贴板权限，可以改用下载', 'warn');
    else if (msg) announce(msg);
    if (ok && btn && btn.isConnected && btn.animate && !kit.reducedMotion()) btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(.96)' }, { transform: 'scale(1)' }], { duration: 180 });
    return ok;
  }

  function copyDiagnostics(btn) {
    const type = S.route.type === 'profile' ? 'profile' : 'search';
    const report = Object.assign({ version: version(), ua: navigator.userAgent.replace(/\s+/g, ' ').slice(0, 160), time: new Date().toISOString(), count: S.videos.size, bridge: DSP.meta.bridgeSeen, meta: { search: DSP.meta.search, profile: DSP.meta.profile } }, A.diagnose(type));
    copy('DouyinSearchPlus 诊断信息（不含任何内容和账号信息）\n' + JSON.stringify(report, null, 2), '诊断信息已复制，可以粘贴到 GitHub issue 或发给 Claude', btn);
  }

  // ---------------- 首次引导 ----------------
  // 工具栏下方的一条横条（在页面流里，不浮在卡片和弹层上）；点"知道了"或第一次用排序看法后不再出现
  function renderGuide(health) {
    // 引导放在单独的、不吸顶的宿主里（工具栏下方、列表上方），往下滚时跟着页面走，不长期占顶部空间
    // 引导讲的是"排序 → 真需求"，排不动的页面（综合标签）先不出
    const want = !S.settings.guideDone && health === 'ok' && ui.bar && ui.listEl && ui.listEl.isConnected && !(ui.vm && ui.vm.canSort === false);
    if (!want) {
      if (ui.guideHost) { ui.guideHost.el.remove(); ui.guideHost = null; }
      ui.guide = null;
      return;
    }
    ui.guideHost = host('dsp-guide', ui.listEl.parentElement, ui.listEl);
    if (ui.guideHost.el.dataset.theme !== ui.theme) ui.guideHost.el.dataset.theme = ui.theme || 'dark';
    const lay = ui.guideHost.root.querySelector('.dsp-layer') || ui.guideHost.root.appendChild(h('div', { class: 'dsp-layer' }));
    if (ui.guide && ui.guide.isConnected) return;
    const step = (n, a, b) => h('li', null, h('i', null, String(n)), h('b', null, a), h('span', null, b));
    ui.guide = h('div', { class: 'guide', role: 'note', 'aria-label': '三步上手' },
      h('span', { class: 'guide-h' }, '三步上手'),
      h('ol', null,
        step(1, '继续加载', '先多读一些，排名才靠谱'),
        step(2, '排序 → 真需求', '收藏率 ≥80% 的视频按收藏数排好'),
        step(3, '☆ 候选 → 复制入库包', '攒好后一次性给 Agent')),
      h('button', { class: 'btn sm', type: 'button', 'data-dsp': 'guide-ok', onclick: () => guideDone() }, '知道了'));
    clear(lay).appendChild(ui.guide);
  }
  function guideDone() {
    if (!S.settings.guideDone) store.saveSettings({ guideDone: true });
    if (ui.guideHost) { ui.guideHost.el.remove(); ui.guideHost = null; }
    ui.guide = null;
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
.guide { display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 14px; border-radius: 12px; background: var(--s1); box-shadow: inset 0 0 0 1px var(--line);
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
