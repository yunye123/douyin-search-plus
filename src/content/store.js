// 状态中心：页面路由与会话、视频数据、评论数据、用户设置、候选篮。
// 设置和候选篮存 chrome.storage.local（跨标签页同步）；会话数据只在内存里。
// 不碰 DOM，Node 单测里没有 chrome 时自动退回内存存储。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  const U = DSP.util || (typeof require === 'function' ? require('./util.js') : null);
  const M = DSP.metrics || (typeof require === 'function' ? require('./metrics.js') : null);

  // ---------------- 路由 ----------------
  // 关键词统一规范化：URL 解码、+ 当空格、去首尾空白、合并连续空白
  function normKw(s) {
    let t = String(s || '');
    try { t = decodeURIComponent(t.replace(/\+/g, ' ')); } catch (e) { t = t.replace(/\+/g, ' '); }
    return t.replace(/\s+/g, ' ').trim();
  }
  // 官方筛选参数规范化：键排序后序列化，避免同一筛选因字段顺序不同被当成新会话
  function normFilter(s) {
    if (!s) return '';
    try {
      const o = typeof s === 'string' ? JSON.parse(s) : s;
      if (!o || typeof o !== 'object') return '';
      const keys = Object.keys(o).filter((k) => o[k] !== '' && o[k] != null && String(o[k]) !== '0').sort();
      return keys.map((k) => k + '=' + o[k]).join('&');
    } catch (e) { return String(s); }
  }
  function routeOf(loc) {
    const path = loc.pathname || '/';
    const qs = new URLSearchParams(loc.search || '');
    const seg = path.split('/');
    const modal = qs.get('modal_id') || '';
    if (seg[1] === 'search' && seg[2]) return { type: 'search', kw: normKw(seg[2]), modalId: modal };
    if (seg[1] === 'user' && seg[2]) return { type: 'profile', secUid: seg[2], modalId: modal };
    if ((seg[1] === 'video' || seg[1] === 'note') && /^\d+$/.test(seg[2] || '')) return { type: 'video', awemeId: seg[2], modalId: modal };
    return { type: 'other', modalId: modal };
  }

  // ---------------- 状态 ----------------
  const DEFAULT_SETTINGS = {
    enabled: true,        // 总开关
    badges: true,         // 卡片数据角标
    loadCap: 200,         // 自动加载上限（条）
    guideDone: false,     // 首次引导是否已看过
    collapsed: false,     // 工具栏是否收起
    sortKeys: ['cr'],     // 上次的排序维度（下次打开时作为默认建议，不自动接管页面）
    asc: false,
  };

  const ev = U.emitter();
  const S = {
    route: { type: 'other' },
    session: '',            // 当前会话签名
    sessionLabel: '',       // 给人看的会话描述：搜索「xx」/ @作者
    videos: new Map(),      // id -> 原始记录（含 capturedAt）
    version: 0,             // 数据版本，变了才重算派生指标
    view: { sortKeys: [], asc: false, filter: M.normFilter(null), active: false },
    comments: { awemeId: '', map: new Map(), total: 0, version: 0 },
    settings: Object.assign({}, DEFAULT_SETTINGS),
    candidates: new Map(),  // id -> { rec, addedAt, source }
    profileStats: null,     // { likes, fans, works }（主页头部读到的账号数据）
  };
  // 最近 3 个会话的数据缓存：回到上一个关键词时立即恢复，不必重新加载
  const recent = new Map();

  const now = () => Date.now() / 1000;

  function sessionOf(route, filter) {
    if (route.type === 'search') return 'search|' + route.kw + '|' + (filter || '');
    if (route.type === 'profile') return 'profile|' + route.secUid;
    return '';
  }

  function setSession(key, label) {
    if (key === S.session) return false;
    if (S.session && S.videos.size) {
      recent.set(S.session, { videos: S.videos, label: S.sessionLabel });
      while (recent.size > 3) recent.delete(recent.keys().next().value);
    }
    const cached = recent.get(key);
    S.session = key;
    S.sessionLabel = label || (cached && cached.label) || '';
    S.videos = cached ? cached.videos : new Map();
    recent.delete(key);
    S.version++;
    ev.emit('session', key);
    ev.emit('data');
    return true;
  }

  // 路由变化（SPA 导航）时调用
  function setRoute(route) {
    const prev = S.route;
    S.route = route;
    if (route.type === 'search') {
      // 换关键词时先切到"无筛选"会话；真正的筛选由接口数据带回来再切
      const sameKw = prev.type === 'search' && prev.kw === route.kw;
      const filter = sameKw ? (S.session.split('|')[2] || '') : '';
      setSession(sessionOf(route, filter), '搜索「' + route.kw + '」');
    } else if (route.type === 'profile') {
      setSession(sessionOf(route), S.route.secUid === (prev && prev.secUid) ? S.sessionLabel : '');
    }
    if (route.type !== prev.type || route.kw !== prev.kw || route.secUid !== prev.secUid || route.awemeId !== prev.awemeId) {
      S.profileStats = route.type === 'profile' ? S.profileStats : null;
      ev.emit('route', route);
    }
  }

  // ---------------- 数据进入 ----------------
  // 归属校验：只收当前页面的数据；迟到的旧会话响应直接丢弃（不清空当前数据）
  function intakeVideos(ctx, items) {
    const r = S.route;
    ctx = ctx || {};
    if (!Array.isArray(items) || !items.length) return 0;
    if (r.type === 'search') {
      if (ctx.endpoint && ctx.endpoint !== 'search' && ctx.source === 'api') return 0;
      if (ctx.kw != null && normKw(ctx.kw) !== r.kw) return 0;
      if (ctx.source === 'fiber' && ctx.path && ctx.path.indexOf('/search/') !== 0) return 0;
      const key = sessionOf(r, normFilter(ctx.filter));
      setSession(key, '搜索「' + r.kw + '」');
    } else if (r.type === 'profile') {
      if (ctx.source === 'api' && ctx.endpoint !== 'profile') return 0;
      if (ctx.source === 'fiber' && ctx.path && ctx.path.indexOf('/user/') !== 0) return 0;
      if (ctx.secUid && r.secUid !== 'self' && ctx.secUid !== r.secUid) return 0;
    } else {
      return 0;
    }
    const t = now();
    let changed = 0;
    for (const it of items) {
      if (!it || !it.id) continue;
      const old = S.videos.get(it.id);
      // 合并：新数据里非空的字段覆盖旧值（fiber 与接口互补，例如接口有封面、fiber 有最新计数）
      const rec = Object.assign({}, old || {}, stripEmpty(it));
      for (const k of COUNTS) if (rec[k] === undefined) rec[k] = null;
      if (!old) rec.capturedAt = t;
      else if (old.digg !== rec.digg || old.collect !== rec.collect || old.comment !== rec.comment || old.share !== rec.share) rec.capturedAt = t;
      if (!old || changedRec(old, rec)) { S.videos.set(it.id, rec); changed++; }
      if (r.type === 'profile' && !S.sessionLabel && rec.author) S.sessionLabel = '@' + rec.author;
    }
    if (changed) { S.version++; ev.emit('data'); }
    return changed;
  }
  // 合并前去掉空值：新数据里缺的字段沿用旧值。计数为 0 是真实的 0，要保留；缺失（null）不覆盖
  const COUNTS = ['digg', 'comment', 'collect', 'share'];
  function stripEmpty(o) {
    const out = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v === '' || v == null) continue;
      if (v === 0 && COUNTS.indexOf(k) < 0) continue;
      out[k] = v;
    }
    return out;
  }
  function changedRec(a, b) {
    for (const k of ['digg', 'comment', 'collect', 'share', 'desc', 'cover', 'author', 'createTime', 'durationMs', 'kind']) if (a[k] !== b[k]) return true;
    return false;
  }

  function intakeComments(msg) {
    const r = S.route;
    const vid = r.modalId || r.awemeId || '';
    const aid = String(msg.awemeId || '');
    if (vid && aid && aid !== vid) return 0;
    const C = S.comments;
    const target = aid || vid;
    if (target && target !== C.awemeId) { C.awemeId = target; C.map = new Map(); C.total = 0; }
    if (msg.total) C.total = Math.max(C.total, msg.total);
    let n = 0;
    for (const c of msg.items || []) {
      if (!c || !c.cid) continue;
      const old = C.map.get(c.cid);
      if (!old || old.digg !== c.digg || old.replies !== c.replies) { C.map.set(c.cid, Object.assign({}, old || {}, c)); n++; }
    }
    if (n) { C.version++; ev.emit('comments'); }
    return n;
  }

  // ---------------- 派生数据（带缓存） ----------------
  let cache = { version: -1, list: [], marks: new Map() };
  function derived() {
    if (cache.version === S.version) return cache;
    const t = now();
    const list = [...S.videos.values()].map((v) => M.derive(v, t));
    cache = { version: S.version, list, byId: new Map(list.map((v) => [v.id, v])), marks: M.marks(list, t) };
    return cache;
  }

  // 当前视图：筛选 + 排序。ids 给出时只看这些（主页：以页面上实际显示的作品为准）
  function viewOf(ids) {
    const d = derived();
    const base = ids ? ids.map((id) => d.byId.get(id)).filter(Boolean) : d.list;
    const pass = M.filterList(base, S.view.filter);
    const passSet = new Set(pass.map((v) => v.id));
    const sorted = M.sortList(pass, S.view.sortKeys, S.view.asc);
    const rest = base.filter((v) => !passSet.has(v.id));
    return { sorted, rest, total: base.length, summary: M.summarize(base), marks: d.marks };
  }

  // ---------------- 视图操作 ----------------
  function setSort(keys, asc) {
    S.view.sortKeys = (keys || []).filter((k) => M.METRICS[k]);
    if (typeof asc === 'boolean') S.view.asc = asc;
    S.view.active = S.view.sortKeys.length > 0 || M.activeFilterCount(S.view.filter) > 0;
    if (S.view.sortKeys.length) saveSettings({ sortKeys: S.view.sortKeys.slice(), asc: S.view.asc });
    ev.emit('view');
  }
  function setFilter(f) {
    S.view.filter = M.normFilter(f);
    S.view.active = S.view.sortKeys.length > 0 || M.activeFilterCount(S.view.filter) > 0;
    ev.emit('view');
  }
  function resetView() {
    S.view = { sortKeys: [], asc: false, filter: M.normFilter(null), active: false };
    ev.emit('view');
  }

  // ---------------- 持久化（设置 + 候选篮） ----------------
  const hasChrome = () => typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const KEY_SETTINGS = 'dsp.settings';
  const KEY_CANDS = 'dsp.candidates';
  const MAX_CANDS = 500;

  function saveSettings(patch) {
    Object.assign(S.settings, patch);
    if (hasChrome()) { try { chrome.storage.local.set({ [KEY_SETTINGS]: S.settings }); } catch (e) { /* 扩展被重载时会失效，忽略 */ } }
    ev.emit('settings', patch);
  }
  function persistCandidates() {
    if (!hasChrome()) return;
    const arr = [...S.candidates.values()].slice(-MAX_CANDS);
    try { chrome.storage.local.set({ [KEY_CANDS]: arr }); } catch (e) { /* 忽略 */ }
  }
  function addCandidate(id) {
    const d = derived();
    const v = d.byId.get(id) || (S.candidates.get(id) && S.candidates.get(id).rec);
    if (!v) return false;
    if (S.candidates.has(id)) return true;
    const rec = {};
    for (const k of ['id', 'kind', 'desc', 'author', 'authorId', 'createTime', 'durationMs', 'cover', 'digg', 'comment', 'collect', 'share', 'capturedAt']) rec[k] = v[k];
    S.candidates.set(id, { rec, addedAt: now(), source: S.sessionLabel });
    persistCandidates();
    ev.emit('candidates');
    return true;
  }
  function removeCandidate(id) {
    if (!S.candidates.delete(id)) return;
    persistCandidates();
    ev.emit('candidates');
  }
  function clearCandidates() {
    S.candidates.clear();
    persistCandidates();
    ev.emit('candidates');
  }
  // 候选篮里的记录：派生指标按"采集时"计算（D+N 与比率对应同一时刻）
  function candidateList() {
    const t = now();
    return [...S.candidates.values()].map((c) => Object.assign(M.derive(c.rec, t), { addedAt: c.addedAt, source: c.source }));
  }

  function load() {
    return new Promise((resolve) => {
      if (!hasChrome()) return resolve();
      try {
        chrome.storage.local.get([KEY_SETTINGS, KEY_CANDS], (res) => {
          if (res && res[KEY_SETTINGS]) Object.assign(S.settings, res[KEY_SETTINGS]);
          if (res && Array.isArray(res[KEY_CANDS])) {
            S.candidates = new Map(res[KEY_CANDS].filter((c) => c && c.rec && c.rec.id).map((c) => [c.rec.id, c]));
          }
          resolve();
        });
        // 其他标签页 / 扩展弹窗改了设置或候选篮，这里同步
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local') return;
          if (changes[KEY_SETTINGS] && changes[KEY_SETTINGS].newValue) {
            const prev = S.settings.enabled;
            Object.assign(S.settings, changes[KEY_SETTINGS].newValue);
            ev.emit('settings', { remote: true, enabledChanged: prev !== S.settings.enabled });
          }
          if (changes[KEY_CANDS]) {
            const arr = changes[KEY_CANDS].newValue || [];
            S.candidates = new Map(arr.filter((c) => c && c.rec && c.rec.id).map((c) => [c.rec.id, c]));
            ev.emit('candidates');
          }
        });
      } catch (e) { resolve(); }
    });
  }

  DSP.store = {
    S, on: ev.on, emit: ev.emit,
    routeOf, normKw, normFilter, setRoute, intakeVideos, intakeComments,
    derived, viewOf, setSort, setFilter, resetView,
    saveSettings, addCandidate, removeCandidate, clearCandidates, candidateList, load,
    DEFAULT_SETTINGS,
  };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') module.exports = DSP.store;
})();
