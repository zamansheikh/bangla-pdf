/**
 * The drawing API's own behaviour: alignment, colour, fallback fonts, and the
 * lifecycle of the embedded font.
 */

import { PDFDocument, rgb } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { drawBanglaText, embedBanglaFonts, loadBanglaFont, measureBanglaText } from '../src/index.js';
import { BanglaFont } from '../src/shaping/font.js';
import { fontBytes, hasTool, inkBox, pdftotext, rasterise, tempDir } from './helpers.js';

const SAMPLE = 'আমার সোনার বাংলা';

async function page(): Promise<[PDFDocument, ReturnType<PDFDocument['addPage']>, BanglaFont]> {
  const doc = await PDFDocument.create();
  return [doc, doc.addPage([400, 200]), await loadBanglaFont()];
}

describe('drawing options', () => {
  it('returns the layout it drew', async () => {
    const [, p, font] = await page();
    const result = drawBanglaText(p, `${SAMPLE}\n${SAMPLE}`, { font, x: 20, y: 150, size: 14 });
    expect(result.lines.length).toBe(2);
    expect(result.width).toBeGreaterThan(0);
    expect(result.lastBaseline).toBeCloseTo(150 - result.lineHeight, 5);
  });

  it('aligns within maxWidth, measured on the page', async () => {
    if (!hasTool('pdftoppm')) return;
    const font = await loadBanglaFont();
    const dir = tempDir('bangla-align-');

    // Where the ink actually lands is the only alignment test worth having:
    // the layout's own numbers are relative to the line either way.
    const inkLeft = async (align: 'left' | 'center' | 'right'): Promise<number> => {
      const doc = await PDFDocument.create();
      const p = doc.addPage([400, 60]);
      drawBanglaText(p, SAMPLE, { font, x: 0, y: 20, size: 14, maxWidth: 400, align });
      const image = rasterise(dir, `align-${align}`, await doc.save(), 100);
      const box = inkBox(image!);
      return box![0];
    };

    const left = await inkLeft('left');
    const centre = await inkLeft('center');
    const right = await inkLeft('right');
    expect(centre).toBeGreaterThan(left);
    expect(right).toBeGreaterThan(centre);
    // Centring puts roughly equal slack on both sides.
    expect(Math.abs(centre - left - (right - centre))).toBeLessThan(4);
  });

  it('draws in colour and with opacity without breaking extraction', async () => {
    if (!hasTool('pdftotext')) return;
    const [doc, p, font] = await page();
    drawBanglaText(p, SAMPLE, {
      font,
      x: 20,
      y: 150,
      size: 16,
      color: rgb(0.8, 0.1, 0.2),
      opacity: 0.5,
    });
    const bytes = await doc.save();
    const dir = tempDir('bangla-api-');
    expect(pdftotext(dir, 'colour', bytes).replace(/\s+/g, ' ').trim()).toBe(SAMPLE);
  });

  it('adds letter spacing to the measured width', async () => {
    const font = await loadBanglaFont();
    const plain = measureBanglaText(SAMPLE, { font, size: 14 });
    const spaced = measureBanglaText(SAMPLE, { font, size: 14, letterSpacing: 2 });
    expect(spaced.width).toBeGreaterThan(plain.width);
  });

  it('never breaks a line inside a cluster', async () => {
    const font = await loadBanglaFont();
    const text = 'ক্ষ্ম কর্ম ধর্ম বিশ্ববিদ্যালয় কর্তৃপক্ষ প্রতিষ্ঠান';
    for (const maxWidth of [40, 60, 90, 140, 220]) {
      const layout = measureBanglaText(text, { font, size: 12, maxWidth });
      expect(layout.lines.map((l) => l.text).join(''), `maxWidth ${maxWidth}`).toBe(text);
      // A line never starts with a virama or a vowel sign, which is what a
      // mid-cluster break would look like.
      for (const line of layout.lines) {
        if (line.text.length === 0) continue;
        expect(/^[া-্ৗ]/.test(line.text.trimStart()), line.text).toBe(false);
      }
    }
  });
});

