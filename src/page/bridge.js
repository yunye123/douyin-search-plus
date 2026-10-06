// 数据桥（运行在页面主世界 MAIN world）
//
// 只做一件事：把页面上已经存在的视频/评论数据"读出来"，整理成统一格式交给内容脚本。
// 两个来源，都是被动读取，不主动发任何请求：
//   1. 接口拦截：钩住 fetch / XHR，读抖音自己请求回来的搜索、主页作品、评论数据
//   2. React fiber 收割：首屏卡片常是服务端直出、不走接口，数据挂在卡片元素的 fiber 上。
//      fiber 是页面脚本设置的 JS 属性，隔离世界的内容脚本看不到，所以必须在这里读。
//
// 实测结构（2026-10，抖音精选改版后）：
//   搜索接口 /aweme/v1/web/search/item/（历史上还有 general/search/stream、search/single）
//   搜索卡片 #search-result-container ul[data-e2e="scroll-list"] > li，
//            fiber：li.return.memoizedProps.itemInfo.awemeInfo（camelCase，stats.diggCount）
//   主页卡片 [data-e2e="user-post-list"] ul > li，fiber：memoizedProps.itemInfo（statistics.diggCount）
//   主页接口 /aweme/v1/web/aweme/post/（作品）、/aweme/v1/web/aweme/favorite/（喜欢）
//   评论接口 /aweme/v1/web/comment/list/（/reply 是楼中楼，忽略）
//
// 归一化后的视频记录：
//   { id, kind:'video'|'note', desc, author, authorId, createTime(秒), durationMs, cover,
//     digg, comment, collect, share }
(() => {
  'use strict';

  // ================= 归一化（纯函数，Node 单测直接引用） =================
  const num = (x) => {
    const n = typeof x === 'string' ? Number(x.replace(/,/g, '')) : Number(x);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  // 计数字段：缺失时记 null（界面显示"—"，不参与比率），而不是当成 0 误判成"展示型"
  const cnt = (x) => (x == null ? null : num(x));
  const str = (x) => (typeof x === 'string' ? x : x == null ? '' : String(x));
  const pick = (o, keys) => {
    if (!o || typeof o !== 'object') return undefined;
    for (const k of keys) if (o[k] != null) return o[k];
    return undefined;
  };
  // 封面可能是字符串、{url_list:[...]}、{urlList:[...]} 或直接是数组
  function firstUrl(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.length ? firstUrl(v[0]) : '';
    const list = v.url_list || v.urlList;
    if (Array.isArray(list) && list.length) return str(list[0]);
    return typeof v.uri === 'string' && /^https?:/.test(v.uri) ? v.uri : '';
  }
  const isId = (s) => /^\d{8,25}$/.test(s);

  function normalizeAweme(a) {
    if (!a || typeof a !== 'object') return null;
    const id = str(pick(a, ['aweme_id', 'awemeId', 'group_id', 'groupId']));
    if (!isId(id)) return null;
    if (a.is_ads === true || a.isAds === true) return null; // 广告卡不参与统计
    const st = pick(a, ['statistics', 'stats']);
    if (!st || typeof st !== 'object') return null;

    const video = a.video && typeof a.video === 'object' ? a.video : null;
    const images = Array.isArray(a.images) ? a.images : Array.isArray(a.imageInfos) ? a.imageInfos : null;
    let dur = num(video && video.duration);
    if (dur > 0 && dur < 600) dur *= 1000; // 个别接口给的是秒（0.6 秒以内的"毫秒"不合理）
    const isNote = (images && images.length > 0 && !dur) || num(pick(a, ['aweme_type', 'awemeType'])) === 68;

    let ct = num(pick(a, ['create_time', 'createTime']));
    if (ct > 1e12) ct = Math.round(ct / 1000); // 毫秒 → 秒

    const author = pick(a, ['author', 'authorInfo']) || {};
    const cover =
      firstUrl(video && pick(video, ['cover', 'coverUrlList', 'origin_cover', 'originCover', 'dynamic_cover'])) ||
      firstUrl(images && images[0]);

    return {
      id,
      kind: isNote ? 'note' : 'video',
      desc: str(pick(a, ['desc', 'caption', 'item_title', 'itemTitle'])).trim(),
      author: str(author.nickname),
      authorId: str(pick(author, ['sec_uid', 'secUid'])),
      createTime: ct,
      durationMs: isNote ? 0 : dur,
      cover,
      digg: cnt(pick(st, ['digg_count', 'diggCount'])),
      comment: cnt(pick(st, ['comment_count', 'commentCount'])),
      collect: cnt(pick(st, ['collect_count', 'collectCount'])),
      share: cnt(pick(st, ['share_count', 'shareCount'])),
    };
  }

  function normalizeComment(c) {
    if (!c || typeof c !== 'object') return null;
    const cid = str(pick(c, ['cid', 'comment_id', 'commentId']));
    if (!isId(cid)) return null;
    const user = c.user || {};
    let ct = num(pick(c, ['create_time', 'createTime']));
    if (ct > 1e12) ct = Math.round(ct / 1000);
    return {
      cid,
      text: str(c.text).trim(),
      digg: num(pick(c, ['digg_count', 'diggCount'])),
      replies: num(pick(c, ['reply_comment_total', 'replyCommentTotal'])),
      nickname: str(user.nickname),
      createTime: ct,
      aid: str(pick(c, ['aweme_id', 'awemeId'])),
      ip: str(pick(c, ['ip_label', 'ipLabel'])),
    };
  }

  // 接口响应可能是单个 JSON，也可能是流式拼接的多段 JSON
  function parseJsonChunks(text) {
    if (typeof text !== 'string' || !text) return [];
    try { return [JSON.parse(text)]; } catch (e) { /* 走分段解析 */ }
    const out = [];
    let depth = 0, start = -1, inStr = false, escNext = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (escNext) escNext = false;
        else if (ch === '\\') escNext = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}' && depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try { out.push(JSON.parse(text.slice(start, i + 1))); } catch (e) { /* 跳过坏段 */ }
          start = -1;
        }
      }
    }
    return out;
  }

  // 从一个接口响应里抽出全部视频（兼容搜索的 data[].aweme_info、主页的 aweme_list、
  // 综合搜索里的 aweme_mix_info.mix_items 等）
  function extractVideos(json) {
    const out = [];
    const push = (a) => { const r = normalizeAweme(a); if (r) out.push(r); };
    if (!json || typeof json !== 'object') return out;
    if (Array.isArray(json.aweme_list)) json.aweme_list.forEach(push);
    if (json.aweme_detail && typeof json.aweme_detail === 'object') push(json.aweme_detail);
    if (Array.isArray(json.data)) {
      for (const it of json.data) {
        if (!it || typeof it !== 'object') continue;
        if (it.aweme_info) push(it.aweme_info);
        else if (it.aweme) push(it.aweme);
        if (it.aweme_mix_info && Array.isArray(it.aweme_mix_info.mix_items)) it.aweme_mix_info.mix_items.forEach(push);
      }
    }
    return out;
  }

  function classify(url) {
    if (!url) return null;
    if (/\/aweme\/v\d+\/web\/comment\/list\/reply/.test(url)) return null;
    if (/\/aweme\/v\d+\/web\/comment\/list/.test(url)) return 'comments';
    if (/\/aweme\/v\d+\/web\/(general\/search|search\/(item|single|stream))/.test(url)) return 'search';
    if (/\/aweme\/v\d+\/web\/aweme\/(post|favorite)\//.test(url)) return 'profile';
    if (/\/aweme\/v\d+\/web\/aweme\/detail\//.test(url)) return 'detail';
    return null;
  }

  // 从 fiber 链上找与卡片 id 匹配的视频数据（不依赖具体层级与属性名，改版也能找到）
  function fiberRecord(el, id) {
    const fk = Object.keys(el).find((k) => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0);
    if (!fk) return null;
    let fiber = el[fk];
    for (let depth = 0; fiber && depth < 12; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      for (const key of Object.keys(props)) {
        const v = props[key];
        if (!v || typeof v !== 'object') continue;
        const candidates = [v, v.awemeInfo, v.aweme_info, v.aweme, v.item];
        for (const c of candidates) {
          const r = c && normalizeAweme(c);
          if (r && r.id === id) return r;
        }
      }
    }
    return null;
  }

  // 评论行的 fiber 上找评论对象（有 cid 和点赞数）。结构未知，做有界广度搜索：
  // 沿 return 链最多 10 层，每层 memoizedProps 向下最多 3 层、最多看 200 个节点
  function fiberComment(el) {
    const fk = Object.keys(el).find((k) => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0);
    if (!fk) return null;
    let fiber = el[fk];
    for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      const queue = [[props, 0]];
      const seen = new Set();
      let visited = 0;
      while (queue.length && visited < 200) {
        const [o, d] = queue.shift();
        if (!o || typeof o !== 'object' || seen.has(o)) continue;
        seen.add(o);
        visited++;
        if (o.cid != null && (o.digg_count != null || o.diggCount != null)) {
          const r = normalizeComment(o);
          if (r) return r;
        }
        if (d >= 3) continue;
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (v && typeof v === 'object' && !(typeof Node !== 'undefined' && v instanceof Node) && k !== 'children' && k.charAt(0) !== '_') queue.push([v, d + 1]);
        }
      }
    }
    return null;
  }

  const api = { normalizeAweme, normalizeComment, parseJsonChunks, extractVideos, classify, fiberRecord, fiberComment };
  if (typeof window === 'undefined') {
    if (typeof module === 'object' && module.exports) module.exports = api;
    return;
  }

  // ================= 以下只在浏览器里运行 =================
  if (window.__DSP_BRIDGE__) return;
  Object.defineProperty(window, '__DSP_BRIDGE__', { value: 1 });

  const NS = 'dsp-bridge';
  const root = document.documentElement;
  const isOff = () => root.dataset.dspOff === '1';

  // 内容脚本就位前先排队，就位后一次性送出（v0.7.1 修过的竞态：早发的消息会掉进真空）
  let ready = false;
  const queue = [];
  function post(msg) {
    msg.ns = NS;
    msg.v = 1;
    if (!ready) { queue.push(msg); if (queue.length > 200) queue.shift(); return; }
    try { window.postMessage(msg, location.origin); } catch (e) { /* 忽略 */ }
  }
  function flush() {
    if (ready) return;
    ready = true;
    while (queue.length) { try { window.postMessage(queue.shift(), location.origin); } catch (e) { /* 忽略 */ } }
  }

  // 最近一次搜索接口的官方筛选参数：fiber 收割的卡片没有 URL，用它归入同一会话
  const lastFilter = { kw: '', filter: '' };
  const qp = (url, k) => {
    try { return new URL(url, location.origin).searchParams.get(k) || ''; } catch (e) { return ''; }
  };

  function onResponse(url, payload) {
    const kind = classify(url);
    if (!kind) return;
    const docs = typeof payload === 'string' ? parseJsonChunks(payload) : payload && typeof payload === 'object' ? [payload] : [];
    if (!docs.length) return;
    if (kind === 'comments') {
      const items = [];
      for (const d of docs) if (d && Array.isArray(d.comments)) d.comments.forEach((c) => { const r = normalizeComment(c); if (r) items.push(r); });
      const awemeId = qp(url, 'aweme_id') || qp(url, 'item_id');
      const total = docs.reduce((m, d) => Math.max(m, num(d && d.total)), 0);
      const meta = pageMeta(docs);
      post({ type: 'comments', awemeId, total, items, meta });
      return;
    }
    const items = [];
    for (const d of docs) items.push(...extractVideos(d));
    // 单条视频详情：只用来在视频页显示这条的收藏率，不带翻页元数据
    if (kind === 'detail') {
      if (items.length) post({ type: 'videos', ctx: { source: 'api', endpoint: 'detail', path: location.pathname }, items });
      return;
    }
    // 翻页元数据（是否还有更多、接口状态）：给自动加载判断"到底了"还是"被拦了"
    const ctx = { source: 'api', endpoint: kind, path: location.pathname, meta: pageMeta(docs) };
    if (kind === 'search') {
      ctx.kw = qp(url, 'keyword');
      ctx.filter = qp(url, 'filter_selected');
      ctx.offset = Number(qp(url, 'offset') || qp(url, 'cursor') || 0);
    } else {
      ctx.secUid = qp(url, 'sec_user_id');
      ctx.tab = /\/favorite\//.test(url) ? 'like' : 'post';
    }
    post({ type: 'videos', ctx, items });
  }
  function pageMeta(docs) {
    const last = docs[docs.length - 1] || {};
    const hm = last.has_more != null ? last.has_more : last.hasMore;
    return {
      hasMore: hm == null ? null : !!Number(hm),
      statusCode: last.status_code != null ? Number(last.status_code) : null,
      verify: !!(last.verify_info || last.verifyInfo || (last.search_nil_info && /verify|captcha/i.test(JSON.stringify(last.search_nil_info)))),
    };
  }

  // 官方筛选以"最近发出的搜索请求"为准（在发请求时记，而不是响应回来时记：
  // 切换筛选前发出的旧请求晚到，不能把 fiber 收割的归属带偏）
  function noteRequest(url) {
    if (classify(url) !== 'search') return;
    lastFilter.kw = qp(url, 'keyword');
    lastFilter.filter = qp(url, 'filter_selected');
  }

  // ---- hook fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
        noteRequest(url);
        if (classify(url)) {
          p.then((res) => res.clone().text()).then((t) => onResponse(url, t)).catch(() => {});
        }
      } catch (e) { /* 忽略 */ }
      return p;
    };
  }

  // ---- hook XMLHttpRequest ----
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  const urlOf = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url) {
    try { urlOf.set(this, String(url)); } catch (e) { /* 忽略 */ }
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = urlOf.get(this) || '';
    noteRequest(url);
    if (classify(url)) {
      this.addEventListener('load', () => {
        try {
          const rt = this.responseType;
          // responseType 为 json 时读 responseText 会抛错；arraybuffer/blob 不处理
          if (rt === 'json') onResponse(url, this.response);
          else if (rt === '' || rt === 'text') onResponse(url, this.responseText);
        } catch (e) { /* 忽略 */ }
      });
    }
    return XS.apply(this, arguments);
  };

  // ---- fiber 收割 ----
  // 只扫"结果列表"里的卡片，避免把侧栏推荐、相关视频混进当前会话
  // 按页面类型只扫"结果列表"：搜索页只收搜索结果，主页只收作品列表。
  // 通用的 scroll-list 组件也出现在视频弹层的"TA 的作品"、侧栏推荐里，只在找不到专属容器时兜底
  // 搜索页地址里的关键词：/search/关键词 或 /jingxuan/search/关键词；不是搜索页返回 null
  function searchKwOf(path) {
    const seg = path.split('/');
    const i = seg.indexOf('search');
    if (i < 1 || !seg[i + 1]) return null;
    try { return decodeURIComponent(seg[i + 1]); } catch (e) { return seg[i + 1]; }
  }
  function listRoots() {
    const p = location.pathname;
    const pick = (sels) => { const out = []; for (const s of sels) document.querySelectorAll(s).forEach((el) => out.push(el)); return out; };
    let roots = [];
    if (searchKwOf(p) != null) roots = pick(['#search-result-container', '[id^="waterfall_item_"]']);
    else if (p.indexOf('/user/') === 0) roots = pick(['[data-e2e="user-post-list"]']);
    else return [];
    if (!roots.length) roots = pick(['main [data-e2e="scroll-list"], #root [data-e2e="scroll-list"]']).filter((el) => !el.closest('[role="dialog"], [class*="modal" i]'));
    return roots;
  }
  // 第一次读到 React fiber 时在 <html> 上做个记号：说明页面已经注水完成，内容脚本这时再往页面里插工具栏，
  // 不会打乱 React 注水（服务端直出的页面，注水前多出节点会触发 hydration 报错和整页重渲染）
  function markHydrated() { if (root.dataset.dspHydrated !== '1') root.dataset.dspHydrated = '1'; }
  let harvested = new WeakMap(); // 卡片元素 -> 已收割的视频 id（React 换了节点会自然重收）
  const ID_RE = /\/(?:video|note)\/(\d{8,25})/;

  function cardRoot(a) {
    return a.closest('li') || a.closest('[id^="waterfall_item_"]') || a.parentElement || a;
  }

  function harvest() {
    if (isOff() || !ready) return;
    harvestComments();
    harvestCards();
    harvestDetail();
  }

  // 视频详情页 / 视频弹层：从详情区的 fiber 读这条视频（从分享链接直接打开也能显示收藏率）。
  // 读到一次就不再读；读不到时每次扫描再试（只看几个节点，开销很小）
  let detailDone = '';
  function currentVideoId() {
    const m = /(?:^|\/)(?:video|note)\/(\d{8,25})/.exec(location.pathname);
    if (m) return m[1];
    const q = /[?&]modal_id=(\d{8,25})/.exec(location.search);
    return q ? q[1] : '';
  }
  function harvestDetail() {
    const id = currentVideoId();
    if (!id || detailDone === id) return;
    for (const el of document.querySelectorAll('[data-e2e="detail-video-info"], [data-e2e="video-detail"], [data-e2e="player-container"]')) {
      const rec = fiberRecord(el, id) || (el.parentElement && fiberRecord(el.parentElement, id));
      if (!rec) continue;
      detailDone = id;
      post({ type: 'videos', ctx: { source: 'fiber', endpoint: 'detail', path: location.pathname }, items: [rec] });
      return;
    }
  }

  function harvestCards() {
    const roots = new Set(listRoots());
    if (!roots.size) return;
    const items = [];
    const seen = new Set();
    for (const r of roots) {
      for (const a of r.querySelectorAll('a[href*="/video/"], a[href*="/note/"]')) {
        const m = ID_RE.exec(a.getAttribute('href') || '');
        if (!m) continue;
        const el = cardRoot(a);
        if (seen.has(el)) continue;
        seen.add(el);
        if (harvested.get(el) === m[1]) continue;
        // fiber 可能挂在 li、卡片 div 或 a 上，逐个试
        const rec = fiberRecord(el, m[1]) || fiberRecord(a, m[1]) || (a.parentElement && fiberRecord(a.parentElement, m[1]));
        if (rec) { harvested.set(el, m[1]); items.push(rec); markHydrated(); }
      }
      // "综合"标签：绝对定位的瀑布流方块，没有链接，视频 id 写在元素 id 上（waterfall_item_<id>）
      const wf = r.id && r.id.indexOf('waterfall_item_') === 0 ? [r] : r.querySelectorAll('[id^="waterfall_item_"]');
      for (const el of wf) {
        const m = /^waterfall_item_(\d{8,25})$/.exec(el.id);
        if (!m || seen.has(el)) continue;
        seen.add(el);
        if (harvested.get(el) === m[1]) continue;
        const rec = fiberRecord(el, m[1]) || (el.firstElementChild && fiberRecord(el.firstElementChild, m[1]));
        if (rec) { harvested.set(el, m[1]); items.push(rec); markHydrated(); }
      }
    }
    if (!items.length) return;
    const path = location.pathname;
    const ctx = { source: 'fiber', path };
    const skw = searchKwOf(path);
    if (skw != null) {
      const kw = skw;
      ctx.kw = kw;
      ctx.filter = lastFilter.kw === kw ? lastFilter.filter : '';
    } else if (path.indexOf('/user/') === 0) {
      ctx.secUid = path.split('/')[2] || '';
    }
    post({ type: 'videos', ctx, items });
  }

  // 评论行盖章：data-dsp-cid / data-dsp-digg / data-dsp-replies，并把首屏直出的评论也送给内容脚本
  let stampedComments = new WeakMap();
  function harvestComments() {
    const rows = document.querySelectorAll('[data-e2e="comment-item"]');
    if (!rows.length) return;
    const groups = new Map(); // 视频 id -> 评论
    const now = Date.now();
    const cur = currentVideoId();
    for (const row of rows) {
      // 已盖章的行跳过；读不到 fiber 的行按 2 秒、10 秒退避重试两次，之后不再试（避免每次 DOM 变化都对几百行做广度搜索）
      const prev = stampedComments.get(row);
      if (prev && prev.ok && now - prev.at < 15000) continue; // 盖过章的行 15 秒内不重算（点赞数变了会在之后更新）
      if (prev && (prev.tries >= 3 || now < prev.next)) continue;
      const c = fiberComment(row);
      if (!c) { const tries = prev ? prev.tries + 1 : 1; stampedComments.set(row, { ok: false, tries, next: now + (tries === 1 ? 2000 : 10000) }); continue; }
      // 这条评论属于哪条视频：评论自己带的视频 id 优先；没有就沿用第一次读到它时的地址（不随换视频改变）
      const aid = c.aid || (prev && prev.aid) || cur;
      // 暂时不属于当前视频的行（例如评论比地址先渲染出来）：2 秒后就重读，地址一变能马上补上
      stampedComments.set(row, { ok: true, at: cur && aid && aid !== cur ? now - 13000 : now, aid });
      markHydrated();
      row.setAttribute('data-dsp-cid', c.cid);
      row.setAttribute('data-dsp-digg', String(c.digg));
      row.setAttribute('data-dsp-replies', String(c.replies));
      // 换视频后旧评论还留在页面上：不报给当前视频
      if (cur && aid && aid !== cur) continue;
      if (!groups.has(aid)) groups.set(aid, []);
      groups.get(aid).push(c);
    }
    for (const [aid, list] of groups) post({ type: 'comments', awemeId: aid, total: 0, items: list, source: 'fiber' });
  }

  // 节流的 DOM 观察 + 低频兜底轮询
  let pending = 0;
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = 0; try { harvest(); } catch (e) { /* 忽略 */ } }, 250);
  };
  const startObserver = () => {
    try { new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) { /* 忽略 */ }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  else startObserver();
  setInterval(schedule, 2000);

  // 内容脚本的控制消息：hello（就位）/ rescan（数据与页面失步时整页重收）
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.ns !== 'dsp-content') return;
    if (d.type === 'hello') { flush(); schedule(); }
    else if (d.type === 'rescan') { harvested = new WeakMap(); stampedComments = new WeakMap(); schedule(); }
  });
  // 兜底：内容脚本先于本脚本就位时，靠 DOM 标记握手
  if (root.dataset.dspReady === '1') flush();
  else {
    const iv = setInterval(() => { if (root.dataset.dspReady === '1') { clearInterval(iv); flush(); schedule(); } }, 100);
    setTimeout(() => clearInterval(iv), 30000);
  }
})();
