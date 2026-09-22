// tools/build-package.js
// 把 src/ 打包到「release/」目录，供实机（Chrome/Edge 加载已解压扩展）测试。
//
// 产物：
//   release/heritage-map-plugin/                ← 在 chrome://extensions 选这个目录
//   release/heritage-map-plugin-v<版本>.zip     ← 备份/分发（manifest.json 在 zip 根）
//   release/使用说明.md
//
// 不依赖第三方库：ZIP 由内置 zlib 手写生成（唯一可用的 tar 不能产出 zip）。
//
// 用法: node tools/build-package.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'release');
const EXT_NAME = 'heritage-map-plugin';

// ---------------- CRC32 ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------------- 最小 ZIP 写入器 ----------------
function buildZip(entries) {
  // entries: [{ name, data: Buffer }]
  const locals = [];
  const centrals = [];
  let offset = 0;

  // 固定 DOS 时间戳（1980-01-01 00:00），保证可复现
  const dosTime = 0, dosDate = 0x0021;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'ascii');
    const crc = crc32(e.data);
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);              // version needed
    lh.writeUInt16LE(0, 6);               // flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);              // version made by
    ch.writeUInt16LE(20, 6);              // version needed
    ch.writeUInt16LE(0, 8);               // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);              // extra len
    ch.writeUInt16LE(0, 32);              // comment len
    ch.writeUInt16LE(0, 34);              // disk start
    ch.writeUInt16LE(0, 36);              // internal attrs
    ch.writeUInt32LE(0, 38);              // external attrs
    ch.writeUInt32LE(offset, 42);         // local header offset
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBuf, eocd]);
}

/** 递归收集目录下所有文件 */
function walk(dir, base = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ name: rel, full });
  }
  return out;
}

// ---------------- 主流程 ----------------
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const version = manifest.version;

console.log('打包 heritage-map-plugin v' + version);
console.log('源目录: ' + SRC);
console.log('输出:   ' + OUT + '\n');

// 1) 清理并重建输出目录
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 2) 复制 src → release/heritage-map-plugin
const extDir = path.join(OUT, EXT_NAME);
fs.mkdirSync(extDir, { recursive: true });
const files = walk(SRC);
for (const f of files) {
  const dest = path.join(extDir, f.name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(f.full, dest);
}
console.log(`① 已复制 ${files.length} 个文件 → release/${EXT_NAME}/`);

// 3) 校验 manifest 引用完整性
const missing = [];
for (const p of Object.values(manifest.icons || {})) {
  if (!fs.existsSync(path.join(extDir, p))) missing.push('icons: ' + p);
}
for (const p of Object.values((manifest.action && manifest.action.default_icon) || {})) {
  if (!fs.existsSync(path.join(extDir, p))) missing.push('action icon: ' + p);
}
if (manifest.action && manifest.action.default_popup &&
    !fs.existsSync(path.join(extDir, manifest.action.default_popup))) {
  missing.push('popup: ' + manifest.action.default_popup);
}
if (manifest.background && manifest.background.service_worker &&
    !fs.existsSync(path.join(extDir, manifest.background.service_worker))) {
  missing.push('service_worker: ' + manifest.background.service_worker);
}
for (const cs of manifest.content_scripts || []) {
  for (const p of cs.js || []) if (!fs.existsSync(path.join(extDir, p))) missing.push('js: ' + p);
  for (const p of cs.css || []) if (!fs.existsSync(path.join(extDir, p))) missing.push('css: ' + p);
}
if (missing.length) {
  console.log('② ❌ manifest 引用了缺失文件:\n   ' + missing.join('\n   '));
  process.exit(1);
}
console.log('② ✅ manifest 引用完整');

// 4) 生成 zip（manifest.json 在压缩包根目录，符合 Chrome 规范）
const zipEntries = files.map(f => ({
  name: f.name,
  data: fs.readFileSync(f.full),
}));
const zipBuf = buildZip(zipEntries);
const zipName = `${EXT_NAME}-v${version}.zip`;
const zipPath = path.join(OUT, zipName);
fs.writeFileSync(zipPath, zipBuf);
console.log(`③ ✅ 已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(1)} KB，${zipEntries.length} 个条目）`);

// 4b) 放入实机测试说明（源文件在 docs/，避免重建时丢失）
const readmeSrc = path.join(ROOT, 'docs', '实机测试说明.md');
if (fs.existsSync(readmeSrc)) {
  fs.copyFileSync(readmeSrc, path.join(OUT, '使用说明.md'));
  console.log('   ✅ 已放入 使用说明.md');
}

// 5) 回读校验 zip（解析中央目录）
{
  const buf = fs.readFileSync(zipPath);
  const eocdOff = buf.length - 22;
  const okSig = buf.readUInt32LE(eocdOff) === 0x06054b50;
  const count = buf.readUInt16LE(eocdOff + 10);
  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const cdOff = buf.readUInt32LE(eocdOff + 16);
  const cdSigOK = buf.readUInt32LE(cdOff) === 0x02014b50;

  // 逐条解压首项，确认 deflate 数据可读
  let checked = 0, firstNames = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    const nlen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('ascii');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const loff = buf.readUInt32LE(p + 42);
    const lnlen = buf.readUInt16LE(loff + 26);
    const dataOff = loff + 30 + lnlen;
    const body = buf.slice(dataOff, dataOff + csize);
    const raw = method === 8 ? zlib.inflateRawSync(body) : body;
    if (raw.length !== usize) throw new Error('解压长度不符: ' + name);
    if (i < 5) firstNames.push(name);
    checked++;
    p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  const totalOK = Math.abs((cdOff + cdSize) - eocdOff) < 1;
  const ok = okSig && cdSigOK && count === zipEntries.length && totalOK && checked === count;
  console.log(`④ ${ok ? '✅' : '❌'} zip 自检：条目 ${checked}/${count}，中央目录偏移正确=${totalOK}`);
  console.log('   前几个条目: ' + firstNames.join(', '));
  if (!ok) process.exit(1);
}

// 6) 统计
let bytes = 0;
for (const f of files) bytes += fs.statSync(f.full).size;
console.log(`\n扩展目录体积: ${(bytes / 1024).toFixed(1)} KB`);
console.log('\n✅ 打包完成。在 chrome://extensions 选择目录：');
console.log('   ' + extDir);
