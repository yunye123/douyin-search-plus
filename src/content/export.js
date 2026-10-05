// 导出：入库包（Markdown / JSON）、表格（TSV 粘贴 / CSV 文件）、评论。纯函数构建文本，
// 下载与复制在最后两个小函数里（只有它们碰 DOM / 剪贴板）。
//
// 字段对齐作者飞书选题库 SOP：原链接用规范的 /video/<id>，原标题照抄 desc 不改一字，
// 比率一律带观察窗口 D+N 和采集时间（同一条视频 10 天内收藏率会掉 6~7 个点）。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  const U = DSP.util || (typeof require === 'function' ? require('./util.js') : null);
  const M = DSP.metrics || (typeof require === 'function' ? require('./metrics.js') : null);

  const videoUrl = (v) => 'https://www.douyin.com/' + (v.kind === 'note' ? 'note/' : 'video/') + v.id;
  const kindLabel = (v) => (v.kind === 'note' ? '图文' : '视频');
  const p2 = (x) => String(x).padStart(2, '0');
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  const pct1 = (r) => (r == null ? '' : r > 0 ? (Math.round(r * 1000) / 10) + '%' : '0%');
  const ratio4 = (r) => (r == null ? null : Math.round(r * 10000) / 10000);
  // 有热度建议值（SOP：对标给 3~4）：收藏率达到真需求线的给 4，其余给 3；只是建议，入库时可改
  const heatHint = (v) => (!v.lowSample && v.cr >= 0.8 ? 4 : 3);

  // ---------- 表格列（TSV / CSV 共用） ----------
  const COLUMNS = [
    ['序号', (v, i) => i + 1],
    ['原标题', (v) => v.desc],
    ['原链接', (v) => videoUrl(v)],
    ['作者', (v) => v.author],
    ['发布时间', (v) => U.fmtDate(v.createTime)],
    ['观察窗口', (v) => M.fmtDn(v.dn)],
    ['时长', (v) => (v.kind === 'note' ? '' : U.fmtDuration(v.durationMs))],
    ['类型', (v) => kindLabel(v)],
    ['点赞', (v) => v.digg],
    ['评论', (v) => v.comment],
    ['收藏', (v) => v.collect],
    ['转发', (v) => v.share],
    ['收藏率', (v) => pct1(v.cr)],
    ['收藏率分档', (v) => M.tierLabel(v)],
    ['转发率', (v) => pct1(v.sr)],
    ['评论率', (v) => pct1(v.er)],
    ['采集时间', (v) => fmtTime(v.capturedAt)],
    ['视频ID', (v) => v.id],
  ];

  // CSV 注入防护：以 = + - @ 制表符 回车 开头的文本，Excel 会当公式执行，前面补一个 '
  function csvCell(x) {
    if (x == null) return '""';
    if (typeof x === 'number') return String(x);
    let s = String(x == null ? '' : x);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  // TSV（粘贴到飞书 / Excel）：去掉换行与制表符，避免把一格拆成多格
  const tsvCell = (x) => String(x == null ? '' : x).replace(/[\t\r\n]+/g, ' ');

  function tableRows(list) {
    return [COLUMNS.map((c) => c[0])].concat(list.map((v, i) => COLUMNS.map((c) => c[1](v, i))));
  }
  function toCsv(list) {
    // BOM 让 Excel 正确识别 UTF-8 中文
    return '\uFEFF' + tableRows(list).map((r) => r.map(csvCell).join(',')).join('\r\n');
  }
  function toTsv(list) {
    return tableRows(list).map((r) => r.map(tsvCell).join('\t')).join('\n');
  }

  // ---------- 入库包 ----------
  const authorUrl = (v) => (v.authorId ? 'https://www.douyin.com/user/' + v.authorId : '');
  // "发现于"：搜索「xx」/ @作者 主页，排过序的带上看法和名次
  function discovered(v) {
    if (!v.source) return '';
    const x = v.extra || {};
    let s = v.srcType === 'profile' && v.source.charAt(0) === '@' ? v.source + ' 主页' : v.source;
    if (x.rank) s += ' · ' + (x.lensLabel ? x.lensLabel + ' ' : '') + '第 ' + x.rank + ' 名';
    return s;
  }
  const accountText = (a) => (a ? [a.fans ? '粉丝 ' + U.fmtNum(a.fans) : '', a.likes ? '获赞 ' + U.fmtNum(a.likes) : '', a.works ? '作品 ' + a.works : ''].filter(Boolean).join(' · ') : '');
  // 评论区诊断：只列出现过的门槛词
  function commentsLine(cm) {
    if (!cm || !cm.stats) return '';
    const parts = BARRIERS.filter((b) => cm.stats[b.key]).map((b) => b.label + ' ' + cm.stats[b.key]);
    const read = cm.total ? '已读 ' + cm.loaded + '/' + cm.total : '已读 ' + cm.loaded;
    return (parts.length ? parts.join(' · ') : '没有人提到门槛词') + '（' + read + '）';
  }
  // Markdown：复制后直接对 Agent 说"添加选题"，Agent 只负责改写标题和打分，不必再去抖音取数
  function toMarkdown(list, meta) {
    meta = meta || {};
    const lines = [];
    lines.push('# 选题候选 · ' + list.length + ' 条');
    const src = meta.source ? '来源：' + meta.source + ' · ' : '';
    lines.push('> ' + src + '导出于 ' + fmtTime(meta.now || (list[0] && list[0].capturedAt)) + ' · 数据由 DouyinSearchPlus 导出，每条的采集时间见条目');
    lines.push('> 口径：收藏率 = 收藏 ÷ 点赞；D+N = 采集时距发布的天数（比率要连窗口一起比）');
    list.forEach((v, i) => {
      lines.push('');
      lines.push('## ' + (i + 1) + '. ' + ((v.desc || '').replace(/\s+/g, ' ').slice(0, 40) || '（无标题）'));
      lines.push('- 原链接：' + videoUrl(v));
      // 原标题照抄 desc；多行时缩进续行，保持在同一个列表项里
      lines.push('- 原标题：' + (v.desc || '').replace(/\n/g, '\n  '));
      const x = v.extra || {};
      lines.push('- 作者：' + (v.author ? '@' + v.author : '未知') + (authorUrl(v) ? '（主页 ' + authorUrl(v) + '）' : ''));
      if (x.account) lines.push('- 账号快照：' + accountText(x.account) + (x.account.at ? '（' + U.fmtDate(x.account.at) + ' 采集）' : ''));
      if (discovered(v)) lines.push('- 发现于：' + discovered(v));
      lines.push('- 发布：' + U.fmtDate(v.createTime) + (v.dn ? '（' + M.fmtDn(v.dn) + '）' : '') + ' · ' + kindLabel(v) + (v.kind === 'note' ? '' : ' ' + U.fmtDuration(v.durationMs)));
      const c = (x) => (x == null ? '—' : String(x));
      const p = (r) => (r == null ? '—' : pct1(r));
      lines.push('- 数据：赞 ' + c(v.digg) + ' · 评 ' + c(v.comment) + ' · 藏 ' + c(v.collect) + ' · 转 ' + c(v.share));
      lines.push('- 比率：收藏率 ' + p(v.cr) + '（' + M.tierLabel(v) + '）· 转发率 ' + p(v.sr) + ' · 评论率 ' + p(v.er));
      if (x.share != null) lines.push('- 占账号总获赞：' + pct1(x.share));
      if (v.capturedAt) lines.push('- 采集：' + fmtTime(v.capturedAt) + (v.dn ? '（' + M.fmtDn(v.dn) + '）' : ''));
      if (x.comments) {
        lines.push('- 评论区：' + commentsLine(x.comments));
        // 原评论一字不改（SOP「原文|原评论」字段）
        for (const t of (x.comments.picks || []).slice(0, 5)) lines.push('  - 原评论：' + String(t).replace(/\s*\n\s*/g, ' '));
      }
      lines.push('- 建议：来源=对标 · 有热度=' + heatHint(v) + '（建议值）');
    });
    return lines.join('\n');
  }

  // JSON：字段名直接用选题库的列名，便于 Agent 写入多维表格
  function toJson(list, meta) {
    meta = meta || {};
    return JSON.stringify({
      tool: 'DouyinSearchPlus',
      exportedAt: fmtTime(meta.now),
      source: meta.source || '候选篮',
      items: list.map((v) => {
        const x = v.extra || {};
        return {
        原标题: v.desc,
        原链接: videoUrl(v),
        作者: v.author,
        作者主页: authorUrl(v),
        发现于: discovered(v),
        账号快照: x.account ? accountText(x.account) : '',
        占账号总获赞: x.share == null ? null : ratio4(x.share),
        发布时间: U.fmtDate(v.createTime),
        观察窗口: M.fmtDn(v.dn),
        采集时间: fmtTime(v.capturedAt),
        类型: kindLabel(v),
        时长秒: Math.round((v.durationMs || 0) / 1000),
        点赞: v.digg, 评论: v.comment, 收藏: v.collect, 转发: v.share,
        收藏率: ratio4(v.cr),
        收藏率分档: M.tierLabel(v),
        转发率: ratio4(v.sr),
        评论率: ratio4(v.er),
        评论区门槛词: x.comments ? commentsLine(x.comments) : '',
        原评论: x.comments ? (x.comments.picks || []).slice(0, 5) : [],
        来源: '对标',
        有热度建议: heatHint(v),
        视频ID: v.id,
        };
      }),
    }, null, 2);
  }

  // ---------- 评论 ----------
  // 门槛词典（SOP：先数"多少钱""进不去""卡在哪"出现几次，判断门槛类型）
  // 词典刻意只收"具体说法"，不收"求""怎么"这类泛用字（"求关注""怎么这么好用"不该算门槛）。
  // 插件只给计数和命中的原评论，结论由作者自己看原文下。
  const BARRIERS = [
    // "付费""会员"单独出现常是夸奖（"讲得比付费课还好"），只收带疑问或抱怨语气的说法
    { key: 'cost', label: '太贵', tip: '问价格、问收不收费、嫌贵', re: /多少钱|太贵|好贵|贵不贵|收费吗|要收费|付费吗|要付费|付费才|需要付费|要钱吗|要钱|收钱|免费吗|是免费的吗|要积分|积分不够|要会员|需要会员|会员才|开会员|充值/ },
    { key: 'access', label: '进不去', tip: '提到打不开、要梯子、注册不了', re: /进不去|梯子|翻墙|魔法上网|打不开|登不上|登录不了|注册不了|访问不了|国内能用|国内用不了|vpn/i },
    { key: 'hard', label: '太复杂', tip: '提到卡住、报错、学不会', re: /卡住|卡在|报错|失败了|看不懂|太难了|好难|学不会|不会弄|弄不出|怎么一直|出不来|没反应|装不上|安装不了/ },
    { key: 'english', label: '英文门槛', tip: '提到界面是英文、没有中文', re: /全是英文|英文界面|看不懂英文|英语不好|英文不好|有中文版|没有中文/ },
    { key: 'ask', label: '求资源', tip: '在要链接、要教程、要提示词', re: /求链接|求教程|求提示词|求软件|求资源|在哪下载|哪里下载|怎么下载|链接在哪|发一下链接|能分享一下|网址是|地址是/ },
  ];
  function barrierHits(text) {
    const out = [];
    for (const b of BARRIERS) if (b.re.test(text || '')) out.push(b.key);
    return out;
  }
  function barrierStats(comments) {
    const stats = Object.fromEntries(BARRIERS.map((b) => [b.key, 0]));
    for (const c of comments) for (const k of barrierHits(c.text)) stats[k]++;
    return stats;
  }
  // 隐私：默认不导出评论者昵称和 IP 属地（这些表格常被贴给 AI 或分享给别人）
  const COMMENT_COLUMNS = [
    ['序号', (c, i) => i + 1],
    ['评论', (c) => c.text],
    ['点赞', (c) => c.digg],
    ['回复数', (c) => c.replies],
    ['时间', (c) => fmtTime(c.createTime)],
    ['门槛词', (c) => barrierHits(c.text).map((k) => BARRIERS.find((b) => b.key === k).label).join('、')],
  ];
  function commentsCsv(list) {
    const rows = [COMMENT_COLUMNS.map((c) => c[0])].concat(list.map((c, i) => COMMENT_COLUMNS.map((col) => col[1](c, i))));
    return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  }
  // 原评论一字不改（SOP："原文|原评论"字段要求逐字）
  function commentsText(list) {
    return list.map((c) => c.text + '（赞 ' + c.digg + (c.replies ? ' · 回复 ' + c.replies : '') + '）').join('\n');
  }

  // 文件名去掉 Windows 非法字符
  function safeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名';
  }

  // ---------- 浏览器端：下载与复制 ----------
  function download(name, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/csv;charset=utf-8' }));
    a.download = name;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 退回老办法 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.documentElement.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  DSP.exporter = {
    COLUMNS, BARRIERS, videoUrl, fmtTime,
    toCsv, toTsv, toMarkdown, toJson, csvCell,
    barrierHits, barrierStats, commentsCsv, commentsText, safeName,
    download, copyText,
  };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') module.exports = DSP.exporter;
})();
