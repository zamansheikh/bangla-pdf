/**
 * Compares what this package *draws* against what HarfBuzz draws.
 *
 * Matching glyph ids prove the shaping is right. They prove nothing about the
 * layer below: an advance written wrongly into the embedded font's `/W`, a
 * glyph placed at the wrong offset, a subsetter that dropped an outline, a TJ
 * array built incorrectly. All of those render wrong while every glyph id still
 * matches, so the only honest check is to look at the pixels.
 *
 * The trick that makes it meaningful: `hb-view` can emit PDF, so both sides are
 * rasterised by the same poppler, at the same size, from the same font file.
 * What is left after cropping to the ink is a like-for-like comparison rather
 * than a fight between two rasterisers.
 *
 * Methodology ported from `test/pixel_diff_test.dart` in the `bangla_pdf` Dart
 * package.
 *
 * Skips unless `hb-view` and `pdftoppm` are installed:
 *   brew install harfbuzz poppler
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { drawBanglaText, loadBanglaFont } from '../src/index.js';
import {
  corpus,
  fontBytes,
  hasTool,
  inkOverlap,
  rasterise,
  ROOT,
  tempDir,
  type Pgm,
} from './helpers.js';

/** Large enough that a one-unit shaping error is several pixels wide. */
const FONT_SIZE = 64;
const DPI = 150;
const MARGIN = 16;

/** Draws [text] with this package, on a page big enough not to clip it. */
async function ourRendering(fontData: Uint8Array, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await loadBanglaFont(fontData);
  const page = doc.addPage([1400, 260]);
  // hb-view puts the baseline at margin + ascender from the top of its page;
  // exact placement does not matter because both sides are cropped to their
  // own ink before they are compared.
  drawBanglaText(page, text, { font, x: MARGIN, y: 120, size: FONT_SIZE });
  return doc.save();
}

/** Draws [text] with HarfBuzz, straight to PDF. */
function harfbuzzRendering(dir: string, fontPath: string, text: string): Uint8Array | null {
  const out = join(dir, 'hb.pdf');
  try {
    execFileSync('hb-view', [
      // Without this, hb-view guesses the script from the buffer and picks
      // Latin for anything starting with Latin, so it shapes with no Indic
      // reordering at all. That is an artefact of the command-line tool, which
      // does not itemise runs by script the way a real text engine does — and
      // the way this package does.
      '--script=Beng',
      `--font-size=${FONT_SIZE}`,
      `--margin=${MARGIN}`,
      '-O',
      'pdf',
      fontPath,
      text,
      '-o',
      out,
    ]);
  } catch {
    return null;
  }
  return existsSync(out) ? new Uint8Array(readFileSync(out)) : null;
}

describe('what we draw matches what HarfBuzz draws', () => {
  const available = hasTool('hb-view') && hasTool('pdftoppm');

  it.skipIf(!available)('over the corpus, with the bundled font', async () => {
    const name = 'Kalpurush-Subset.ttf';
    const fontPath = join(ROOT, 'test/fixtures/fonts', name);
    const fontData = fontBytes(name);
    const dir = tempDir('bangla-pixel-');

    const scores: number[] = [];
    const poor: string[] = [];

    for (const testCase of corpus()) {
      const text = testCase.text;
      // A blank line has no ink to compare, and a very long one would be
      // clipped by the fixed page width rather than laid out differently.
      if (text.trim().length === 0 || text.length > 24) continue;

      const theirs = harfbuzzRendering(dir, fontPath, text);
      if (theirs === null) continue;
      const a: Pgm | null = rasterise(dir, 'ours', await ourRendering(fontData, text), DPI);
      const b: Pgm | null = rasterise(dir, 'theirs', theirs, DPI);
      if (a === null || b === null) continue;

      const overlap = inkOverlap(a, b);
      scores.push(overlap);
      if (overlap < 0.9) {
        poor.push(`[${testCase.id}] ${text}  overlap ${(overlap * 100).toFixed(1)}%`);
      }
    }

    expect(scores.length).toBeGreaterThan(100);
    const mean = scores.reduce((x, y) => x + y, 0) / scores.length;
    const worst = Math.min(...scores);
    console.log(
      `pixel diff: ${scores.length} cases, mean ink overlap ${(mean * 100).toFixed(1)}%, ` +
        `worst ${(worst * 100).toFixed(1)}%`,
    );
    if (poor.length > 0) console.log(poor.join('\n'));

    // Identical shaping still leaves a hairline of disagreement along every
    // antialiased edge, so this can never reach 1.0. What it can show is that
    // no case is drawing something structurally different.
    expect(mean).toBeGreaterThan(0.95);
    expect(poor).toEqual([]);
  });
});
