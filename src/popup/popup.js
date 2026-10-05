// 扩展弹窗：当前标签页状态、总开关、设置、口径说明、版本与反馈。
// 设置读写 chrome.storage.local（内容脚本监听变化，实时生效）；页面状态向当前标签页的内容脚本询问。
'use strict';

const KEY = 'dsp.settings';
const $ = (s) => document.querySelector(s);
const DEFAULTS = { enabled: true, badges: true, loadCap: 100 };

const PAGE_NAMES = { search: '搜索结果页', profile: '博主主页', video: '视频详情页', other: '' };

function setText(sel, t) { const el = $(sel); if (el) el.textContent = t; }

async function getSettings() {
  const res = await chrome.storage.local.get(KEY);
  return Object.assign({}, DEFAULTS, res[KEY] || {});
}
async function patchSettings(p) {
  const s = Object.assign(await getSettings(), p);
  await chrome.storage.local.set({ [KEY]: s });
  return s;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 先直接问页面里的插件：有回应就是抖音页（不依赖能否读到标签页地址）；
// 没回应再看地址：是抖音 = 插件刚安装/更新、页面还没刷新；其他网址或读不到地址 = 不在抖音
async function pageStatus(tab) {
  if (!tab) return { onDouyin: false };
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'dsp:status' });
    if (r) return Object.assign({ onDouyin: true }, r);
  } catch (e) { /* 页面里没有插件 */ }
  if (/^https:\/\/www\.douyin\.com\//.test(tab.url || '')) return { onDouyin: true, stale: true };
  return { onDouyin: false };
}

function renderStatus(st, settings) {
  const card = $('#status');
  card.dataset.state = !st.onDouyin ? 'off-site' : st.stale ? 'stale' : !settings.enabled ? 'paused' : st.health === 'fail' ? 'fail' : st.type && st.type !== 'other' ? 'ok' : 'idle';
  const title = $('#status-title');
  const sub = $('#status-sub');
  const act = $('#status-act');
  act.hidden = true;
  if (!st.onDouyin) {
    title.textContent = '当前页面不是抖音网页版';
    sub.textContent = '打开 douyin.com 搜索任意关键词，工具栏会出现在结果上方。';
    act.hidden = false;
    act.textContent = '去抖音搜「AI 保姆级教程」';
    act.onclick = () => chrome.tabs.create({ url: 'https://www.douyin.com/search/' + encodeURIComponent('AI保姆级教程') + '?type=video' });
    return;
  }
  if (st.stale) {
    title.textContent = '刷新一下抖音页面';
    sub.textContent = '插件刚安装或更新，当前页面还在用旧版本。';
    act.hidden = false;
    act.textContent = '刷新页面';
    act.onclick = async () => { const t = await activeTab(); chrome.tabs.reload(t.id); window.close(); };
    return;
  }
  if (!settings.enabled) {
    title.textContent = '插件已暂停';
    sub.textContent = '抖音页面已还原。打开上面的开关即可恢复。';
    return;
  }
  const name = PAGE_NAMES[st.type] || '';
  if (!name) {
    title.textContent = '这一页没有可分析的内容';
    sub.textContent = '支持：搜索结果、博主主页、视频评论区。';
    return;
  }
  if (st.health === 'fail') {
    title.textContent = name + ' · 暂时读不到结果';
    sub.textContent = '抖音页面可能刚更新。可以在页面工具栏的"更多"里复制诊断信息反馈。';
    return;
  }
  title.textContent = name + (st.label ? ' · ' + st.label : '');
  const parts = [];
  if (st.type === 'video') parts.push('已读取评论 ' + (st.comments || 0) + ' 条');
  else {
    parts.push('已读取 ' + (st.count || 0) + ' 条');
    if (st.strongNeed != null) parts.push('真需求 ' + st.strongNeed + ' 条');
    if (st.sortLabel) parts.push('按' + st.sortLabel + '排序');
  }
  sub.textContent = parts.join(' · ');
}

async function init() {
  const manifest = chrome.runtime.getManifest();
  setText('#version', 'v' + manifest.version);
  let settings = await getSettings();
  const tab = await activeTab();
  const st = await pageStatus(tab);

  const sw = $('#enabled');
  sw.checked = !!settings.enabled;
  sw.addEventListener('change', async () => {
    settings = await patchSettings({ enabled: sw.checked });
    renderStatus(st, settings);
  });
  const badges = $('#badges');
  badges.checked = !!settings.badges;
  badges.addEventListener('change', async () => { settings = await patchSettings({ badges: badges.checked }); });
  const cap = $('#loadCap');
  cap.value = String(settings.loadCap || 100);
  cap.addEventListener('change', async () => { settings = await patchSettings({ loadCap: Number(cap.value) }); });

  setText('#cand-count', String(st.candidates != null ? st.candidates : (await chrome.storage.local.get('dsp.candidates'))['dsp.candidates']?.length || 0));
  renderStatus(st, settings);
}

document.addEventListener('DOMContentLoaded', () => { init().catch((e) => { setText('#status-title', '出了点问题'); setText('#status-sub', String(e && e.message || e)); }); });
