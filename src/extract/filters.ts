/**
 * PDF stream filters.
 *
 * Covers the filters that appear in real documents: `FlateDecode` (with PNG and
 * TIFF predictors), `LZWDecode`, `ASCIIHexDecode`, `ASCII85Decode` and
 * `RunLengthDecode`. Image filters (`DCTDecode`, `JPXDecode`, `CCITTFaxDecode`)
 * are left encoded — extraction never needs their pixels, only to know they are
 * there.
 *
 * Ported from `lib/src/extract/filters.dart` in the `bangla_pdf` Dart package.
 * Inflate comes from `fflate`, which is synchronous in both Node and the
 * browser; `DecompressionStream` is not, and a synchronous reader is much
 * simpler to keep correct.
 */

import { inflateSync, unzlibSync } from 'fflate';

import { get, type PdfDictObj, type PdfObj } from './objects.js';

/** Filters whose output is image data, not something to decode here. */
const IMAGE_FILTERS = new Set([
  'DCTDecode',
  'DCT',
  'JPXDecode',
  'CCITTFaxDecode',
  'CCF',
  'JBIG2Decode',
]);

type Resolve = (o: PdfObj) => PdfObj;

/**
 * Decodes [raw] according to the stream dictionary [d].
 *
 * Returns null when the data is an encoded image, and the bytes unchanged when
 * a filter is unrecognised — a partially decoded stream is more useful than
 * none.
 */
export function decodeStream(raw: Uint8Array, d: PdfDictObj, resolve: Resolve): Uint8Array | null {
  const filterObj = resolve(get(d, 'Filter'));
  const parmsObj = resolve(get(d, 'DecodeParms'));

  const filters: string[] = [];
  if (filterObj.kind === 'name') {
    filters.push(filterObj.value);
  } else if (filterObj.kind === 'array') {
    for (const f of filterObj.values) {
      const r = resolve(f);
      if (r.kind === 'name') filters.push(r.value);
    }
  }

  const parms: (PdfDictObj | null)[] = [];
  if (parmsObj.kind === 'dict') {
    parms.push(parmsObj);
  } else if (parmsObj.kind === 'array') {
    for (const p of parmsObj.values) {
      const r = resolve(p);
      parms.push(r.kind === 'dict' ? r : null);
    }
  }

  let data = raw;
  for (let i = 0; i < filters.length; i++) {
    const filterName = filters[i]!;
    if (IMAGE_FILTERS.has(filterName)) return null;
    const parm = parms[i] ?? null;
    switch (filterName) {
      case 'FlateDecode':
      case 'Fl':
        data = applyPredictor(inflate(data), parm, resolve);
        break;
      case 'LZWDecode':
      case 'LZW':
        data = applyPredictor(lzwDecode(data, earlyChange(parm, resolve)), parm, resolve);
        break;
      case 'ASCIIHexDecode':
      case 'AHx':
        data = asciiHexDecode(data);
        break;
      case 'ASCII85Decode':
      case 'A85':
        data = ascii85Decode(data);
        break;
      case 'RunLengthDecode':
      case 'RL':
        data = runLengthDecode(data);
        break;
      default:
        // Crypt, or something we do not know: leave it as it is.
        break;
    }
  }
  return data;
}

function earlyChange(parm: PdfDictObj | null, resolve: Resolve): number {
  if (parm === null) return 1;
  const v = resolve(get(parm, 'EarlyChange'));
  return v.kind === 'num' ? Math.trunc(v.value) : 1;
}

function inflate(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;
  try {
    return unzlibSync(data);
  } catch {
    // Some writers emit raw deflate, or a stream with trailing junk. Retry
    // without the zlib header before giving up.
    try {
      return inflateSync(data);
    } catch {
      if (data.length > 2) {
        try {
          return inflateSync(data.subarray(2));
        } catch {
          // fall through
        }
      }
      return new Uint8Array(0);
    }
  }
}

