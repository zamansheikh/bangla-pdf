/**
 * Recovering text from glyph ids alone, for PDFs that offer nothing else.
 *
 * This is inference, not decoding: the font is read backwards to work out which
 * characters would produce the glyphs that were drawn. So the tests measure how
 * much comes back, and say plainly what cannot.
 *
 * Ported from `test/unshape_test.dart` in the `bangla_pdf` Dart package,
 * including its normalisation, so the numbers mean the same thing.
 */

import { PDFDocument, PDFName, PDFOperator, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { extractBanglaText } from '../src/extract.js';
import { GlyphReverseMap } from '../src/extract/glyph-reverse.js';
import { BanglaFont } from '../src/shaping/font.js';
import { corpus, fontBytes } from './helpers.js';

/**
 * Folds NFD onto NFC. The nukta letters and two-part vowels have two spellings
 * of the same text, and which one comes back is not a defect.
 */
function norm(text: string): string {
  return text
    .split('ড়')
    .join('ড়')
    .split('ঢ়')
    .join('ঢ়')
    .split('য়')
    .join('য়')
    .split('ো')
    .join('ো')
    .split('ৌ')
    .join('ৌ')
    .split('‌')
    .join('')
    .split('‍')
    .join('')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(' ');
}

/** The font read backwards, with HarfBuzz available to check its guesses. */
async function reverseMapFor(name: string): Promise<[BanglaFont, GlyphReverseMap]> {
  const font = await BanglaFont.load(fontBytes(name));
  const map = GlyphReverseMap.build(font.otf, (text) =>
    font.shape(text, 'Beng').glyphs.map((g) => g.gid),
  );
  return [font, map];
}

describe('reading a font backwards', () => {
  it('the corpus comes back from glyph ids alone', async () => {
    const [font, reverse] = await reverseMapFor('Kalpurush-Unicode.ttf');

    let recovered = 0;
    let total = 0;
    const missed: string[] = [];
    for (const testCase of corpus()) {
      if (testCase.text.trim().length === 0) continue;
      total++;
      const gids = font.shape(testCase.text, 'Beng').glyphs.map((g) => g.gid);
      const back = reverse.decodeRun(gids);
      if (norm(back) === norm(testCase.text)) recovered++;
      else missed.push(`[${testCase.id}] ${testCase.text} -> ${back}`);
    }

    console.log(
      `un-shaping: ${recovered}/${total} (${((recovered / total) * 100).toFixed(1)}%)`,
    );
    if (missed.length > 0) console.log(missed.join('\n'));

    // The shortfall is text that is not in the glyphs at all: an emoji the font
    // cannot draw, a ZWJ (which is invisible and produces nothing), and the
    // dotted circles a shaper inserts for a vowel sign typed with no consonant.
    expect(total).toBeGreaterThan(200);
    expect(recovered / total).toBeGreaterThan(0.95);
  });

  it('a conjunct comes back whole, not as its parts', async () => {
    const [font, reverse] = await reverseMapFor('Kalpurush-Unicode.ttf');
    for (const text of ['ক্ষ্ম', 'ঙ্ক্ষ', 'শ্ব', 'ব্য', 'র্ক', 'কি']) {
      const gids = font.shape(text, 'Beng').glyphs.map((g) => g.gid);
      expect(norm(reverse.decodeRun(gids)), text).toBe(norm(text));
    }
  });

  it('reph and pre-base vowels are put back in typing order', async () => {
    const [font, reverse] = await reverseMapFor('Kalpurush-Unicode.ttf');
    // Both are drawn in an order nobody types: the reph after its cluster, the
    // vowel sign before its consonant.
    for (const text of ['কর্ম', 'ধর্ম', 'কি', 'কে', 'কো']) {
      const gids = font.shape(text, 'Beng').glyphs.map((g) => g.gid);
      expect(norm(reverse.decodeRun(gids)), text).toBe(norm(text));
    }
  });

  it('reports how much of a font it could express as text at all', async () => {
    // Kalpurush comes out at 1.0: every glyph it has is either in the cmap or
    // reachable by inverting a substitution. A font with ornaments or internal
    // forms that no text produces scores lower, which is what the number is
    // for — it is not a quality score for the recovered text.
    for (const name of ['Kalpurush-Unicode.ttf', 'NotoSerifBengali-Regular.ttf']) {
      const [, reverse] = await reverseMapFor(name);
      expect(reverse.confidence, name).toBeGreaterThan(0.5);
      expect(reverse.confidence, name).toBeLessThanOrEqual(1);
      expect(reverse.isEmpty, name).toBe(false);
    }
  });
});

/**
 * Builds a PDF that says nothing about what its character codes mean.
 *
 * This is what a careless producer emits: a Type0 font addressed by glyph id,
 * with no `/ToUnicode` and no `/ActualText`. The font is embedded whole so its
 * `GSUB` survives — which is exactly the condition un-shaping needs, and which
 * this package's own subsetter deliberately does not meet.
 */
async function bareGlyphPdf(font: BanglaFont, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 100]);
  const context = doc.context;
  const otf = font.otf;
  const scaled = (v: number) => Math.round((v * 1000) / otf.upem);
  const [xMin, yMin, xMax, yMax] = otf.boundingBox;

  const fileRef = context.register(
    context.flateStream(font.bytes, { Length1: font.bytes.length }),
  );
  const descriptor = context.register(
    context.obj({
      Type: 'FontDescriptor',
      FontName: PDFName.of(otf.postScriptName),
      Flags: 4,
      FontBBox: [scaled(xMin), scaled(yMin), scaled(xMax), scaled(yMax)],
      Ascent: scaled(otf.ascender),
      Descent: scaled(otf.descender),
      ItalicAngle: 0,
      CapHeight: scaled(otf.ascender),
      StemV: 80,
      FontFile2: fileRef,
    }),
  );
  const fontRef = context.register(
    context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: PDFName.of(otf.postScriptName),
      Encoding: 'Identity-H',
      DescendantFonts: [
        context.obj({
          Type: 'Font',
          Subtype: 'CIDFontType2',
          BaseFont: PDFName.of(otf.postScriptName),
          CIDSystemInfo: {
            Registry: PDFString.of('Adobe'),
            Ordering: PDFString.of('Identity'),
            Supplement: 0,
          },
          FontDescriptor: descriptor,
          DW: 1000,
          CIDToGIDMap: 'Identity',
        }),
      ],
      // No /ToUnicode, on purpose.
    }),
  );
  const name = page.node.newFontDictionary('Bare', fontRef);

  const run = font.shape(text, 'Beng');
  const hex = run.glyphs
    .map((g) => g.gid.toString(16).toUpperCase().padStart(4, '0'))
    .join('');
  page.pushOperators(
    PDFOperator.of('BT' as never),
    PDFOperator.of('Tf' as never, [name, '20']),
    PDFOperator.of('Tm' as never, ['1', '0', '0', '1', '20', '40']),
    PDFOperator.of('TJ' as never, [`[<${hex}>]`]),
    PDFOperator.of('ET' as never),
  );
  return doc.save();
}

