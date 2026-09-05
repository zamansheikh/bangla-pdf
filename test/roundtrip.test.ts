/**
 * The headline conformance test: draw every corpus case into a PDF, then read
 * it back with an outside tool and check the text is unchanged.
 *
 * This is what `/ActualText` exists for. Bengali reorders glyphs — `কি` draws
 * `ি` before `ক` — so a PDF that carries only per-glyph `/ToUnicode` mappings
 * gives back scrambled text no matter how correct the rendering looks. Anything
 * much below 100% here means the marked-content spans are wrong.
 *
 * The corpus is `test/corpus/bangla_cases.json`, copied verbatim from the
 * `bangla_pdf` Dart package (253 cases, two of them blank).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { drawBanglaText, loadBanglaFont } from '../src/index.js';
import { corpus, fontBytes, hasTool, pdftotext, tempDir, type CorpusCase } from './helpers.js';

/** Small enough that the longest case fits on one line of a wide page. */
const SIZE = 10;
const PAGE_WIDTH = 2200;
const PAGE_HEIGHT = 60;

const drawable = corpus().filter((c) => c.text.trim().length > 0);

/** One page per case, so page breaks in the extracted text separate them. */
async function renderCorpus(font: Uint8Array, cases: CorpusCase[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const banglaFont = await loadBanglaFont(font);
  for (const testCase of cases) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawBanglaText(page, testCase.text, { font: banglaFont, x: 20, y: 20, size: SIZE });
  }
  return doc.save();
}

/** Splits `pdftotext` output back into one string per page. */
function pages(text: string): string[] {
  return text.split('\f').map((page) => page.replace(/\n+$/, '').replace(/\n/g, ''));
}

describe('round trip through a PDF', () => {
  const available = hasTool('pdftotext');

  it.skipIf(!available)('pdftotext recovers every corpus case (bundled Kalpurush)', async () => {
    const bytes = await renderCorpus(fontBytes('Kalpurush-Subset.ttf'), drawable);
    const dir = tempDir('bangla-roundtrip-');
    const extracted = pages(pdftotext(dir, 'corpus', bytes));

    const failures: string[] = [];
    for (let i = 0; i < drawable.length; i++) {
      const want = drawable[i]!.text;
      const got = extracted[i] ?? '';
      if (got !== want) failures.push(`[${drawable[i]!.id}] want ${want}\n              got  ${got}`);
    }

    const rate = (drawable.length - failures.length) / drawable.length;
    // Reported in the README as a real number; the assertion is the floor.
    console.log(
      `round trip: ${drawable.length - failures.length}/${drawable.length} ` +
        `(${(rate * 100).toFixed(1)}%)`,
    );
    if (failures.length > 0) console.log(failures.join('\n'));
    expect(rate).toBeGreaterThanOrEqual(0.95);
  });

  const otherFonts = [
    'Kalpurush-Unicode.ttf',
    'SolaimanLipi.ttf',
    'SiyamRupali.ttf',
    'NotoSansBengali-Regular.ttf',
    'NotoSerifBengali-Regular.ttf',
  ];

  for (const name of otherFonts) {
    it.skipIf(!available)(`pdftotext recovers every corpus case (${name})`, async () => {
      const bytes = await renderCorpus(fontBytes(name), drawable);
      const dir = tempDir('bangla-roundtrip-');
      const extracted = pages(pdftotext(dir, 'corpus', bytes));

      let ok = 0;
      const failures: string[] = [];
      for (let i = 0; i < drawable.length; i++) {
        if ((extracted[i] ?? '') === drawable[i]!.text) ok++;
        else failures.push(`[${drawable[i]!.id}] ${drawable[i]!.text} -> ${extracted[i] ?? ''}`);
      }
      console.log(`round trip ${name}: ${ok}/${drawable.length}`);
      if (failures.length > 0) console.log(failures.slice(0, 10).join('\n'));
      expect(ok / drawable.length).toBeGreaterThanOrEqual(0.95);
    });
  }

  it('writes a sample document for inspection', async () => {
    const doc = await PDFDocument.create();
    const font = await loadBanglaFont();
    const page = doc.addPage([595, 842]);
    let y = 780;
    for (const testCase of corpus().slice(0, 30)) {
      if (testCase.text.trim().length === 0) continue;
      drawBanglaText(page, testCase.text, { font, x: 40, y, size: 16 });
      y -= 24;
    }
    const dir = tempDir('bangla-sample-');
    writeFileSync(join(dir, 'sample.pdf'), await doc.save());
    expect(readFileSync(join(dir, 'sample.pdf')).length).toBeGreaterThan(1000);
  });
});