/** Undoes PNG (predictor >= 10) or TIFF (predictor 2) prediction. */
function applyPredictor(
  data: Uint8Array,
  parm: PdfDictObj | null,
  resolve: Resolve,
): Uint8Array {
  if (parm === null || data.length === 0) return data;
  const intOf = (key: string, fallback: number): number => {
    const v = resolve(get(parm, key));
    return v.kind === 'num' ? Math.trunc(v.value) : fallback;
  };

  const predictor = intOf('Predictor', 1);
  if (predictor <= 1) return data;

  const colors = intOf('Colors', 1);
  const bpc = intOf('BitsPerComponent', 8);
  const columns = intOf('Columns', 1);
  const bpp = Math.min(64, Math.max(1, Math.ceil((colors * bpc) / 8)));
  const rowLength = Math.ceil((columns * colors * bpc) / 8);
  if (rowLength <= 0) return data;

  if (predictor === 2) {
    if (bpc !== 8) return data;
    const out = data.slice();
    for (let r = 0; r + rowLength <= out.length; r += rowLength) {
      for (let i = bpp; i < rowLength; i++) {
        out[r + i] = (out[r + i]! + out[r + i - bpp]!) & 0xff;
      }
    }
    return out;
  }

  // PNG predictors: each row is prefixed with a filter-type byte.
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  let previous = new Uint8Array(rowLength);
  let src = 0;
  let dst = 0;
  for (let r = 0; r < rows; r++) {
    const type = data[src++]!;
    const row = new Uint8Array(rowLength);
    for (let i = 0; i < rowLength; i++) row[i] = src < data.length ? data[src++]! : 0;
    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? row[i - bpp]! : 0;
      const up = previous[i]!;
      const upLeft = i >= bpp ? previous[i - bpp]! : 0;
      switch (type) {
        case 1:
          row[i] = (row[i]! + left) & 0xff;
          break;
        case 2:
          row[i] = (row[i]! + up) & 0xff;
          break;
        case 3:
          row[i] = (row[i]! + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          row[i] = (row[i]! + pred) & 0xff;
          break;
        }
        default:
          break; // type 0: none
      }
    }
    out.set(row, dst);
    previous = row;
    dst += rowLength;
  }
  return out;
}

function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let high = -1;
  for (const c of data) {
    if (c === 0x3e) break; // '>'
    let v: number;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) v = c - 0x41 + 10;
    else if (c >= 0x61 && c <= 0x66) v = c - 0x61 + 10;
    else continue;
    if (high < 0) {
      high = v;
    } else {
      out.push(high * 16 + v);
      high = -1;
    }
  }
  if (high >= 0) out.push(high * 16);
  return Uint8Array.from(out);
}

function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  const group: number[] = [];
  let i = 0;
  // An optional <~ introduces the data.
  if (data.length >= 2 && data[0] === 0x3c && data[1] === 0x7e) i = 2;
  for (; i < data.length; i++) {
    const c = data[i]!;
    if (c === 0x7e) break; // ~>
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 0x21);
    if (group.length === 5) {
      let value = 0;
      for (const g of group) value = value * 85 + g;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      group.length = 0;
    }
  }
  if (group.length > 0) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let value = 0;
    for (const g of group) value = value * 85 + g;
    const bytes = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const n = data[i++]!;
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]!);
    } else {
      if (i >= data.length) break;
      const b = data[i++]!;
      for (let k = 0; k < 257 - n; k++) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

function lzwDecode(data: Uint8Array, early: number): Uint8Array {
  const out: number[] = [];
  let table: number[][] = [];
  const resetTable = () => {
    table = [];
    for (let i = 0; i < 256; i++) table.push([i]);
    table.push([], []);
  };

  resetTable();
  let codeWidth = 9;
  let bitBuffer = 0;
  let bitCount = 0;
  let previous: number[] | null = null;

  for (const byte of data) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= codeWidth) {
      const code = (bitBuffer >>> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);
      bitCount -= codeWidth;

      if (code === 256) {
        resetTable();
        codeWidth = 9;
        previous = null;
        continue;
      }
      if (code === 257) return Uint8Array.from(out);

      let entry: number[];
      if (code < table.length) {
        entry = table[code]!;
      } else if (previous !== null) {
        entry = [...previous, previous[0]!];
      } else {
        return Uint8Array.from(out);
      }
      out.push(...entry);
      if (previous !== null) table.push([...previous, entry[0]!]);
      previous = entry;

      const limit = table.length + early;
      if (limit >= 512 && codeWidth === 9) codeWidth = 10;
      else if (limit >= 1024 && codeWidth === 10) codeWidth = 11;
      else if (limit >= 2048 && codeWidth === 11) codeWidth = 12;
    }
  }
  return Uint8Array.from(out);
}
