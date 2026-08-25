// 内容脚本（隔离世界）
// 界面：页面底部一条胶囊工具条，按当前页面自动显示对应功能。
//
// 实测确认的页面结构（2026-07）：
//   搜索卡片   div#waterfall_item_<视频ID>，绝对定位瀑布流（transform 摆位）
//              —— 所以排序方式是"自己重算瀑布流坐标"，不是 CSS order
//   评论列表   [data-e2e="comment-list"] 的直接子级是每条评论的包装 div，
//              内部是 [data-e2e="comment-item"]；正常文档流，可用 CSS order
//   评论点赞数 评论元素内第一个"独立纯数字"文本节点（回复数在"展开N条回复"里，排除）
//
// 调试：控制台执行 localStorage.DSP_DEBUG = '1' 后刷新
(() => {
  'use strict';
  if (window.__DSP_CONTENT__) return;
  window.__DSP_CONTENT__ = true;

  const SIG = 'DSP_DATA';
  const DEBUG = () => { try { return localStorage.DSP_DEBUG === '1'; } catch { return false; } };
  const log = (...a) => { if (DEBUG()) console.log('[DSP]', ...a); };
  // 异常上报到 DOM 属性（隔离世界的报错在页面控制台看不到，写到 DOM 上跨世界可读）
  function trap(tag, fn) {
    try { return fn(); } catch (e) {
      try {
        document.documentElement.dataset.dspErr =
          tag + ' @' + new Date().toTimeString().slice(0, 8) + ': ' + String((e && (e.stack || e.message)) || e).slice(0, 600);
      } catch (e2) { /* 忽略 */ }
      log('trap', tag, e);
    }
  }

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const fmt = (n) => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n));

  // ============ 状态 ============
  const videos = new Map();    // aweme_id -> {digg, comment, collect, share}
  let comments = new Map();    // cid -> {text, digg}
  let commentAwemeId = null;
  let lastKeyword = null;

  const S = {                  // 用户设置
    sortKeys: new Set(),       // 'digg' | 'comment' | 'collect' | 'share'，可多选组合
    th: { digg: 0, comment: 0, collect: 0 },
    badge: true,
    commentSorted: false,
  };
  const sortActive = () => S.sortKeys.size > 0 || S.th.digg > 0 || S.th.comment > 0 || S.th.collect > 0;
  try { S.badge = (localStorage.DSP_BADGE ?? '1') === '1'; } catch {}

  // ============ 数据接收与解析 ============
  // 容错解析：整体 JSON 失败时按大括号配对切出多个顶层 JSON（兼容流式响应）
  function parseJsonChunks(text) {
    try { return [JSON.parse(text)]; } catch {}
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          try { out.push(JSON.parse(text.slice(start, i + 1))); } catch {}
          start = -1;
        }
      }
    }
    return out;
  }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.source !== SIG || typeof d.text !== 'string') return;
    trap('intake', () => {
      const docs = parseJsonChunks(d.text);
      if (d.kind === 'search') docs.forEach((j) => intakeSearch(j, d.url));
      else if (d.kind === 'comments') docs.forEach((j) => intakeComments(d.url, j));
    });
  });

  function intakeSearch(json, url) {
    // 会话签名 = 关键词 + 原生筛选参数（搜索页）或博主 ID（主页，sec_user_id）
    // 换关键词、切换原生筛选、换博主都会开启新会话 → 清空重新统计，
    // 避免把上一批结果混进当前排序里
    const kw = (/[?&]keyword=([^&]+)/.exec(url || '') || [])[1] || '';
    const fs = (/[?&]filter_selected=([^&]+)/.exec(url || '') || [])[1] || '';
    const su = (/[?&]sec_user_id=([^&]+)/.exec(url || '') || [])[1] || '';
    const sig = kw + '|' + fs + '|' + su;
    if ((kw || su) && sig !== lastKeyword) {
      if (lastKeyword !== null) { videos.clear(); log('会话变更，清空数据', sig); }
      lastKeyword = sig;
    }
    const push = (a) => {
      if (!a || !a.aweme_id || !a.statistics) return;
      const digg = num(a.statistics.digg_count);
      const comment = num(a.statistics.comment_count);
      const collect = num(a.statistics.collect_count);
      const ct = num(a.create_time);
      const ageDays = ct > 0 ? Math.max(1, (Date.now() / 1000 - ct) / 86400) : 0;
      videos.set(String(a.aweme_id), {
        digg, comment, collect,
        share: num(a.statistics.share_count),
        desc: String(a.desc || ''),
        author: String((a.author && a.author.nickname) || ''),
        ct,
        // 派生指标：藏赞比（干货度）、评赞比（互动度）、日均点赞（增速）
        cr: digg > 0 ? collect / digg : 0,
        er: digg > 0 ? comment / digg : 0,
        dpd: ageDays > 0 ? Math.round(digg / ageDays) : 0,
      });
    };
    if (Array.isArray(json.aweme_list)) json.aweme_list.forEach(push);
    if (Array.isArray(json.data)) json.data.forEach((it) => it && push(it.aweme_info));
    log('搜索数据累计', videos.size);
    ui.refresh();
    search.schedule();
  }

  function intakeComments(url, json) {
    const m = /[?&](?:aweme_id|item_id)=(\d+)/.exec(url || '');
    const aid = m ? m[1] : null;
    if (aid && aid !== commentAwemeId) { comments = new Map(); commentAwemeId = aid; }
    const list = Array.isArray(json.comments) ? json.comments : [];
    for (const c of list) {
      if (!c || !c.cid) continue;
      comments.set(String(c.cid), { text: String(c.text || ''), digg: num(c.digg_count) });
    }
    log('评论数据累计', comments.size);
    ui.refresh();
    if (S.commentSorted) commentSort.schedule();
  }

  // 注：主页首屏数据由 inject-main.js 在 MAIN world 从 React fiber 收割后
  // 经 search 通道发来（fiber 是页面脚本的 JS 属性，本隔离世界看不到）。

  // ============ 搜索结果：瀑布流重排 ============
  const search = {
    timer: null,
    schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this.apply(), 400); },

    // 两种页面布局，自动识别：
    //   waterfall —— 搜索页瀑布流（绝对定位 transform 摆位，需自己重算坐标）
    //   order     —— 博主主页作品/喜欢列表（正常文档流，CSS order 即可）
    cards() {
      const wf = [...document.querySelectorAll('[id^="waterfall_item_"]')];
      if (wf.length) {
        return {
          mode: 'waterfall',
          cards: wf.map((el, idx) => {
            const id = el.id.slice('waterfall_item_'.length);
            const t = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform || '');
            return {
              el, id, idx,
              v: videos.get(id) || null,
              x: t ? parseFloat(t[1]) : 0,
              y: t ? parseFloat(t[2]) : 0,
              h: parseFloat(el.style.height) || el.getBoundingClientRect().height || 300,
            };
          }),
        };
      }
      // 主页模式：user-post-list 里带 /video/ 或 /note/ 链接的卡片
      const list = document.querySelector('[data-e2e="user-post-list"]');
      if (!list) return { mode: null, cards: [] };
      const res = [];
      const seen = new Set();
      let idx = 0;
      for (const a of list.querySelectorAll('a[href*="/video/"], a[href*="/note/"]')) {
        const m = /\/(?:video|note)\/(\d+)/.exec(a.getAttribute('href') || '');
        if (!m) continue;
        const root = a.closest('li') || a.closest('span') || a;
        if (seen.has(root)) continue;
        seen.add(root);
        res.push({ el: root, id: m[1], idx: idx++, v: videos.get(m[1]) || null, x: 0, y: 0, h: 0 });
      }
      return { mode: 'order', cards: res };
    },

    wasActive: false,
    apply() { return trap('search.apply', () => this.applyInner()); },
    applyInner() {
      // 主页会话：按路径里的 sec_user_id 维护（格式和 API 端 'kw|fs|su' 对齐，
      // 都是 '||<sec>'，两个来源不会互相触发误清空）；换博主自动清零
      if (location.pathname.startsWith('/user/')) {
        const sec = location.pathname.split('/')[2] || '';
        if (sec) {
          const sig = '||' + sec;
          if (sig !== lastKeyword) {
            if (lastKeyword !== null) { videos.clear(); log('切换博主，清空数据'); }
            lastKeyword = sig;
          }
        }
      }
      const { mode, cards } = this.cards();
      if (!mode || !cards.length) return;
      const parent = cards[0].el.parentElement;
      if (!parent) return;

      // 黑马标记 + 角标。单个角标出问题只跳过它，绝不拖垮排序主流程
      computeMarks();
      if (S.badge) {
        for (const c of cards) {
          if (c.v) { try { addBadge(c.el, c.v); } catch (e) { log('badge error', c.id, e); } }
        }
      } else removeBadges();

      const active = sortActive();
      if (!active) {
        // 刚从排序状态退出 → 恢复一次原始布局
        if (this.wasActive) { this.restore(mode, cards, parent); this.wasActive = false; }
        // 空闲时持续刷新"原始位置"快照（此时布局归抖音管，是最新的）
        if (mode === 'waterfall') {
          parent.dataset.dspH = parent.style.height || '';
          for (const c of cards) c.el.dataset.dspOrig = c.el.style.transform || 'none';
        }
        ui.refresh();
        return;
      }
      this.wasActive = true;
      // 排序中途新加载的卡片：第一次见到时记住抖音给它的原始位置
      if (mode === 'waterfall') {
        if (!('dspH' in parent.dataset)) parent.dataset.dspH = parent.style.height || '';
        for (const c of cards) {
          if (!('dspOrig' in c.el.dataset)) c.el.dataset.dspOrig = c.el.style.transform || 'none';
        }
      }
      if (cards.length < 2) return;

      // 阈值过滤
      const pass = (c) => !c.v || (c.v.digg >= S.th.digg && c.v.comment >= S.th.comment && c.v.collect >= S.th.collect);
      const shown = [], hidden = [];
      for (const c of cards) (pass(c) ? shown : hidden).push(c);
      for (const c of hidden) c.el.classList.add('dsp-hide');
      for (const c of shown) c.el.classList.remove('dsp-hide');

      // 排序（无数据的卡片保持相对原位置，排在最后）
      const keys = [...S.sortKeys];
      const byPos = mode === 'waterfall'
        ? (a, b) => (a.y - b.y) || (a.x - b.x)
        : (a, b) => a.idx - b.idx;
      let order;
      if (keys.length === 1) {
        const k = keys[0];
        const withData = shown.filter((c) => c.v).sort((a, b) => (b.v[k] - a.v[k]) || (a.id < b.id ? -1 : 1));
        order = withData.concat(shown.filter((c) => !c.v).sort(byPos));
      } else if (keys.length > 1) {
        // 组合排序：名次和。每个维度各排一次名，名次相加，总名次小的排前面。
        // 用名次而不是数值相加，避免点赞（十万级）淹没评论（百级）。
        const withData = shown.filter((c) => c.v);
        const rankSum = new Map();
        for (const k of keys) {
          [...withData].sort((a, b) => b.v[k] - a.v[k])
            .forEach((c, i) => rankSum.set(c, (rankSum.get(c) || 0) + i));
        }
        withData.sort((a, b) => (rankSum.get(a) - rankSum.get(b)) || (a.id < b.id ? -1 : 1));
        order = withData.concat(shown.filter((c) => !c.v).sort(byPos));
      } else {
        order = [...shown].sort(byPos);
      }

      if (mode === 'order') {
        // 主页模式：父容器保证是 flex/grid，然后用 CSS order 排
        if (!/flex|grid/.test(getComputedStyle(parent).display)) parent.classList.add('dsp-flexwrap');
        order.forEach((c, i) => { c.el.style.order = String(i + 1); });
        ui.refresh(shown.length, cards.length);
        return;
      }

      // 瀑布流模式：从现有几何信息反推参数（列 x 坐标、顶部 y、纵向间距）
      const xs = [...new Set(cards.map((c) => Math.round(c.x)))].sort((a, b) => a - b);
      if (xs.length < 2) return; // 结构异常，不动
      const topY = Math.min(...cards.map((c) => c.y));
      const gaps = [];
      const byCol = new Map();
      for (const c of [...cards].sort(byPos)) {
        const cx = Math.round(c.x);
        if (byCol.has(cx)) {
          const prev = byCol.get(cx);
          const g = c.y - (prev.y + prev.h);
          if (g > 0 && g < 80) gaps.push(g);
        }
        byCol.set(cx, c);
      }
      gaps.sort((a, b) => a - b);
      const gapY = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 24;

      // 按排序结果重新摆瀑布流：每张卡放进当前最矮的列
      const colH = xs.map(() => topY);
      for (const c of order) {
        let ci = 0;
        for (let i = 1; i < colH.length; i++) if (colH[i] < colH[ci]) ci = i;
        c.el.style.transform = `translate(${xs[ci]}px, ${colH[ci]}px)`;
        c.el.style.visibility = 'visible';
        colH[ci] += c.h + gapY;
      }
      parent.style.height = Math.max(...colH) + 40 + 'px';
      ui.refresh(shown.length, cards.length);
    },

    restore(mode, cards, parent) {
      if (!cards) { const r = this.cards(); mode = r.mode; cards = r.cards; }
      if (!cards.length) return;
      parent = parent || cards[0].el.parentElement;
      for (const c of cards) {
        c.el.classList.remove('dsp-hide');
        if (mode === 'waterfall') {
          if (c.el.dataset.dspOrig) {
            c.el.style.transform = c.el.dataset.dspOrig === 'none' ? '' : c.el.dataset.dspOrig;
          }
        } else {
          c.el.style.order = '';
        }
      }
      if (mode === 'waterfall') {
        if (parent && parent.dataset.dspH !== undefined) parent.style.height = parent.dataset.dspH;
      } else if (parent) {
        parent.classList.remove('dsp-flexwrap');
      }
    },
  };

  const pct = (r) => (r * 100).toFixed(1) + '%';

  // 黑马标记：在"当前已捕获的这批结果"内做相对比较（前 10% 分位）
  //   🔥 发布 ≤30 天且日均点赞进前 10% —— 正在起飞的选题
  //   💎 藏赞比进前 10%（点赞≥100 才参评，排除小样本噪音）—— 干货密度高
  function computeMarks() {
    const vs = [...videos.values()];
    for (const v of vs) { v.hot = false; v.gem = false; }
    if (vs.length < 5) return; // 样本太少，分位数没意义
    const q90 = (arr) => arr.length ? [...arr].sort((a, b) => a - b)[Math.floor(arr.length * 0.9)] : Infinity;
    const dpdTop = q90(vs.map((v) => v.dpd));
    const crTop = q90(vs.filter((v) => v.digg >= 100).map((v) => v.cr));
    const now = Date.now() / 1000;
    for (const v of vs) {
      v.hot = v.ct > 0 && (now - v.ct) / 86400 <= 30 && v.dpd > 0 && v.dpd >= dpdTop;
      v.gem = v.digg >= 100 && v.cr > 0 && v.cr >= crTop;
    }
  }

  function addBadge(root, v) {
    let b = root.querySelector('.dsp-badge');
    if (!b) {
      b = document.createElement('div');
      b.className = 'dsp-badge';
      root.classList.add('dsp-rel'); // 主页卡片可能是 static 定位，角标需要定位上下文
      root.appendChild(b);
    }
    // 抖音的 React 重渲染可能清掉角标的子元素（实测踩过：一个空角标反复
    // 崩掉整个 apply，排序全灭）——缺了就重建，绝不假设结构还在
    while (b.children.length < 2) b.appendChild(document.createElement('div'));
    const marks = (v.hot ? '🔥' : '') + (v.gem ? '💎' : '');
    const l1 = `${marks}赞${fmt(v.digg)} 评${fmt(v.comment)} 藏${fmt(v.collect)}`;
    const l2 = `藏/赞${pct(v.cr)} 评/赞${pct(v.er)} 日增${fmt(v.dpd)}`;
    // 内容没变就不动 DOM，减少闪烁
    if (b.children[0].textContent !== l1) b.children[0].textContent = l1;
    if (b.children[1].textContent !== l2) b.children[1].textContent = l2;
  }
  function removeBadges() {
    document.querySelectorAll('.dsp-badge').forEach((b) => b.remove());
  }

  // ============ 评论区：按点赞排序 ============
  const commentSort = {
    timer: null, iv: null,
    schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this.apply(), 300); },

    // comment-list 的直接子级中包含 comment-item 的包装 div
    rows() {
      const list = document.querySelector('[data-e2e="comment-list"]');
      if (!list) return { list: null, rows: [] };
      const rows = [...list.children].filter((el) => el.querySelector('[data-e2e="comment-item"]'));
      return { list, rows };
    },

    enable() {
      S.commentSorted = true;
      this.apply();
      clearInterval(this.iv);
      this.iv = setInterval(() => this.apply(), 2000); // 对抗 React 重渲染 + 新评论加载
    },
    disable() {
      S.commentSorted = false;
      clearInterval(this.iv);
      const { list, rows } = this.rows();
      for (const r of rows) r.style.order = '';
      if (list) list.classList.remove('dsp-flexcol');
    },

    apply() {
      if (!S.commentSorted) return;
      const { list, rows } = this.rows();
      if (!list || rows.length < 2) return;
      const apiList = [...comments.values()];
      const used = new Set();
      const scored = rows.map((el, idx) => {
        // 优先用接口数据（评论文本前 12 字配对）
        let digg = null;
        const txt = el.textContent || '';
        for (const c of apiList) {
          if (used.has(c)) continue;
          const key = c.text.trim().slice(0, 12);
          if (key.length >= 3 && txt.includes(key)) { digg = c.digg; used.add(c); break; }
        }
        // 兜底：直接读页面上显示的点赞数
        if (digg == null) digg = parseDomDigg(el);
        return { el, idx, digg: digg == null ? -1 : digg };
      });
      list.classList.add('dsp-flexcol');
      const sorted = [...scored].sort((a, b) => (b.digg - a.digg) || (a.idx - b.idx));
      sorted.forEach((s, i) => { s.el.style.order = String(i + 1); });
      log('评论排序', sorted.map((s) => s.digg).slice(0, 10));
    },
  };

  // 从评论元素解析点赞数。实测规律（2026-07）：
  //   点赞数 = 第一个"旁边带 SVG 图标"的独立纯数字文本（图标+数字结构）
  //   评论正文里的数字（如 QQ 号）没有图标；回复数在点赞数之后
  function parseDomDigg(item) {
    const toNum = (t) => (/[万w]$/.test(t) ? Math.round(parseFloat(t) * 10000) : parseInt(t, 10));
    const w = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let n, fallback = null;
    while ((n = w.nextNode())) {
      const t = n.textContent.trim();
      if (!/^\d+(\.\d+)?[万w]?$/.test(t)) continue;
      const p = n.parentElement;
      const gp = p && p.parentElement;
      if (gp && gp.querySelector('svg')) return toNum(t); // 图标+数字 → 点赞数
      // 无图标兜底：排除"展开N条回复"类文本和过大的数字（点赞过万会带"万"字）
      const pTxt = (p && p.textContent || '').trim();
      if (fallback == null && !( pTxt !== t && /展开|回复|分享/.test(pTxt) )) {
        const v = toNum(t);
        if (/[万w]$/.test(t) || v < 100000) fallback = v;
      }
    }
    return fallback;
  }

  // ============ 自动加载 ============
  function makeLoader(opts) {
    return {
      running: false, last: -1, still: 0, t: null,
      start() {
        if (this.running) return;
        this.running = true; this.still = 0; this.last = opts.count();
        ui.refresh();
        this.tick();
      },
      stop(msg) {
        if (!this.running) return;
        this.running = false; clearTimeout(this.t);
        ui.refresh();
        if (msg) toast(msg);
      },
      tick() {
        if (!this.running) return;
        const c = opts.count();
        if (c >= opts.max) return this.stop(opts.doneMsg(c));
        if (c === this.last) {
          if (++this.still >= 6) return this.stop(opts.dryMsg(c));
        } else { this.still = 0; this.last = c; }
        opts.scroll();
        this.t = setTimeout(() => this.tick(), opts.delay + Math.random() * opts.delay);
      },
    };
  }

  const searchLoad = makeLoader({
    count: () => videos.size,
    max: 300,
    delay: 1400,
    doneMsg: (c) => `已加载 ${c} 条`,
    dryMsg: (c) => `没有更多了，共 ${c} 条`,
    scroll: () => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      window.scrollBy(0, 10000); // 双保险，两种滚动模型都试
      const { cards } = search.cards();
      const card = cards.length ? cards[cards.length - 1].el : null;
      if (card) card.scrollIntoView({ block: 'end' });
      let sc = card && card.parentElement;
      while (sc && sc !== document.body) {
        if (sc.scrollHeight > sc.clientHeight + 100) { sc.scrollTop = sc.scrollHeight; break; }
        sc = sc.parentElement;
      }
    },
  });

  const commentLoad = makeLoader({
    count: () => commentSort.rows().rows.length,
    max: 1000,
    delay: 1200,
    doneMsg: (c) => `已达上限，共 ${c} 条`,
    dryMsg: (c) => `评论加载完毕，共 ${c} 条`,
    scroll: () => {
      const list = document.querySelector('[data-e2e="comment-list"]');
      if (!list) return;
      let sc = list.parentElement;
      while (sc && sc !== document.body) {
        if (sc.scrollHeight > sc.clientHeight + 100) { sc.scrollTop = sc.scrollHeight; break; }
        sc = sc.parentElement;
      }
      window.scrollTo(0, document.documentElement.scrollHeight);
    },
  });

  // ============ CSV 导出 ============
  function exportCsv() {
    if (!videos.size) return toast('还没捕获到数据，先搜索并加载一些结果');
    computeMarks();
    const rows = [['标题', '作者', '发布时间', '点赞', '评论', '收藏', '分享', '藏赞比', '评赞比', '日均点赞', '黑马', '链接']];
    for (const [id, v] of videos) {
      rows.push([
        v.desc, v.author,
        v.ct > 0 ? new Date(v.ct * 1000).toISOString().slice(0, 10) : '',
        v.digg, v.comment, v.collect, v.share,
        pct(v.cr), pct(v.er), v.dpd,
        (v.hot ? '🔥' : '') + (v.gem ? '💎' : ''),
        'https://www.douyin.com/video/' + id,
      ]);
    }
    // BOM 让 Excel 正确识别 UTF-8 中文
    const csv = '﻿' + rows.map((r) => r.map((c) => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    // 文件名：搜索页用关键词；主页没有关键词，用第一条视频的作者名
    let kw = '';
    try { kw = decodeURIComponent((lastKeyword || '').split('|')[0]); } catch {}
    if (!kw) kw = [...videos.values()].find((v) => v.author)?.author || '主页作品';
    a.download = `抖音_${kw}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`已导出 ${videos.size} 条`);
  }

  // ============ UI：底部胶囊工具条 ============
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  let toastT = null;
  function toast(msg) {
    let el = document.getElementById('dsp-toast');
    if (!el) { el = h('div', 'dsp-toast'); el.id = 'dsp-toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('dsp-show');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove('dsp-show'), 2400);
  }

  const ui = {
    bar: null, dot: null, pop: null,
    chips: new Map(), // sortKey -> chip
    els: {},

    build() {
      if (document.getElementById('dsp-bar')) return;

      // 收起状态的小圆点
      this.dot = h('div', 'dsp-dot dsp-none', '抖+');
      this.dot.id = 'dsp-dot';
      this.dot.title = '展开抖音搜索增强';
      this.dot.addEventListener('click', () => this.setCollapsed(false));

      // 工具条
      this.bar = h('div', 'dsp-bar');
      this.bar.id = 'dsp-bar';

      // -- 搜索组 --
      const gSearch = h('div', 'dsp-group');
      gSearch.append(h('span', 'dsp-label', '排序'));
      const SORT_TIPS = [
        ['digg', '点赞', '按点赞数排序。点赞高 = 大众认可度高，但不代表深度'],
        ['comment', '评论', '按评论数排序。评论多 = 话题性/争议性强，评论区有选题金矿'],
        ['collect', '收藏', '按收藏数排序。收藏多 = 观众想存着回看的实用干货'],
        ['share', '分享', '按分享数排序。分享多 = 观众愿意转发，自带传播力'],
        ['cr', '藏赞比', '收藏÷点赞，比值高说明是观众存着回看的干货（教程类核心指标）'],
        ['er', '评赞比', '评论÷点赞，比值高说明话题性强、评论区值得挖'],
      ];
      for (const [key, label, tip] of SORT_TIPS) {
        const chip = h('button', 'dsp-chip', label);
        chip.title = tip + '。可多选：点亮多个维度时按各维度名次之和组合排序';
        chip.addEventListener('click', () => {
          if (S.sortKeys.has(key)) S.sortKeys.delete(key);   // 再点一次 = 取消该维度
          else {
            if (!videos.size) return toast('还没捕获到数据，滚动页面加载一些结果试试');
            S.sortKeys.add(key);
          }
          if (S.sortKeys.size > 1) toast('组合排序：按各维度名次之和');
          this.refresh();
          search.apply();
        });
        this.chips.set(key, chip);
        gSearch.append(chip);
      }
      const filterChip = h('button', 'dsp-chip', '筛选');
      filterChip.title = '设置阈值（只看 赞/评/藏 ≥ N 的结果）和角标开关';
      filterChip.addEventListener('click', (e) => { e.stopPropagation(); this.togglePop(); });
      const loadChip = h('button', 'dsp-chip', '加载更多');
      loadChip.title = '自动下拉加载结果攒样本（上限300条），搜索页和博主主页都可用。加载得越多，排序越接近真实情况';
      loadChip.addEventListener('click', () => {
        if (searchLoad.running) searchLoad.stop('已停止');
        else searchLoad.start();
      });
      const csvChip = h('button', 'dsp-chip', '导出');
      csvChip.title = '把已捕获的结果导出为 CSV（含数据、比率、黑马标记、链接）';
      csvChip.addEventListener('click', exportCsv);
      const count = h('span', 'dsp-count', '');
      gSearch.append(filterChip, loadChip, csvChip, count);
      this.els.gSearch = gSearch;
      this.els.filterChip = filterChip;
      this.els.loadChip = loadChip;
      this.els.count = count;

      // -- 评论组 --
      const gComment = h('div', 'dsp-group');
      gComment.append(h('span', 'dsp-label', '评论'));
      const cSort = h('button', 'dsp-chip', '按赞排序');
      cSort.title = '把当前视频的评论按点赞数从多到少排列，再点一次恢复默认顺序';
      cSort.addEventListener('click', () => {
        if (S.commentSorted) { commentSort.disable(); toast('已恢复默认顺序'); }
        else {
          if (!commentSort.rows().rows.length) return toast('先让评论区显示出来');
          commentSort.enable();
        }
        this.refresh();
      });
      const cLoad = h('button', 'dsp-chip', '加载全部');
      cLoad.title = '自动下拉加载全部评论（上限1000条），加载完再排序才是完整排名';
      cLoad.addEventListener('click', () => {
        if (commentLoad.running) commentLoad.stop('已停止');
        else {
          if (!commentSort.rows().rows.length) return toast('先让评论区显示出来');
          commentLoad.start();
        }
      });
      gComment.append(cSort, cLoad);
      this.els.gComment = gComment;
      this.els.cSort = cSort;
      this.els.cLoad = cLoad;

      // -- 收起按钮 --
      const min = h('button', 'dsp-chip dsp-min', '—');
      min.title = '收起';
      min.addEventListener('click', () => this.setCollapsed(true));

      this.bar.append(gSearch, h('span', 'dsp-sep'), gComment, min);

      // -- 筛选弹层 --
      this.pop = h('div', 'dsp-pop dsp-none');
      this.pop.id = 'dsp-pop';
      this.pop.addEventListener('click', (e) => e.stopPropagation());
      for (const [key, label] of [['digg', '点赞 ≥'], ['comment', '评论 ≥'], ['collect', '收藏 ≥']]) {
        const row = h('div', 'dsp-pop-row');
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '0'; inp.placeholder = '不限';
        inp.className = 'dsp-input';
        inp.addEventListener('change', () => { S.th[key] = num(inp.value); search.apply(); this.refresh(); });
        row.append(h('span', 'dsp-pop-lbl', label), inp);
        this.pop.append(row);
      }
      const bRow = h('div', 'dsp-pop-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.id = 'dsp-cb'; cb.checked = S.badge;
      cb.addEventListener('change', () => {
        S.badge = cb.checked;
        try { localStorage.DSP_BADGE = cb.checked ? '1' : '0'; } catch {}
        search.apply();
      });
      const cbl = document.createElement('label');
      cbl.htmlFor = 'dsp-cb'; cbl.className = 'dsp-pop-lbl'; cbl.textContent = '卡片显示数据角标';
      bRow.append(cb, cbl);
      this.pop.append(bRow, h('div', 'dsp-pop-hint',
        '排序/筛选只针对已加载的结果，建议先"加载更多"。角标含义：🔥=30天内高增速黑马，💎=高收藏率干货（均为当前结果前10%）'));
      document.addEventListener('click', () => this.pop.classList.add('dsp-none'));

      document.body.append(this.bar, this.dot, this.pop);
      this.refresh();
    },

    togglePop() {
      this.pop.classList.toggle('dsp-none');
    },
    setCollapsed(c) {
      this.bar.classList.toggle('dsp-none', c);
      this.dot.classList.toggle('dsp-none', !c);
      this.pop.classList.add('dsp-none');
    },

    // 按当前页面状态刷新工具条（哪些组可见、选中态、计数）
    refresh(shown, total) {
      if (!this.bar) return;
      const hasCards = !!document.querySelector('[id^="waterfall_item_"]')
        || !!document.querySelector('[data-e2e="user-post-list"] a[href*="/video/"], [data-e2e="user-post-list"] a[href*="/note/"]');
      const hasComments = !!document.querySelector('[data-e2e="comment-list"]');
      this.els.gSearch.classList.toggle('dsp-none', !hasCards);
      this.els.gComment.classList.toggle('dsp-none', !hasComments);
      this.bar.querySelector('.dsp-sep').classList.toggle('dsp-none', !(hasCards && hasComments));
      // 两个组都没有 → 整条隐藏（保留小圆点也没意义，全部隐藏）
      const anything = hasCards || hasComments;
      if (!anything) { this.bar.classList.add('dsp-none'); this.dot.classList.add('dsp-none'); }
      else if (this.dot.classList.contains('dsp-none') && this.bar.classList.contains('dsp-none')) {
        this.bar.classList.remove('dsp-none'); // 默认展开
      }

      for (const [k, chip] of this.chips) chip.classList.toggle('dsp-on', S.sortKeys.has(k));
      const hasTh = S.th.digg > 0 || S.th.comment > 0 || S.th.collect > 0;
      this.els.filterChip.classList.toggle('dsp-on', hasTh);
      this.els.loadChip.textContent = searchLoad.running ? `停止(${videos.size})` : '加载更多';
      this.els.loadChip.classList.toggle('dsp-on', searchLoad.running);
      this.els.count.textContent = shown != null && shown !== total
        ? `${shown}/${videos.size}条`
        : (videos.size ? `${videos.size}条` : '');
      this.els.cSort.classList.toggle('dsp-on', S.commentSorted);
      this.els.cSort.textContent = S.commentSorted ? '已按赞排序' : '按赞排序';
      const cRows = document.querySelectorAll('[data-e2e="comment-item"]').length;
      this.els.cLoad.textContent = commentLoad.running ? `停止(${cRows})` : '加载全部';
      this.els.cLoad.classList.toggle('dsp-on', commentLoad.running);
    },
  };

  // ============ 启动 ============
  function init() {
    if (!document.body) return void setTimeout(init, 300);
    ui.build();
    // 定时兜底：React 重渲染会冲掉我们的坐标/角标，这里定期补上，
    // 同时处理 SPA 导航（工具条被清掉就重建，页面类型变了就刷新显隐）
    setInterval(() => trap('tick', () => {
      if (!document.getElementById('dsp-bar')) ui.build();
      // 无条件跑：空闲分支本身很轻
      search.apply();
      ui.refresh();
    }), 1500);
    log('DouyinSearchPlus v0.5.3 已就绪');
  }
  init();
})();
