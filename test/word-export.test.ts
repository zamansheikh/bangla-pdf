/**
 * A real government PDF exported from Microsoft Word.
 *
 * `test/fixtures/real/nctb-assessment-guideline-2026.pdf` is the NCTB primary
 * assessment guideline (56 pages), written in Word 2013 with NikoshBAN,
 * SutonnyMJ and Vrinda. It was reported as extracting badly, and it is a good
 * example of how Word breaks Bangla text layers — every problem below was found
 * in it, and poppler and pdf.js get it wrong in the same ways:
 *
 *  * Word's /ToUnicode CMaps pair glyphs with characters by *position*, so every
 *    pair Bengali reorders is exchanged: ি with শ, ে with দ, র with ে. Which pairs
 *    depends on the document's words, so no fixed table can undo it; the text
 *    has to be read back through the embedded font instead.
 *  * It draws one glyph per `Tj`, and on justified lines gives each glyph its own
 *    text object and a structure tag, so no single operator holds a cluster.
 *  * Its WinAnsi subset of NikoshBAN has no Bengali in its cmap, and was taken
 *    for Bijoy by name — turning page numbers into noise.
 *  * It shows a lone byte with a two-byte CID font, which is not a glyph.
 *  * Its SutonnyMJ runs use alternate Bijoy codes (`Ö`, `†`) the conversion
 *    table never contained.
 *
 * Nothing here knows the exact text, so the checks are what can be known: that
 * the Bangla is well-formed, that known passages come back, and that the scan
 * pages are treated as scans.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { extractBanglaText, type ExtractionResult } from '../src/extract.js';
import { bijoyToUnicode } from '../src/extract/bijoy.js';
import { ROOT } from './helpers.js';

const FIXTURE = join(ROOT, 'test/fixtures/real/nctb-assessment-guideline-2026.pdf');

/** Compares spellings rather than encodings: NFC and NFD Bangla are the same text. */
const nfd = (text: string): string => text.normalize('NFD').replace(/\s+/g, ' ');

/**
 * Words Unicode spelling rules out: starting with a dependent vowel sign, a
 * virama or a nasal mark, or carrying two vowel signs in a row. Scrambled
 * Bengali produces them in bulk; poppler's reading of this file is a quarter
 * such words.
 */
function malformedWords(text: string): string[] {
  const isSign = (c: number) => (c >= 0x09be && c <= 0x09cc) || c === 0x09d7;
  const bad: string[] = [];
  for (const word of text.match(/[ঀ-৿]+/g) ?? []) {
    const cs = [...word].map((ch) => ch.codePointAt(0)!);
    const first = cs[0]!;
    const leading = isSign(first) || first === 0x09cd || (first >= 0x0981 && first <= 0x0983);
    const doubled = cs.some((c, i) => i > 0 && isSign(c) && isSign(cs[i - 1]!));
    if (leading || doubled) bad.push(word);
  }
  return bad;
}

