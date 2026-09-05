/**
 * Cuts a TrueType font down to the glyphs a document actually draws.
 *
 * A Bengali font is mostly outlines and a document uses a few dozen of them.
 * The layout tables are pure waste in a PDF as well: shaping has already been
 * applied, so `GSUB`, `GPOS` and `GDEF` are never consulted by a reader.
 *
 * Glyph ids are **preserved**. Blanking unused outlines rather than renumbering
 * keeps `/CIDToGIDMap`, the `/W` array and `/ToUnicode` exactly as they were,
 * and costs only the `loca` entries for glyphs that are now empty.
 *
 * Ported from `lib/src/pdf/font_subset.dart` in the `bangla_pdf` Dart package.
 */

/** Tables a reader never consults for an already-shaped Identity-H CID font. */
const DROP = new Set([
  'GSUB',
  'GPOS',
  'GDEF', // shaping, already applied
  'hdmx',
  'VDMX',
  'LTSH',
  'gasp', // screen-rendering hints
  'DSIG', // signature, invalid the moment we edit anything
  'kern', // superseded by GPOS, and we position glyphs ourselves
]);

interface Table {
  offset: number;
  length: number;
}

/**
 * Returns [source] with only [usedGids] (and anything they reference) kept.
 *
 * Returns null when the font cannot be subset safely — a CFF outline font, a
 * malformed table directory, a missing `glyf` — in which case the caller should
 * embed the original.
 */
