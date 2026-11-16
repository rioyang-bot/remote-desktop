'use strict';
/** 用程式產生一個圓形 PNG 圖示（不用另外準備圖檔） */
const zlib = require('zlib');

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/**
 * @param {number} size
 * @param {[number, number, number]} rgb
 */
function circlePng(size, rgb) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const ring = d > r * 0.55 && d < r * 0.75; // 中間留一個白色圓環
      const a = Math.max(0, Math.min(1, r - d)) * 255;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = ring ? 255 : rgb[0];
      raw[o + 1] = ring ? 255 : rgb[1];
      raw[o + 2] = ring ? 255 : rgb[2];
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { circlePng };
