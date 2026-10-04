// PNG 完整性校验：签名、每个块的 CRC、IDAT 能完整解压且长度与尺寸吻合。
// v0.3 起 icon16 / icon128 就是坏文件（浏览器显示不出来），打包和生成图标时都跑一遍。
'use strict';
const zlib = require('zlib');

const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function verifyPng(buf, size) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('不是 PNG 文件');
  let i = 8, w = 0, h = 0, bpp = 4;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.slice(i + 4, i + 8);
    const data = buf.slice(i + 8, i + 8 + len);
    if (crc(Buffer.concat([type, data])) !== buf.readUInt32BE(i + 8 + len)) throw new Error('数据块校验失败 ' + type);
    const t = type.toString();
    if (t === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bpp = { 6: 4, 2: 3, 4: 2, 0: 1 }[data[9]] || 4; }
    if (t === 'IDAT') idat.push(data);
    i += 12 + len;
    if (t === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (size && (w !== size || h !== size)) throw new Error(`尺寸 ${w}x${h}，应为 ${size}x${size}`);
  if (raw.length !== h * (1 + w * bpp)) throw new Error('像素数据长度不对');
  return true;
}

module.exports = { verifyPng };
