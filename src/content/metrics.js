// 指标、排序、筛选、统计 —— 纯函数，不碰 DOM。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});

  // 比率类指标的最小样本：点赞太少时"收藏÷点赞"会被几次点击放大成离谱的数（3 赞 5 藏 = 167%），
  // 排序时把这类结果放到可靠结果之后，界面上标"样本少"。
  const RATIO_MIN_DIGG = 100;

  // 排序维度定义：key 与界面、导出共用一份，改文案只改这里。
  // 命名对齐作者选题库 SOP 的口径：收藏率 = 收藏 ÷ 点赞（不是"观众里多少人收藏"）。
  const METRICS = {
    digg:    { label: '点赞', short: '赞', kind: 'count', tip: '大众认可度。点赞高说明受众面广，但不代表内容有深度' },
    comment: { label: '评论', short: '评', kind: 'count', tip: '话题性。评论多说明有共鸣或争议，评论区常藏着下一个选题' },
    collect: { label: '收藏', short: '藏', kind: 'count', tip: '实用价值。收藏多说明观众想存下来反复看，是干货的信号' },
    share:   { label: '转发', short: '转', kind: 'count', tip: '传播力。转发多说明观众愿意推荐给别人，自带扩散' },
    cr:      { label: '收藏率', short: '收藏率', kind: 'ratio', formula: '收藏 ÷ 点赞', tip: '收藏 ÷ 点赞。越高越像"存着回看的干货"：≥80% 是真需求，≤40% 说明有门槛（太难/太贵/进不去）' },
    sr:      { label: '转发率', short: '转发率', kind: 'ratio', formula: '转发 ÷ 点赞', tip: '转发 ÷ 点赞。教程类常见 15%~27%；收藏率低而转发率高的多是猎奇内容' },
    er:      { label: '评论率', short: '评论率', kind: 'ratio', formula: '评论 ÷ 点赞', tip: '评论 ÷ 点赞。越高说明越能引发讨论；先看评论是求助还是灌水再下结论' },
    dpd:     { label: '日均赞', short: '日均赞', kind: 'rate', formula: '点赞 ÷ 发布天数', tip: '点赞 ÷ 发布天数。衡量涨得多快，用来发现正在起飞的新视频' },
  };

  // 由原始记录算出派生指标
  // now：用于"日均赞"的当前时刻；观察窗口 D+N 用采集时刻（capturedAt）算，比率要连窗口一起看
  // 计数缺失（null）时比率也记 null：界面显示"—"，不参与分档，排序时排在最后
  function derive(rec, now) {
    const digg = rec.digg == null ? null : rec.digg;
    const ratio = (x) => (x == null || digg == null ? null : digg > 0 ? x / digg : 0);
    const ageDays = rec.createTime > 0 ? Math.max(1, (now - rec.createTime) / 86400) : 0;
    const at = rec.capturedAt || now;
    return Object.assign({}, rec, {
      cr: ratio(rec.collect),
      sr: ratio(rec.share),
      er: ratio(rec.comment),
      ageDays,
      dn: rec.createTime > 0 ? Math.max(0, (at - rec.createTime) / 86400) : 0,
      dpd: ageDays > 0 && digg != null ? digg / ageDays : 0,
      lowSample: !(digg >= RATIO_MIN_DIGG),
    });
  }

  // 观察窗口文案：D+6.2；超过 100 天取整
  function fmtDn(dn) {
    if (!(dn > 0)) return '';
    return 'D+' + (dn >= 100 ? Math.round(dn) : (Math.round(dn * 10) / 10));
  }

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  const asc = (a, b) => a - b;

  // 黑马标记（在当前这批结果里做相对比较，样本 ≥ 8 才评）：
  //   rising 起飞：发布 ≤ 30 天，且日均赞进前 10%
  //   gem    干货：点赞 ≥ 100，且藏赞比进前 10%
  function marks(list, now) {
    const out = new Map();
    if (list.length < 8) return out;
    const dpdTop = quantile(list.map((v) => v.dpd).sort(asc), 0.9);
    const reliable = list.filter((v) => !v.lowSample);
    const crTop = reliable.length >= 5 ? quantile(reliable.map((v) => v.cr).sort(asc), 0.9) : Infinity;
    for (const v of list) {
      const rising = v.createTime > 0 && (now - v.createTime) / 86400 <= 30 && v.dpd > 0 && v.dpd >= dpdTop;
      const gem = !v.lowSample && v.cr > 0 && v.cr >= crTop;
      if (rising || gem) out.set(v.id, { rising, gem });
    }
    return out;
  }

  // 排序值：比率类在样本不足时降一档（-1 之下），保证可靠结果排在前面
  function sortValue(v, k) {
    if (v[k] == null) return -1e15; // 拿不到的数排在最后
    const x = v[k];
    if (METRICS[k] && METRICS[k].kind === 'ratio' && v.lowSample) return x - 1e6;
    return x;
  }

  // 分数排名（并列取平均名次），避免一堆 0 评论时名次被 id 随机决定
  function ranks(list, k) {
    const idx = list.map((v, i) => i).sort((a, b) => sortValue(list[b], k) - sortValue(list[a], k));
    const r = new Array(list.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      const val = sortValue(list[idx[i]], k);
      while (j + 1 < idx.length && sortValue(list[idx[j + 1]], k) === val) j++;
      const avg = (i + j) / 2 + 1;
      for (let t = i; t <= j; t++) r[idx[t]] = avg;
      i = j + 1;
    }
    return r;
  }

  // 单维：按数值从高到低；多维：按"各维度名次之和"从小到大（避免十万级的点赞淹没百级的评论），
  // 名次和相同时按第一个维度的数值破（与作者做账号 Top10 的口径一致）。
  // 返回新数组，每项附带 score（单维=数值，多维=名次和），不修改入参
  function sortList(list, keys, ascending) {
    const ks = (keys || []).filter((k) => METRICS[k]);
    const items = list.map((v) => ({ v, score: 0 }));
    if (!ks.length) return items;
    if (ks.length === 1) {
      const k = ks[0];
      items.forEach((it) => { it.score = it.v[k] || 0; });
      items.sort((a, b) => (sortValue(b.v, k) - sortValue(a.v, k)) || (a.v.id < b.v.id ? -1 : 1));
    } else {
      const rk = ks.map((k) => ranks(list, k));
      items.forEach((it, i) => { it.score = rk.reduce((s, r) => s + r[i], 0); });
      const k0 = ks[0];
      items.sort((a, b) => (a.score - b.score) || (sortValue(b.v, k0) - sortValue(a.v, k0)) || (a.v.id < b.v.id ? -1 : 1));
    }
    if (ascending) items.reverse();
    return items;
  }

  // 筛选条件：
  //   min: { digg, comment, collect, share }  —— 下限，0 = 不限
  //   minCr: 0.8 —— 藏赞比下限（样本少的结果不参与比率筛选时也一并排除）
  //   maxAgeDays: 30 —— 只看近 N 天发布
  //   kind: 'all' | 'video' | 'note'
  //   tier: '' | 'high' | 'mid' | 'low' | 'show' | 'na' —— 只看某一档收藏率（点分布条的分段）
  const EMPTY_FILTER = Object.freeze({ min: Object.freeze({ digg: 0, comment: 0, collect: 0, share: 0 }), minCr: 0, maxAgeDays: 0, kind: 'all', tier: '' });
  const TIER_KEYS = ['high', 'mid', 'low', 'show', 'na'];
  function normFilter(f) {
    f = f || {};
    const m = f.min || {};
    return {
      min: { digg: +m.digg || 0, comment: +m.comment || 0, collect: +m.collect || 0, share: +m.share || 0 },
      minCr: +f.minCr || 0,
      maxAgeDays: +f.maxAgeDays || 0,
      kind: f.kind === 'video' || f.kind === 'note' ? f.kind : 'all',
      tier: TIER_KEYS.indexOf(f.tier) >= 0 ? f.tier : '',
    };
  }
  function activeFilterCount(f) {
    f = normFilter(f);
    let n = 0;
    for (const k of Object.keys(f.min)) if (f.min[k] > 0) n++;
    if (f.minCr > 0) n++;
    if (f.maxAgeDays > 0) n++;
    if (f.kind !== 'all') n++;
    if (f.tier) n++;
    return n;
  }
  function passes(v, f) {
    if (v.digg < f.min.digg || v.comment < f.min.comment || v.collect < f.min.collect || v.share < f.min.share) return false;
    if (f.minCr > 0 && (v.lowSample || v.cr < f.minCr)) return false;
    if (f.maxAgeDays > 0 && !(v.createTime > 0 && v.ageDays <= f.maxAgeDays)) return false;
    if (f.kind !== 'all' && v.kind !== f.kind) return false;
    if (f.tier && crTier(v) !== f.tier) return false;
    return true;
  }
  // 没达标的原因（给变暗的卡片挂原因牌）：只返回最主要的一条
  function failReason(v, f) {
    f = normFilter(f);
    const n = (x) => (x >= 10000 ? (Math.round(x / 1000) / 10 + '万').replace('.0万', '万') : String(x));
    if (f.tier && crTier(v) !== f.tier) return '不在这一档';
    if (f.kind !== 'all' && v.kind !== f.kind) return v.kind === 'note' ? '图文' : '视频';
    if (f.minCr > 0 && v.lowSample) return '样本少';
    if (f.minCr > 0 && !(v.cr >= f.minCr)) return '收藏率 < ' + Math.round(f.minCr * 100) + '%';
    if (f.maxAgeDays > 0 && !(v.createTime > 0 && v.ageDays <= f.maxAgeDays)) return f.maxAgeDays === 365 ? '一年前' : f.maxAgeDays + ' 天前';
    if (f.min.digg && !(v.digg >= f.min.digg)) return '赞 < ' + n(f.min.digg);
    if (f.min.collect && !(v.collect >= f.min.collect)) return '藏 < ' + n(f.min.collect);
    if (f.min.comment && !(v.comment >= f.min.comment)) return '评 < ' + n(f.min.comment);
    if (f.min.share && !(v.share >= f.min.share)) return '转 < ' + n(f.min.share);
    return '';
  }
  function filterList(list, f) {
    const nf = normFilter(f);
    if (!activeFilterCount(nf)) return list.slice();
    return list.filter((v) => passes(v, nf));
  }

  // 这批结果的概况：给"结果头部"和弹窗用
  function summarize(list) {
    const n = list.length;
    if (!n) return { count: 0 };
    const med = (k) => quantile(list.map((v) => v[k]).filter((x) => x != null).sort(asc), 0.5);
    const reliable = list.filter((v) => !v.lowSample);
    return {
      count: n,
      median: { digg: med('digg'), comment: med('comment'), collect: med('collect'), share: med('share'), dpd: med('dpd') },
      medianCr: reliable.length ? quantile(reliable.map((v) => v.cr).sort(asc), 0.5) : 0,
      medianEr: reliable.length ? quantile(reliable.map((v) => v.er).sort(asc), 0.5) : 0,
      max: { digg: Math.max(0, ...list.map((v) => v.digg || 0)), collect: Math.max(0, ...list.map((v) => v.collect || 0)) },
      strongNeed: reliable.filter((v) => v.cr >= 0.8).length, // 藏赞比 ≥ 80% 的"真需求"条数
    };
  }

  // 收藏率分档（作者选题库 SOP 的判读口径）：
  //   high ≥80% 真需求 · mid 40%~80% 一般 · low 10%~40% 有门槛 · show <10% 展示型 · na 点赞太少不评
  const CR_TIERS = {
    high: { label: '真需求', range: '≥80%' },
    mid:  { label: '一般', range: '40%~80%' },
    low:  { label: '有门槛', range: '10%~40%' },
    show: { label: '展示型', range: '<10%' },
    na:   { label: '样本少', range: '点赞<' + RATIO_MIN_DIGG },
  };
  function crTier(v) {
    if (v.lowSample || v.cr == null) return 'na';
    if (v.cr >= 0.8) return 'high';
    if (v.cr > 0.4) return 'mid';
    if (v.cr >= 0.1) return 'low';
    return 'show';
  }

  DSP.metrics = {
    METRICS, RATIO_MIN_DIGG, EMPTY_FILTER, CR_TIERS,
    derive, fmtDn, marks, sortList, filterList, failReason, normFilter, activeFilterCount, summarize, crTier, quantile,
  };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') module.exports = DSP.metrics;
})();
