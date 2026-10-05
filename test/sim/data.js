// 仿真数据生成器：确定性（同一个种子永远生成同一批数据），供本地仿真页和测试共用。
// 数据形状对齐 2026-10 实测的抖音网页版：
//   接口（snake_case）：aweme_info.statistics.digg_count ...
//   React fiber（camelCase）：awemeInfo.stats.diggCount ...（搜索页）/ statistics.diggCount（主页）
'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const TOPICS = ['AI 视频', '即梦', 'Seedance 2.0', 'Claude Code', 'Codex', 'DeepSeek', '剪映', '可灵', '豆包', 'Midjourney', 'ComfyUI', '飞书多维表格', 'Obsidian', 'Notion AI', '数字人', 'AI 漫剧', '提示词', 'Cursor'];
const HOOKS = ['保姆级教程', '零基础入门', '3 分钟学会', '一条视频讲透', '手把手教你', '新手必看', '实操全流程', '避坑指南', '小白也能做', '万能模板'];
const TAILS = ['#AI教程 #干货分享', '#保姆级教程 #ai', '#效率工具 #自媒体', '#AI创作 #新手', '#实操 #教程', ''];
const AUTHORS = ['星辰ai', 'AI视频系统教学', '镜间Foto', '底层男孩Zaki', '阿康AI自媒体', '暴打柠檬', '小暖AIGC', '姜Dora在此', '旗木卡卡西', 'Vibe西海岸', 'AIGC-桃子', '刺猬星球super-i', 'AI视次方', '木子不写代码', '十元钱钱', 'Lala罐头', '创野小朱', '大牙大'];
const PALETTES = [
  ['#1f1c2c', '#928dab'], ['#0f2027', '#2c5364'], ['#42275a', '#734b6d'], ['#141e30', '#243b55'],
  ['#3a1c71', '#d76d77'], ['#000428', '#004e92'], ['#232526', '#414345'], ['#16222a', '#3a6073'],
  ['#4b134f', '#c94b4b'], ['#0b486b', '#f56217'], ['#1d4350', '#a43931'], ['#283c86', '#45a247'],
];

// 对数正态分布：短视频数据的典型形态（少数爆款 + 大量长尾）
function lognormal(rand, median, sigma) {
  const u = Math.max(1e-9, rand()), v = rand();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(0, Math.round(median * Math.exp(sigma * z)));
}

// 以固定"现在"为基准，测试结果不随真实时间漂移
const NOW = Math.floor(Date.UTC(2026, 9, 4, 6, 0, 0) / 1000);

function makeVideo(rand, i, opts) {
  const topic = opts.topic || TOPICS[Math.floor(rand() * TOPICS.length)];
  const hook = HOOKS[Math.floor(rand() * HOOKS.length)];
  const author = opts.author || AUTHORS[Math.floor(rand() * AUTHORS.length)];
  const digg = lognormal(rand, opts.median || 1800, 1.6);
  // 藏赞比：教程类常见 20%~150%，少数极端值
  const cr = Math.min(1.8, Math.max(0.02, 0.45 * Math.exp(0.75 * (rand() * 2 - 1) + (rand() < 0.15 ? 0.9 : 0))));
  const er = Math.min(0.6, Math.max(0.002, 0.03 * Math.exp(1.1 * (rand() * 2 - 1))));
  const collect = Math.round(digg * cr);
  const comment = Math.round(digg * er);
  const share = Math.round(digg * (0.05 + rand() * 0.35));
  const ageDays = Math.max(0.3, Math.round(Math.pow(rand(), 2.2) * 700 * 10) / 10);
  const createTime = NOW - Math.round(ageDays * 86400);
  const isNote = rand() < 0.08;
  const durSec = isNote ? 0 : Math.round(20 + Math.pow(rand(), 1.8) * 1800);
  const id = String(7400000000000000000n + BigInt(hashStr(opts.salt + ':' + i)) * 1000n + BigInt(i));
  const desc = `${topic}${hook}！${['超简单', '一看就会', '收藏备用', '建议反复看', '干货满满'][Math.floor(rand() * 5)]} ${TAILS[Math.floor(rand() * TAILS.length)]}`.trim();
  const palette = PALETTES[Math.floor(rand() * PALETTES.length)];
  return {
    id, desc, author, digg, comment, collect, share, createTime, isNote,
    durMs: durSec * 1000, topic, palette,
    isMix: !isNote && rand() < 0.25,
    secUid: 'MS4wLjABAAAA_sim_' + hashStr(author).toString(36),
  };
}

