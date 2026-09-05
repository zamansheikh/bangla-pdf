/**
 * Reading Bangla back out of a PDF.
 *
 * The fixtures come from the `bangla_pdf` Dart package, along with their
 * `ground_truth.json`: eight text-bearing documents (Unicode and Bijoy) and two
 * scans with no text layer at all. They are generated rather than collected, so
 * what they should say is known exactly — see the README for what that does and
 * does not prove.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractBanglaText } from '../src/extract.js';
import { bijoyConfidence, bijoyToUnicode } from '../src/extract/bijoy.js';
import { ROOT } from './helpers.js';

interface GroundTruth {
  name: string;
  kind: string;
  encoding: 'unicode' | 'bijoy' | 'mixed' | 'none';
  extractable: boolean;
  lines: string[];
}

function truth(): GroundTruth[] {
  return JSON.parse(readFileSync(join(ROOT, 'test/fixtures/pdfs/ground_truth.json'), 'utf8'));
}

function fixture(dir: string, name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, 'test/fixtures', dir, name)));
}

/**
 * Folds away spelling differences Bijoy cannot carry, and collapses runs of
 * whitespace so line wrapping does not count as a mismatch.
 *
 * `\u09DF` and `\u09AF\u09BC` are the same letter written two ways, and Unicode
 * will not normalise between them — the nukta forms are composition exclusions,
 * so NFC and NFD disagree about which is canonical. Extraction settles on the
 * precomposed spelling because that is what a Bangla keyboard produces; the
 * fixtures were written with the other. Ported verbatim from `normalise` in
 * `test/extraction_test.dart` in the Dart package, so the numbers here mean the
 * same thing as the ones there.
 */
function normalise(text: string): string {
  return text
    .split('\u09DC')
    .join('\u09A1\u09BC')
    .split('\u09DD')
    .join('\u09A2\u09BC')
    .split('\u09DF')
    .join('\u09AF\u09BC')
    .split('\u09CB')
    .join('\u09C7\u09BE')
    .split('\u09CC')
    .join('\u09C7\u09D7')
    .split('\u200C')
    .join('')
    .split('\u200D')
    .join('')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(' ');
}

describe('extraction', () => {
  it('recovers every text-bearing fixture', async () => {
    const cases = truth().filter((t) => t.extractable);
    const failures: string[] = [];

    for (const testCase of cases) {
      const result = await extractBanglaText(fixture('pdfs', `${testCase.name}.pdf`));
      const got = normalise(result.text);
      const want = normalise(testCase.lines.join(' '));
      if (got !== want) failures.push(`[${testCase.name}]\n  want ${want}\n  got  ${got}`);
      expect(result.encoding, testCase.name).toBe(testCase.encoding);
    }

    console.log(`extraction: ${cases.length - failures.length}/${cases.length} fixtures exact`);
    if (failures.length > 0) console.log(failures.join('\n'));
    expect(failures).toEqual([]);
  });

  it('reports a scan as having no text layer rather than inventing text', async () => {
    for (const testCase of truth().filter((t) => !t.extractable)) {
      const result = await extractBanglaText(fixture('pdfs', `${testCase.name}.pdf`));
      expect(result.text, testCase.name).toBe('');
      expect(result.encoding, testCase.name).toBe('none');
      expect(result.pages[0]!.hasImages, testCase.name).toBe(true);
    }
  });

  it('offers every empty page to an OCR hook', async () => {
    const seen: number[] = [];
    const result = await extractBanglaText(fixture('pdfs', 'scan-1.pdf'), {
      ocrHook: (page) => {
        seen.push(page.number);
        return 'ওসিআর থেকে পাওয়া লেখা';
      },
    });
    expect(seen).toEqual([1]);
    expect(result.text).toBe('ওসিআর থেকে পাওয়া লেখা');
  });

  it('reports high confidence when the document carries /ActualText', async () => {
    const result = await extractBanglaText(fixture('pdfs', 'invoice-1.pdf'));
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.hasBangla).toBe(true);
  });

  it('reports lower confidence for a Bijoy conversion, which is inference', async () => {
    const unicode = await extractBanglaText(fixture('pdfs', 'invoice-1.pdf'));
    const bijoy = await extractBanglaText(fixture('pdfs', 'gov-notice-1.pdf'));
    expect(bijoy.confidence).toBeLessThan(unicode.confidence);
  });

  it('returns an empty result for data that is not a PDF', async () => {
    const result = await extractBanglaText(new TextEncoder().encode('not a pdf at all'));
    expect(result.text).toBe('');
    expect(result.encoding).toBe('none');
    expect(result.pages).toEqual([]);
  });
});

describe('Bijoy conversion', () => {
  it('converts the classic mojibake', () => {
    expect(bijoyToUnicode('Avgvi ‡mvbvi evsjv')).toBe('আমার সোনার বাংলা');
  });

  it('moves a pre-base vowel sign back after its consonant', () => {
    // Bijoy stores ি before the ক it belongs to, the way it renders.
    expect(bijoyToUnicode('wK')).toBe('কি');
  });

  it('moves a reph back to the front of its cluster', () => {
    expect(bijoyToUnicode('Kg©')).toBe('কর্ম');
  });

  it('is a raw transcoder, which is why the caller must gate it by font', () => {
    // Bijoy reaches Bangla glyphs through ordinary Latin-1 byte values, so the
    // letters of an English word are perfectly good Bijoy input and come back
    // as Bangla. Nothing in the bytes distinguishes the two cases, which is
    // exactly why extraction only applies this to a run whose own font is a
    // Bijoy face — see FontInfo.isBijoy.
    expect(bijoyToUnicode('Invoice')).not.toBe('Invoice');
    expect(bijoyConfidence('Invoice')).toBeGreaterThan(0);
    // Text that is already Unicode Bangla is never mistaken for Bijoy.
    expect(bijoyConfidence('আমার সোনার বাংলা')).toBe(0);
  });
});

describe('encrypted documents', () => {
  const cases = [
    ['rc4-40.pdf', 'RC4 40-bit (revision 2)'],
    ['rc4-128.pdf', 'RC4 128-bit (revision 3)'],
    ['aes-128.pdf', 'AES-128 (revision 4)'],
    ['aes-256.pdf', 'AES-256 (revisions 5 and 6)'],
  ] as const;

  for (const [file, what] of cases) {
    it(`opens ${what} with an empty user password`, async () => {
      const result = await extractBanglaText(fixture('encrypted', file));
      expect(result.isEncrypted, file).toBe(true);
      expect(result.isLocked, file).toBe(false);
      expect(result.hasBangla, file).toBe(true);
    });
  }

  it('reports a document that genuinely needs a password as locked', async () => {
    const result = await extractBanglaText(fixture('encrypted', 'aes-256-userpw.pdf'));
    expect(result.isEncrypted).toBe(true);
    expect(result.isLocked).toBe(true);
    expect(result.text).toBe('');
  });

  it('opens that document when given the password', async () => {
    const result = await extractBanglaText(fixture('encrypted', 'aes-256-userpw.pdf'), {
      password: 'secret',
    });
    expect(result.isLocked).toBe(false);
    expect(result.hasBangla).toBe(true);
  });
});
