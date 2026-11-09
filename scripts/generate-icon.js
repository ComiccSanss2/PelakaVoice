const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Generate 256x256 PNG with PelakaVoice logo
const width = 256;
const height = 256;

// Create raw RGBA buffer
// Each row starts with a filter byte (0 = None) followed by 256 * 4 bytes
const rowLength = 1 + width * 4;
const rawBuffer = Buffer.alloc(rowLength * height);

const cx = width / 2;
const cy = height / 2;
const radius = 110;

for (let y = 0; y < height; y++) {
  const rowStart = y * rowLength;
  rawBuffer[rowStart] = 0; // Filter byte: 0

  for (let x = 0; x < width; x++) {
    const pixelIndex = rowStart + 1 + x * 4;
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist <= radius) {
      // Rounded icon background with smooth dark blurple gradient
      const grad = y / height;
      let r = Math.floor(88 + 30 * grad);
      let g = Math.floor(101 + 20 * grad);
      let b = Math.floor(242 - 30 * grad);
      let a = 255;

      // Anti-aliasing at outer edge
      if (dist > radius - 2) {
        a = Math.floor(255 * (radius - dist) / 2);
      }

      // Draw stylized microphone & voice wave in white/cyan
      // Central pill (mic body)
      const micW = 20;
      const micH = 45;
      const micY = cy - 10;
      if (Math.abs(dx) <= micW && y >= micY - micH && y <= micY + micH) {
        // Rounded caps
        const capTopDist = Math.sqrt(dx * dx + Math.pow(y - (micY - micH + micW), 2));
        const capBotDist = Math.sqrt(dx * dx + Math.pow(y - (micY + micH - micW), 2));
        if ((y < micY - micH + micW && capTopDist <= micW) ||
            (y > micY + micH - micW && capBotDist <= micW) ||
            (y >= micY - micH + micW && y <= micY + micH - micW)) {
          r = 255; g = 255; b = 255;
        }
      }

      // Mic cradle / arc
      const arcRadius = 40;
      const arcDist = Math.sqrt(dx * dx + Math.pow(y - micY, 2));
      if (arcDist >= arcRadius - 4 && arcDist <= arcRadius + 4 && y >= micY - 5 && y <= micY + arcRadius + 2) {
        r = 255; g = 255; b = 255;
      }

      // Mic stand
      if (Math.abs(dx) <= 4 && y >= micY + arcRadius && y <= micY + arcRadius + 30) {
        r = 255; g = 255; b = 255;
      }
      if (Math.abs(dx) <= 28 && y >= micY + arcRadius + 26 && y <= micY + arcRadius + 32) {
        r = 255; g = 255; b = 255;
      }

      // Sound waves (left and right)
      const waveDist = Math.sqrt(dx * dx + Math.pow(y - micY, 2));
      if (waveDist >= 60 && waveDist <= 66 && Math.abs(dx) > 35 && y >= micY - 40 && y <= micY + 40) {
        r = 87; g = 242; b = 135; // Neon green voice wave
      }
      if (waveDist >= 80 && waveDist <= 86 && Math.abs(dx) > 55 && y >= micY - 50 && y <= micY + 50) {
        r = 87; g = 242; b = 135;
      }

      rawBuffer[pixelIndex] = r;
      rawBuffer[pixelIndex + 1] = g;
      rawBuffer[pixelIndex + 2] = b;
      rawBuffer[pixelIndex + 3] = a;
    } else {
      // Transparent outside
      rawBuffer[pixelIndex] = 0;
      rawBuffer[pixelIndex + 1] = 0;
      rawBuffer[pixelIndex + 2] = 0;
      rawBuffer[pixelIndex + 3] = 0;
    }
  }
}

// Compress IDAT
const compressedIDAT = zlib.deflateSync(rawBuffer);

// Helper for PNG chunks
function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);

  const crc = crc32(body);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);

  return Buffer.concat([length, body, crcBuf]);
}

// Standard CRC32 table
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1);
    else c = c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

// PNG Header
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; // 8 bit depth
ihdr[9] = 6; // RGBA color type
ihdr[10] = 0; // Deflate compression
ihdr[11] = 0; // Filter method
ihdr[12] = 0; // Interlace none

const ihdrChunk = createChunk('IHDR', ihdr);
const idatChunk = createChunk('IDAT', compressedIDAT);
const iendChunk = createChunk('IEND', Buffer.alloc(0));

const pngFile = Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);

const assetsDir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

fs.writeFileSync(path.join(assetsDir, 'icon.png'), pngFile);
console.log('Generated assets/icon.png successfully! Size:', pngFile.length, 'bytes');
