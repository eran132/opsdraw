/**
 * Embeds and reads text in PNG files (an iTXt chunk, UTF-8), so an exported PNG can carry its
 * Mermaid source and be reopened for editing, like draw.io's editable PNGs.
 */

export const PNG_SOURCE_KEYWORD = 'opsdraw-source';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const isPng = (bytes: Uint8Array) => SIGNATURE.every((b, i) => bytes[i] === b);
const readU32 = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

function writeU32(out: Uint8Array, i: number, v: number) {
  out[i] = (v >>> 24) & 0xff;
  out[i + 1] = (v >>> 16) & 0xff;
  out[i + 2] = (v >>> 8) & 0xff;
  out[i + 3] = v & 0xff;
}

/** Returns a copy of the PNG with an iTXt chunk inserted right after IHDR. */
export function embedPngText(
  png: Uint8Array,
  keyword: string,
  text: string,
): Uint8Array<ArrayBuffer> {
  if (!isPng(png)) throw new Error('Not a PNG file');
  const enc = new TextEncoder();
  // iTXt: keyword \0 compression-flag compression-method language-tag \0 translated-keyword \0 text
  const data = new Uint8Array([...enc.encode(keyword), 0, 0, 0, 0, 0, ...enc.encode(text)]);
  const chunk = new Uint8Array(12 + data.length);
  writeU32(chunk, 0, data.length);
  chunk.set(enc.encode('iTXt'), 4);
  chunk.set(data, 8);
  writeU32(chunk, 8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  const ihdrEnd = 8 + 12 + readU32(png, 8);
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

/** Reads an uncompressed iTXt (or tEXt) chunk with the given keyword. */
export function extractPngText(png: Uint8Array, keyword: string): string | null {
  if (!isPng(png)) return null;
  const dec = new TextDecoder();
  for (let i = 8; i + 12 <= png.length;) {
    const len = readU32(png, i);
    const type = dec.decode(png.subarray(i + 4, i + 8));
    const data = png.subarray(i + 8, i + 8 + len);
    if (type === 'iTXt' || type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul > 0 && dec.decode(data.subarray(0, nul)) === keyword) {
        if (type === 'tEXt') return new TextDecoder('latin1').decode(data.subarray(nul + 1));
        if (data[nul + 1] !== 0) return null; // compressed iTXt is not used by OpsDraw
        let p = nul + 3;
        p = data.indexOf(0, p) + 1; // language tag
        p = data.indexOf(0, p) + 1; // translated keyword
        return dec.decode(data.subarray(p));
      }
    }
    if (type === 'IEND') break;
    i += 12 + len;
  }
  return null;
}
