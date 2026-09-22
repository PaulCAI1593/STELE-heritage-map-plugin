// tools/make-icons.js
// 生成扩展所需的 PNG 图标（Chrome 对扩展图标要求 PNG，SVG 可能导致加载失败）。
// 不依赖任何第三方库，纯 Node（zlib + 手写 PNG 编码器）。
//
// 图形：红色圆角方块 + 白色**地图定位针**，针内是**表盘**——
// 表达"在地图上标注开放时间"。
// （早期版本画的是石碑，用户反馈像墓碑，已弃用。）
//
// 用法: node tools/make-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------- PNG 编码 ----------------
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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA 像素缓冲 → PNG Buffer */
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // 每行前加一个 filter 字节（0 = None）
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 4);
    raw[off] = 0;
    rgba.copy(raw, off + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------- 图形定义（单位正方形 0..1）----------------
const BG = [0xEC, 0x70, 0x63];   // #EC7063 站点文保主色
const FG = [0xFF, 0xFF, 0xFF];

/** 圆角矩形（图标底） */
function inRoundedRect(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  const dx = u - cx, dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 点到线段的距离（画表针用） */
function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const L2 = vx * vx + vy * vy;
  let t = L2 ? (wx * vx + wy * vy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return Math.sqrt(dx * dx + dy * dy);
}

// 定位针：上半是圆头，下半收成尖
const PIN_CX = 0.50, PIN_CY = 0.395, PIN_R = 0.320, PIN_TIP = 0.930;

function inPin(u, v) {
  const dx = u - PIN_CX;
  if (v <= PIN_CY) {
    const dy = v - PIN_CY;
    return dx * dx + dy * dy <= PIN_R * PIN_R;
  }
  const t = (v - PIN_CY) / (PIN_TIP - PIN_CY);
  if (t > 1) return false;
  // 半宽从 PIN_R 平滑收到 0；指数 <1 让针身更饱满，不像细针
  const half = PIN_R * Math.pow(1 - t, 0.62);
  return Math.abs(dx) <= half;
}

// 针内表盘：圆环 + 时针（朝上）+ 分针（朝右），用底色画，形成"挖空"效果。
//
// 尺寸不同、笔画粗细必须不同：同一套参数在 128px 下清楚，缩到 16px 就糊成一团
// （环和针连成一片，读出来像个"@"）。所以小尺寸单独加粗、并放大表盘占比。
function clockCfg(size) {
  if (size <= 16) {
    return { big: true };
  }
  if (size <= 32) {
    return { ringR: 0.208, ringT: 0.070, handT: 0.048, hour: 0.072, minute: 0.112 };
  }
  return { ringR: 0.212, ringT: 0.062, handT: 0.042, hour: 0.074, minute: 0.118 };
}

// 16px 专用：**实心白盘 + 红针**（时钟图标最经典的画法）。
// "定位针 + 针内表盘"在 16px 下只有 10px 的针头可用，两件事塞不下，必然糊成一团；
// 实心盘 + 细针的面积对比最强，缩到这个尺寸仍一眼是钟。
const BIG_CX = 0.5, BIG_CY = 0.5, BIG_R = 0.360, BIG_HT = 0.058;

function inBigDisc(u, v) {
  const dx = u - BIG_CX, dy = v - BIG_CY;
  return dx * dx + dy * dy <= BIG_R * BIG_R;
}

function inBigHands(u, v) {
  if (distToSeg(u, v, BIG_CX, BIG_CY, BIG_CX, BIG_CY - 0.155) <= BIG_HT) return true;  // 时针朝上
  if (distToSeg(u, v, BIG_CX, BIG_CY, BIG_CX + 0.205, BIG_CY) <= BIG_HT) return true;  // 分针朝右
  return false;
}

function inClock(u, v, cfg) {
  const dx = u - PIN_CX, dy = v - PIN_CY;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= cfg.ringR && d >= cfg.ringR - cfg.ringT) return true;   // 表盘外圈
  if (distToSeg(u, v, PIN_CX, PIN_CY, PIN_CX, PIN_CY - cfg.hour) <= cfg.handT) return true;    // 时针
  if (distToSeg(u, v, PIN_CX, PIN_CY, PIN_CX + cfg.minute, PIN_CY) <= cfg.handT) return true;  // 分针
  return false;
}

/** 渲染为 RGBA（SS×SS 超采样抗锯齿） */
function render(size) {
  const SS = 4;
  const CLK = clockCfg(size);
  const n = SS * SS;
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (!inRoundedRect(u, v, 0, 0, 1, 1, 0.22)) continue; // 圆角外透明
          // 16px 只画时钟（白盘红针）；更大的尺寸画"定位针 + 针内表盘"
          const c = CLK.big
            ? ((inBigDisc(u, v) && !inBigHands(u, v)) ? FG : BG)
            : ((inPin(u, v) && !inClock(u, v, CLK)) ? FG : BG);
          const w = 1 / 255;             // 该子样本的 alpha 权重
          sr += c[0] * w; sg += c[1] * w; sb += c[2] * w; sa += w;
        }
      }
      const i = (y * size + x) * 4;
      if (sa === 0) { px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0; continue; }
      // 反预乘：按 alpha 加权平均得到直通色
      px[i]     = Math.round(sr / sa);
      px[i + 1] = Math.round(sg / sa);
      px[i + 2] = Math.round(sb / sa);
      px[i + 3] = Math.round((sa / (n / 255)) * 255);
    }
  }
  return px;
}

// ---------------- 输出 ----------------
const OUT = path.join(__dirname, '..', 'src', 'icons');
const SIZES = [16, 32, 48, 128];

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

for (const size of SIZES) {
  const png = encodePNG(size, size, render(size));
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`  ✅ icon-${size}.png  (${png.length} bytes)`);
}

// ---------------- 自检：回读校验 ----------------
console.log('\n自检（解析刚写出的 PNG）：');
for (const size of SIZES) {
  const buf = fs.readFileSync(path.join(OUT, `icon-${size}.png`));
  const sigOK = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  // 找 IDAT
  let off = 8, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const expect = h * (1 + w * 4);
  const ok = sigOK && w === size && h === size && raw.length === expect;
  console.log(`  ${ok ? '✅' : '❌'} ${size}×${size}  签名=${sigOK}  尺寸=${w}×${h}  解压后=${raw.length}/${expect}`);
}
