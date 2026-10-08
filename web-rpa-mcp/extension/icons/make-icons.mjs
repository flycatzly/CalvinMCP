#!/usr/bin/env node
// 生成扩展图标 icon16/32/48/128.png（纯 Node，无依赖：手写 PNG 编码 + 2x2 超采样抗锯齿）。
// 用法：node extension/icons/make-icons.mjs
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
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
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 绘制：圆角渐变底 + 白色播放三角 ---------------- */

const SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
if (SIG[0] !== 0x89) throw new Error('unreachable');

function renderIcon(S) {
  const px = Buffer.alloc(S * S * 4);
  const r = S * 0.24;
  const A = [0.40 * S, 0.28 * S], B = [0.40 * S, 0.72 * S], C = [0.72 * S, 0.50 * S];
  const c1 = [0x63, 0x66, 0xF1], c2 = [0x7C, 0x3A, 0xED];
  const inCorner = (x, y) => {
    if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r;
    if (x >= S - r && y < r) return (x - (S - r)) ** 2 + (y - r) ** 2 <= r * r;
    if (x < r && y >= S - r) return (x - r) ** 2 + (y - (S - r)) ** 2 <= r * r;
    if (x >= S - r && y >= S - r) return (x - (S - r)) ** 2 + (y - (S - r)) ** 2 <= r * r;
    return true;
  };
  const inTri = (x, y) => {
    const s1 = (B[0] - A[0]) * (y - A[1]) - (B[1] - A[1]) * (x - A[0]);
    const s2 = (C[0] - B[0]) * (y - B[1]) - (C[1] - B[1]) * (x - B[0]);
    const s3 = (A[0] - C[0]) * (y - C[1]) - (A[1] - C[1]) * (x - C[0]);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
  const N = 2; // 2x2 超采样
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let bg = 0, tri = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const cx = x + (sx + 0.5) / N, cy = y + (sy + 0.5) / N;
          if (cx < 0 || cy < 0 || cx >= S || cy >= S || !inCorner(cx, cy)) continue;
          bg++;
          if (inTri(cx, cy)) tri++;
        }
      }
      const o = (y * S + x) * 4;
      if (bg === 0) { px[o] = 0; px[o + 1] = 0; px[o + 2] = 0; px[o + 3] = 0; continue; }
      const t = (x + y) / (2 * S);
      const bgc = [0, 1, 2].map((i) => Math.round(c1[i] + (c2[i] - c1[i]) * t));
      const triRatio = tri / bg;
      px[o] = Math.round(bgc[0] + (255 - bgc[0]) * triRatio);
      px[o + 1] = Math.round(bgc[1] + (255 - bgc[1]) * triRatio);
      px[o + 2] = Math.round(bgc[2] + (255 - bgc[2]) * triRatio);
      px[o + 3] = Math.round(255 * (bg / (N * N)));
    }
  }
  return encodePng(S, S, px);
}

/* ---------------- 输出 + 自检 ---------------- */

for (const size of [16, 32, 48, 128]) {
  const png = renderIcon(size);
  const file = path.join(here, 'icon' + size + '.png');
  fs.writeFileSync(file, png);
  // 自检：签名 + IHDR 尺寸 + IDAT 解压后长度 = 每行(1+4S)×S
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    throw new Error('PNG 签名不对');
  }
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  if (w !== size || h !== size) throw new Error('IHDR 尺寸不对');
  const idatStart = png.indexOf('IDAT', 0, 'ascii');
  const idatLen = png.readUInt32BE(idatStart - 4);
  const raw = zlib.inflateSync(png.subarray(idatStart + 4, idatStart + 4 + idatLen));
  if (raw.length !== (size * 4 + 1) * size) throw new Error('IDAT 解压长度不对');
  console.log('ok  icon' + size + '.png  ' + png.length + ' bytes');
}
