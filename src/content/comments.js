// 评论区引擎：把页面上的每条评论对到数据（点赞、回复数），按赞 / 按回复排序，按门槛词高亮。
// 排序只改视觉顺序（CSS order），随时一键还原。
// 对数据的优先级：数据桥盖的章（fiber）→ 接口数据按正文配对 → 页面上显示的点赞数。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  const A = DSP.adapters, E = DSP.exporter;

  const rowCache = new WeakMap(); // 行元素 -> { sig, data }
  let textIndex = { version: -1, map: new Map() };

  function indexByText() {
    const C = DSP.store.S.comments;
    if (textIndex.version === C.version) return textIndex.map;
    const map = new Map();
    for (const c of C.map.values()) {
      const k = A.normText(c.text);
      if (k.length >= 2) { if (!map.has(k)) map.set(k, []); map.get(k).push(c); }
    }
    textIndex = { version: C.version, map };
    return map;
  }

  // 一行评论的数据：{ cid, digg, replies, text, source }
  // used：本轮已经配给别的行的接口评论（同一条接口数据只能配一行，重复短评不会全套用第一条）
  function dataOf(row, used) {
    used = used || new Set();
    const it = row.item;
    const stampCid = it.getAttribute('data-dsp-cid');
    const sig = (stampCid || '') + '|' + (it.getAttribute('data-dsp-digg') || '') + '|' + DSP.store.S.comments.version;
    const cached = rowCache.get(row.el);
    if (cached && cached.sig === sig && !(cached.data.source === 'api' && used.has(cached.data.cid))) {
      if (cached.data.cid) used.add(cached.data.cid);
      return cached.data;
    }
    let data = null;
    const C = DSP.store.S.comments.map;
    if (stampCid) {
      const c = C.get(stampCid);
      data = {
        cid: stampCid,
        digg: Number(it.getAttribute('data-dsp-digg')) || (c ? c.digg : 0),
        replies: Number(it.getAttribute('data-dsp-replies')) || (c ? c.replies : 0),
        text: c ? c.text : '',
        source: 'fiber',
      };
    }
    if (!data) {
      // 正文配对：在行里找 textContent 规范化后能命中接口正文的元素
      const idx = indexByText();
      if (idx.size) {
        for (const el of it.querySelectorAll('*')) {
          if (el.children.length > 4) continue;
          const k = A.normText(el.textContent);
          const list = k.length >= 2 && idx.get(k);
          const free = list ? list.filter((c) => !used.has(c.cid)) : [];
          if (free.length) {
            // 多条同名候选时，优先选点赞数与页面上显示一致的那条；仍不唯一就按出现顺序逐个消耗
            let c = free[0];
            if (free.length > 1) {
              const shown = A.domCommentDigg(it);
              const same = shown != null && free.find((x) => x.digg === shown);
              if (same) c = same;
            }
            data = { cid: c.cid, digg: c.digg, replies: c.replies, text: c.text, source: 'api' };
            break;
          }
        }
      }
    }
    if (!data) {
      const d = A.domCommentDigg(it);
      data = { cid: '', digg: d == null ? -1 : d, replies: 0, text: '', source: 'dom' };
    }
    if (data.cid) used.add(data.cid);
    rowCache.set(row.el, { sig, data });
    return data;
  }

  const state = { mode: null, highlight: null, applied: false, list: null };

  // mode: 'digg' | 'replies' | null（还原）；highlight: 门槛词组 key 或 null
  function apply() {
    const list = A.commentList();
    if (!list) return { rows: 0 };
    const rows = A.commentRows(list);
    if (!state.mode && !state.highlight) { restore(); return { rows: rows.length }; }
    const used = new Set();
    const scored = rows.map((r, i) => {
      const d = dataOf(r, used);
      const text = d.text || r.item.textContent || '';
      return { r, i, d, hit: state.highlight ? E.barrierHits(text).includes(state.highlight) : false };
    });
    if (state.mode) {
      const key = state.mode === 'replies' ? 'replies' : 'digg';
      const sorted = scored.slice().sort((a, b) => (b.d[key] - a.d[key]) || (b.d.digg - a.d.digg) || (a.i - b.i));
      list.classList.add('dsp-flowcol');
      sorted.forEach((s, n) => { const v = String(n + 1); if (s.r.el.style.order !== v) s.r.el.style.order = v; });
    } else {
      list.classList.remove('dsp-flowcol');
      for (const s of scored) if (s.r.el.style.order) s.r.el.style.order = '';
    }
    // 一条都没命中时不把整片评论变暗（只在工具条上说明"没有人提到"）
    const anyHit = scored.some((s) => s.hit);
    for (const s of scored) {
      s.r.el.classList.toggle('dsp-c-hit', !!state.highlight && s.hit);
      s.r.el.classList.toggle('dsp-c-miss', !!state.highlight && anyHit && !s.hit);
    }
    state.applied = true;
    state.list = list;
    return { rows: rows.length, hits: scored.filter((s) => s.hit).length };
  }

  function restore() {
    const list = state.list || A.commentList();
    if (!list) return;
    list.classList.remove('dsp-flowcol');
    for (const el of list.children) {
      if (el.style.order) el.style.order = '';
      el.classList.remove('dsp-c-hit', 'dsp-c-miss');
    }
    state.applied = false;
  }

  function setMode(mode) { state.mode = mode || null; return apply(); }
  function setHighlight(key) { state.highlight = key || null; return apply(); }

  // 当前页面上评论的数据（用于门槛统计、复制、导出），按当前排序
  function collected() {
    const C = DSP.store.S.comments;
    const list = [...C.map.values()];
    const key = state.mode === 'replies' ? 'replies' : 'digg';
    list.sort((a, b) => (b[key] - a[key]) || (b.digg - a.digg));
    return list;
  }

  DSP.comments = { state, apply, restore, setMode, setHighlight, collected, dataOf };
})();