function makeVideos(seed, count, opts = {}) {
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < count; i++) out.push(makeVideo(rand, i, { salt: String(seed), ...opts }));
  return out;
}

const coverUrl = (v) => `https://p3-sim.douyinpic.com/cover/${v.id}.svg`;

// ---- 接口形状（snake_case） ----
function toApiAweme(v) {
  return {
    aweme_id: v.id,
    desc: v.desc,
    create_time: v.createTime,
    aweme_type: v.isNote ? 68 : 0,
    author: { nickname: v.author, sec_uid: v.secUid },
    statistics: { digg_count: v.digg, comment_count: v.comment, collect_count: v.collect, share_count: v.share, play_count: 0 },
    video: v.isNote ? undefined : { duration: v.durMs, cover: { url_list: [coverUrl(v)] } },
    images: v.isNote ? [{ url_list: [coverUrl(v)] }] : undefined,
  };
}

// ---- 搜索页 fiber 形状（camelCase，itemInfo.awemeInfo.stats） ----
function toSearchFiber(v) {
  return {
    type: 1,
    docType: 1,
    awemeInfo: {
      awemeId: v.id,
      desc: v.desc,
      createTime: v.createTime,
      awemeType: v.isNote ? 68 : 0,
      isSlides: false,
      authorInfo: { nickname: v.author, secUid: v.secUid },
      stats: { diggCount: v.digg, commentCount: v.comment, collectCount: v.collect, shareCount: v.share, playCount: 0, downloadCount: 0, forwardCount: 0 },
      video: v.isNote ? null : { duration: v.durMs, cover: coverUrl(v), coverUrlList: [coverUrl(v)] },
      images: v.isNote ? [{ urlList: [coverUrl(v)] }] : null,
    },
  };
}

// ---- 主页 fiber 形状（camelCase，itemInfo.statistics） ----
function toProfileFiber(v) {
  return {
    awemeId: v.id,
    desc: v.desc,
    createTime: v.createTime,
    authorInfo: { nickname: v.author },
    statistics: { diggCount: v.digg, commentCount: v.comment, collectCount: v.collect, shareCount: v.share },
    video: v.isNote ? null : { duration: v.durMs, cover: coverUrl(v) },
    images: v.isNote ? [{ url: coverUrl(v) }] : null,
  };
}

// ---- 评论 ----
const COMMENT_BODIES = ['求教程链接', '收藏了，回头慢慢看', '博主讲得太清楚了', '这个工具要钱吗？', '第三步卡住了怎么办', '已关注，求出下一期', '我的 QQ 是 123456789 求带', '跟着做出来了，感谢！', '电脑配置要求高吗', '有没有手机版的做法', '这个提示词能分享一下吗', '讲得比付费课还好', '能出一期进阶版吗', '哪里可以下载？', '学到了学到了'];
function makeComments(seed, count) {
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const body = COMMENT_BODIES[Math.floor(rand() * COMMENT_BODIES.length)] + (rand() < 0.4 ? '，' + COMMENT_BODIES[Math.floor(rand() * COMMENT_BODIES.length)] : '');
    out.push({
      cid: String(7500000000000000000n + BigInt(hashStr(seed + ':c' + i)) * 100n + BigInt(i)),
      text: `${body}（${i + 1}楼）`,
      digg: lognormal(rand, 30, 1.9),
      replies: rand() < 0.3 ? Math.round(rand() * 40) : 0,
      nickname: '用户' + Math.floor(rand() * 90000 + 10000),
      createTime: NOW - Math.round(rand() * 60 * 86400),
      ip: ['北京', '上海', '广东', '浙江', '四川', '湖北'][Math.floor(rand() * 6)],
    });
  }
  return out;
}
function toApiComment(c) {
  return {
    cid: c.cid, text: c.text, digg_count: c.digg, reply_comment_total: c.replies,
    create_time: c.createTime, ip_label: c.ip, user: { nickname: c.nickname },
  };
}

module.exports = {
  NOW, mulberry32, hashStr, makeVideos, makeComments, coverUrl,
  toApiAweme, toSearchFiber, toProfileFiber, toApiComment,
};
