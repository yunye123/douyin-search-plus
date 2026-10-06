// 仿真页面：按 2026-10 实测的抖音网页版（「抖音精选」）结构生成 HTML。
// 只复刻插件依赖的"结构契约"和大致外观，不追求像素级一致：
//   搜索页  #search-result-container ul[data-e2e="scroll-list"] > li > div.search-result-card > a[href*=/video/]
//          li 上挂 React fiber：li.__reactFiber$x.return.memoizedProps.itemInfo.awemeInfo（camelCase）
//          翻页走 XHR /aweme/v1/web/search/item/（snake_case）
//   主页    [data-e2e="user-post-list"] ul[data-e2e="scroll-list"] > li > div > a[href*=/video/]
//          首屏服务端直出（不发接口），fiber：memoizedProps.itemInfo.statistics；翻页走 /aweme/v1/web/aweme/post/
//   详情页  [data-e2e="comment-list"] > div > [data-e2e="comment-item"]；评论走 /aweme/v1/web/comment/list/
'use strict';

const { NOW, coverUrl, toSearchFiber, toProfileFiber } = require('./data');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

const BASE_CSS = `
*{box-sizing:border-box} html,body{margin:0;padding:0}
body{background:#161722;color:#e8e8ea;font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:inherit;text-decoration:none}
.sim-top{position:fixed;top:0;left:0;right:0;height:56px;display:flex;align-items:center;padding:0 24px;background:#161722;z-index:50}
.sim-logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:18px;width:160px}
.sim-logo i{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#25f4ee,#fe2c55);display:inline-block}
.sim-search{margin:0 auto;width:516px;height:40px;border-radius:12px;background:#2a2b36;display:flex;align-items:center;padding:0 6px 0 14px;color:#9a9ba5}
.sim-search input{flex:1;background:none;border:0;outline:0;color:#e8e8ea;font-size:14px}
.sim-search button{all:unset;cursor:pointer;color:#fff;font-weight:600;padding:6px 10px}
.sim-actions{display:flex;gap:22px;color:#b9bac2;font-size:11px;width:260px;justify-content:flex-end;align-items:center;white-space:nowrap}
.sim-avatar{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#8e9eab,#eef2f3)}
.sim-nav{position:fixed;top:56px;left:0;bottom:0;width:160px;padding:8px 18px;color:#d6d6db}
.sim-nav div{height:40px;display:flex;align-items:center;gap:12px;font-size:15px}
.sim-nav hr{border:0;border-top:1px solid #2a2b36;margin:8px 0}
.sim-main{margin-left:160px;padding:56px 24px 40px 14px}
`;

