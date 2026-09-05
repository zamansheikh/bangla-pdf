/**
 * A second, independent extractor.
 *
 * `pdftotext` honours `/ActualText`, so the round-trip suite measures the
 * marked-content spans. pdf.js does not: its text layer reads the glyphs and
 * their `/ToUnicode` entries. Running both says which of the two mechanisms is
 * carrying the result, and what a reader that only implements one will see.
 */

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { drawBanglaText, loadBanglaFont } from '../src/index.js';
import { corpus, fontBytes } from './helpers.js';

const drawable = corpus().filter((c) => c.text.trim().length > 0);

async function textOfPages(bytes: Uint8Array): Promise<string[]> {
  // The legacy build is the one that runs under plain Node without a DOM.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join('')
        .trim(),
    );
  }
  await doc.destroy();
  return out;
}

describe('pdf.js text layer', () => {
  it('recovers the corpus from /ToUnicode alone', async () => {
    const doc = await PDFDocument.create();
    const font = await loadBanglaFont(fontBytes('Kalpurush-Subset.ttf'));
    for (const testCase of drawable) {
      const page = doc.addPage([2200, 60]);
      drawBanglaText(page, testCase.text, { font, x: 20, y: 20, size: 10 });
    }
    const extracted = await textOfPages(await doc.save());

    let raw = 0;
    let stripped = 0;
    const failures: string[] = [];
    for (let i = 0; i < drawable.length; i++) {
      const want = drawable[i]!.text;
      const got = extracted[i] ?? '';
      if (got === want) raw++;
      // U+FEFF is what a continuation glyph maps to: zero-width, and invisible
      // when pasted. Stripping it separates "wrong text" from "right text with
      // an invisible filler in it".
      if (got.replace(/\uFEFF/g, '') === want) stripped++;
      else failures.push(`[${drawable[i]!.id}] ${JSON.stringify(want)} -> ${JSON.stringify(got)}`);
    }
    console.log(
      `pdf.js: ${raw}/${drawable.length} exact, ` +
        `${stripped}/${drawable.length} ignoring U+FEFF fillers`,
    );
    if (failures.length > 0) console.log(failures.slice(0, 20).join('\n'));

    // Recorded rather than asserted tightly: this measures what a reader that
    // ignores /ActualText sees, and the floor is what the README reports.
    //
    // The cases that fail come back with the right characters and a spurious
    // space in the middle. pdf.js classifies a whole /ToUnicode entry as a
    // zero-width diacritic if it *contains* one anywhere -- its regexp is
    // `/^(\s)|(\p{Mn})|(\p{Cf})$/u`, whose middle branch is unanchored -- and
    // then advances its pen by nothing for that glyph. Every correct mapping of
    // a Bengali conjunct contains a virama, so every one trips it. Not
    // something this package can encode its way around without giving up
    // multi-codepoint mappings, which is the entire point of them.
    expect(stripped / drawable.length).toBeGreaterThanOrEqual(0.85);
  });
});