describe('fonts', () => {
  it('falls back for characters the main font has no glyph for', async () => {
    if (!hasTool('pdftotext') || !hasTool('pdftoppm')) return;
    // The bundled Kalpurush is a 206-glyph subset with no accented Latin and no
    // degree sign; Noto Sans Bengali has both. Neither has ±, so it drops out
    // either way — which is what makes this a fair before/after.
    const kalpurush = await loadBanglaFont();
    const noto = await BanglaFont.load(fontBytes('NotoSansBengali-Regular.ttf'));
    expect(kalpurush.supports(0x00e9), 'é').toBe(false);
    expect(noto.supports(0x00e9), 'é').toBe(true);

    const text = 'বাংলা café 50°C';
    const dir = tempDir('bangla-fallback-');

    const draw = async (fallbackFonts: BanglaFont[]): Promise<Uint8Array> => {
      const doc = await PDFDocument.create();
      const p = doc.addPage([400, 60]);
      drawBanglaText(p, text, { font: kalpurush, x: 20, y: 20, size: 20, fallbackFonts });
      return doc.save();
    };

    const without = await draw([]);
    const withFallback = await draw([noto]);

    // Extraction says the same thing either way, because /ActualText carries
    // the source text whatever was drawn — so the only honest check that the
    // glyphs appeared is to count the ink.
    expect(pdftotext(dir, 'fallback', withFallback).replace(/\s+/g, ' ').trim()).toBe(text);

    const inkOf = (name: string, bytes: Uint8Array): number => {
      const image = rasterise(dir, name, bytes, 150)!;
      let ink = 0;
      for (const pixel of image.pixels) if (pixel < 200) ink++;
      return ink;
    };
    expect(inkOf('with', withFallback)).toBeGreaterThan(inkOf('without', without));
  });

  it('embeds one font per document however many times it is drawn', async () => {
    const doc = await PDFDocument.create();
    const font = await loadBanglaFont();
    for (let i = 0; i < 5; i++) {
      const p = doc.addPage([300, 80]);
      drawBanglaText(p, SAMPLE, { font, x: 20, y: 40, size: 14 });
    }
    const bytes = await doc.save();
    // One FontFile2 for five pages: five copies would be five times the size.
    expect(bytes.length).toBeLessThan(40 * 1024);
  });

  it('survives being saved twice', async () => {
    if (!hasTool('pdftotext')) return;
    const [doc, p, font] = await page();
    drawBanglaText(p, SAMPLE, { font, x: 20, y: 150, size: 16 });
    const first = await doc.save();

    // Drawing more between saves must not leave the first font behind.
    const p2 = doc.addPage([400, 100]);
    drawBanglaText(p2, 'কর্ম ক্ষ্ম', { font, x: 20, y: 50, size: 16 });
    const second = await doc.save();

    const dir = tempDir('bangla-api-');
    expect(pdftotext(dir, 'first', first).replace(/\s+/g, ' ').trim()).toBe(SAMPLE);
    const pages = pdftotext(dir, 'second', second).split('\f');
    expect(pages[0]!.replace(/\s+/g, ' ').trim()).toBe(SAMPLE);
    expect(pages[1]!.replace(/\s+/g, ' ').trim()).toBe('কর্ম ক্ষ্ম');
  });

  it('embedBanglaFonts is idempotent and safe on a document with no Bangla', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    expect(() => embedBanglaFonts(doc)).not.toThrow();

    const [doc2, p, font] = await page();
    drawBanglaText(p, SAMPLE, { font, x: 20, y: 150, size: 16 });
    embedBanglaFonts(doc2);
    embedBanglaFonts(doc2);
    expect((await doc2.save()).length).toBeGreaterThan(1000);
  });

  it('rejects bytes that are not a font', async () => {
    await expect(loadBanglaFont(new Uint8Array(64))).rejects.toThrow(/not a usable/);
  });

  it('reports metrics from the font, not guesses', async () => {
    const font = await loadBanglaFont();
    expect(font.unitsPerEm).toBe(1000);
    expect(font.ascent).toBeGreaterThan(0);
    expect(font.descent).toBeLessThan(0);
    expect(font.supports('ক'.codePointAt(0)!)).toBe(true);
    expect(font.supports(0x1f600)).toBe(false); // no Bangla font has emoji
    expect(font.postScriptName).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