function shell(title, body, extraCss, script) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${BASE_CSS}${extraCss || ''}</style></head><body class="entry-content">
<div class="sim-top"><div class="sim-logo"><i></i>抖音精选</div>
<form class="sim-search" id="sim-search-form"><input id="sim-q" placeholder="搜索你感兴趣的内容" value=""><button>搜索</button></form>
<div class="sim-actions"><span>充值</span><span>客户端</span><span>通知</span><span>消息</span><span>投稿</span><span class="sim-avatar"></span></div></div>
<nav class="sim-nav"><div>精选</div><div>推荐</div><div>AI抖音</div><hr><div>关注</div><div>朋友</div><div>我的</div><hr><div>直播</div><div>放映厅</div><div>短剧</div></nav>
<main class="sim-main">${body}</main>
<script>${script || ''}</script></body></html>`;
}

// ---------- 页面通用脚本：卡片渲染、fiber 挂载、snake→camel ----------
const COMMON_JS = `
window.__SIM__ = window.__SIM__ || {};
const NOW = ${NOW};
const fmt = (n) => n >= 10000 ? (n / 10000).toFixed(1).replace(/\\.0$/, '') + '万' : String(n);
const ago = (ct) => { const d = (NOW - ct) / 86400; if (d < 1) return Math.max(1, Math.round(d * 24)) + '小时前'; if (d < 30) return Math.round(d) + '天前'; if (d < 365) return Math.round(d / 30) + '月前'; return Math.round(d / 365) + '年前'; };
const dur = (ms) => { const s = Math.round(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const escH = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FK = '__reactFiber$sim' + Math.random().toString(36).slice(2, 8);
const NOFIBER = /[?&](nofiber|broken)=1/.test(location.search);
// ?bodyscroll=1：和真实抖音一样由 body 自己滚动（html 不滚，window.scrollBy / scrollTo 不起作用）
const BODYSCROLL = /[?&]bodyscroll=1/.test(location.search);
if (BODYSCROLL) { const st = document.createElement('style'); st.textContent = 'html{height:100%;overflow:hidden}body{height:100%;overflow-y:auto}'; document.head.appendChild(st); }
function pageNearBottom(px) {
  if (BODYSCROLL) { const b = document.body; return b.scrollTop + b.clientHeight >= b.scrollHeight - px; }
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - px;
}
function onPageScroll(fn) { (BODYSCROLL ? document.body : window).addEventListener('scroll', fn, { passive: true }); }
function attachFiber(el, itemInfo) { if (NOFIBER) return; el[FK] = { tag: 5, memoizedProps: { className: el.className }, return: { tag: 0, memoizedProps: { itemInfo } } }; }
function apiToSearchFiber(a) {
  return { type: 1, docType: 1, awemeInfo: {
    awemeId: a.aweme_id, desc: a.desc, createTime: a.create_time, awemeType: a.aweme_type,
    authorInfo: { nickname: a.author.nickname, secUid: a.author.sec_uid },
    stats: { diggCount: a.statistics.digg_count, commentCount: a.statistics.comment_count, collectCount: a.statistics.collect_count, shareCount: a.statistics.share_count, playCount: 0 },
    video: a.video ? { duration: a.video.duration, cover: a.video.cover.url_list[0], coverUrlList: a.video.cover.url_list } : null,
    images: a.images ? a.images.map((i) => ({ urlList: i.url_list })) : null,
  } };
}
function apiToProfileFiber(a) {
  return { awemeId: a.aweme_id, desc: a.desc, createTime: a.create_time, authorInfo: { nickname: a.author.nickname },
    statistics: { diggCount: a.statistics.digg_count, commentCount: a.statistics.comment_count, collectCount: a.statistics.collect_count, shareCount: a.statistics.share_count },
    video: a.video ? { duration: a.video.duration, cover: a.video.cover.url_list[0] } : null,
    images: a.images ? a.images.map((x) => ({ url: x.url_list[0] })) : null };
}
function xhrJson(url) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.onload = () => { try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); } };
    x.onerror = reject;
    x.send();
  });
}
// "React 重渲染"混沌：随机重建若干卡片内部（会冲掉插件注入的子元素），偶尔整块替换节点
function chaos(listSel, rerender) {
  if (!/[?&]chaos=1/.test(location.search)) return;
  setInterval(() => {
    const lis = [...document.querySelectorAll(listSel)];
    if (!lis.length) return;
    for (let k = 0; k < 2; k++) { const li = lis[Math.floor(Math.random() * lis.length)]; rerender(li, false); }
    if (Math.random() < 0.3) { const li = lis[Math.floor(Math.random() * lis.length)]; rerender(li, true); }
  }, 1200);
}
`;

// ---------- 搜索页 ----------
const SEARCH_CSS = `
.sim-tabs{display:flex;gap:64px;align-items:center;height:56px;font-size:16px;color:#b9bac2;padding-left:14px}
.sim-tabs .on{color:#fe2c55;font-weight:600}
.sim-tabs .sim-filter{margin-left:auto;margin-right:330px;cursor:pointer;position:relative}
.sim-filter-pop{display:none;position:absolute;right:0;top:30px;background:#252632;border-radius:12px;padding:12px 16px;z-index:30;width:520px;font-size:13px}
.sim-filter.open .sim-filter-pop{display:block}
.sim-filter-pop div{display:flex;gap:14px;padding:6px 0;color:#9a9ba5}
.sim-filter-pop b{width:70px;font-weight:400}
.sim-filter-pop span{cursor:pointer;color:#e8e8ea}
.sim-filter-pop span.on{color:#fe2c55}
.sim-wrap{display:flex;gap:30px}
#search-result-container{width:1140px;flex:none}
#search-result-container ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;position:relative;width:1161px}
#search-result-container li{width:269.25px;margin:0 21px 21px 0}
.search-result-card a{display:flex;flex-direction:column;position:relative;background:#252632;border-radius:12px;overflow:hidden;height:303px}
.sim-cover{position:relative;height:185px;background:#33343f}
.sim-cover img{width:100%;height:100%;object-fit:cover;display:block}
.sim-like{position:absolute;left:10px;bottom:8px;font-size:13px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6)}
.sim-dur{position:absolute;right:8px;bottom:8px;font-size:12px;color:#fff;background:rgba(0,0,0,.45);padding:0 5px;border-radius:4px}
.sim-mix{position:absolute;left:8px;top:8px;font-size:12px;color:#fff;background:rgba(0,0,0,.45);padding:0 6px;border-radius:4px}
.sim-info{padding:10px 14px}
.sim-title{font-size:15px;line-height:21px;height:42px;overflow:hidden;color:#e8e8ea;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.sim-meta{display:flex;justify-content:space-between;color:#8a8b96;font-size:13px;margin-top:12px}
.sim-side{width:290px;flex:none;color:#d6d6db}
.sim-side h4{margin:8px 0 14px;font-size:16px}
.sim-side p{margin:0 0 12px;font-size:13px;color:#b9bac2}
.sim-loading{color:#8a8b96;text-align:center;padding:20px;width:1140px}
.sim-wall{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:99}
.sim-wall div{background:#fff;color:#111;border-radius:20px;padding:40px 80px;font-size:22px;font-weight:700}
`;

const SEARCH_JS = `
${COMMON_JS}
const S = window.__SIM__;
const SEGS = location.pathname.split('/');
S.kw = decodeURIComponent(SEGS[SEGS.indexOf('search') + 1] || '');
S.filter = '';
// ?type=general："综合"标签——绝对定位的瀑布流（#waterFallScrollContainer > div#waterfall_item_<id>），卡片没有链接，
// fiber 在 return 一层的 memoizedProps.item 上；"视频"标签的空列表还留在页面上（和真实页面一样）
const GENERAL = /[?&]type=general/.test(location.search);
S.offset = 0; S.hasMore = 1; S.loading = false; S.total = 0;
const wallAt = Number((/[?&]loginwall=(\\d+)/.exec(location.search) || [])[1] || 0);
const ul = document.querySelector('#search-result-container ul[data-e2e="scroll-list"]');
let wf = null;
if (GENERAL) {
  wf = document.createElement('div');
  wf.id = 'waterFallScrollContainer';
  wf.style.cssText = 'position:relative;width:1140px';
  ul.parentElement.appendChild(wf);
}
document.querySelectorAll('.sim-tabs > span[data-type]').forEach((sp) => {
  sp.classList.toggle('on', sp.dataset.type === (GENERAL ? 'general' : 'video'));
  sp.addEventListener('click', () => { const u = new URL(location.href); u.searchParams.set('type', sp.dataset.type); location.assign(u.toString()); });
});
function cardHTML(f) {
  const a = f.awemeInfo, st = a.stats;
  const cover = a.video ? a.video.cover : (a.images && a.images[0] && a.images[0].urlList[0]);
  return '<div class="search-result-card"><a href="//www.douyin.com/' + (a.video ? 'video/' : 'note/') + a.awemeId + '">' +
    '<div class="sim-cover"><img src="' + cover + '" alt="">' + (S.mix && S.mix[a.awemeId] ? '<span class="sim-mix">合集</span>' : '') +
    '<span class="sim-like">♡ ' + fmt(st.diggCount) + '</span>' + (a.video ? '<span class="sim-dur">' + dur(a.video.duration) + '</span>' : '') + '</div>' +
    '<div class="sim-info"><div class="sim-title">' + escH(a.desc) + '</div><div class="sim-meta"><span>@ ' + escH(a.authorInfo.nickname) + '</span><span>' + ago(a.createTime) + '</span></div></div></a></div>';
}
function addWaterfall(f) {
  const i = S.total;
  const el = document.createElement('div');
  el.id = 'waterfall_item_' + f.awemeInfo.awemeId;
  el.className = 'AMqhOzPC';
  el.style.cssText = 'position:absolute;width:269px;height:303px;left:' + (i % 4) * 290 + 'px;top:' + Math.floor(i / 4) * 324 + 'px';
  el.innerHTML = cardHTML(f).replace(/<a href="[^"]*">/, '<div class="sim-a">').replace(/<\\/a><\\/div>$/, '</div></div>');
  if (!NOFIBER) el[FK] = { tag: 5, memoizedProps: { className: el.className }, return: { tag: 0, memoizedProps: { item: f } } };
  wf.appendChild(el);
  wf.style.height = (Math.floor(i / 4) + 1) * 324 + 'px';
  S.total++;
}
function addItem(f) {
  if (wf) return addWaterfall(f);
  const li = document.createElement('li');
  li.className = 'SwZLHMKk';
  li.innerHTML = cardHTML(f);
  attachFiber(li, f);
  ul.appendChild(li);
  S.total++;
}
function render(list) { list.forEach(addItem); }
async function loadMore() {
  if (S.loading || !S.hasMore) return;
  if (wallAt && S.total >= wallAt) { if (!document.querySelector('.sim-wall')) { const w = document.createElement('div'); w.className = 'sim-wall'; w.innerHTML = '<div>登录后即可搜索更多精彩视频</div>'; document.body.appendChild(w); } return; }
  S.loading = true;
  const url = (GENERAL ? '/aweme/v1/web/general/search/single/?device_platform=webapp&aid=6383&keyword=' : '/aweme/v1/web/search/item/?device_platform=webapp&aid=6383&search_channel=aweme_video_web&keyword=') + encodeURIComponent(S.kw) +
    '&offset=' + S.offset + '&count=' + (S.offset ? 10 : 20) + (S.filter ? '&filter_selected=' + encodeURIComponent(S.filter) + '&is_filter_search=1' : '');
  try {
    const j = await xhrJson(url);
    render((j.data || []).map((d) => apiToSearchFiber(d.aweme_info)));
    S.offset = j.cursor; S.hasMore = j.has_more;
  } finally { S.loading = false; }
}
function nearBottom() { return pageNearBottom(300); }
onPageScroll(() => { if (nearBottom()) loadMore(); });
window.addEventListener('wheel', (e) => { if (e.deltaY > 0 && nearBottom()) loadMore(); }, { passive: true });
// SPA：换关键词 / 切官方筛选 —— 清空列表，从接口重新拉第一页（与真实站点一致：第二次起首屏走接口）
function resetAndLoad() { ul.textContent = ''; S.offset = 0; S.hasMore = 1; S.total = 0; window.scrollTo(0, 0); loadMore(); }
document.getElementById('sim-search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('sim-q').value.trim();
  if (!q) return;
  S.kw = q; S.filter = '';
  history.pushState({}, '', '/search/' + encodeURIComponent(q) + '?type=video');
  document.title = q + ' - 抖音搜索';
  resetAndLoad();
});
document.getElementById('sim-q').value = S.kw;
const fEl = document.querySelector('.sim-filter');
fEl.addEventListener('click', (e) => { if (e.target === fEl || e.target.classList.contains('sim-filter-label')) fEl.classList.toggle('open'); });
fEl.querySelectorAll('[data-k]').forEach((sp) => sp.addEventListener('click', () => {
  const row = sp.parentElement;
  row.querySelectorAll('span').forEach((x) => x.classList.toggle('on', x === sp));
  const sel = {};
  fEl.querySelectorAll('span.on[data-k]').forEach((x) => { if (x.dataset.v !== '0') sel[x.dataset.k] = x.dataset.v; });
  S.filter = Object.keys(sel).length ? JSON.stringify(sel) : '';
  fEl.classList.remove('open');
  resetAndLoad();
}));
chaos('#search-result-container ul[data-e2e="scroll-list"] > li', (li, replace) => {
  const fk = Object.keys(li).find((k) => k.startsWith('__reactFiber$'));
  const f = li[fk].return.memoizedProps.itemInfo;
  if (replace) { const n = document.createElement('li'); n.className = li.className; n.innerHTML = cardHTML(f); attachFiber(n, f); li.replaceWith(n); }
  else li.innerHTML = cardHTML(f);
});
S.mix = __MIX__;
render(__FIRST__);
S.offset = 20;
// ?broken=1：模拟抖音改版——容器 id、data-e2e 全换掉，fiber 也没有（插件应进入"读不到结果"并给出诊断）
if (/[?&]broken=1/.test(location.search)) { const c = document.getElementById("search-result-container"); c.id = "src-" + Math.random().toString(36).slice(2, 7); ul.removeAttribute("data-e2e"); }
// ?modal=1：模拟在搜索页点开视频弹层（满屏固定层，评论区里有"登录后查看更多评论"字样）——不能被当成登录墙
if (/[?&]modal=1/.test(location.search)) {
  const m = document.createElement('div');
  m.className = 'sim-modal';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,16,.92);z-index:80;display:flex;gap:24px;padding:40px';
  m.innerHTML = '<div style="flex:1;border-radius:16px;background:#222"></div><div style="width:420px;overflow:auto;color:#ccc;font-size:14px;line-height:22px">' +
    Array.from({ length: 30 }, (_, i) => '<p>用户' + (1000 + i) + '：这个教程真的太实用了，第' + (i + 1) + '步我也跟着做出来了，感谢分享！</p>').join('') +
    '<p style="color:#888">登录后查看更多评论</p></div>';
  document.body.appendChild(m);
}
S.ready = true;
`;

function searchPage(kw, first, mixIds) {
  const filterRow = (label, k, opts) => `<div><b>${label}</b>${opts.map(([v, t], i) => `<span data-k="${k}" data-v="${v}" class="${i === 0 ? 'on' : ''}">${t}</span>`).join('')}</div>`;
  const body = `
<div class="sim-tabs"><span data-type="general">综合</span><span data-type="video">视频</span><span data-type="user">用户</span><span data-type="live">直播</span>
<span class="sim-filter"><span class="sim-filter-label">筛选 ˅</span><div class="sim-filter-pop">
${filterRow('排序依据', 'sort_type', [['0', '综合排序'], ['1', '最多点赞'], ['2', '最新发布']])}
${filterRow('发布时间', 'publish_time', [['0', '不限'], ['1', '一天内'], ['7', '一周内'], ['180', '半年内']])}
${filterRow('视频时长', 'filter_duration', [['0', '不限'], ['0-1', '1分钟以下'], ['1-5', '1-5分钟'], ['5-10000', '5分钟以上']])}
</div></span></div>
<div class="sim-wrap"><div id="search-result-container" class="dNUdeXaI"><div><ul data-e2e="scroll-list" class="gZq36zrh"></ul></div></div>
<aside class="sim-side"><h4>相关搜索</h4>${['使用教程', '教学变现', '电商出图', '完整版', '实操记录'].map((t) => `<p>🔍 ${esc(kw)} ${t}</p>`).join('')}</aside></div>`;
  const js = SEARCH_JS
    .replace('__FIRST__', () => json(first.map(toSearchFiber)))
    .replace('__MIX__', () => json(Object.fromEntries(mixIds.map((id) => [id, 1]))));
  return shell(kw + ' - 抖音搜索', body, SEARCH_CSS, js);
}

// ---------- 博主主页 ----------
const PROFILE_CSS = `
.sim-prof{display:flex;gap:28px;align-items:center;padding:24px 0 20px}
.sim-prof .av{width:104px;height:104px;border-radius:50%;background:linear-gradient(135deg,#f6d365,#fda085)}
.sim-prof h2{margin:0 0 8px;font-size:20px}
.sim-prof p{margin:2px 0;color:#9a9ba5;font-size:13px}
.sim-ptabs{display:flex;gap:28px;font-size:17px;padding:10px 0 16px;color:#9a9ba5}
.sim-ptabs .on{color:#fff;font-weight:600}
[data-e2e="user-post-list"] ul{list-style:none;margin:0;padding:0}
[data-e2e="user-post-list"] li{display:inline-block;position:relative;width:calc((100% - 5 * 16px) / 6);margin:0 16px 18px 0;vertical-align:top}
[data-e2e="user-post-list"] li:nth-child(6n){margin-right:0}
.sim-pcard{display:block}
.sim-pcover{position:relative;aspect-ratio:3/4;border-radius:10px;overflow:hidden;background:#33343f}
.sim-pcover img{width:100%;height:100%;object-fit:cover;display:block}
.sim-pcover .sim-like{position:absolute;left:10px;bottom:8px;font-size:13px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6)}
.sim-ptitle{font-size:13px;color:#d6d6db;margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;

const PROFILE_JS = `
${COMMON_JS}
const S = window.__SIM__;
S.sec = location.pathname.split('/')[2] || '';
S.cursor = 0; S.hasMore = 1; S.loading = false;
const ul = document.querySelector('[data-e2e="user-post-list"] ul[data-e2e="scroll-list"]');
function cardHTML(f) {
  // 图文作品：链接是 /note/，封面取第一张图
  return '<div><a class="sim-pcard" href="//www.douyin.com/' + (f.video ? 'video/' : 'note/') + f.awemeId + '"><div class="sim-pcover"><img src="' + (f.video ? f.video.cover : (f.images && f.images[0] ? f.images[0].url : '')) + '" alt="">' +
    '<span class="sim-like">♡ ' + fmt(f.statistics.diggCount) + '</span></div><div class="sim-ptitle">' + escH(f.desc) + '</div></a></div>';
}
function addItem(f) {
  const li = document.createElement('li');
  li.className = 'AhHE71Bq';
  li.innerHTML = cardHTML(f);
  attachFiber(li, f);
  ul.appendChild(li);
}
async function loadMore() {
  if (S.loading || !S.hasMore) return;
  S.loading = true;
  try {
    const j = await xhrJson('/aweme/v1/web/aweme/post/?device_platform=webapp&aid=6383&sec_user_id=' + S.sec + '&max_cursor=' + S.cursor + '&count=18');
    (j.aweme_list || []).map(apiToProfileFiber).forEach(addItem);
    S.cursor = j.max_cursor; S.hasMore = j.has_more;
  } finally { S.loading = false; }
}
onPageScroll(() => { if (pageNearBottom(300)) loadMore(); });
chaos('[data-e2e="user-post-list"] ul[data-e2e="scroll-list"] > li', (li, replace) => {
  const fk = Object.keys(li).find((k) => k.startsWith('__reactFiber$'));
  const f = li[fk].return.memoizedProps.itemInfo;
  if (replace) { const n = document.createElement('li'); n.className = li.className; n.innerHTML = cardHTML(f); attachFiber(n, f); li.replaceWith(n); }
  else li.innerHTML = cardHTML(f);
});
// 首屏服务端直出：不发接口（与真实主页一致），数据只在 fiber 上
__FIRST__.forEach(addItem);
S.cursor = 18;
S.ready = true;
`;

function profilePage(author, total, first) {
  const body = `
<div class="sim-prof" data-e2e="user-info"><div class="av"></div><div><h2>${esc(author)}</h2>
<p><span data-e2e="user-info-follow">关注 50</span> · <span data-e2e="user-info-fans">粉丝 2.7万</span> · <span data-e2e="user-info-like">获赞 17.9万</span></p>
<p>每天分享干货 · 仿真主页</p></div></div>
<div class="sim-ptabs"><span class="on" data-e2e="user-work-tab">作品 <span data-e2e="user-tab-count">${total}</span></span><span>推荐</span><span data-e2e="user-like-tab">喜欢</span></div>
<div data-e2e="user-post-list" class="XioRKGro"><ul data-e2e="scroll-list" class="cPDrcaOY"></ul></div>`;
  return shell(author + '的抖音 - 抖音', body, PROFILE_CSS, PROFILE_JS.replace('__FIRST__', () => json(first.map(toProfileFiber))));
}

// ---------- 视频详情页（评论区） ----------
const VIDEO_CSS = `
.sim-vwrap{display:flex;gap:24px}
.sim-player{flex:1;height:520px;border-radius:16px;background:radial-gradient(circle at 40% 40%,#3a3b47,#14151c)}
.sim-vstats{display:flex;gap:28px;padding:14px 0;font-size:15px}
.sim-vside{width:420px;flex:none;height:calc(100vh - 80px);overflow:auto;background:#1e1f29;border-radius:12px;padding:12px 16px}
[data-e2e="comment-item"]{display:flex;gap:10px;padding:12px 0;border-bottom:1px solid #2a2b36}
.c-av{width:36px;height:36px;border-radius:50%;background:#3a3b47;flex:none}
.c-body{flex:1;min-width:0}
.c-name{color:#9a9ba5;font-size:13px}
.c-text{margin:4px 0;font-size:14px;color:#e8e8ea}
.c-foot{display:flex;gap:18px;align-items:center;color:#8a8b96;font-size:12px}
.c-like{display:flex;align-items:center;gap:4px}
.c-like svg{width:14px;height:14px}
.c-more{color:#8a8b96;font-size:12px;margin-top:6px}
`;

const VIDEO_JS = `
${COMMON_JS}
const S = window.__SIM__;
S.aid = location.pathname.split('/')[2];
// 真实抖音的视频页会单独请求这条视频的详情；?nodetail=1 时不请求；?fiber=detail 时改为把数据挂在详情区的 fiber 上
if (/[?&]fiber=detail/.test(location.search)) xhrJson('/sim/detail-fiber?aweme_id=' + S.aid).then((j) => attachFiber(document.querySelector('[data-e2e="detail-video-info"]'), j));
else if (!/[?&]nodetail=1/.test(location.search)) xhrJson('/aweme/v1/web/aweme/detail/?aweme_id=' + S.aid);
S.cursor = 0; S.hasMore = 1; S.loading = false;
const list = document.querySelector('[data-e2e="comment-list"]');
const side = document.querySelector('.sim-vside');
const HEART = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z"/></svg>';
function addComment(c) {
  const w = document.createElement('div');
  w.innerHTML = '<div data-e2e="comment-item"><div class="c-av"></div><div class="c-body"><div class="c-name">' + escH(c.user.nickname) + '</div>' +
    '<div class="c-text">' + escH(c.text) + '</div><div class="c-foot"><span>' + ago(c.create_time) + ' · ' + escH(c.ip_label) + '</span>' +
    '<span class="c-like"><span>' + HEART + '</span><span>' + fmt(c.digg_count) + '</span></span><span>分享</span><span>回复</span></div>' +
    (c.reply_comment_total ? '<div class="c-more">展开' + c.reply_comment_total + '条回复</div>' : '') + '</div></div>';
  // 评论项也挂 fiber（真实结构未知，这里模拟成 props.comment = 接口对象）；?nofiber=1 时不挂，测试纯接口兜底
  const item = w.querySelector('[data-e2e="comment-item"]');
  // 和真实页面一样：fiber 上是 commentInfo（camelCase，回复数叫 replyTotal，不带视频 id）
  if (!NOFIBER) item[FK] = { tag: 5, memoizedProps: { className: 'c' }, return: { tag: 0, memoizedProps: { commentInfo: { cid: c.cid, text: c.text, diggCount: c.digg_count, replyTotal: c.reply_comment_total, createTime: c.create_time, user: { nickname: c.user.nickname }, ipLabel: c.ip_label }, index: 0 } } };
  list.appendChild(w);
}
async function loadMore() {
  if (S.loading || !S.hasMore) return;
  S.loading = true;
  try {
    const j = await xhrJson('/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&aweme_id=' + S.aid + '&cursor=' + S.cursor + '&count=20');
    (j.comments || []).forEach(addComment);
    S.cursor = j.cursor; S.hasMore = j.has_more;
  } finally { S.loading = false; }
}
side.addEventListener('scroll', () => { if (side.scrollTop + side.clientHeight >= side.scrollHeight - 200) loadMore(); }, { passive: true });
loadMore().then(() => { S.ready = true; });
`;

function videoPage(v) {
  const body = `<div class="sim-vwrap"><div style="flex:1"><div class="sim-player" data-e2e="player-container"></div>
<h3 data-e2e="detail-video-info">${esc(v.desc)}</h3>
<div class="sim-vstats"><span data-e2e="video-player-digg">♥ ${v.digg}</span><span>💬 ${v.comment}</span><span data-e2e="video-player-collect">★ ${v.collect}</span><span data-e2e="video-player-share">↗ ${v.share}</span></div></div>
<div class="sim-vside"><div style="font-weight:600;padding:4px 0 8px">全部评论</div><div data-e2e="comment-list" class="sim-clist"></div></div></div>`;
  return shell(v.desc.slice(0, 20) + ' - 抖音', body, VIDEO_CSS, VIDEO_JS);
}

function homePage() {
  return shell('抖音精选', '<div style="padding:40px;color:#9a9ba5">仿真首页（无可分析内容，插件应保持隐藏）</div>', '', '');
}

// ---------- 封面 SVG ----------
function coverSvg(v) {
  const [c1, c2] = v ? v.palette : ['#222', '#555'];
  const words = v ? v.topic : '抖音';
  const sub = v ? (v.desc.split('！')[0].replace(v.topic, '') || '教程') : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="720" viewBox="0 0 540 720">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="540" height="720" fill="url(#g)"/>
<circle cx="430" cy="140" r="120" fill="rgba(255,255,255,0.08)"/><circle cx="90" cy="600" r="160" fill="rgba(0,0,0,0.18)"/>
<text x="270" y="330" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="64" font-weight="800" fill="#fff" text-anchor="middle">${esc(words)}</text>
<text x="270" y="410" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="40" font-weight="700" fill="#ffd84d" text-anchor="middle">${esc(sub)}</text>
</svg>`;
}

module.exports = { searchPage, profilePage, videoPage, homePage, coverSvg, coverUrl };
