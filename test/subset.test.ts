/**
 * Font subsetting.
 *
 * Ported from `lib/src/pdf/font_subset.dart`. Glyph ids are preserved, so
 * `/CIDToGIDMap`, `/W` and `/ToUnicode` need no remapping; unused outlines are
 * blanked rather than renumbered.
 */

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { drawBanglaText, loadBanglaFont } from '../src/index.js';
import { OtFont } from '../src/ot/ot-font.js';
import { subsetTrueType } from '../src/pdf/subset.js';
import { BanglaFont } from '../src/shaping/font.js';
import { fontBytes } from './helpers.js';

describe('subsetting', () => {
  it('cuts a font down but keeps the glyphs asked for', async () => {
    const original = fontBytes('Kalpurush-Unicode.ttf');
    const font = await BanglaFont.load(original);
    const used = new Set<number>();
    for (const glyph of font.shape('আমার সোনার বাংলা', 'Beng').glyphs) used.add(glyph.gid);

    const subset = subsetTrueType(original, used);
    expect(subset).not.toBeNull();
    expect(subset!.length).toBeLessThan(original.length / 3);

    const parsed = OtFont.parse(subset!);
    expect(parsed).not.toBeNull();
    // Glyph ids are unchanged, so every drawn glyph still has its outline.
    expect(parsed!.numGlyphs).toBe(font.otf.numGlyphs);
    for (const gid of used) {
      if (font.otf.glyphExtents(gid) === null) continue; // a blank glyph stays blank
      expect(parsed!.glyphExtents(gid)).toEqual(font.otf.glyphExtents(gid));
    }
  });

  it('drops the layout tables, which a reader never consults', () => {
    const original = fontBytes('Kalpurush-Unicode.ttf');
    expect(OtFont.parse(original)!.tableOffset('GSUB')).toBeDefined();
    const subset = subsetTrueType(original, [3, 4, 5])!;
    const parsed = OtFont.parse(subset)!;
    expect(parsed.tableOffset('GSUB')).toBeUndefined();
    expect(parsed.tableOffset('GPOS')).toBeUndefined();
    expect(parsed.tableOffset('GDEF')).toBeUndefined();
    // …but keeps what a reader does need.
    for (const tag of ['head', 'hhea', 'hmtx', 'maxp', 'cmap', 'glyf', 'loca']) {
      expect(parsed.tableOffset(tag), tag).toBeDefined();
    }
  });

  it('keeps the components a composite glyph draws', () => {
    const original = fontBytes('Kalpurush-Unicode.ttf');
    const font = OtFont.parse(original)!;

    // Find a composite glyph: its first int16 is negative.
    let composite = -1;
    for (let gid = 1; gid < font.numGlyphs && composite < 0; gid++) {
      const extents = font.glyphExtents(gid);
      if (extents === null) continue;
      const glyf = font.tableOffset('glyf')!;
      const loca = font.tableOffset('loca');
      if (loca === undefined) break;
      // glyphExtents already proved this glyph has an outline; read its header.
      const start = glyf + readLoca(font, gid);
      if (font.d.i16(start) < 0) composite = gid;
    }
    if (composite < 0) return; // no composites in this font: nothing to check

    const subset = subsetTrueType(original, [composite])!;
    const parsed = OtFont.parse(subset)!;
    expect(parsed.glyphExtents(composite)).toEqual(font.glyphExtents(composite));
  });

  it('refuses a font it cannot rebuild rather than corrupting it', () => {
    expect(subsetTrueType(new Uint8Array(10), [1])).toBeNull();
    // 'OTTO' — CFF outlines, which this cannot rebuild.
    const otto = new Uint8Array(64);
    new DataView(otto.buffer).setUint32(0, 0x4f54544f);
    expect(subsetTrueType(otto, [1])).toBeNull();
  });

  it('makes a real document small', async () => {
    const doc = await PDFDocument.create();
    const font = await loadBanglaFont();
    const page = doc.addPage([595, 842]);
    drawBanglaText(page, 'গণপ্রজাতন্ত্রী বাংলাদেশ সরকার\nবিজ্ঞপ্তি', {
      font,
      x: 50,
      y: 750,
      size: 18,
    });
    const bytes = await doc.save();
    console.log(`one-page notice: ${(bytes.length / 1024).toFixed(1)} KB`);
    // The unsubsetted font alone is 118 KB.
    expect(bytes.length).toBeLessThan(30 * 1024);
  });
});

function readLoca(font: OtFont, gid: number): number {
  const head = font.tableOffset('head')!;
  const loca = font.tableOffset('loca')!;
  const long = font.d.i16(head + 50) !== 0;
  return long ? font.d.u32(loca + gid * 4) : font.d.u16(loca + gid * 2) * 2;
}
