/**
 * Invariants of the shaping-to-text mapping.
 *
 * These do not check that HarfBuzz shapes Bengali correctly — HarfBuzz is the
 * reference implementation, and `hb-shape.test.ts` compares against the
 * command-line tool anyway. What they check is this package's own layer: that
 * the text attached to glyphs adds up to the text that went in, for every case
 * in the corpus and every font tested.
 *
 * If this ever fails, a PDF is being written whose `/ToUnicode` cannot
 * reconstruct the original — the exact failure this package exists to prevent.
 */

import { describe, expect, it } from 'vitest';

import { BanglaFont } from '../src/shaping/font.js';
import { corpus, fontBytes } from './helpers.js';

const FONTS = [
  'Kalpurush-Subset.ttf',
  'Kalpurush-Unicode.ttf',
  'SolaimanLipi.ttf',
  'SiyamRupali.ttf',
  'NotoSansBengali-Regular.ttf',
  'NotoSerifBengali-Regular.ttf',
];

describe('glyph text assignment', () => {
  for (const name of FONTS) {
    it(`is lossless over the whole corpus (${name})`, async () => {
      const font = await BanglaFont.load(fontBytes(name));
      const lossy: string[] = [];

      for (const testCase of corpus()) {
        if (testCase.text.trim().length === 0) continue;
        const run = font.shape(testCase.text, 'Beng');

        // Every glyph belongs to exactly one cluster, in order.
        let next = 0;
        for (const cluster of run.clusters) {
          expect(cluster.glyphStart).toBe(next);
          expect(cluster.glyphTexts.length).toBe(cluster.glyphEnd - cluster.glyphStart);
          // A cluster's per-glyph texts add back up to the cluster's text.
          expect(cluster.glyphTexts.join('')).toBe(cluster.text);
          next = cluster.glyphEnd;
        }
        expect(next).toBe(run.glyphs.length);

        // And the clusters add back up to the whole string.
        const rebuilt = run.clusters.map((c) => c.text).join('');
        if (rebuilt !== testCase.text) lossy.push(`[${testCase.id}] ${testCase.text} -> ${rebuilt}`);
      }

      expect(lossy).toEqual([]);
    });
  }

  it('gives a ligature glyph the whole conjunct as its text', async () => {
    const font = await BanglaFont.load(fontBytes('Kalpurush-Subset.ttf'));
    const run = font.shape('ক্ষ্ম', 'Beng');
    expect(run.glyphs.length).toBe(1);
    expect(run.clusters[0]!.glyphTexts).toEqual(['ক্ষ্ম']);
  });

  it('puts a reordered cluster’s text on one glyph, in typing order', async () => {
    const font = await BanglaFont.load(fontBytes('Kalpurush-Subset.ttf'));
    // কি draws ি first; no per-glyph assignment can express the typed order,
    // so the whole cluster's text goes on the first spacing glyph.
    const run = font.shape('কি', 'Beng');
    const texts = run.clusters[0]!.glyphTexts;
    expect(texts.filter((t) => t !== '')).toEqual(['কি']);
  });

  it('gives each glyph its own text when the order is preserved', async () => {
    const font = await BanglaFont.load(fontBytes('Kalpurush-Subset.ttf'));
    // কা draws ক then া, exactly as typed, so both glyphs carry real text.
    const run = font.shape('কা', 'Beng');
    expect(run.clusters[0]!.glyphTexts).toEqual(['ক', 'া']);
  });

  it('splits runs by script so Latin never suppresses Indic reordering', async () => {
    const font = await BanglaFont.load(fontBytes('Kalpurush-Subset.ttf'));
    // Shaped as one Latin-scripted buffer this gets no reordering at all and
    // কি comes out with its glyphs in typed order.
    const mixed = font.shape('Hi কি', 'Beng');
    const bengaliOnly = font.shape('কি', 'Beng');
    const tail = mixed.glyphs.slice(-2).map((g) => g.gid);
    expect(tail).toEqual(bengaliOnly.glyphs.map((g) => g.gid));
  });
});