describe('a Word export with a scrambled text layer', () => {
  let result: ExtractionResult;
  const offeredToOcr: number[] = [];

  beforeAll(async () => {
    result = await extractBanglaText(new Uint8Array(readFileSync(FIXTURE)), {
      ocrHook: (page) => {
        offeredToOcr.push(page.number);
        return null;
      },
    });
  });

  it('reads as well-formed Bangla', () => {
    const words = result.text.match(/[ঀ-৿]+/g) ?? [];
    const bad = malformedWords(result.text);
    expect(words.length).toBeGreaterThan(10_000);
    // One word at the time of writing, out of over fourteen thousand.
    expect(bad.length / words.length, bad.slice(0, 20).join(' ')).toBeLessThan(0.002);
  });

  it('recovers known passages exactly', () => {
    const text = nfd(result.text);
    for (const passage of [
      'জাতীয় শিক্ষাক্রম ও পাঠ্যপুস্তক বোর্ড, বাংলাদেশ',
      'প্রাথমিক স্তরের মূল্যায়ন নির্দেশিকা',
      'প্রথম শ্রেণি থেকে পঞ্চম শ্রেণি',
      // Reordered pairs Word's CMap exchanges.
      'মূল্যায়ন শিক্ষাক্রমের একটি অবিচ্ছেদ্য অংশ',
      // A reph fused with its vowel sign, and a ya-phala before a pre-base sign.
      'প্রাথমিক স্তরের শিক্ষার্থীদের জন্য একটি কার্যকর মূল্যায়ন পদ্ধতি প্রণয়নের লক্ষ্যে',
      // A justified line, one text object per glyph.
      'যৌক্তিক সমন্বয়ের মাধ্যমে',
      '১ম প্রান্তিকে মোট ৫২০, ২য় প্রান্তিকে মোট ৫৮০',
    ]) {
      expect(text, passage).toContain(nfd(passage));
    }
  });

  it('names vowel signs the font subset pruned from its cmap', () => {
    // `তৃ` is one glyph, and ৃ is not in the subset's cmap. Word's CMap calls the
    // glyph `র্ত`, having first met it in কর্তৃপক্ষ, where the reph follows it.
    const text = nfd(result.text);
    const count = (word: string) => text.split(nfd(word)).length - 1;
    expect(count('র্ততীয়')).toBe(0);
    expect(count('তৃতীয়')).toBeGreaterThanOrEqual(37);
    expect(text).toContain(nfd('কর্তৃপক্ষ'));
    expect(text).toContain(nfd('নেতৃত্বে'));
    // Drawn with the vowel sign before the ya-phala.
    expect(text).toContain(nfd('ন্যূনতম'));
    expect(text).not.toMatch(/[\u09BE-\u09CC]\u09CD/u);
  });

  it('does not split words inside table cells', () => {
    // Word clips each glyph of a cell with `q … re W* n … Q`, which says nothing
    // about words; its spaces there are one-byte `( )` shows.
    const text = nfd(result.text);
    for (const split of ['ব ণ্ট ন', 'খ্রী ষ্ট', 'ঘ ণ্টা', 'উ ত্তর']) {
      expect(text, split).not.toContain(nfd(split));
    }
    for (const passage of ['বণ্টন', 'খ্রীষ্ট', '১:০০ ঘণ্টা', 'একাধিক অংশ থাকবে না', 'জ্ঞান- ৩টি, দক্ষতা- ৩টি']) {
      expect(text, passage).toContain(nfd(passage));
    }
  });

  it('does not invent symbols from bytes that are not glyphs', () => {
    // A space shown as one byte with a two-byte font was read as glyph 32, `=`,
    // thousands of times. What is left are the formulas' own equals signs.
    const page1 = result.pages[0]!.text;
    expect(page1).not.toContain('=');
    expect((result.text.match(/=/g) ?? []).length).toBeLessThan(200);
  });

  it('converts the Bijoy runs, alternate codes included', () => {
    // SutonnyMJ's second e-kar and ra-phala, left raw beside converted text.
    expect(result.text).not.toMatch(/[ঀ-৿][Ö†]|[Ö†][ঀ-৿]/);
  });

  it('does not call a page Bijoy because of its page number', () => {
    // Pages 12-15 are scans whose only text is a page number drawn in a WinAnsi
    // subset of NikoshBAN — a Unicode font, which has no Bengali cmap entries
    // left but still carries a Bengali GSUB.
    for (const number of [12, 13, 14, 15]) {
      const page = result.pages[number - 1]!;
      expect(page.encoding, `page ${number}`).not.toBe('bijoy');
      expect(page.hasImages, `page ${number}`).toBe(true);
    }
  });

  it('offers the scanned pages to OCR, and only those', () => {
    expect(offeredToOcr).toEqual([12, 13, 14, 15]);
  });

  it('reports inference as inference', () => {
    // Most of the text had to be read back through the fonts, which counts for
    // less than text a document states outright.
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.confidence).toBeLessThan(1);
  });
});

describe('Bijoy alternate codes', () => {
  it('reads SutonnyMJ alternates the same as the canonical codes', () => {
    expect(bijoyToUnicode('cÖ_g †kÖwY')).toBe(bijoyToUnicode('cª_g ‡kªwY'));
    expect(nfd(bijoyToUnicode('cÖ_g †kÖwY'))).toBe(nfd('প্রথম শ্রেণি'));
    expect(nfd(bijoyToUnicode('cÖvwšÍK'))).toBe(nfd('প্রান্তিক'));
  });
});

describe('package metadata', () => {
  it('points older TypeScript resolution at the extract types', () => {
    // `moduleResolution: node` ignores `exports`, so without typesVersions
    // `import … from 'bangla-pdf/extract'` fails with TS2307 there.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.typesVersions?.['*']?.extract).toEqual([pkg.exports['./extract'].import.types]);
  });
});
