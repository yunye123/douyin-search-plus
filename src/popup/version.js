// 弹窗打开时对照 GitHub main 的 manifest.version。
// raw.githubusercontent.com 这个文件带 Access-Control-Allow-Origin: *，
// 扩展页用普通 fetch 就能读到正文（Chrome 85 起如此，本插件要求 111+）。
// 因此不增加 host_permissions：精确到单个文件的主机权限也会被 Chrome 放宽成整个主机，
// 安装提示会变成「读取并更改 raw.githubusercontent.com 上的数据」。
// 失败、超时或版本号对不上数字分段时返回 null，调用方不显示任何提示。
(() => {
  'use strict';

  const UPDATE_URL = 'https://raw.githubusercontent.com/yunye123/douyin-search-plus/main/manifest.json';
  const REPO_URL = 'https://github.com/yunye123/douyin-search-plus';
  const TIMEOUT_MS = 4000;

  // 只接受点分的非负整数。空段、符号、前缀 v、预发布号都算无法比较。
  function parseVer(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim();
    if (!s || s.length > 32) return null;
    const parts = s.split('.');
    if (parts.length < 1 || parts.length > 8) return null;
    const nums = [];
    for (const p of parts) {
      if (!/^\d{1,9}$/.test(p)) return null;
      nums.push(Number(p));
    }
    return nums;
  }

  // 1：a 更新；-1：a 更旧；0：相等；null：至少一边不是版本号。缺的段按 0。
  function cmpVersion(a, b) {
    const pa = parseVer(a);
    const pb = parseVer(b);
    if (!pa || !pb) return null;
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const da = pa[i] || 0;
      const db = pb[i] || 0;
      if (da !== db) return da > db ? 1 : -1;
    }
    return 0;
  }

  function canonical(input) {
    const parts = parseVer(input);
    return parts ? parts.join('.') : null;
  }

  function notice(remote) {
    const v = canonical(remote);
    if (!v) return '';
    return '有新版本 v' + v + '，重新下载后在扩展管理页点刷新。';
  }

  function showUpdate(el, remote) {
    const text = notice(remote);
    if (!el || !text) return false;
    el.textContent = text;
    el.hidden = false;
    return true;
  }

  // 远程更高时返回规范化的版本号，否则 null。任何异常都变成 null。
  // 不用 AbortSignal.timeout：Node 里那个计时器不占住事件循环，单测会在超时前被掐掉。
  async function remoteNewerVersion(local, fetchImpl, opts) {
    const timeoutMs = opts && opts.timeoutMs != null ? opts.timeoutMs : TIMEOUT_MS;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const url = (opts && opts.url) || UPDATE_URL;
      const res = await fetchImpl(url, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: ctrl.signal,
      });
      if (!res || !res.ok || typeof res.json !== 'function') return null;
      const data = await res.json();
      const remote = canonical(data && data.version);
      if (!remote || cmpVersion(remote, local) !== 1) return null;
      return remote;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const api = { UPDATE_URL, REPO_URL, TIMEOUT_MS, parseVer, cmpVersion, notice, showUpdate, remoteNewerVersion };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') module.exports = api;
  else globalThis.DSP_VERSION = api;
})();
