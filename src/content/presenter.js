// 呈现层：把状态翻译成"给人看的话"和界面需要的结构。不碰 DOM，便于单测。
// 文案原则：用作者自己的词（收藏率、真需求、门槛、候选、入库包、D+N），短、白话、准确。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  const M = DSP.metrics || (typeof require === 'function' ? require('./metrics.js') : null);
  const U = DSP.util || (typeof require === 'function' ? require('./util.js') : null);

  // 选题视角：一次点击 = 一种看法（排序 + 可选的门槛）
  const LENSES = [
    // 真需求 = 收藏率过线 + 量够大：先筛收藏率 ≥ 80% 的视频，再按收藏数排（只按比率排，299 赞的小样本会冲到第一）
    { key: 'need', label: '真需求', sort: ['collect'], filter: { minCr: 0.8, kind: 'video' }, desc: '收藏率 ≥ 80% 的视频，按收藏数从多到少', tip: '收藏率 = 收藏 ÷ 点赞。≥80% 说明观众存着回看，选题成立；再按收藏数排，量大的在前' },
    { key: 'ratio', label: '收藏率最高', sort: ['cr'], desc: '按收藏率从高到低，点赞不足 100 的排最后', tip: '只看比例。点赞太少时比率波动大，这些结果排在最后、标"样本少"' },
    { key: 'rising', label: '起飞中', sort: ['dpd'], filter: { maxAgeDays: 30 }, desc: '近 30 天，按日均赞', tip: '只看近 30 天发布的，按"点赞 ÷ 发布天数"排，找正在涨的新视频' },
    { key: 'talk', label: '热议', sort: ['er'], desc: '按评论率从高到低', tip: '评论率 = 评论 ÷ 点赞。越高越能引发讨论，评论区常藏着下一个选题' },
    { key: 'top10', label: '账号 Top10', sort: ['collect', 'comment'], filter: { kind: 'video', maxAgeDays: 365 }, desc: '近一年视频，收藏名次 + 评论名次', tip: '做账号对标用：近一年、只看视频，按收藏名次 + 评论名次相加排，同分按收藏数', only: 'profile' },
  ];
  function lensesFor(type) { return LENSES.filter((l) => !l.only || l.only === type); }
  // 当前视图对应哪个视角（排序维度与门槛都一致才算）
  function matchLens(view) {
    for (const l of LENSES) {
      if (l.sort.join('+') !== view.sortKeys.join('+') || view.asc) continue;
      const want = M.normFilter(l.filter || null);
      const f = view.filter;
      if (want.maxAgeDays === f.maxAgeDays && want.kind === f.kind && want.minCr === f.minCr && !f.tier && !f.min.digg && !f.min.comment && !f.min.collect && !f.min.share) return l;
    }
    return null;
  }

  // 门槛快捷项
  const QUICK_FILTERS = [
    { key: 'cr80', label: '收藏率 ≥ 80%', patch: (f) => ({ minCr: f.minCr >= 0.8 ? 0 : 0.8 }), on: (f) => f.minCr >= 0.8 },
    { key: 'd30', label: '近 30 天', patch: (f) => ({ maxAgeDays: f.maxAgeDays === 30 ? 0 : 30 }), on: (f) => f.maxAgeDays === 30 },
    { key: 'y1', label: '近一年', patch: (f) => ({ maxAgeDays: f.maxAgeDays === 365 ? 0 : 365 }), on: (f) => f.maxAgeDays === 365 },
    { key: 'video', label: '只看视频', patch: (f) => ({ kind: f.kind === 'video' ? 'all' : 'video' }), on: (f) => f.kind === 'video' },
  ];

  // "1w" "1万" "1.5万" "2k" "12,000" → 数字；空 → 0；不认识 → NaN
  function parseCount(s) {
    const t = String(s == null ? '' : s).trim().replace(/[,，\s]/g, '').toLowerCase();
    if (!t) return 0;
    const m = /^(\d+(?:\.\d+)?)(万|w|千|k|亿)?$/.exec(t);
    if (!m) return NaN;
    const unit = { 万: 1e4, w: 1e4, 千: 1e3, k: 1e3, 亿: 1e8 }[m[2]] || 1;
    return Math.round(parseFloat(m[1]) * unit);
  }

  function sortText(keys, asc) {
    if (!keys || !keys.length) return '';
    const names = keys.map((k) => M.METRICS[k].label);
    if (keys.length === 1) return '按' + names[0] + (asc ? '从低到高' : '从高到低');
    return '综合排序（' + names.join(' + ') + (asc ? '，倒序' : '') + '）';
  }

  // 收藏率分档计数（概况条用）
  function tierCounts(list) {
    const c = { high: 0, mid: 0, low: 0, show: 0, na: 0 };
    for (const v of list) c[M.crTier(v)]++;
    return c;
  }

  // 门槛的白话描述："赞 ≥ 1万、收藏率 ≥ 80%、近 30 天"
  function filterText(f) {
    f = M.normFilter(f);
    const parts = [];
    if (f.min.digg) parts.push('赞 ≥ ' + U.fmtNum(f.min.digg));
    if (f.min.collect) parts.push('藏 ≥ ' + U.fmtNum(f.min.collect));
    if (f.min.comment) parts.push('评 ≥ ' + U.fmtNum(f.min.comment));
    if (f.min.share) parts.push('转 ≥ ' + U.fmtNum(f.min.share));
    if (f.minCr) parts.push('收藏率 ≥ ' + Math.round(f.minCr * 100) + '%');
    if (f.maxAgeDays) parts.push(f.maxAgeDays === 365 ? '近一年' : '近 ' + f.maxAgeDays + ' 天');
    if (f.kind === 'video') parts.push('只看视频');
    if (f.kind === 'note') parts.push('只看图文');
    if (f.tier) parts.push('只看「' + M.CR_TIERS[f.tier].label + '」档');
    return parts.join('、');
  }

  // 页面识别健康度
  //   recognizing：刚进页面，还没读到；ok：正常；fail：该有结果却读不到（抖音可能改版）；blocked：被登录墙/验证拦住
  function health(o) {
    if (o.type !== 'search' && o.type !== 'profile') return 'ok';
    if (o.blocked) return 'blocked';
    if (o.count > 0 && o.located) return 'ok';
    if (o.sinceRouteMs < 6000) return 'recognizing';
    if (o.count > 0 && !o.located) return 'partial'; // 有数据但找不到列表：角标与原地排序不可用，导出仍可用
    return 'fail';
  }

  const SAMPLE_LOW = 30; // 样本少于 30 条时提示"排名仅供参考"

  // 状态句：[{ t: 文本, tone: 'em' | 'warn' | 'dim' }]
  function statusLine(o) {
    const out = [];
    if (o.health === 'recognizing') return [{ t: '正在读取结果…', tone: 'dim' }];
    if (o.health === 'fail') return [{ t: '抖音页面可能刚更新，插件暂时读不到结果', tone: 'warn' }];
    if (o.health === 'blocked') return [{ t: o.blocked === 'captcha' ? '抖音弹出了安全验证，请先手动完成' : '抖音要求登录，登录后才能继续读取', tone: 'warn' }];
    // total：账号作品总数（主页能读到时）。没读全时写成"已读取 18 / 60 条"，提醒排名还不准
    const of = o.total && o.total > o.count ? ' / ' + o.total : '';
    if (o.loading) out.push({ t: '正在加载 ' + o.count + ' / ' + (o.total && o.total < o.cap ? o.total : o.cap) + ' 条', tone: 'em' });
    // 排过序但没读全：直接在这一段说"排名还不准"，不另起一段
    else out.push(of && o.sorted ? { t: '已读取 ' + o.count + of + ' 条，排名还不准', tone: 'warn' } : { t: '已读取 ' + o.count + of + ' 条', tone: '' });
    if (o.sorted) {
      // 当前看法已经写在"排序"按钮上，这里只说结果（避免状态句过长被截断）
      if (o.sortText) out.push({ t: o.sortText, tone: 'em' });
      out.push({ t: '达标 ' + o.shown + ' 条', tone: 'em' });
      if (o.excludedHigh) out.push({ t: '另有 ' + o.excludedHigh + ' 条真需求没过线', tone: 'dim' });
    } else if (o.count) {
      out.push({ t: '真需求 ' + o.strongNeed + ' 条', tone: o.strongNeed ? 'em' : 'dim' });
    }
    if (o.count && !o.loading && o.count < SAMPLE_LOW && !(of && o.sorted)) out.push({ t: o.sorted ? '样本少，排名还不准' : '样本较少，建议继续加载', tone: 'dim' });
    return out;
  }

  DSP.presenter = { LENSES, lensesFor, matchLens, QUICK_FILTERS, parseCount, sortText, tierCounts, filterText, health, statusLine, SAMPLE_LOW };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') module.exports = DSP.presenter;
})();
