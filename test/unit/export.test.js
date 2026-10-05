'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../../src/content/util.js');
const M = require('../../src/content/metrics.js');
const E = require('../../src/content/export.js');

const NOW = 1_790_000_000;
const v = M.derive({
  id: '7400000000000000001', kind: 'video', desc: '=HYPERLINK("x") 保姆级教程\n第二行', author: '星辰ai',
  createTime: NOW - 6.2 * 86400, capturedAt: NOW, durationMs: 127199,
  digg: 2600, comment: 44, collect: 2903, share: 120,
}, NOW);

test('CSV：BOM、表头、公式注入防护、引号转义', () => {
  const csv = E.toCsv([v]);
  assert.ok(csv.startsWith('﻿"序号","原标题","原链接"'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"") 保姆级教程`)); // 公式前补 '，引号双写
  assert.ok(csv.includes('"https://www.douyin.com/video/7400000000000000001"'));
  assert.ok(csv.includes('"D+6.2"'));
  assert.ok(csv.includes('"112%"') === false); // 表格里用一位小数
  assert.ok(csv.includes('"111.7%"'));
  assert.ok(csv.includes('"真需求"'));
});

test('TSV：去掉换行与制表符，列数一致', () => {
  const tsv = E.toTsv([v, Object.assign({}, v, { id: '7400000000000000002', kind: 'note' })]);
  const rows = tsv.split('\n');
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(r.split('\t').length, E.COLUMNS.length);
  assert.ok(rows[2].includes('https://www.douyin.com/note/7400000000000000002'));
});

test('入库包 Markdown：原标题照抄、链接规范、带口径与窗口', () => {
  const md = E.toMarkdown([v], { source: '搜索「AI保姆级教程」', now: NOW });
  assert.ok(md.includes('# 选题候选 · 1 条'));
  assert.ok(md.includes('来源：搜索「AI保姆级教程」'));
  assert.ok(md.includes('- 原链接：https://www.douyin.com/video/7400000000000000001'));
  assert.ok(md.includes('- 原标题：=HYPERLINK("x") 保姆级教程\n第二行'.split('\n')[0]));
  assert.ok(md.includes('收藏率 111.7%（真需求）'));
  assert.ok(md.includes('（D+6.2）'));
  assert.ok(md.includes('有热度=4'));
});

test('入库包 JSON：选题库列名', () => {
  const j = JSON.parse(E.toJson([v], { now: NOW }));
  assert.equal(j.items[0].原链接, 'https://www.douyin.com/video/7400000000000000001');
  assert.equal(j.items[0].收藏, 2903);
  assert.equal(j.items[0].收藏率, 1.1165);
  assert.equal(j.items[0].观察窗口, 'D+6.2');
  assert.equal(j.items[0].时长秒, 127);
  assert.equal(j.items[0].来源, '对标');
});

test('评论门槛词：命中具体说法', () => {
  assert.deepEqual(E.barrierHits('这个要多少钱？有梯子吗'), ['cost', 'access']);
  assert.deepEqual(E.barrierHits('第三步卡住了，报错'), ['hard']);
  assert.deepEqual(E.barrierHits('全是英文'), ['english']);
  assert.deepEqual(E.barrierHits('全是英文看不懂'), ['hard', 'english']); // 一条评论可以同时命中多类
  assert.deepEqual(E.barrierHits('求链接！在哪下载'), ['ask']);
  assert.deepEqual(E.barrierHits('VPN 才能用吗'), ['access']);
  const s = E.barrierStats([{ text: '多少钱' }, { text: '太贵了' }, { text: '全是英文' }, { text: '安装不了' }]);
  assert.equal(s.cost, 2);
  assert.equal(s.english, 1);
  assert.equal(s.hard, 1);
});

test('评论门槛词：泛用说法不误报', () => {
  for (const t of ['讲得真好', '求关注', '怎么这么好用', '英文歌好听', '已关注，求出下一期', '这个教程太棒了', '讲得比付费课还好', '开了会员也学不到这么多']) {
    assert.deepEqual(E.barrierHits(t), [], t);
  }
});

test('评论 CSV：默认不带昵称和 IP；原文复制一字不改', () => {
  const list = [{ cid: '1', text: '求链接', digg: 12, replies: 3, nickname: '某用户', createTime: NOW, ip: '北京' }];
  const csv = E.commentsCsv(list);
  assert.ok(csv.includes('"求链接",12,3,'));
  assert.ok(csv.includes('"求资源"'));
  assert.ok(!csv.includes('某用户'));
  assert.ok(!csv.includes('北京'));
  assert.equal(E.commentsText(list), '求链接（赞 12 · 回复 3）');
});

test('缺失的计数导出为空，不当成 0', () => {
  const nv = M.derive({ id: '7400000000000000009', kind: 'video', desc: 'x', digg: 500, collect: null, comment: 3, share: 1, createTime: NOW - 86400, capturedAt: NOW }, NOW);
  assert.equal(nv.cr, null);
  assert.equal(M.crTier(nv), 'na');
  const row = E.toTsv([nv]).split('\n')[1].split('\t');
  const col = (name) => row[E.COLUMNS.findIndex((c) => c[0] === name)];
  assert.equal(col('收藏'), '');
  assert.equal(col('收藏率'), '');
  assert.equal(col('收藏率分档'), '缺数据'); // 点赞够多、只是收藏缺失：不是样本少
  assert.equal(JSON.parse(E.toJson([nv])).items[0].收藏率, null);
});

test('文件名去非法字符', () => {
  assert.equal(E.safeName('a/b:c*?"<>|d'), 'a b c d');
  assert.equal(E.safeName(''), '未命名');
});

test('fmtNum 被导出依赖', () => { assert.equal(U.fmtNum(2903), '2903'); });

test('入库包：作者主页、账号快照、发现于名次、占比、评论区诊断与原评论', () => {
  const w = Object.assign(M.derive({
    id: '7400000000000000007', kind: 'video', desc: 'Top10 作品', author: '星辰ai', authorId: 'MS4w_x',
    createTime: NOW - 10 * 86400, capturedAt: NOW, durationMs: 60000, digg: 4000, comment: 80, collect: 3600, share: 300,
  }, NOW), {
    source: '@星辰ai', srcType: 'profile',
    extra: { rank: 1, lensLabel: '账号 Top10', account: { fans: 27000, likes: 179000, works: 60, at: NOW }, share: 0.225,
      comments: { stats: { cost: 14, access: 0, hard: 12, english: 0, ask: 31 }, loaded: 160, total: 160, picks: ['这个要多少钱？', '第三步\n卡住了'] } },
  });
  const md = E.toMarkdown([w], { now: NOW });
  assert.ok(md.includes('（主页 https://www.douyin.com/user/MS4w_x）'));
  assert.ok(md.includes('- 账号快照：粉丝 2.7万 · 获赞 17.9万 · 作品 60'));
  assert.ok(md.includes('- 发现于：@星辰ai 主页 · 账号 Top10 第 1 名'));
  assert.ok(md.includes('- 占账号总获赞：22.5%'));
  assert.ok(md.includes('- 评论区：太贵 14 · 太复杂 12 · 求资源 31（已读 160/160）'));
  assert.ok(md.includes('  - 原评论：第三步 卡住了'));
  const j = JSON.parse(E.toJson([w], { now: NOW }));
  assert.equal(j.source, '候选篮');
  assert.equal(j.items[0].作者主页, 'https://www.douyin.com/user/MS4w_x');
  assert.equal(j.items[0].占账号总获赞, 0.225);
  assert.deepEqual(j.items[0].原评论, ['这个要多少钱？', '第三步\n卡住了']);
});
