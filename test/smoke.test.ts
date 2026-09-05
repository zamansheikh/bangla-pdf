import { PDFDocument, rgb } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { drawBanglaText, loadBanglaFont, measureBanglaText } from '../src/index.js';

describe('generation', () => {
  it('draws a page and produces a readable PDF', async () => {
    const doc = await PDFDocument.create();
    const font = await loadBanglaFont();
    const page = doc.addPage([595, 842]);

    drawBanglaText(page, 'আমার সোনার বাংলা, আমি তোমায় ভালোবাসি।', {
      font,
      x: 50,
      y: 750,
      size: 22,
    });
    drawBanglaText(page, 'কি ক্ষ্ম কর্ম ধর্ম ব্যাংক ৳১২,৫০০ Invoice #42', {
      font,
      x: 50,
      y: 700,
      size: 18,
      color: rgb(0.1, 0.1, 0.6),
    });

    const bytes = await doc.save();
    expect(bytes.length).toBeGreaterThan(1000);
    expect(new TextDecoder('latin1').decode(bytes.subarray(0, 8))).toContain('%PDF-');
  });

  it('shapes কি with the vowel sign drawn first', async () => {
    const font = await loadBanglaFont();
    const run = font.shape('কি', 'Beng');
    expect(run.glyphs.length).toBe(2);
    // One cluster covering both characters, whose text is the whole thing.
    expect(run.clusters.length).toBe(1);
    expect(run.clusters[0]!.text).toBe('কি');
    // The pre-base vowel sign is emitted before its consonant.
    expect(run.glyphs[0]!.gid).not.toBe(run.glyphs[1]!.gid);
  });

  it('ligates ক্ষ্ম into one glyph', async () => {
    const font = await loadBanglaFont();
    const run = font.shape('ক্ষ্ম', 'Beng');
    expect(run.glyphs.length).toBe(1);
    expect(run.clusters[0]!.text).toBe('ক্ষ্ম');
  });

  it('measures without drawing', async () => {
    const font = await loadBanglaFont();
    const layout = measureBanglaText('আমার সোনার বাংলা', { font, size: 20 });
    expect(layout.lines.length).toBe(1);
    expect(layout.width).toBeGreaterThan(50);
  });

  it('wraps on cluster boundaries at maxWidth', async () => {
    const font = await loadBanglaFont();
    const text = 'আমার সোনার বাংলা, আমি তোমায় ভালোবাসি। চিরদিন তোমার আকাশ, তোমার বাতাস।';
    const layout = measureBanglaText(text, { font, size: 14, maxWidth: 150 });
    expect(layout.lines.length).toBeGreaterThan(1);
    // Nothing is lost or duplicated by wrapping.
    expect(layout.lines.map((l) => l.text).join('')).toBe(text);
    for (const line of layout.lines) expect(line.width).toBeLessThanOrEqual(150 + 0.01);
  });
});
