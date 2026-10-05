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
        // SPA 导航后，抖音的新数据可能比路由轮询先到：收数据前先同步核对一次地址
        checkRoute();
        if (d.type === 'videos' && Array.isArray(d.items)) {
          if (d.ctx && d.ctx.meta && d.ctx.endpoint) { meta[d.ctx.endpoint] = d.ctx.meta; meta.lastAt = Date.now(); }
          const items = d.items.filter(validVideo);
          if (!store.intakeVideos(d.ctx, items) && items.length) {
            // 没收下（可能是还没切过去的新页面的数据）：暂存，路由变化后重放
            pending.push({ ctx: d.ctx, items, at: Date.now() });
            if (pending.length > 12) pending.shift();
          }
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
  const pending = []; // 暂存的未收批次（最多 12 批、30 秒内有效）
  function checkRoute() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    store.setRoute(store.routeOf(location));
    // 重放：之前因为"还不是当前页面"而没收的数据，现在可能属于当前页面了
    const now = Date.now();
    const replay = pending.splice(0).filter((b) => now - b.at < 30000);
    for (const b of replay) store.intakeVideos(b.ctx, b.items);
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

  // ---------- 扩展弹窗询问当前页状态 ----------
  // 插件在扩展管理页被重载后，旧页面里的内容脚本与扩展断开（chrome.runtime.id 变成 undefined），
  // 界面据此提示"插件已更新，请刷新页面"，并停止一切加载
  DSP.alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } };
  function status() {
    const S = store.S;
    const v = store.viewOf();
    const M = DSP.metrics;
    const keys = S.view.sortKeys;
    return {
      type: S.route.type,
      label: S.sessionLabel,
      count: S.videos.size,
      strongNeed: S.videos.size ? v.summary.strongNeed : null,
      // 和页面工具栏同一个说法：有看法时用看法名（「真需求」），否则列出指标
      sortLabel: (() => { const l = DSP.presenter.matchLens(S.view); return l ? '「' + l.label + '」' : keys.length ? keys.map((k) => M.METRICS[k].label).join(' + ') : ''; })(),
      comments: S.comments.map.size,
      candidates: S.candidates.size,
      health: DSP.ui && DSP.ui.health ? DSP.ui.health() : 'ok',
    };
  }
  try {
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg && msg.type === 'dsp:status') { reply(trap('status', status) || {}); return false; }
      return false;
    });
  } catch (e) { /* 忽略 */ }

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
