// 页面适配层：所有"抖音页面长什么样"的知识只放在这里。
// 原则：数据优先、DOM 只做增强；每类页面多种定位策略按顺序尝试，最后用启发式兜底；
// 全部失败时返回空结果并在诊断里说明，由界面显示"识别失败"而不是静默消失。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});

  const ID_RE = /\/(?:video|note)\/(\d{8,25})/;
  const LINK_SEL = 'a[href*="/video/"], a[href*="/note/"]';

  // ---------- 结果列表定位 ----------
  // 每个策略返回列表容器（卡片的共同父节点）；按"实测日期"排列，新版在前
  const LIST_STRATEGIES = {
    search: [
      { name: 'scroll-list@2026-10', find: () => document.querySelector('#search-result-container ul[data-e2e="scroll-list"]') },
      { name: 'waterfall@2026-07', find: () => { const c = document.querySelector('[id^="waterfall_item_"]'); return c && c.parentElement; } },
      { name: 'stamped', find: () => stampedParent(document.querySelector('#search-result-container') || document.body) },
      { name: 'heuristic', find: () => heuristicList(document.querySelector('#search-result-container') || mainArea()) },
    ],
    profile: [
      { name: 'user-post-list@2026-10', find: () => { const r = document.querySelector('[data-e2e="user-post-list"]'); return r && (r.querySelector('ul[data-e2e="scroll-list"]') || r.querySelector('ul')); } },
      { name: 'stamped', find: () => stampedParent(document.querySelector('[data-e2e="user-post-list"]') || document.body) },
      { name: 'heuristic', find: () => heuristicList(document.querySelector('[data-e2e="user-post-list"]') || mainArea()) },
    ],
  };

  function mainArea() {
    return document.querySelector('main') || document.querySelector('#root') || document.body;
  }

  // 数据桥盖过章（data-dsp-aid）的卡片按父节点分组，取最大的一组
  function stampedParent(scope) {
    if (!scope) return null;
    const groups = new Map();
    for (const el of scope.querySelectorAll('[data-dsp-aid]')) {
      const p = el.parentElement;
      if (p) groups.set(p, (groups.get(p) || 0) + 1);
    }
    let best = null, n = 0;
    for (const [p, c] of groups) if (c > n) { best = p; n = c; }
    return n >= 3 ? best : null;
  }

  // 启发式："同一父节点下、重复出现、各自带一个视频链接的子节点"最多的那个父节点就是列表
  function heuristicList(scope) {
    if (!scope) return null;
    const counts = new Map();
    for (const a of scope.querySelectorAll(LINK_SEL)) {
      if (!ID_RE.test(a.getAttribute('href') || '')) continue;
      // 向上找到"父节点有多个兄弟卡片"的那一层
      let el = a;
      for (let i = 0; el && el !== scope && i < 6; i++) {
        const p = el.parentElement;
        if (!p) break;
        if (p.children.length >= 4) { counts.set(p, (counts.get(p) || 0) + 1); break; }
        el = p;
      }
    }
    let best = null, n = 0;
    for (const [p, c] of counts) if (c > n) { best = p; n = c; }
    return n >= 4 ? best : null;
  }

  function locateList(type) {
    const strategies = LIST_STRATEGIES[type];
    if (!strategies) return null;
    for (const s of strategies) {
      let el = null;
      try { el = s.find(); } catch (e) { el = null; }
      if (el && el.isConnected) return { el, strategy: s.name };
    }
    return null;
  }

  // 列表里的卡片：{ el（列表的直接子节点）, id, a, img }
  function cardsOf(listEl) {
    const out = [];
    if (!listEl) return out;
    for (const child of listEl.children) {
      if (child.id === 'dsp-dock' || child.hasAttribute('data-dsp-own')) continue;
      const a = child.matches(LINK_SEL) ? child : child.querySelector(LINK_SEL);
      const m = a && ID_RE.exec(a.getAttribute('href') || '');
      // 链接里的 id 最直接；没有链接时用数据桥盖的章
      const id = (m && m[1]) || child.getAttribute('data-dsp-aid') || '';
      if (!id) continue;
      out.push({ el: child, id, a, img: child.querySelector('img') });
    }
    return out;
  }

  // ---------- 评论 ----------
  function commentList() {
    return document.querySelector('[data-e2e="comment-list"]');
  }
  // 评论行：列表的直接子节点里包含 comment-item 的那些
  function commentRows(list) {
    list = list || commentList();
    if (!list) return [];
    const rows = [];
    for (const el of list.children) {
      const item = el.matches('[data-e2e="comment-item"]') ? el : el.querySelector('[data-e2e="comment-item"]');
      if (item) rows.push({ el, item });
    }
    return rows;
  }
  // 评论区的滚动容器（向上找第一个可滚动的祖先）
  function scrollerOf(el) {
    let sc = el && el.parentElement;
    while (sc && sc !== document.body && sc !== document.documentElement) {
      const cs = getComputedStyle(sc);
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight + 40) return sc;
      sc = sc.parentElement;
    }
    return null;
  }

  // 从评论 DOM 里读点赞数（没有 fiber 和接口数据时的兜底）：
  // 第一个"旁边有 SVG 图标"的独立纯数字；正文里的数字（QQ 号）没有图标
  function domCommentDigg(item) {
    const toNum = (t) => (/[万w]$/.test(t) ? Math.round(parseFloat(t) * 10000) : parseInt(t, 10));
    const w = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = n.textContent.trim();
      if (!/^\d+(\.\d+)?[万w]?$/.test(t)) continue;
      const p = n.parentElement;
      const gp = p && p.parentElement;
      if ((p && p.querySelector('svg')) || (gp && gp.querySelector('svg'))) return toNum(t);
    }
    return null;
  }
  // 评论正文的规范化文本（配对接口数据用）
  const normText = (s) => String(s || '').replace(/\s+/g, '').slice(0, 24);

  // ---------- 拦截检测：登录墙 / 验证码 ----------
  // 只看"可见的、悬浮在页面上的"元素，避免把页面正文里的"登录"二字当成登录墙
  const RE_CAPTCHA = /验证码|安全验证|滑块|拖动.*完成|请完成验证|向右拖动|旋转.*图片/;
  const RE_LOGIN = /登录后|扫码登录|一键登录|手机号登录|登录抖音|立即登录|验证码登录/;
  function blockingReason() {
    // ① 通用：屏幕中央最上层是不是一个"盖住页面的固定遮罩"，而且里面写着登录/验证（不依赖类名）
    const W = window.innerWidth, H = window.innerHeight;
    for (const [x, y] of [[W / 2, H / 2], [W / 2, H * 0.35]]) {
      const stack = document.elementsFromPoint(x, y);
      for (const el of stack.slice(0, 6)) {
        if (el.closest('#dsp-root, #dsp-dock, #dsp-cbar')) continue;
        let p = el;
        for (let i = 0; p && p !== document.body && i < 8; i++, p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (cs.position !== 'fixed') continue;
          const r = p.getBoundingClientRect();
          if (r.width < 240 || r.height < 140) continue;
          const t = (p.textContent || '').slice(0, 600);
          if (RE_CAPTCHA.test(t)) return 'captcha';
          if (RE_LOGIN.test(t)) return 'login';
          break;
        }
      }
    }
    // ② 按类名找常见的登录/验证弹窗
    const cands = document.querySelectorAll('[class*="login" i], [class*="Login"], [id*="login" i], [class*="captcha" i], [id*="captcha" i], [class*="verify" i], [id*="verify" i], [role="dialog"], [class*="modal" i]');
    for (const el of cands) {
      if (el.closest('#dsp-root')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 120) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      const t = (el.textContent || '').slice(0, 400);
      if (RE_CAPTCHA.test(t) || /captcha|verify/i.test(el.id + ' ' + el.className)) return 'captcha';
      if (RE_LOGIN.test(t)) return 'login';
    }
    for (const f of document.querySelectorAll('iframe[src*="verify"], iframe[src*="captcha"]')) {
      const r = f.getBoundingClientRect();
      if (r.width > 100 && r.height > 80) return 'captcha';
    }
    return null;
  }

  // ---------- 页面几何 ----------
  // 顶部固定栏的底边：吸顶工具栏要停在它下面
  function headerBottom() {
    let bottom = 0;
    const xs = [Math.round(window.innerWidth / 2), 260, window.innerWidth - 200];
    for (const x of xs) {
      for (const el of document.elementsFromPoint(x, 4)) {
        if (el.closest && el.closest('#dsp-root, #dsp-dock')) continue;
        let p = el;
        while (p && p !== document.body && p !== document.documentElement) {
          const cs = getComputedStyle(p);
          if (cs.position === 'fixed' || cs.position === 'sticky') {
            const r = p.getBoundingClientRect();
            if (r.top <= 4 && r.height < 200 && r.width > window.innerWidth * 0.5) bottom = Math.max(bottom, r.bottom);
            break;
          }
          p = p.parentElement;
        }
      }
    }
    return Math.round(bottom);
  }

  // 抖音当前是深色还是浅色：取 body（或第一个有背景色的祖先）的亮度
  function pageTheme() {
    const pick = (el) => {
      while (el) {
        const c = getComputedStyle(el).backgroundColor;
        const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(c || '');
        if (m && (m[4] === undefined || +m[4] > 0.5)) return [+m[1], +m[2], +m[3]];
        el = el.parentElement;
      }
      return null;
    };
    const rgb = pick(document.querySelector('#search-result-container') || document.body) || pick(document.documentElement);
    if (!rgb) return 'dark';
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    return lum > 0.6 ? 'light' : 'dark';
  }

  // 主页头部的账号数据（获赞、粉丝、作品数），用来算"单条占账号总获赞"
  function profileStats() {
    const read = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return 0;
      const m = /([\d.]+)\s*(万|亿|w)?/.exec(el.textContent.replace(/,/g, ''));
      if (!m) return 0;
      const unit = m[2] === '亿' ? 1e8 : m[2] ? 1e4 : 1;
      return Math.round(parseFloat(m[1]) * unit);
    };
    const likes = read('[data-e2e="user-info-like"]');
    const fans = read('[data-e2e="user-info-fans"]');
    const works = read('[data-e2e="user-tab-count"]');
    return likes || fans || works ? { likes, fans, works } : null;
  }

  // ---------- 诊断 ----------
  // 只含结构信息（标签、data-e2e、类名骨架、计数），不含任何正文和用户信息
  function skeleton(el, depth) {
    if (!el || depth > 3) return '';
    const e2e = el.getAttribute && el.getAttribute('data-e2e');
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    let s = el.tagName.toLowerCase() + (el.id ? '#' + el.id.replace(/\d{6,}/g, 'N') : '') + (cls ? '.' + cls : '') + (e2e ? '[e2e=' + e2e + ']' : '');
    const kids = [...el.children].slice(0, 3).map((c) => skeleton(c, depth + 1)).filter(Boolean);
    if (kids.length) s += '>(' + kids.join(',') + ')';
    return s;
  }
  function diagnose(type) {
    const out = { type, url: location.pathname.replace(/\/user\/[^/]+/, '/user/<id>').replace(/\/search\/[^/]+/, '/search/<kw>'), strategies: {} };
    for (const s of LIST_STRATEGIES[type] || []) {
      let el = null;
      try { el = s.find(); } catch (e) { /* 忽略 */ }
      out.strategies[s.name] = el ? cardsOf(el).length : 0;
    }
    out.links = document.querySelectorAll(LINK_SEL).length;
    out.stamped = document.querySelectorAll('[data-dsp-aid]').length;
    out.commentItems = document.querySelectorAll('[data-e2e="comment-item"]').length;
    out.blocking = blockingReason();
    const located = locateList(type);
    const first = located && located.el.firstElementChild;
    out.firstCard = first ? skeleton(first, 0) : '';
    out.err = document.documentElement.dataset.dspErr || '';
    return out;
  }

  DSP.adapters = {
    ID_RE, LINK_SEL, LIST_STRATEGIES,
    locateList, cardsOf, commentList, commentRows, scrollerOf, domCommentDigg, normText,
    blockingReason, headerBottom, pageTheme, profileStats, diagnose,
  };
})();
