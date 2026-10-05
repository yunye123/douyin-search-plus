// 候选篮抽屉：跨关键词、跨页面攒下的候选（存在本机），一键复制入库包给 Agent。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});
  const { h, icon, clear, closePop } = DSP.kit;
  const U = DSP.util, M = DSP.metrics, E = DSP.exporter;

  const st = { tab: 'md' };

  function ago(ts) { return U.fmtAgo(ts); }

  function item(c, api) {
    const tier = M.crTier(c);
    const url = E.videoUrl(c);
    const thumb = h('span', { class: 'bk-thumb' });
    if (c.cover) {
      const img = h('img', { src: c.cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => img.remove());
      thumb.appendChild(img);
    }
    if (c.kind === 'note') thumb.appendChild(h('span', { class: 'bk-dur' }, '图文'));
    else if (c.durationMs) thumb.appendChild(h('span', { class: 'bk-dur' }, U.fmtDuration(c.durationMs)));
    const row = h('li', { class: 'bk-item' + (c.copiedAt ? ' copied' : '') },
      h('a', { class: 'bk-link', href: url, target: '_blank', rel: 'noopener noreferrer', title: '在新标签页打开' },
        thumb,
        h('span', { class: 'bk-body' },
          h('span', { class: 'bk-title' }, c.desc || '（无标题）'),
          h('span', { class: 'bk-src' }, (c.author ? '@' + c.author : '') + (c.source ? ' · ' + c.source : '')),
          h('span', { class: 'bk-data' },
            h('b', { class: 'c-' + tier }, tier === 'na' ? '样本少' : U.fmtPct(c.cr)),
            tier !== 'na' ? h('span', { class: 'tier tier-' + tier }, M.CR_TIERS[tier].label) : null,
            h('span', { class: 'bk-meta' }, (c.dn ? M.fmtDn(c.dn) + ' · ' : '') + '赞 ' + U.fmtNum(c.digg)),
            c.copiedAt ? h('span', { class: 'bk-copied' }, '已复制') : null,
            c.extra && c.extra.comments ? h('span', { class: 'bk-copied' }, '含评论结论') : null))),
      h('span', { class: 'bk-side' },
        h('button', { class: 'bk-x', type: 'button', 'aria-label': '移出候选篮', onclick: () => api.removeCandidate(c.id) }, icon('close', 14)),
        h('span', { class: 'bk-ago' }, ago(c.addedAt))));
    return row;
  }

  function panel(api) {
    const list = api.candidates();
    const box = h('div', { class: 'pop-basket' });
    box.appendChild(h('div', { class: 'bk-head' },
      h('span', { class: 'bk-ic' }, icon('star', 16)),
      h('b', null, '候选篮'),
      list.length ? h('span', { class: 'count gold' }, String(list.length)) : null,
      h('span', { class: 'grow' }),
      list.length ? h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': '清空候选篮', title: '清空候选篮', onclick: () => api.clearCandidates() }, icon('trash', 16)) : null,
      h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': '关闭', onclick: () => closePop(true) }, icon('close', 16))));
    box.appendChild(h('div', { class: 'bk-note' }, icon('info', 14), '存在这台电脑的浏览器里，换关键词、换页面都还在。'));

    if (!list.length) {
      box.appendChild(h('div', { class: 'bk-empty' },
        h('span', { class: 'bk-empty-ic' }, icon('star', 28)),
        h('b', null, '候选篮还是空的'),
        h('span', null, '在卡片右上角点「☆ 候选」，把值得做的选题攒在这里，最后一次性复制给 Agent。')));
      return box;
    }

    const ul = h('ul', { class: 'bk-list', 'aria-label': '候选列表' });
    list.slice().reverse().forEach((c) => ul.appendChild(item(c, api)));
    box.appendChild(ul);

    // 预览：复制前先看一眼
    const tabs = h('div', { class: 'bk-tabs', role: 'group', 'aria-label': '预览格式' });
    const pre = h('pre', { class: 'bk-pre', tabindex: '0', 'aria-label': '预览：入库包' });
    const renderPre = () => {
      pre.textContent = st.tab === 'md' ? api.markdown() : E.toTsv(list).split('\n').map((r) => r.split('\t').slice(1, 8).join('  │  ')).join('\n');
      pre.setAttribute('aria-label', '预览：' + (st.tab === 'md' ? '入库包' : '表格'));
      for (const b of tabs.querySelectorAll('.bk-tab')) { const on = b.dataset.tab === st.tab; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    };
    for (const [k, label] of [['md', '入库包'], ['tsv', '表格']]) {
      tabs.appendChild(h('button', { class: 'bk-tab', type: 'button', 'data-tab': k, onclick: () => { st.tab = k; renderPre(); } }, label));
    }
    tabs.appendChild(h('span', { class: 'bk-tab-hint' }, '复制前先看一眼'));
    box.append(tabs, pre);
    renderPre();

    // 默认只复制还没复制过的（上次已交给 Agent 的不重复给）；都复制过时复制全部
    const fresh = list.filter((c) => !c.copiedAt).length;
    const n = fresh || list.length;
    const primary = h('button', { class: 'bk-primary', type: 'button', 'data-autofocus': '', 'data-dsp': 'copy-md', onclick: () => api.copy('md', primary) },
      icon('copy', 18), h('span', { class: 'bk-pt' }, h('b', null, '复制入库包 · ' + n + ' 条' + (fresh && fresh < list.length ? '新的' : '')),
        h('span', null, fresh && fresh < list.length ? '另有 ' + (list.length - fresh) + ' 条复制过，不重复给' : '粘贴给 Agent，说「添加选题」')));
    const sec = h('div', { class: 'bk-sec' },
      h('button', { class: 'bk-btn', type: 'button', 'data-dsp': 'copy-tsv', onclick: (e) => api.copy('tsv', e.currentTarget) }, icon('table', 16), '复制为表格'),
      h('button', { class: 'bk-btn', type: 'button', 'data-dsp': 'csv', onclick: () => api.downloadCsv() }, icon('download', 16), '下载 CSV'),
      h('button', { class: 'bk-btn', type: 'button', 'data-dsp': 'copy-json', onclick: (e) => api.copy('json', e.currentTarget) }, h('span', { class: 'mono' }, '{ }'), '复制 JSON'));
    const again = fresh && fresh < list.length ? h('button', { class: 'link bk-again', type: 'button', 'data-dsp': 'copy-all', onclick: (e) => api.copy('md', e.currentTarget, true) }, '全部 ' + list.length + ' 条再复制一次') : null;
    box.append(h('div', { class: 'bk-actions' }, primary, sec, again));
    return box;
  }

  const CSS = `
.pop-basket { position: fixed; top: 72px; right: 16px; bottom: 16px; width: 400px; max-width: calc(100vw - 32px); display: flex; flex-direction: column; padding: 0; overflow: hidden;
  transform: translateX(16px); transform-origin: right center; }
.pop-basket.dsp-in { transform: none; }
.bk-head { display: flex; align-items: center; gap: 8px; padding: 14px 12px 6px 16px; }
.bk-head b { font: 600 16px/24px var(--font); }
.bk-ic { width: 28px; height: 28px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: rgba(255,197,61,.16); color: var(--gold); }
.bk-ic svg { fill: var(--gold); }
.grow { flex: 1; }
.count.gold { background: var(--gold); color: #2A1E00; }
.icon-btn.sm { width: 30px; height: 30px; }
.bk-note { display: flex; align-items: center; gap: 6px; padding: 0 16px 10px; color: var(--t3); font-size: 12px; border-bottom: 1px solid var(--line); }
.bk-list { list-style: none; margin: 0; padding: 6px; overflow: auto; flex: 1 1 auto; min-height: 120px; }
.bk-item { display: flex; gap: 6px; padding: 6px; border-radius: 12px; }
.bk-item:hover { background: var(--line); }
.bk-link { flex: 1; min-width: 0; display: flex; gap: 10px; color: inherit; text-decoration: none; border-radius: 8px; }
.bk-thumb { position: relative; width: 84px; height: 58px; flex: none; border-radius: 8px; overflow: hidden; background: var(--s3); }
.bk-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.bk-dur { position: absolute; right: 4px; bottom: 4px; padding: 0 4px; border-radius: 4px; background: rgba(0,0,0,.6); color: #fff; font-size: 10px; line-height: 16px; }
.bk-body { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.bk-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bk-src { color: var(--t3); font-size: 12px; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bk-data { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 20px; }
.bk-data b { font: 700 14px/20px var(--font); }
.bk-meta { color: var(--t3); white-space: nowrap; }
.bk-side { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; flex: none; }
.bk-x { width: 24px; height: 24px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; color: var(--t3); opacity: 0; }
.bk-item:hover .bk-x, .bk-x:focus-visible { opacity: 1; }
.bk-x:hover { background: var(--line2); color: var(--t1); }
.bk-ago { color: var(--t3); font-size: 11px; white-space: nowrap; }
.bk-tabs { display: flex; align-items: center; gap: 4px; padding: 8px 12px 6px; border-top: 1px solid var(--line); }
.bk-tab { height: 28px; padding: 0 10px; border-radius: 8px; color: var(--t2); }
.bk-tab.on { background: var(--s3); color: var(--t1); font-weight: 600; }
.bk-tab-hint { margin-left: auto; color: var(--t3); font-size: 12px; }
.bk-pre { margin: 0 12px; padding: 10px 12px; height: 132px; overflow: auto; border-radius: 10px; background: var(--bg); color: var(--t2);
  font: 11.5px/18px ui-monospace, "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace; white-space: pre-wrap; word-break: break-all; }
.bk-actions { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.bk-primary { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 16px; border-radius: 12px; background: var(--red-solid); color: #fff; text-align: left; }
.bk-primary:hover { background: #F0254D; }
.bk-pt { display: flex; flex-direction: column; }
.bk-pt b { font: 600 15px/22px var(--font); }
.bk-pt span { font-size: 12px; line-height: 18px; }
.bk-item.copied .bk-title, .bk-item.copied .bk-thumb { opacity: .55; }
.bk-copied { height: 18px; padding: 0 6px; border-radius: 4px; background: var(--s3); color: var(--t2); font-size: 11px; line-height: 18px; white-space: nowrap; }
.bk-again { align-self: center; }
.bk-sec { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.bk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 38px; border-radius: 10px; box-shadow: inset 0 0 0 1px var(--line2); color: var(--t1); font-size: 13px; }
.bk-btn:hover { background: var(--line); }
.mono { font: 600 12px ui-monospace, Consolas, monospace; color: var(--t2); }
.bk-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 40px 32px; text-align: center; color: var(--t2); }
.bk-empty b { color: var(--t1); font: 600 16px/24px var(--font); }
.bk-empty-ic { width: 56px; height: 56px; border-radius: 16px; display: inline-flex; align-items: center; justify-content: center; background: var(--s3); color: var(--t3); margin-bottom: 4px; }
@media (max-height: 640px) { .bk-pre { height: 84px; } }
`;
  DSP.css = (DSP.css || '') + CSS;

  DSP.basket = { panel };
})();
