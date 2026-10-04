// 命名空间与通用工具（隔离世界）。
// 内容脚本按 manifest 里的顺序加载，共享同一个隔离世界的全局对象，统一挂在 DSP 下。
// 纯函数部分不碰 document / chrome，Node 单测可以直接 require。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});

  // ---- 数字与时间格式 ----
  // 1.2万 / 123.5万 / 1.2亿；万以下原样（中文用户读"万"最快）
  function fmtNum(n) {
    if (n == null || n === '') return '—';
    n = Number(n) || 0;
    if (n >= 1e8) return trim1(n / 1e8) + '亿';
    if (n >= 1e4) return trim1(n / 1e4) + '万';
    return String(Math.round(n));
  }
  function trim1(x) {
    const s = x >= 1000 ? String(Math.round(x)) : x.toFixed(1);
    return s.replace(/\.0$/, '');
  }
  // 比率：<10% 保留 1 位小数，≥10% 取整（112%、41%、2.5%）
  function fmtPct(r) {
    if (r == null) return '—';
    if (!Number.isFinite(r) || r <= 0) return '0%';
    const p = r * 100;
    return (p < 10 ? p.toFixed(1).replace(/\.0$/, '') : String(Math.round(p))) + '%';
  }
  function fmtAgo(ts, now) {
    if (!ts) return '';
    const d = ((now || Date.now() / 1000) - ts) / 86400;
    if (d < 1 / 24) return '刚刚';
    if (d < 1) return Math.round(d * 24) + '小时前';
    if (d < 30) return Math.round(d) + '天前';
    if (d < 365) return Math.round(d / 30) + '个月前';
    return trim1(d / 365) + '年前';
  }
  function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function fmtDuration(ms) {
    const s = Math.round((Number(ms) || 0) / 1000);
    if (s <= 0) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (x) => String(x).padStart(2, '0');
    return h ? h + ':' + p(m) + ':' + p(sec) : p(m) + ':' + p(sec);
  }

  function debounce(fn, ms) {
    let t = 0;
    const d = function () { clearTimeout(t); const args = arguments; t = setTimeout(() => fn.apply(null, args), ms); };
    d.cancel = () => clearTimeout(t);
    return d;
  }

  // 黑匣子：隔离世界的报错在页面控制台里不好找，最近一次异常写到 DOM 属性上（两个世界都能读）
  const DEBUG = () => { try { return localStorage.DSP_DEBUG === '1'; } catch (e) { return false; } };
  const log = (...a) => { if (DEBUG()) console.log('[DSP]', ...a); };
  function trap(tag, fn) {
    try { return fn(); } catch (e) {
      try {
        document.documentElement.dataset.dspErr =
          tag + ' @' + new Date().toTimeString().slice(0, 8) + ': ' + String((e && (e.stack || e.message)) || e).slice(0, 600);
      } catch (e2) { /* 忽略 */ }
      log('trap', tag, e);
      return undefined;
    }
  }

  // 极简事件总线
  function emitter() {
    const map = new Map();
    return {
      on(ev, fn) { if (!map.has(ev)) map.set(ev, new Set()); map.get(ev).add(fn); return () => map.get(ev).delete(fn); },
      emit(ev, payload) { const s = map.get(ev); if (s) for (const fn of [...s]) trap('ev:' + ev, () => fn(payload)); },
    };
  }

  DSP.util = { fmtNum, fmtPct, fmtAgo, fmtDate, fmtDuration, debounce, trap, log, emitter };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') module.exports = DSP.util;
})();