describe('a document with no text layer of its own', () => {
  it('recovers text where the document gives none', async () => {
    const font = await BanglaFont.load(fontBytes('Kalpurush-Unicode.ttf'));
    const source = 'বাংলাদেশ সরকার';
    const bytes = await bareGlyphPdf(font, source);

    // Nothing in the file says what the codes mean.
    const raw = new TextDecoder('latin1').decode(bytes);
    expect(raw).not.toContain('/ToUnicode');
    expect(raw).not.toContain('/ActualText');

    const result = await extractBanglaText(bytes);
    expect(norm(result.text)).toBe(norm(source));
    // Inference, and reported as such.
    expect(result.confidence).toBeLessThan(1);
  });

  it('leaves a document that does carry its text alone', async () => {
    // The reverse map is a last resort and must never displace a real
    // /ToUnicode, which is authoritative where a reverse map only guesses.
    const { drawBanglaText, loadBanglaFont } = await import('../src/index.js');
    const doc = await PDFDocument.create();
    const font = await loadBanglaFont(fontBytes('Kalpurush-Unicode.ttf'));
    const page = doc.addPage([400, 100]);
    const source = 'গণপ্রজাতন্ত্রী বাংলাদেশ ক্ষ্ম কর্ম';
    drawBanglaText(page, source, { font, x: 20, y: 40, size: 14 });

    const result = await extractBanglaText(await doc.save());
    expect(norm(result.text)).toBe(norm(source));
    expect(result.confidence).toBe(1);
  });
});
