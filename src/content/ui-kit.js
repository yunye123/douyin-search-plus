// 界面基础件：元素工厂、图标、Shadow DOM 宿主、弹层、提示（tooltip）、轻提示（toast）。
// 与具体视觉无关；样式全部来自 ui-css.js 注入到 Shadow DOM 的样式表，不受抖音页面 CSS 影响。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  const { trap } = DSP.util;

  // ---------- 元素工厂 ----------
  // h('button', { class: 'x', onclick: fn, 'aria-pressed': 'true' }, '文字', childEl)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), (e) => trap('ui:' + k, () => v(e)));
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    append(el, kids);
    return el;
  }
  function append(el, kids) {
    for (const c of kids) {
      if (c == null || c === false) continue;
      if (Array.isArray(c)) append(el, c);
      else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  // ---------- 图标（24 网格，1.8 描边，内联构建，不加载外部资源） ----------
  const NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    sort: ['M7 4v16', 'M3.5 16.5 7 20l3.5-3.5', 'M13 6h8', 'M13 11h6', 'M13 16h4'],
    filter: ['M4 5h16l-6 7.5V19l-4 1.5v-8L4 5z'],
    down: ['M12 4v12', 'M6.5 11 12 16.5 17.5 11', 'M5 20h14'],
    loadMore: ['M6.5 6.5 12 12l5.5-5.5', 'M6.5 12.5 12 18l5.5-5.5'],
    star: ['M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z'],
    copy: ['M9 9h10v11H9z', 'M5 15V4h10'],
    download: ['M12 4v11', 'M7 10.5 12 15.5l5-5', 'M5 19.5h14'],
    more: ['M5.5 12h.01', 'M12 12h.01', 'M18.5 12h.01'],
    power: ['M12 3.5v7.5', 'M17.6 6.6a8 8 0 1 1-11.2 0'],
    chevron: ['M6.5 9.5 12 15l5.5-5.5'],
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    close: ['M6 6l12 12', 'M18 6 6 18'],
    info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5.5', 'M12 7.6h.01'],
    heart: ['M12 20s-7.5-4.6-9.2-9.4A4.9 4.9 0 0 1 12 6.7a4.9 4.9 0 0 1 9.2 3.9C19.5 15.4 12 20 12 20z'],
    comment: ['M4 5.5h16v10.5H9.5L5.5 19.5V16H4z'],
    share: ['M14 5l6 6-6 6', 'M20 11H11a7 7 0 0 0-7 7v1'],
    refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4v4.5H15'],
    warn: ['M12 3.8 21.5 20H2.5z', 'M12 10v4.5', 'M12 17.4h.01'],
    table: ['M4 5h16v14H4z', 'M4 10h16', 'M4 14.5h16', 'M10 5v14'],
    sparkle: ['M12 3.5l1.8 4.9 4.9 1.8-4.9 1.8L12 16.9l-1.8-4.9-4.9-1.8 4.9-1.8z', 'M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
    arrowUp: ['M12 19V6', 'M6.5 11.5 12 6l5.5 5.5'],
    arrowDown: ['M12 5v13', 'M6.5 12.5 12 18l5.5-5.5'],
    minimize: ['M5 12h14'],
    trash: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l1 13h9l1-13'],
    clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5V12l3 2'],
    pause: ['M8.5 5.5v13', 'M15.5 5.5v13'],
    play: ['M7.5 5l11 7-11 7z'],
    layers: ['M12 4 3 9l9 5 9-5-9-5z', 'M3 14l9 5 9-5'],
    bug: ['M9 7.5a3 3 0 0 1 6 0', 'M7 10h10v5a5 5 0 0 1-10 0z', 'M4 11h3', 'M17 11h3', 'M4 17h3.5', 'M16.5 17H20', 'M12 10v10'],
  };
  function icon(name, size, cls) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size || 16);
    s.setAttribute('height', size || 16);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('focusable', 'false');
    if (cls) s.setAttribute('class', cls);
    for (const d of ICONS[name] || []) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    }
    return s;
  }

  // 品牌标：三根上升的柱子 + 顶端的收藏星（"收藏率"的视觉化），红青色差是抖音的签名色
  function logo(size) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size || 20);
    s.setAttribute('height', size || 20);
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'dsp-logo');
    const bars = [[4, 13.5, 4.2, 6.5], [9.9, 10, 4.2, 10], [15.8, 6.5, 4.2, 13.5]];
    const g = (dx, dy, cls) => {
      const gg = document.createElementNS(NS, 'g');
      gg.setAttribute('class', cls);
      for (const [x, y, w, hh] of bars) {
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', x + dx); r.setAttribute('y', y + dy);
        r.setAttribute('width', w); r.setAttribute('height', hh);
        r.setAttribute('rx', 1.3);
        gg.appendChild(r);
      }
      return gg;
    };
    s.appendChild(g(-0.6, 0, 'dsp-logo-c'));
    s.appendChild(g(0.6, 0, 'dsp-logo-r'));
    s.appendChild(g(0, 0, 'dsp-logo-w'));
    const star = document.createElementNS(NS, 'path');
    star.setAttribute('d', 'M17.9 1.2l.95 1.9 2.1.3-1.5 1.5.35 2.1-1.9-1-1.9 1 .35-2.1-1.5-1.5 2.1-.3z');
    star.setAttribute('class', 'dsp-logo-star');
    s.appendChild(star);
    return s;
  }

  // ---------- Shadow DOM 宿主 ----------
  // 每个宿主一个 shadow root，共用同一份样式表（adoptedStyleSheets，失败时退回 <style>）
  let sharedSheet = null;
  function styleInto(root) {
    const css = DSP.css || '';
    try {
      if (!sharedSheet) { sharedSheet = new CSSStyleSheet(); sharedSheet.replaceSync(css); }
      root.adoptedStyleSheets = [sharedSheet];
    } catch (e) {
      root.appendChild(h('style', null, css));
    }
  }
  function host(id, parent, before) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.setAttribute('data-dsp-own', '');
      const root = el.attachShadow({ mode: 'open' });
      styleInto(root);
      el.__root = root;
    }
    if (parent && (el.parentNode !== parent || (before && el.nextSibling !== before))) {
      parent.insertBefore(el, before || null);
    }
    return { el, root: el.__root || el.shadowRoot };
  }

  // ---------- 弹层（菜单 / 对话框） ----------
  // 同一时刻只开一个；点外面、按 Esc 关闭并把焦点还给触发按钮；打开时聚焦第一个可操作项
  let openPop = null;
  function popover(anchorBtn, panel, opts) {
    opts = opts || {};
    if (openPop && openPop.panel === panel) { closePop(); return null; }
    closePop();
    const layer = opts.layer;
    layer.appendChild(panel);
    panel.classList.add('dsp-pop');
    panel.setAttribute('role', opts.role || 'dialog');
    if (opts.label) panel.setAttribute('aria-label', opts.label);
    anchorBtn.setAttribute('aria-expanded', 'true');
    place(anchorBtn, panel, opts.placement || 'below');
    // Tab 键在弹层内循环（弹层在 DOM 里离触发按钮很远，不管住的话焦点会跑到页面顶部或底部）
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = [...panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select, a[href], [tabindex="0"]')].filter((el) => el.offsetWidth || el.offsetHeight);
      if (!items.length) return;
      const act = panel.getRootNode().activeElement;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (act === first || !panel.contains(act))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
    });
    const st = { anchorBtn, panel, onClose: opts.onClose };
    openPop = st;
    requestAnimationFrame(() => {
      panel.classList.add('dsp-in');
      const f = panel.querySelector('[data-autofocus]') || panel.querySelector('button:not([disabled]), input, [tabindex="0"]');
      if (f && opts.focus !== false) f.focus({ preventScroll: true });
    });
    return st;
  }
  function closePop(restoreFocus) {
    if (!openPop) return;
    const st = openPop;
    openPop = null;
    st.anchorBtn.setAttribute('aria-expanded', 'false');
    st.panel.classList.remove('dsp-in');
    st.panel.remove();
    if (restoreFocus) st.anchorBtn.focus({ preventScroll: true });
    if (st.onClose) trap('pop:close', st.onClose);
  }
  function isOpen(panel) { return !!openPop && (!panel || openPop.panel === panel); }
  // 定位：贴着按钮下方（或上方），不出视口
  function place(anchor, panel, placement) {
    if (placement === 'none') return; // 面板自己定位（例如右侧抽屉）
    const r = anchor.getBoundingClientRect();
    panel.style.position = 'fixed';
    panel.style.visibility = 'hidden';
    panel.style.left = '0px';
    panel.style.top = '0px';
    const pw = panel.offsetWidth, ph = panel.offsetHeight;
    let left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    if (placement === 'below-end') left = Math.min(Math.max(8, r.right - pw), window.innerWidth - pw - 8);
    let top = r.bottom + 8;
    if (placement === 'above' || top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
    panel.style.visibility = '';
  }
  // 全局：Esc 关闭、点外面关闭（事件在 shadow 边界会被重定向，用 composedPath 判断）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (tip.el && tip.el.classList.contains('dsp-in')) hideTip(); // 提示框可以用 Esc 关掉
    if (openPop) { e.stopPropagation(); closePop(true); }
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (!openPop) return;
    const path = e.composedPath();
    if (path.includes(openPop.panel) || path.includes(openPop.anchorBtn)) return;
    closePop(false);
  }, true);
  window.addEventListener('resize', () => closePop(false));

  // ---------- 提示（tooltip） ----------
  // 悬停 400ms 或键盘聚焦时出现；在相邻控件间移动时立即切换；内容：标题 + 一行解释 + 可选公式
  const tip = { el: null, t: 0, warm: false, cool: 0, cur: null };
  // 读屏：提示文字直接写进目标的 aria-description（aria-describedby 的 id 引用跨不过 shadow root）
  const tipText = (c) => (typeof c === 'string' ? c : [c.title, c.body, c.foot].filter(Boolean).join('：'));
  function hideTip() {
    clearTimeout(tip.t);
    if (tip.el) tip.el.classList.remove('dsp-in');
    tip.cur = null;
    clearTimeout(tip.cool);
    tip.cool = setTimeout(() => { tip.warm = false; }, 300);
  }
  function bindTip(target, content, layer) {
    target.__tip = content;
    const describe = () => { try { const c = typeof content === 'function' ? content() : content; if (c) target.setAttribute('aria-description', tipText(c)); } catch (e) { /* 忽略 */ } };
    describe();
    const show = (immediate) => {
      clearTimeout(tip.t);
      clearTimeout(tip.hideT);
      tip.t = setTimeout(() => renderTip(target, layer), immediate || tip.warm ? 0 : 400);
    };
    // 离开目标后留 150ms：鼠标可以移到提示上（WCAG 1.4.13：提示可悬停、可关闭）
    const hideSoon = () => { clearTimeout(tip.t); clearTimeout(tip.hideT); tip.hideT = setTimeout(hideTip, 150); };
    target.addEventListener('pointerenter', () => show(false));
    target.addEventListener('pointerleave', hideSoon);
    target.addEventListener('focus', () => { describe(); if (target.matches(':focus-visible')) show(true); });
    target.addEventListener('blur', hideTip);
    target.addEventListener('pointerdown', hideTip);
  }
  function renderTip(target, layer) {
    const c = typeof target.__tip === 'function' ? target.__tip() : target.__tip;
    if (!c || !target.isConnected) return;
    if (!tip.el) {
      tip.el = h('div', { class: 'dsp-tip', 'aria-hidden': 'true' });
      tip.el.addEventListener('pointerenter', () => clearTimeout(tip.hideT));
      tip.el.addEventListener('pointerleave', () => { tip.hideT = setTimeout(hideTip, 150); });
    }
    if (tip.el.parentNode !== layer) layer.appendChild(tip.el);
    clear(tip.el);
    if (typeof c === 'string') tip.el.appendChild(h('div', { class: 'dsp-tip-body' }, c));
    else {
      if (c.title) tip.el.appendChild(h('div', { class: 'dsp-tip-title' }, c.title));
      if (c.body) tip.el.appendChild(h('div', { class: 'dsp-tip-body' }, c.body));
      if (c.foot) tip.el.appendChild(h('div', { class: 'dsp-tip-foot' }, c.foot));
    }
    target.setAttribute('aria-description', tipText(c));
    const r = target.getBoundingClientRect();
    tip.el.style.left = '0px';
    tip.el.style.top = '0px';
    tip.el.classList.add('dsp-measure');
    const w = tip.el.offsetWidth, hh = tip.el.offsetHeight;
    tip.el.classList.remove('dsp-measure');
    let top = r.bottom + 8;
    if (top + hh > window.innerHeight - 8) top = r.top - hh - 8;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    tip.el.style.left = Math.round(left) + 'px';
    tip.el.style.top = Math.round(top) + 'px';
    tip.el.classList.add('dsp-in');
    tip.warm = true;
    tip.cur = target;
  }

  // ---------- 轻提示（toast） ----------
  // 出现在指定锚点附近；3 秒消失，悬停时暂停；可带一个动作按钮（例如"撤销"）
  let toastSt = { el: null, t: 0 };
  // 统一出现在视口底部居中（不盖住结果第一行的名次和收藏率）；
  // 只有带动作按钮（例如"撤销"）的提示在鼠标悬停时暂停计时，普通提示照常消失
  function toast(layer, msg, opts) {
    opts = opts || {};
    if (!toastSt.el) {
      toastSt.el = h('div', { class: 'dsp-toast', role: 'status', 'aria-live': 'polite' });
      toastSt.el.addEventListener('pointerenter', () => { if (toastSt.hasAction) clearTimeout(toastSt.t); });
      toastSt.el.addEventListener('pointerleave', () => { if (toastSt.hasAction) toastSt.arm(2000); });
    }
    const el = toastSt.el;
    if (el.parentNode !== layer) layer.appendChild(el);
    clear(el);
    el.classList.toggle('dsp-toast-warn', opts.tone === 'warn');
    el.appendChild(icon(opts.icon || (opts.tone === 'warn' ? 'warn' : 'check'), 16));
    el.appendChild(h('span', { class: 'dsp-toast-msg' }, msg));
    toastSt.hasAction = !!opts.action;
    if (opts.action) {
      el.appendChild(h('button', { class: 'dsp-toast-act', type: 'button', onclick: () => { el.classList.remove('dsp-in'); opts.action.run(); } }, opts.action.label));
    }
    toastSt.arm = (ms) => { clearTimeout(toastSt.t); toastSt.t = setTimeout(() => el.classList.remove('dsp-in'), ms); };
    requestAnimationFrame(() => el.classList.add('dsp-in'));
    toastSt.arm(opts.duration || (opts.action ? 5000 : 3000));
  }

  // 系统"减少动态效果"
  const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };

  DSP.kit = { h, append, clear, icon, logo, host, popover, closePop, isOpen, place, bindTip, toast, reducedMotion, ICONS };
})();
