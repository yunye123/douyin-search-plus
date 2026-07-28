// 运行在页面主世界（MAIN world）：拦截抖音自己发出的接口响应，
// 把原始文本转发给内容脚本解析。只被动监听，不主动发任何请求。
//
// 实测确认的接口（2026-07）：
//   搜索结果  /aweme/v1/web/general/search/stream/   （旧版叫 search/single）
//   评论列表  /aweme/v1/web/comment/list/
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
