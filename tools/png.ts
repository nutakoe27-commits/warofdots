/**
 * A minimal PNG codec so terrain masks can be written and read outside a browser.
 * `node:zlib` does the compression; everything else here is chunk plumbing.
 *
 * The decoder is deliberately strict. A terrain mask that decodes *almost* right —
 * a palette PNG read as truecolour, a 16-bit file truncated to 8 — produces a map
 * that plays subtly wrong, and that is far more expensive to find than a crash at
 * load time. So anything outside "8-bit RGB or RGBA, non-interlaced" throws, and
 * every chunk's CRC is checked.
 *
 * Scanlines are written with filter 0 (None): deflate already collapses the long
 * runs of identical pixels a terrain mask is made of, and an encoder nobody has to
 * second-guess is worth more here than a few hundred bytes. Decoding handles all
 * five filter types, because real image editors do use them.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_RGB = 2;
const COLOR_RGBA = 6;
const BIT_DEPTH = 8;
/** Max level: exports are re-run often and byte-identical output makes them idempotent. */
const DEFLATE_LEVEL = 9;
const CHUNK_OVERHEAD = 12;
const IHDR_LENGTH = 13;

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Int32Array {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + CHUNK_OVERHEAD);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// ────────────────────────────────────────────────────────────────── encode ──

/** Encodes 8-bit RGBA pixel data (`width * height * 4` bytes) into a PNG file. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`PNG encode: bad size ${width}×${height}`);
  }
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`PNG encode: expected ${expected} bytes for ${width}×${height}, got ${rgba.length}`);
  }

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(IHDR_LENGTH);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = BIT_DEPTH;
  ihdr[9] = COLOR_RGBA;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // non-interlaced

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: DEFLATE_LEVEL })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ────────────────────────────────────────────────────────────────── decode ──

interface Header {
  width: number;
  height: number;
  colorType: number;
}

function readHeader(data: Buffer): Header {
  if (data.length !== IHDR_LENGTH) throw new Error(`PNG: IHDR is ${data.length} bytes, expected 13`);
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const depth = data[8]!;
  const colorType = data[9]!;
  const compression = data[10]!;
  const filterMethod = data[11]!;
  const interlace = data[12]!;

  if (width < 1 || height < 1) throw new Error(`PNG: bad size ${width}×${height}`);
  if (depth !== BIT_DEPTH) {
    throw new Error(`PNG: ${depth}-bit samples are not supported — re-save as 8 bits per channel`);
  }
  if (colorType !== COLOR_RGB && colorType !== COLOR_RGBA) {
    throw new Error(
      `PNG: colour type ${colorType} is not supported (only 2 = RGB and 6 = RGBA) — ` +
        're-save as 8-bit RGB or RGBA truecolour, not palette or greyscale',
    );
  }
  if (compression !== 0) throw new Error(`PNG: unknown compression method ${compression}`);
  if (filterMethod !== 0) throw new Error(`PNG: unknown filter method ${filterMethod}`);
  if (interlace !== 0) throw new Error('PNG: interlaced files are not supported — save without Adam7');
  return { width, height, colorType };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverses per-scanline filtering into a tightly packed pixel buffer. */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const need = (stride + 1) * height;
  if (raw.length < need) {
    throw new Error(`PNG: image data is ${raw.length} bytes, expected ${need}`);
  }
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    let src = y * (stride + 1);
    const filter = raw[src++]!;
    if (filter > 4) throw new Error(`PNG: unknown filter type ${filter} on scanline ${y}`);
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[row + i - bpp]! : 0;
      const b = y > 0 ? out[prev + i]! : 0;
      let add = 0;
      switch (filter) {
        case 1:
          add = a;
          break;
        case 2:
          add = b;
          break;
        case 3:
          add = (a + b) >> 1;
          break;
        case 4:
          add = paeth(a, b, i >= bpp && y > 0 ? out[prev + i - bpp]! : 0);
          break;
        default:
          add = 0;
      }
      out[row + i] = (raw[src + i]! + add) & 0xff;
    }
  }
  return out;
}

/** Walks the chunk stream, checking every CRC and gathering the image data. */
function readChunks(buf: Buffer): { header: Header; idat: Buffer } {
  const parts: Buffer[] = [];
  let header: Header | null = null;
  let pos = SIGNATURE.length;
  let sawEnd = false;
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    // A corrupt file can put arbitrary bytes here, and those bytes end up in an
    // error message on somebody's terminal.
    const type = buf.toString('ascii', pos + 4, pos + 8).replace(/[^ -~]/g, '?');
    const dataStart = pos + 8;
    const end = dataStart + length + 4;
    if (end > buf.length) throw new Error(`PNG: chunk "${type}" runs past the end of the file`);
    const data = buf.subarray(dataStart, dataStart + length);
    const stored = buf.readUInt32BE(dataStart + length);
    if (crc32(buf.subarray(pos + 4, dataStart + length)) !== stored) {
      throw new Error(`PNG: CRC mismatch in chunk "${type}" — the file is corrupt`);
    }
    if (type === 'IHDR') header = readHeader(data);
    else if (type === 'IDAT') parts.push(Buffer.from(data));
    else if (type === 'IEND') sawEnd = true;
    pos = end;
    if (sawEnd) break;
  }
  if (!header) throw new Error('PNG: no IHDR chunk');
  if (parts.length === 0) throw new Error('PNG: no image data (IDAT)');
  return { header, idat: parts.length === 1 ? parts[0]! : Buffer.concat(parts) };
}

/** Decodes an 8-bit RGB or RGBA PNG. Output is always 4 bytes per pixel. */
export function decodePng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } {
  if (buf.length < SIGNATURE.length || !buf.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new Error('PNG: bad signature — this is not a PNG file');
  }
  const { header, idat } = readChunks(buf);
  const { width, height, colorType } = header;
  const bpp = colorType === COLOR_RGBA ? 4 : 3;
  const pixels = unfilter(inflateSync(idat), width, height, bpp);

  if (bpp === 4) return { width, height, rgba: new Uint8Array(pixels) };

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    rgba[i * 4] = pixels[i * 3]!;
    rgba[i * 4 + 1] = pixels[i * 3 + 1]!;
    rgba[i * 4 + 2] = pixels[i * 3 + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}
