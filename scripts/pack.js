// 打包发布用的 zip（Chrome 应用商店 / Edge 加载项商店 / GitHub Release 通用）。
// 运行：npm run pack   → dist/douyin-search-plus-<版本>.zip
//
// 打包前检查：
//   · manifest.json、package.json、README.md 三处版本号一致
//   · manifest 引用的每个文件都存在；图标 PNG 能完整解码（v0.3 起有两个图标是坏文件）
//   · 只打包运行需要的文件（manifest、icons/*.png、src/、LICENSE），不带测试和开发依赖
// zip 用 Node 自己写（zlib 压缩），保证条目路径是正斜杠（PowerShell 5.1 的 Compress-Archive 会写成反斜杠，商店会拒收）。
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { verifyPng } = require('./png-check');

const ROOT = path.resolve(__dirname, '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1); };

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const v = manifest.version;
if (pkg.version !== v) fail(`package.json 版本 ${pkg.version} 与 manifest ${v} 不一致`);
if (!readme.includes(v)) fail(`README.md 里没有写当前版本 ${v}`);

// manifest 引用的文件
const referenced = new Set();
for (const p of Object.values(manifest.icons || {})) referenced.add(p);
if (manifest.action && manifest.action.default_popup) referenced.add(manifest.action.default_popup);
if (manifest.action && manifest.action.default_icon) for (const p of Object.values(manifest.action.default_icon)) referenced.add(p);
for (const cs of manifest.content_scripts || []) for (const p of [...(cs.js || []), ...(cs.css || [])]) referenced.add(p);
if (manifest.background && manifest.background.service_worker) referenced.add(manifest.background.service_worker);
for (const p of referenced) if (!fs.existsSync(path.join(ROOT, p))) fail('manifest 引用的文件不存在：' + p);
for (const [size, p] of Object.entries(manifest.icons || {})) {
  try { verifyPng(fs.readFileSync(path.join(ROOT, p)), Number(size)); } catch (e) { fail(`图标 ${p} 损坏：${e.message}`); }
}

// 收集文件
const files = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full);
    else files.push(full);
  }
};
files.push(path.join(ROOT, 'manifest.json'), path.join(ROOT, 'LICENSE'));
for (const f of fs.readdirSync(path.join(ROOT, 'icons')).sort()) if (f.endsWith('.png')) files.push(path.join(ROOT, 'icons', f));
walk(path.join(ROOT, 'src'));

// ---- 最小 zip 写入器（deflate） ----
const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 固定时间戳，同样的源码打出同样的包
const locals = [], centrals = [];
let offset = 0;
for (const f of files) {
  const name = Buffer.from(rel(f), 'utf8');
  const data = fs.readFileSync(f);
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  locals.push(lh, name, comp);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
  ch.writeUInt32LE(offset, 42);
  centrals.push(ch, name);
  offset += lh.length + name.length + comp.length;
}
const cd = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
const out = path.join(ROOT, 'dist', `douyin-search-plus-${v}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([...locals, cd, end]));
console.log(`✓ ${rel(out)}  ${files.length} 个文件  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
for (const f of files) console.log('  ' + rel(f));
