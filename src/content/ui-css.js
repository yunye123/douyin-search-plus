// 界面样式（注入到 Shadow DOM，与抖音页面互不影响）。
// 设计令牌对齐抖音新版深色界面；浅色值在 :host([data-theme="light"]) 上整体替换。
(() => {
  'use strict';
  const DSP = (globalThis.DSP = globalThis.DSP || {});

  const TOKENS = `
:host {
  all: initial;
  /* 表面 */
  --bg: #161722; --s1: #252632; --s2: #2E2F3D; --s3: #393A4A;
  --glass: rgba(30, 31, 44, 0.88);
  --line: rgba(255, 255, 255, 0.08); --line2: rgba(255, 255, 255, 0.14);
  /* 文字 */
  --t1: #EDEDF0; --t2: #A9AAB4; --t3: #9495A0; --t4: #6E6F7B;
  /* 品牌 */
  --red: #FE2C55; --red-solid: #E3173F; --red-text: #FF6B86; --red-soft: rgba(254, 44, 85, 0.16); --red-line: rgba(254, 44, 85, 0.42);
  --cyan: #25F4EE; --cyan-text: #5FF7F2; --cyan-soft: rgba(37, 244, 238, 0.13);
  --gold: #FFC53D;
  /* 收藏率分档 */
  --tier-high: #25F4EE; --tier-high-ink: #04262B; --tier-high-text: #5FF7F2; --tier-high-soft: rgba(37, 244, 238, 0.13);
  --tier-mid: #7A7E98; --tier-mid-text: #C9CAD6; --tier-mid-soft: rgba(122, 126, 152, 0.18);
  --tier-low: #FFB547; --tier-low-text: #FFC670; --tier-low-soft: rgba(255, 181, 71, 0.14);
  --tier-show: #B597FF; --tier-show-text: #C9B3FF; --tier-show-soft: rgba(181, 151, 255, 0.14);
  --tier-na: #5A5B6C; --tier-na-text: #9495A0;
  /* 形状与效果 */
  --r-tag: 4px; --r-chip: 7px; --r-btn: 10px; --r-card: 12px; --r-pop: 16px; --r-bar: 14px;
  --sh-pop: 0 0 0 1px rgba(255, 255, 255, 0.09), 0 24px 56px -12px rgba(0, 0, 0, 0.66);
  --sh-bar: 0 0 0 1px rgba(255, 255, 255, 0.07), 0 12px 32px -8px rgba(0, 0, 0, 0.55);
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1); --ease-out: cubic-bezier(0.4, 0, 1, 1);
  --font: "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  --focus: 0 0 0 2px var(--bg), 0 0 0 4px var(--cyan);
  color-scheme: dark;
}
:host([data-theme="light"]) {
  --bg: #FFFFFF; --s1: #FFFFFF; --s2: #F4F4F6; --s3: #E9E9EE;
  --glass: rgba(255, 255, 255, 0.9);
  --line: rgba(22, 24, 35, 0.10); --line2: rgba(22, 24, 35, 0.18);
  --t1: #161823; --t2: #57585F; --t3: #6F7079; --t4: #A0A1A8;
  --red-text: #D9123A; --cyan-text: #00807C;
  --tier-high-text: #00807C; --tier-mid-text: #57585F; --tier-low-text: #9A5B00; --tier-show-text: #6B4BC8; --tier-na-text: #6F7079;
  --sh-pop: 0 0 0 1px rgba(22, 24, 35, 0.08), 0 24px 56px -12px rgba(22, 24, 35, 0.28);
  --sh-bar: 0 0 0 1px rgba(22, 24, 35, 0.08), 0 12px 32px -8px rgba(22, 24, 35, 0.22);
  --focus: 0 0 0 2px #fff, 0 0 0 4px #00A8A3;
  color-scheme: light;
}
*, *::before, *::after { box-sizing: border-box; }
.dsp-layer { font: 13px/20px var(--font); color: var(--t1); font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; }
button:focus-visible, input:focus-visible, [tabindex]:focus-visible, a:focus-visible { outline: none; box-shadow: var(--focus); }
svg { display: block; flex: none; }
.dsp-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.num { font-variant-numeric: tabular-nums; }
.dsp-logo .dsp-logo-c { fill: var(--cyan); opacity: .9; } .dsp-logo .dsp-logo-r { fill: var(--red); opacity: .9; }
.dsp-logo .dsp-logo-w { fill: #fff; } .dsp-logo .dsp-logo-star { fill: var(--gold); }
:host([data-theme="light"]) .dsp-logo .dsp-logo-w { fill: #161823; }
`;

  // 分档标签（卡片角标、详情卡、候选篮、评论共用）
  const TIERS = `
.tier { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px; border-radius: var(--r-tag); font: 600 11px/20px var(--font); white-space: nowrap; }
.tier-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.tier-high { color: var(--tier-high-text); background: var(--tier-high-soft); }
.tier-mid { color: var(--tier-mid-text); background: var(--tier-mid-soft); }
.tier-low { color: var(--tier-low-text); background: var(--tier-low-soft); }
.tier-show { color: var(--tier-show-text); background: var(--tier-show-soft); }
.tier-na { color: var(--tier-na-text); background: rgba(128, 129, 145, 0.12); }
.c-high { color: var(--tier-high-text); } .c-mid { color: var(--tier-mid-text); } .c-low { color: var(--tier-low-text); } .c-show { color: var(--tier-show-text); } .c-na { color: var(--tier-na-text); }
`;

  // 弹层、提示、轻提示
  const OVERLAYS = `
.dsp-pop { position: fixed; z-index: 30; min-width: 240px; background: var(--s2); border-radius: var(--r-pop); box-shadow: var(--sh-pop); color: var(--t1);
  opacity: 0; transform: translateY(6px) scale(.98); transform-origin: top center; transition: opacity 120ms var(--ease-out), transform 120ms var(--ease-out); }
.dsp-pop.dsp-in { opacity: 1; transform: none; transition: opacity 180ms var(--ease), transform 180ms var(--ease); }
.dsp-tip { position: fixed; z-index: 40; max-width: 260px; padding: 8px 10px; background: var(--s3); color: var(--t1); border-radius: 8px; box-shadow: var(--sh-pop);
  font: 12px/18px var(--font); pointer-events: none; opacity: 0; transform: translateY(2px); transition: opacity 120ms var(--ease-out), transform 120ms var(--ease-out); }
.dsp-tip.dsp-in { opacity: 1; transform: none; transition: opacity 180ms var(--ease), transform 180ms var(--ease); }
.dsp-tip.dsp-measure { opacity: 0 !important; transition: none; }
.dsp-tip-title { font-weight: 600; margin-bottom: 2px; }
.dsp-tip-body { color: var(--t2); }
.dsp-tip-foot { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--line); color: var(--t3); font-size: 11px; line-height: 16px; }
.dsp-toast { position: fixed; z-index: 50; display: flex; align-items: center; gap: 8px; min-height: 40px; max-width: min(560px, calc(100vw - 32px)); padding: 8px 8px 8px 12px;
  background: var(--s3); color: var(--t1); border-radius: 12px; box-shadow: var(--sh-pop); font: 13px/20px var(--font);
  opacity: 0; translate: 0 6px; transition: opacity 160ms var(--ease), translate 160ms var(--ease); pointer-events: none; }
.dsp-toast.dsp-in { opacity: 1; translate: 0 0; pointer-events: auto; }
.dsp-toast svg { color: var(--cyan-text); }
.dsp-toast.dsp-toast-warn svg { color: var(--tier-low-text); }
.dsp-toast-msg { flex: 1; min-width: 0; padding-right: 4px; }
.dsp-toast-act { height: 28px; padding: 0 10px; border-radius: 8px; color: var(--cyan-text); font-weight: 600; }
.dsp-toast-act:hover { background: var(--line); }
@media (prefers-reduced-motion: reduce) {
  .dsp-pop, .dsp-pop.dsp-in, .dsp-tip, .dsp-tip.dsp-in, .dsp-toast, .dsp-toast.dsp-in { transform: none !important; translate: none !important; transition: opacity 80ms linear !important; }
}
`;

  DSP.cssParts = { TOKENS, TIERS, OVERLAYS };
  DSP.css = TOKENS + TIERS + OVERLAYS;
})();
