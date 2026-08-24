// 运行在页面主世界（MAIN world）：拦截抖音自己发出的接口响应，
// 把原始文本转发给内容脚本解析。只被动监听，不主动发任何请求。
//
// 实测确认的接口（2026-07 / 2026-08）：
//   搜索结果  /aweme/v1/web/general/search/stream/   （旧版叫 search/single）
//   评论列表  /aweme/v1/web/comment/list/
//   博主主页  /aweme/v1/web/aweme/post/（作品）、/aweme/v1/web/aweme/favorite/（喜欢）
//             返回结构和搜索一样是 aweme_list，所以复用 search 通道
(() => {
  'use strict';
  if (window.__DSP_HOOKED__) return;
  window.__DSP_HOOKED__ = true;

  const SIG = 'DSP_DATA';

  function classify(url) {
    if (!url) return null;
    if (/\/aweme\/v\d+\/web\/comment\/list\/reply/.test(url)) return null; // 楼中楼，忽略
    if (/\/aweme\/v\d+\/web\/comment\/list/.test(url)) return 'comments';
    // 兼容 stream / single / item 等历史与未来变体
    if (/\/aweme\/v\d+\/web\/(general\/search|search\/(item|single|stream))/.test(url)) return 'search';
    // 博主主页的作品/喜欢列表，数据结构与搜索相同，共用通道
    if (/\/aweme\/v\d+\/web\/aweme\/(post|favorite)\//.test(url)) return 'search';
    return null;
  }

  function send(kind, url, text) {
    try { window.postMessage({ source: SIG, kind, url, text }, '*'); } catch (e) { /* 忽略 */ }
  }

  // ---- hook fetch ----
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      const kind = classify(url);
      // 用 text() 而不是 json()：stream 接口可能是多段 JSON 拼接
      if (kind) res.clone().text().then((t) => send(kind, url, t)).catch(() => {});
    } catch (e) { /* 忽略 */ }
    return res;
  };

  // ---- 主页首屏数据收割 ----
  // 主页前 ~20 条作品是服务端直出的，不发 /aweme/post/ 请求；完整数据挂在
  // 卡片元素的 React fiber 上（itemInfo.statistics，camelCase）。
  // fiber 是页面脚本设置的 JS 属性，隔离世界的 content script 看不到，
  // 所以收割必须在 MAIN world 做，打包成 aweme_list 结构走既有 search 通道发出。
  function pickFiberData(el, id) {
    try {
      const fk = Object.keys(el).find((k) => k.indexOf('__reactFiber$') === 0);
      if (!fk) return null;
      let fiber = el[fk];
      for (let i = 0; fiber && i < 30; i++, fiber = fiber.return) {
        const p = fiber.memoizedProps;
        if (!p || typeof p !== 'object') continue;
        for (const key of Object.keys(p)) {
          const v = p[key];
          if (!v || typeof v !== 'object') continue;
          const st = v.statistics || v.stats;
          if (!st) continue;
          if (String(v.awemeId != null ? v.awemeId : v.aweme_id) !== id) continue;
          const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
          let ct = num(v.createTime != null ? v.createTime : v.create_time);
          if (ct > 1e12) ct = Math.round(ct / 1000); // 毫秒 → 秒
          return {
            aweme_id: id,
            desc: String(v.desc || ''),
            create_time: ct,
            author: { nickname: String((v.authorInfo && v.authorInfo.nickname) || (v.author && v.author.nickname) || '') },
            statistics: {
              digg_count: num(st.diggCount != null ? st.diggCount : st.digg_count),
              comment_count: num(st.commentCount != null ? st.commentCount : st.comment_count),
              collect_count: num(st.collectCount != null ? st.collectCount : st.collect_count),
              share_count: num(st.shareCount != null ? st.shareCount : st.share_count),
            },
          };
        }
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  setInterval(() => {
    try {
      if (!/^\/user\//.test(location.pathname)) return;
      const list = document.querySelector('[data-e2e="user-post-list"]');
      if (!list) return;
      const items = [];
      for (const a of list.querySelectorAll('a[href*="/video/"], a[href*="/note/"]')) {
        const m = /\/(?:video|note)\/(\d+)/.exec(a.getAttribute('href') || '');
        if (!m) continue;
        const root = a.closest('li') || a.closest('span') || a;
        if (root.__dspHv === m[1]) continue; // 已收割过（React 重建节点后会自然重收）
        const rec = pickFiberData(root, m[1]);
        if (rec) { root.__dspHv = m[1]; items.push(rec); }
      }
      if (items.length) {
        const sec = location.pathname.split('/')[2] || '';
        // sec_user_id 放进 URL，content 端会话签名与真实接口对齐
        send('search', 'harvest://profile?sec_user_id=' + sec, JSON.stringify({ aweme_list: items }));
      }
    } catch (e) { /* 忽略 */ }
  }, 1500);

  // ---- hook XMLHttpRequest ----
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dsp_url = url;
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    const kind = classify(String(this.__dsp_url || ''));
    if (kind) {
      this.addEventListener('load', () => {
        try { send(kind, String(this.__dsp_url), String(this.responseText || '')); } catch (e) { /* 忽略 */ }
      });
    }
    return origSend.apply(this, args);
  };
})();
