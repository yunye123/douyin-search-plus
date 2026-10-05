// 用 Chromium 自带的编码器把截图转成 WebP（文档图片体积约为 PNG 的 1/4，不需要额外安装工具）。
'use strict';
const fs = require('fs');

async function saveWebp(page, file, quality = 0.86) {
  const png = await page.screenshot();
  const ctx = page.context();
  const tmp = await ctx.newPage();
  try {
    const b64 = await tmp.evaluate(async ({ src, q }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', q).split(',')[1];
    }, { src: 'data:image/png;base64,' + png.toString('base64'), q: quality });
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  } finally {
    await tmp.close();
  }
}

module.exports = { saveWebp };
