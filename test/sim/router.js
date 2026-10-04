// 把 https://www.douyin.com/** 的请求全部拦截到本地仿真页 / 仿真接口。
// 其他一切外网请求一律拒绝 —— 测试永远不碰真实抖音和用户账号。
'use strict';

const data = require('./data');
const pages = require('./pages');

const SEARCH_TOTAL = 120;
const PROFILE_TOTAL = 60;
const COMMENT_TOTAL = 160;

function createSim() {
  const registry = new Map(); // id -> video（供封面与详情页查找）
  const cache = new Map();
  const remember = (list) => { for (const v of list) registry.set(v.id, v); return list; };

  const searchSet = (kw) => {
    const k = 's:' + kw;
    if (!cache.has(k)) cache.set(k, remember(data.makeVideos(data.hashStr(kw), SEARCH_TOTAL)));
    return cache.get(k);
  };
  const profileSet = (sec) => {
    const k = 'p:' + sec;
    if (!cache.has(k)) {
      const author = '星辰ai';
      cache.set(k, remember(data.makeVideos(data.hashStr(sec), PROFILE_TOTAL, { author, median: 900 })));
    }
    return cache.get(k);
  };

  // 官方筛选是服务端过滤：这里按 filter_selected 真的过滤/重排，便于测试"会话切换清空"
  function applyFilter(list, filterSelected) {
    if (!filterSelected) return list;
    let f = {};
    try { f = JSON.parse(filterSelected); } catch { return list; }
    let out = list.slice();
    const days = Number(f.publish_time || 0);
    if (days) out = out.filter((v) => (data.NOW - v.createTime) / 86400 <= days);
    if (f.filter_duration) {
      const [lo, hi] = String(f.filter_duration).split('-').map(Number);
      out = out.filter((v) => v.durMs / 60000 >= lo && v.durMs / 60000 < hi);
    }
    if (f.sort_type === '1') out.sort((a, b) => b.digg - a.digg);
    if (f.sort_type === '2') out.sort((a, b) => b.createTime - a.createTime);
    return out;
  }

  const counters = { search: 0, post: 0, comment: 0, pages: 0 };

  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const html = (body) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
    const jsonRes = (obj) => route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(obj) });

    if (url.hostname === 'p3-sim.douyinpic.com') {
      const id = (/\/cover\/(\d+)\.svg/.exec(p) || [])[1];
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: pages.coverSvg(registry.get(id)) });
    }
    if (url.hostname !== 'www.douyin.com') return route.abort();

    if (p.startsWith('/aweme/v1/web/search/item')) {
      counters.search++;
      const kw = url.searchParams.get('keyword') || '';
      const list = applyFilter(searchSet(kw), url.searchParams.get('filter_selected'));
      const offset = Number(url.searchParams.get('offset') || 0);
      const count = Number(url.searchParams.get('count') || 10);
      const slice = list.slice(offset, offset + count);
      return jsonRes({ status_code: 0, data: slice.map((v) => ({ type: 1, aweme_info: data.toApiAweme(v) })), has_more: offset + count < list.length ? 1 : 0, cursor: offset + count });
    }
    if (p.startsWith('/aweme/v1/web/aweme/post')) {
      counters.post++;
      const list = profileSet(url.searchParams.get('sec_user_id') || '');
      const cursor = Number(url.searchParams.get('max_cursor') || 0);
      const count = Number(url.searchParams.get('count') || 18);
      const slice = list.slice(cursor, cursor + count);
      return jsonRes({ status_code: 0, aweme_list: slice.map(data.toApiAweme), has_more: cursor + count < list.length ? 1 : 0, max_cursor: cursor + count });
    }
    if (p.startsWith('/aweme/v1/web/comment/list/reply')) return jsonRes({ status_code: 0, comments: [] });
    if (p.startsWith('/aweme/v1/web/comment/list')) {
      counters.comment++;
      const aid = url.searchParams.get('aweme_id') || '';
      const k = 'c:' + aid;
      if (!cache.has(k)) cache.set(k, data.makeComments(data.hashStr(aid), COMMENT_TOTAL));
      const list = cache.get(k);
      const cursor = Number(url.searchParams.get('cursor') || 0);
      const count = Number(url.searchParams.get('count') || 20);
      const slice = list.slice(cursor, cursor + count);
      return jsonRes({ status_code: 0, comments: slice.map(data.toApiComment), has_more: cursor + count < list.length ? 1 : 0, cursor: cursor + count, total: list.length });
    }
    if (p.startsWith('/aweme/')) return jsonRes({ status_code: 0 });

    counters.pages++;
    if (p.startsWith('/search/')) {
      const kw = decodeURIComponent(p.split('/')[2] || '');
      const list = searchSet(kw);
      const mixIds = list.filter((v) => v.isMix).map((v) => v.id);
      return html(pages.searchPage(kw, list.slice(0, 20), mixIds));
    }
    if (p.startsWith('/user/')) {
      const sec = p.split('/')[2] || 'self';
      const list = profileSet(sec);
      return html(pages.profilePage('星辰ai', PROFILE_TOTAL, list.slice(0, 18)));
    }
    if (p.startsWith('/video/') || p.startsWith('/note/')) {
      const id = p.split('/')[2];
      const v = registry.get(id) || data.makeVideos(data.hashStr(id), 1)[0];
      return html(pages.videoPage(v));
    }
    if (p === '/' || p === '') return html(pages.homePage());
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'sim: not found' });
  }

  async function install(context) {
    await context.route(/.*/, (route) => {
      const u = route.request().url();
      if (/^https:\/\/(www\.douyin\.com|p3-sim\.douyinpic\.com)\//.test(u)) return handle(route);
      if (u.startsWith('chrome-extension://') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
      return route.abort();
    });
  }

  return { install, counters, registry, searchSet, profileSet };
}

module.exports = { createSim, SEARCH_TOTAL, PROFILE_TOTAL, COMMENT_TOTAL };
