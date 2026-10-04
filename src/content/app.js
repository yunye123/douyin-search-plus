// 启动与调度（隔离世界，最后加载）。
// document_start 就注册消息监听（数据桥早期发来的数据不会丢），界面等页面 body 就绪后再挂。
// 调度是事件驱动的：数据到达、路由变化、列表 DOM 变化（节流），外加低频自检。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  if (DSP.__started) return;
  DSP.__started = true;

  const { store, util } = DSP;
  const { trap, log } = util;
  const root = document.documentElement;

  // ---------- 与数据桥通信 ----------
  // 只收本窗口发来的、结构正确的消息（防误收；页面脚本理论上能伪造，这不是安全边界，所有渲染都只用 textContent）
  const meta = { search: null, profile: null, comments: null, lastAt: 0, bridgeSeen: false };
  DSP.meta = meta;
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    if (d.ns === 'dsp-bridge' && d.v === 1) {
      meta.bridgeSeen = true;
      trap('intake', () => {
        if (!store.S.settings.enabled) return;
        if (d.type === 'videos' && Array.isArray(d.items)) {
          if (d.ctx && d.ctx.meta && d.ctx.endpoint) { meta[d.ctx.endpoint] = d.ctx.meta; meta.lastAt = Date.now(); }
          store.intakeVideos(d.ctx, d.items.filter(validVideo));
        } else if (d.type === 'comments' && Array.isArray(d.items)) {
          if (d.meta) meta.comments = d.meta;
          store.intakeComments({ awemeId: d.awemeId, total: d.total, items: d.items.filter(validComment) });
        }
      });
    } else if (d.ns === 'dsp-test' && d.type === 'state?' && root.dataset.dspTest === '1') {
      // 仅测试：Playwright 在页面主世界读不到隔离世界的状态，通过这个通道取快照
      window.postMessage({ ns: 'dsp-test', type: 'state', state: snapshot() }, location.origin);
    }
  });
  const isNum = (x) => x === null || (typeof x === 'number' && isFinite(x) && x >= 0);
  function validVideo(it) {
    return it && typeof it.id === 'string' && /^\d{8,25}$/.test(it.id) && isNum(it.digg) && isNum(it.collect) && isNum(it.comment) && isNum(it.share);
  }
  function validComment(c) {
    return c && typeof c.cid === 'string' && typeof c.text === 'string' && isNum(c.digg);
  }
  function hello() {
    try { root.dataset.dspReady = '1'; } catch (e) { /* 忽略 */ }
    window.postMessage({ ns: 'dsp-content', type: 'hello' }, location.origin);
  }
  DSP.requestRescan = () => window.postMessage({ ns: 'dsp-content', type: 'rescan' }, location.origin);

  // ---------- 路由（SPA 导航） ----------
  let lastHref = '';
  function checkRoute() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    store.setRoute(store.routeOf(location));
  }

  // ---------- 测试快照 ----------
  function snapshot() {
    const S = store.S;
    const v = store.viewOf();
    return {
      route: S.route, session: S.session, label: S.sessionLabel,
      count: S.videos.size, version: S.version,
      view: { sortKeys: S.view.sortKeys, asc: S.view.asc, filter: S.view.filter, active: S.view.active },
      sortedIds: v.sorted.map((x) => x.v.id), restIds: v.rest.map((x) => x.id),
      comments: { awemeId: S.comments.awemeId, count: S.comments.map.size, total: S.comments.total },
      candidates: [...S.candidates.keys()],
      settings: S.settings,
      meta: { search: meta.search, profile: meta.profile, bridgeSeen: meta.bridgeSeen },
      ui: DSP.ui && DSP.ui.debugState ? DSP.ui.debugState() : null,
      err: root.dataset.dspErr || '',
    };
  }
  DSP.snapshot = snapshot;

  // ---------- 启动 ----------
  hello();
  checkRoute();
  store.load().then(() => {
    hello();
    const boot = () => trap('boot', () => {
      if (DSP.ui && DSP.ui.mount) DSP.ui.mount();
      setInterval(() => trap('route', checkRoute), 400);
      log('DouyinSearchPlus 已就绪', chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '');
    });
    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot, { once: true });
  });
})();
