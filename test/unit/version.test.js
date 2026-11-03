'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../../src/popup/version.js');

const root = (...p) => path.join(__dirname, '../..', ...p);
const NOTICE = (v) => '有新版本 v' + v + '，重新下载后在扩展管理页点刷新。';

test('版本比较：1.0.0 < 1.1.0，相等，1.0.10 > 1.0.9，垃圾版本无法比较', () => {
  assert.equal(V.cmpVersion('1.0.0', '1.1.0'), -1);
  assert.equal(V.cmpVersion('1.1.0', '1.0.0'), 1);
  assert.equal(V.cmpVersion('1.0.0', '1.0.0'), 0);
  assert.equal(V.cmpVersion('1.0', '1.0.0'), 0);
  assert.equal(V.cmpVersion('1.0.10', '1.0.9'), 1);
  assert.equal(V.cmpVersion('1.0.9', '1.0.10'), -1);
  assert.equal(V.cmpVersion('1.0.0.1', '1.0.0'), 1);
  assert.equal(V.cmpVersion(' 1.0.0 ', '1.0.0'), 0);
  for (const bad of ['garbage', 'v1.1.0', '1.0.0-beta', '1..0', '', '  ', null, undefined, 1.1]) {
    assert.equal(V.cmpVersion(bad, '1.0.0'), null, String(bad));
    assert.equal(V.cmpVersion('1.0.0', bad), null, String(bad));
  }
});

test('只在远程更高时返回版本号，并只请求那一个 raw 地址', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ version: '1.1.0' }) };
  };
  assert.equal(await V.remoteNewerVersion('1.0.0', fetchImpl), '1.1.0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, V.UPDATE_URL);
  assert.equal(V.UPDATE_URL, 'https://raw.githubusercontent.com/yunye123/douyin-search-plus/main/manifest.json');
  assert.equal(calls[0].opts.cache, 'no-store');
  assert.equal(calls[0].opts.credentials, 'omit');
  assert.equal(calls[0].opts.referrerPolicy, 'no-referrer');
  assert.equal(calls[0].opts.signal.aborted, false);
  assert.equal(V.TIMEOUT_MS, 4000);

  const json = (version) => async () => ({ ok: true, json: async () => ({ version }) });
  assert.equal(await V.remoteNewerVersion('1.0.0', json('1.0.0')), null);
  assert.equal(await V.remoteNewerVersion('1.0.10', json('1.0.9')), null);
  assert.equal(await V.remoteNewerVersion('1.0.9', json('1.0.10')), '1.0.10');
  assert.equal(await V.remoteNewerVersion('1.0.0', json('garbage')), null);
  assert.equal(await V.remoteNewerVersion('1.0.0', json(2)), null);
  assert.equal(await V.remoteNewerVersion('garbage', json('9.0.0')), null);
});

test('失败、非 JSON、HTTP 错误、超时都当作没有更新', async () => {
  assert.equal(await V.remoteNewerVersion('1.0.0', async () => { throw new TypeError('Failed to fetch'); }), null);
  assert.equal(await V.remoteNewerVersion('1.0.0', async () => ({
    ok: true,
    json: async () => { throw new SyntaxError('Unexpected token'); },
  })), null);
  assert.equal(await V.remoteNewerVersion('1.0.0', async () => ({
    ok: false,
    status: 500,
    json: async () => ({ version: '9.9.9' }),
  })), null);
  const slow = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  assert.equal(await V.remoteNewerVersion('1.0.0', slow, { timeoutMs: 30 }), null);
});

test('假节点：更高版本写入提示文字，失败或相同版本不改节点', async () => {
  const ok = { textContent: '', hidden: true };
  const remote = await V.remoteNewerVersion('1.0.0', async () => ({ ok: true, json: async () => ({ version: '1.1.0' }) }));
  assert.equal(V.showUpdate(ok, remote), true);
  assert.equal(ok.hidden, false);
  assert.equal(ok.textContent, NOTICE('1.1.0'));
  assert.equal(V.notice('1.1.0'), NOTICE('1.1.0'));

  const stay = { textContent: 'stay', hidden: true };
  const failed = await V.remoteNewerVersion('1.0.0', async () => { throw new Error('nope'); });
  assert.equal(failed, null);
  assert.equal(V.showUpdate(stay, failed), false);
  assert.equal(V.showUpdate(stay, 'garbage'), false);
  assert.equal(stay.hidden, true);
  assert.equal(stay.textContent, 'stay');
});

test('清单不放宽抖音权限，弹窗链接指向仓库并默认藏起提示', () => {
  const manifest = JSON.parse(fs.readFileSync(root('manifest.json'), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://www.douyin.com/*']);
  const html = fs.readFileSync(root('src/popup/popup.html'), 'utf8');
  const versionAt = html.indexOf('id="version"');
  const updateAt = html.indexOf('id="update"');
  assert.ok(versionAt > 0 && updateAt > versionAt);
  assert.ok(html.includes('href="' + V.REPO_URL + '"'));
  assert.equal(V.REPO_URL, 'https://github.com/yunye123/douyin-search-plus');
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes('rel="noopener"'));
  assert.ok(/id="update"[^>]*hidden/.test(html));
  assert.ok(html.includes('src="version.js"'));
  const privacy = fs.readFileSync(root('PRIVACY.md'), 'utf8');
  assert.ok(privacy.includes(V.UPDATE_URL));
  const readme = fs.readFileSync(root('README.md'), 'utf8');
  assert.ok(readme.includes('弹窗会在版本号下面提示'));
});
