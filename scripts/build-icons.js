// 生成扩展图标：按尺寸分别绘制 SVG（小尺寸简化细节保证清晰），用 Chromium 渲染成透明 PNG，
// 然后逐个解码校验（v0.3 起 icon16/icon128 是坏文件，就是因为没有校验）。
// 运行：node scripts/build-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { verifyPng } = require('./png-check');

const OUT = path.resolve(__dirname, '..', 'icons');

// 设计：深色圆角方块 + 三根上升的柱子（排序）+ 最高柱顶上的收藏星（收藏率）；
// 红/青错位是抖音的签名色差。size 越小，圆角越大、色差越弱、细节越少。
function svg(size) {
  const S = 128;
  const small = size <= 16;
  const mid = size <= 32;
  const r = small ? 30 : 28;
  const ab = small ? 0 : mid ? 4 : 3.2; // 色差偏移
  const bars = small
    ? [[22, 70, 22, 36], [53, 52, 22, 54], [84, 34, 22, 72]]
    : [[26, 72, 20, 34], [54, 56, 20, 50], [82, 40, 20, 66]];
  const rx = small ? 6 : 5;
  const rect = (x, y, w, h, fill, op) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${op ? ` opacity="${op}"` : ''}/>`;
  const barsSvg = (dx, fill, op) => bars.map(([x, y, w, h]) => rect(x + dx, y, w, h, fill, op)).join('');
  // 五角星（中心 cx,cy，外径 R）
  const star = (cx, cy, R) => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? R * 0.46 : R;
      pts.push((cx + rr * Math.cos(a)).toFixed(2) + ',' + (cy + rr * Math.sin(a)).toFixed(2));
    }
    return `<polygon points="${pts.join(' ')}" fill="url(#gold)" stroke-linejoin="round"/>`;
  };
  const starSvg = small ? star(95, 17, 15) : star(92, 21, 15);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${S} ${S}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2A2B3A"/><stop offset="1" stop-color="#14151E"/></linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE27A"/><stop offset="1" stop-color="#FFB020"/></linearGradient>
  <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E4E5EE"/></linearGradient>
</defs>
<rect x="4" y="4" width="120" height="120" rx="${r}" fill="url(#bg)"/>
<rect x="4.5" y="4.5" width="119" height="119" rx="${r - 0.5}" fill="none" stroke="#FFFFFF" stroke-opacity="${small ? 0 : 0.08}"/>
${ab ? barsSvg(-ab, '#25F4EE', 0.95) + barsSvg(ab, '#FE2C55', 0.95) : ''}
${barsSvg(0, 'url(#bar)')}
${starSvg}
</svg>`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.svg'), svg(128));
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
    const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    verifyPng(buf, size);
    fs.writeFileSync(path.join(OUT, `icon${size}.png`), buf);
    console.log(`icon${size}.png ✓ ${buf.length} bytes`);
  }
  // 预览图（放大看细节，不进扩展包）
  await page.setViewportSize({ width: 560, height: 160 });
  await page.setContent(`<!doctype html><body style="margin:0;background:#f3f3f5;display:flex;gap:24px;align-items:center;padding:16px">
    ${[16, 32, 48, 128].map((s) => `<div style="text-align:center;font:12px sans-serif;color:#555"><img src="data:image/png;base64,${fs.readFileSync(path.join(OUT, `icon${s}.png`)).toString('base64')}" width="${s}" height="${s}"><br>${s}</div>`).join('')}
    <div style="background:#161722;padding:12px;border-radius:10px;display:flex;gap:12px">${[16, 32].map((s) => `<img src="data:image/png;base64,${fs.readFileSync(path.join(OUT, `icon${s}.png`)).toString('base64')}" width="${s}" height="${s}">`).join('')}</div>
  </body>`);
  const prev = process.argv[2];
  if (prev) await page.screenshot({ path: prev });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

module.exports = { svg };