export function subsetTrueType(source: Uint8Array, usedGids: Iterable<number>): Uint8Array | null {
  const d = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const tables = readDirectory(d, source.byteLength);
  if (tables === null) return null;

  const head = tables.get('head');
  const maxp = tables.get('maxp');
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  if (!head || !maxp || !loca || !glyf) return null;
  if (head.length < 54 || maxp.length < 6) return null;

  const numGlyphs = d.getUint16(maxp.offset + 4);
  if (numGlyphs === 0) return null;

  const longLoca = d.getInt16(head.offset + 50) !== 0;
  const offsets = readLoca(d, loca, numGlyphs, longLoca);
  if (offsets === null) return null;

  // A composite glyph draws other glyphs, which must survive with it.
  const keep = new Set<number>([0]); // .notdef is always glyph 0
  const pending: number[] = [0];
  for (const g of usedGids) if (g >= 0 && g < numGlyphs) pending.push(g);
  while (pending.length > 0) {
    const gid = pending.pop()!;
    if (keep.has(gid)) continue;
    keep.add(gid);
    for (const component of components(d, glyf, offsets, gid)) {
      if (component >= 0 && component < numGlyphs && !keep.has(component)) {
        pending.push(component);
      }
    }
  }

  // Rebuild glyf and loca, keeping every glyph id.
  const chunks: Uint8Array[] = [];
  let glyfLength = 0;
  const newOffsets = new Uint32Array(numGlyphs + 1);
  for (let gid = 0; gid < numGlyphs; gid++) {
    newOffsets[gid] = glyfLength;
    if (!keep.has(gid)) continue;
    const start = offsets[gid]!;
    const end = offsets[gid + 1]!;
    if (end <= start) continue; // already an empty glyph
    if (glyf.offset + end > source.byteLength) return null;
    const slice = source.subarray(glyf.offset + start, glyf.offset + end);
    chunks.push(slice);
    glyfLength += slice.length;
    // Glyph data is 4-byte aligned; short loca cannot express odd offsets.
    const pad = (4 - (glyfLength % 4)) % 4;
    if (pad > 0) {
      chunks.push(new Uint8Array(pad));
      glyfLength += pad;
    }
  }
  newOffsets[numGlyphs] = glyfLength;

  const glyfBytes = concat(chunks, glyfLength);
  // Short loca stores offsets halved, so it cannot address past 128 KB.
  const useLong = longLoca || glyfBytes.length > 0x1ffff;
  const locaBytes = writeLoca(newOffsets, useLong);

  const out = new Map<string, Uint8Array>();
  for (const [tag, table] of tables) {
    if (DROP.has(tag)) continue;
    out.set(tag, source.slice(table.offset, table.offset + table.length));
  }
  out.set('glyf', glyfBytes);
  out.set('loca', locaBytes);

  // `post` version 2 carries a glyph-name table a PDF reader never reads.
  // Version 3 declares "no names" in 32 bytes.
  const post = out.get('post');
  if (post && post.length > 32) {
    const v3 = post.slice(0, 32);
    new DataView(v3.buffer, v3.byteOffset, 32).setUint32(0, 0x00030000);
    out.set('post', v3);
  }

  // head records which loca format we just wrote.
  const headBytes = out.get('head')!.slice();
  new DataView(headBytes.buffer, headBytes.byteOffset, headBytes.byteLength).setInt16(
    50,
    useLong ? 1 : 0,
  );
  out.set('head', headBytes);

  return assemble(out);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function readDirectory(d: DataView, byteLength: number): Map<string, Table> | null {
  if (byteLength < 12) return null;
  const version = d.getUint32(0);
  // 0x00010000 is TrueType outlines; 'true' is the old Apple tag. 'OTTO' is
  // CFF, whose outlines live in a table this cannot rebuild.
  if (version !== 0x00010000 && version !== 0x74727565) return null;

  const count = d.getUint16(4);
  if (12 + count * 16 > byteLength) return null;
  const out = new Map<string, Table>();
  for (let i = 0; i < count; i++) {
    const row = 12 + i * 16;
    let tag = '';
    for (let k = 0; k < 4; k++) tag += String.fromCharCode(d.getUint8(row + k));
    const offset = d.getUint32(row + 8);
    const length = d.getUint32(row + 12);
    if (offset + length > byteLength) return null;
    out.set(tag, { offset, length });
  }
  return out;
}

function readLoca(d: DataView, loca: Table, numGlyphs: number, longLoca: boolean): number[] | null {
  const need = (numGlyphs + 1) * (longLoca ? 4 : 2);
  if (loca.length < need) return null;
  const out = new Array<number>(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i++) {
    out[i] = longLoca ? d.getUint32(loca.offset + i * 4) : d.getUint16(loca.offset + i * 2) * 2;
  }
  return out;
}

function writeLoca(offsets: Uint32Array, long: boolean): Uint8Array {
  const out = new Uint8Array(offsets.length * (long ? 4 : 2));
  const view = new DataView(out.buffer);
  for (let i = 0; i < offsets.length; i++) {
    if (long) view.setUint32(i * 4, offsets[i]!);
    else view.setUint16(i * 2, offsets[i]! / 2);
  }
  return out;
}

/** Glyph ids a composite glyph draws; empty for a simple one. */
function components(d: DataView, glyf: Table, offsets: number[], gid: number): number[] {
  const out: number[] = [];
  if (gid + 1 >= offsets.length) return out;
  const start = glyf.offset + offsets[gid]!;
  if (offsets[gid + 1]! <= offsets[gid]!) return out;
  if (start + 10 > d.byteLength) return out;
  if (d.getInt16(start) >= 0) return out; // simple glyph

  let at = start + 10;
  while (at + 4 <= d.byteLength) {
    const flags = d.getUint16(at);
    out.push(d.getUint16(at + 2));
    at += 4;
    at += (flags & 0x0001) !== 0 ? 4 : 2; // ARG_1_AND_2_ARE_WORDS
    if ((flags & 0x0008) !== 0) at += 2; // WE_HAVE_A_SCALE
    else if ((flags & 0x0040) !== 0) at += 4; // WE_HAVE_AN_X_AND_Y_SCALE
    else if ((flags & 0x0080) !== 0) at += 8; // WE_HAVE_A_TWO_BY_TWO
    if ((flags & 0x0020) === 0) break; // MORE_COMPONENTS
  }
  return out;
}

/** Writes [tables] as a valid sfnt, with the checksums a validator expects. */
function assemble(tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort();
  const count = tags.length;
  let offset = 12 + count * 16;
  const starts = new Map<string, number>();
  for (const tag of tags) {
    starts.set(tag, offset);
    offset += (tables.get(tag)!.length + 3) & ~3;
  }

  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, count);
  // searchRange, entrySelector and rangeShift, per the sfnt header.
  let power = 1;
  let selector = 0;
  while (power * 2 <= count) {
    power *= 2;
    selector++;
  }
  view.setUint16(6, power * 16);
  view.setUint16(8, selector);
  view.setUint16(10, count * 16 - power * 16);

  for (let i = 0; i < count; i++) {
    const tag = tags[i]!;
    const data = tables.get(tag)!;
    const row = 12 + i * 16;
    for (let k = 0; k < 4; k++) view.setUint8(row + k, tag.charCodeAt(k));
    const start = starts.get(tag)!;
    out.set(data, start);
    view.setUint32(row + 4, checksum(view, start, data.length));
    view.setUint32(row + 8, start);
    view.setUint32(row + 12, data.length);
  }

  // head.checkSumAdjustment is defined over the finished file, so it is zeroed
  // while the total is taken and written last.
  const headStart = starts.get('head');
  if (headStart !== undefined && tables.get('head')!.length >= 12) {
    view.setUint32(headStart + 8, 0);
    const total = checksum(view, 0, out.length);
    view.setUint32(headStart + 8, (0xb1b0afba - total) >>> 0);
  }
  return out;
}

function checksum(d: DataView, start: number, length: number): number {
  let sum = 0;
  const words = Math.ceil(length / 4);
  for (let i = 0; i < words; i++) {
    const at = start + i * 4;
    let value = 0;
    for (let k = 0; k < 4; k++) {
      value = ((value << 8) | (at + k < d.byteLength ? d.getUint8(at + k) : 0)) >>> 0;
    }
    sum = (sum + value) >>> 0;
  }
  return sum;
}
