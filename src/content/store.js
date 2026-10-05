// 状态中心：页面路由与会话、视频数据、评论数据、用户设置、候选篮。
// 设置和候选篮存 chrome.storage.local（跨标签页同步）；会话数据只在内存里。
// 不碰 DOM，Node 单测里没有 chrome 时自动退回内存存储。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  const U = DSP.util || (typeof require === 'function' ? require('./util.js') : null);
  const M = DSP.metrics || (typeof require === 'function' ? require('./metrics.js') : null);

  // ---------------- 路由 ----------------
  // 关键词规范化。只在一处解码：地址路径段用 decodeURIComponent（路径里的 + 就是加号，不是空格），
  // 接口参数和数据桥送来的关键词已经解码过，只合并空白。"AI+办公""C++"这类词因此不会被误判成别的关键词。
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  function normKw(pathSeg) {
    let t = String(pathSeg || '');
    try { t = decodeURIComponent(t); } catch (e) { /* 不是合法编码就按原样 */ }
    return squash(t);
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
  // 抖音官方筛选 → 给人看的名字（来源名里用，例如 搜索「kw」· 一周内 · 最多点赞）
  const FILTER_NAMES = {
    publish_time: { 1: '一天内', 7: '一周内', 180: '半年内' },
    sort_type: { 1: '最多点赞', 2: '最新发布' },
    filter_duration: { '0-1': '1 分钟以内', '1-5': '1~5 分钟', '5-10000': '5 分钟以上' },
  };
  function filterLabel(nf) {
    if (!nf) return '';
    const names = nf.split('&').map((kv) => { const [k, v] = kv.split('='); return (FILTER_NAMES[k] && FILTER_NAMES[k][v]) || ''; });
    const known = names.filter(Boolean);
    return known.length ? ' · ' + known.join(' · ') : ' · 已筛选';
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
    loadCap: 100,         // 自动加载上限（条）：搜索页默认 100，主页按 3 倍（最多 600）
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
    // 打开/关闭/切换视频弹层（modal_id）也算路由变化：评论加载要停，评论模式要清
    if (route.type !== prev.type || route.kw !== prev.kw || route.secUid !== prev.secUid || route.awemeId !== prev.awemeId || route.modalId !== prev.modalId) {
      if (route.secUid !== prev.secUid) S.profileStats = null; // 换博主：账号总获赞要重读
      // 换了一条视频：立刻清掉上一条的评论数据（不等新评论到达），门槛词计数、加入候选都不会用到上一条的
      const vid = route.modalId || route.awemeId || '';
      if (vid && vid !== S.comments.awemeId) resetComments(vid);
      ev.emit('route', route);
    }
  }

  // ---------------- 数据进入 ----------------
  // 归属校验：只收当前页面的数据；迟到的旧会话响应直接丢弃（不清空当前数据）
  function intakeVideos(ctx, items) {
    const r = S.route;
    ctx = ctx || {};
    if (!Array.isArray(items) || !items.length) return 0;
    if (ctx.endpoint === 'detail') return intakeDetail(items);
    if (r.type === 'search') {
      if (ctx.endpoint && ctx.endpoint !== 'search' && ctx.source === 'api') return 0;
      if (ctx.kw != null && squash(ctx.kw) !== r.kw) return 0;
      if (ctx.source === 'fiber' && ctx.path && ctx.path.indexOf('/search/') !== 0) return 0;
      const key = sessionOf(r, normFilter(ctx.filter));
      // 只有"第一页"的接口响应能切换官方筛选会话；翻页响应（offset>0）的筛选和当前会话对不上，
      // 说明是切换筛选前发出的旧请求晚到了，直接丢弃，不把会话切回去
      if (key !== S.session && ctx.source === 'api' && Number(ctx.offset) > 0) return 0;
      setSession(key, '搜索「' + r.kw + '」' + filterLabel(normFilter(ctx.filter)));
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
    if (changed) { S.version++; ev.emit('data'); rememberSeen(items.map((it) => S.videos.get(it.id))); }
    return changed;
  }
  // 单条视频详情（视频页、弹层里读到的）：不进当前搜索/主页会话，只供视频页显示收藏率、加入候选
  const details = new Map();
  function intakeDetail(items) {
    const t = now();
    const recs = [];
    for (const it of items) {
      if (!it || !it.id) continue;
      const rec = Object.assign({}, findVideo(it.id) || {}, stripEmpty(it), { capturedAt: t });
      for (const k of COUNTS) if (rec[k] === undefined) rec[k] = null;
      details.delete(it.id);
      details.set(it.id, rec);
      recs.push(rec);
    }
    while (details.size > 50) details.delete(details.keys().next().value);
    if (recs.length) { S.version++; ev.emit('data'); rememberSeen(recs); }
    return recs.length;
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

  function resetComments(vid) {
    const C = S.comments;
    C.awemeId = vid; C.map = new Map(); C.total = 0; C.version++;
    ev.emit('comments');
  }
  function intakeComments(msg) {
    const r = S.route;
    const vid = r.modalId || r.awemeId || '';
    const aid = String(msg.awemeId || '');
    if (vid && aid && aid !== vid) return 0;
    const C = S.comments;
    const target = aid || vid;
    if (target && target !== C.awemeId) resetComments(target);
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
  // 交给过 Agent 的作品（id → 复制时间），最多 2000 条。移出候选、清空候选篮都不删：
  // 之后再加入同一条，入库包会写"之前交给过你，请更新原条目"，Agent 不会建重复条目
  const KEY_HANDED = 'dsp.handed';
  const MAX_HANDED = 2000;
  let handed = new Map();
  function persistHanded() {
    while (handed.size > MAX_HANDED) handed.delete(handed.keys().next().value);
    if (!hasChrome()) return;
    try { chrome.storage.local.set({ [KEY_HANDED]: [...handed] }); } catch (e) { /* 忽略 */ }
  }

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
  // 按 id 找视频：当前会话 → 最近几个会话 → 候选篮（从搜索页点进视频页时，用刚才读到的数据）
  function findVideo(id) {
    if (!id) return null;
    if (details.has(id)) return details.get(id); // 详情是单独读的，最新
    if (S.videos.has(id)) return S.videos.get(id);
    for (const c of recent.values()) if (c.videos.has(id)) return c.videos.get(id);
    const cand = S.candidates.get(id);
    if (cand) return cand.rec;
    return seen.get(id) || null;
  }

  // 最近读到过的视频（精简记录，最多 300 条，存本机）：在新标签页打开视频时，视频页也能显示收藏率
  const KEY_SEEN = 'dsp.seen';
  const MAX_SEEN = 300;
  let seen = new Map();
  let seenTimer = 0;
  const SEEN_FIELDS = ['id', 'kind', 'desc', 'author', 'authorId', 'createTime', 'durationMs', 'cover', 'digg', 'comment', 'collect', 'share', 'capturedAt'];
  function rememberSeen(recs) {
    for (const v of recs) {
      if (!v || !v.id) continue;
      const r = {};
      for (const k of SEEN_FIELDS) r[k] = v[k];
      seen.delete(v.id);
      seen.set(v.id, r);
    }
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
    if (!hasChrome() || seenTimer) return;
    // 写入节流：5 秒最多一次
    seenTimer = setTimeout(() => {
      seenTimer = 0;
      try { chrome.storage.local.set({ [KEY_SEEN]: [...seen.values()] }); } catch (e) { /* 扩展被重载时会失效，忽略 */ }
    }, 5000);
  }

  // extra：加入时的上下文（都可省略）
  //   rank / lensLabel：当时的名次与排序看法；account：账号快照 { fans, likes, works }；share：占账号总获赞；
  //   comments：评论区诊断 { stats, loaded, total, picks: [原评论...] }
  function addCandidate(id, extra) {
    const v = derived().byId.get(id) || findVideo(id);
    if (!v) return false;
    const old = S.candidates.get(id);
    if (old && !extra) return true;
    const rec = {};
    for (const k of ['id', 'kind', 'desc', 'author', 'authorId', 'createTime', 'durationMs', 'cover', 'digg', 'comment', 'collect', 'share', 'capturedAt']) rec[k] = v[k];
    const entry = old || { rec, addedAt: now(), source: S.sessionLabel, srcType: S.route.type, srcSession: S.session };
    // 移出过、之前已经交给过 Agent 的：带回复制时间，并作为"更新"再给一次（不当成新选题）
    if (!old && handed.has(id)) {
      entry.copiedAt = handed.get(id);
      entry.updatedAt = now();
      entry.updateNote = '重新加入候选（' + U.fmtDate(entry.copiedAt) + ' 交给过）';
    }
    if (extra) {
      const prev = entry.extra || {};
      entry.extra = Object.assign({}, prev, extra);
      // 已经复制（交给 Agent）过的候选，又补上了评论结论或名次变了：记为"有更新"，下一次入库包会带上并注明
      const note = old && old.copiedAt ? updateNote(prev, entry.extra) : '';
      if (note) {
        // 复制之后的多次更新合在一起写（补了评论、名次又变了），同类只留最新一条
        const kind = (t) => (t.indexOf('补充了评论结论') === 0 ? 'comments' : 'rank');
        const kinds = new Set(note.split('，').map(kind));
        const keep = (entry.updateNote || '').split('，').filter((t) => t && !kinds.has(kind(t)));
        entry.updatedAt = now(); entry.updateNote = keep.concat(note).join('，');
      }
    }
    S.candidates.set(id, entry);
    persistCandidates();
    ev.emit('candidates');
    return true;
  }
  function updateNote(a, b) {
    const n = [];
    if (b.comments && JSON.stringify(b.comments) !== JSON.stringify(a.comments || null)) n.push('补充了评论结论');
    const lens = b.lensLabel ? b.lensLabel + ' ' : '';
    if (b.rankStale && !a.rankStale) n.push(lens + '已不在前 ' + b.rankStale + ' 名');
    else if (b.rank && (b.rank !== a.rank || b.lensLabel !== a.lensLabel)) n.push('名次变为' + lens + '第 ' + b.rank + ' 名');
    return n.join('，');
  }
  // 还没交给 Agent 的：从没复制过，或复制后又有更新（复制时清掉"有更新"标记，不靠比较时间先后）
  const isFresh = (c) => !c.copiedAt || !!c.updatedAt;
  // 复制过入库包的候选记上时间，下次默认只复制新加入的（和有更新的）
  function markCopied(ids) {
    const t = now();
    for (const id of ids) {
      const c = S.candidates.get(id);
      if (c) { c.copiedAt = t; delete c.updatedAt; delete c.updateNote; }
      handed.delete(id); handed.set(id, t);
    }
    persistHanded();
    persistCandidates();
    ev.emit('candidates');
  }
  function removeCandidates(ids) {
    let n = 0;
    for (const id of ids) if (S.candidates.delete(id)) n++;
    if (n) { persistCandidates(); ev.emit('candidates'); }
    return n;
  }
  function removeCandidate(id) {
    if (!S.candidates.delete(id)) return;
    persistCandidates();
    ev.emit('candidates');
  }
  // 撤销用：把之前的候选条目原样放回（保留加入时间和来源）
  function restoreCandidates(entries) {
    for (const [id, c] of entries) S.candidates.set(id, c);
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
    return [...S.candidates.values()].map((c) => Object.assign(M.derive(c.rec, t), { addedAt: c.addedAt, source: c.source, srcType: c.srcType, extra: c.extra || null, copiedAt: c.copiedAt || 0,
      updatedAt: c.updatedAt || 0, updateNote: c.updateNote || '', fresh: isFresh(c) }));
  }

  function load() {
    return new Promise((resolve) => {
      if (!hasChrome()) return resolve();
      try {
        chrome.storage.local.get([KEY_SETTINGS, KEY_CANDS, KEY_SEEN, KEY_HANDED], (res) => {
          if (res && res[KEY_SETTINGS]) Object.assign(S.settings, res[KEY_SETTINGS]);
          if (res && Array.isArray(res[KEY_HANDED])) handed = new Map(res[KEY_HANDED].filter((e) => Array.isArray(e) && e[0]));
          if (res && Array.isArray(res[KEY_SEEN])) {
            for (const r of res[KEY_SEEN]) if (r && r.id && !seen.has(r.id)) seen.set(r.id, r);
          }
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
          if (changes[KEY_HANDED] && Array.isArray(changes[KEY_HANDED].newValue)) handed = new Map(changes[KEY_HANDED].newValue);
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
    saveSettings, addCandidate, removeCandidate, removeCandidates, markCopied, clearCandidates, restoreCandidates, candidateList, findVideo, load,
    DEFAULT_SETTINGS,
  };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') module.exports = DSP.store;
})();
