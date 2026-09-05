/**
 * bangla-pdf/extract — reading Bangla text out of a PDF.
 *
 * A separate entry point on purpose: importing `bangla-pdf` to *generate* a PDF
 * costs nothing from this file, and this file needs no pdf-lib.
 *
 * ```ts
 * import { extractBanglaText } from 'bangla-pdf/extract';
 *
 * const result = await extractBanglaText(bytes);
 * console.log(result.encoding); // 'unicode' | 'bijoy' | 'mixed' | 'none'
 * console.log(result.text);
 * ```
 *
 * It handles three kinds of document:
 *
 *  * **Unicode** — a modern PDF with a `/ToUnicode` CMap, or `/ActualText`
 *    spans like the ones this package writes. Read directly.
 *  * **Bijoy / ANSI** — the legacy encoding behind most Bangladeshi government
 *    and newspaper PDFs. The text layer is Latin-1 mojibake
 *    (`Avgvi ‡mvbvi evsjv`); it is converted back to Unicode per text run,
 *    because only the run's font can tell Bijoy bytes from real English.
 *  * **Scanned** — no text layer at all. Reported as `none`, with `ocrHook`
 *    available to plug in an OCR engine.
 */

import type { OtFont } from './ot/ot-font.js';
import { bijoyConfidence, bijoyToUnicode } from './extract/bijoy.js';
import { walkContentStream } from './extract/content-stream.js';
import { FontInfo } from './extract/font-info.js';
import type { Replay } from './extract/glyph-reverse.js';
import type { ReplayFactory } from './extract/font-info.js';
import { get, type PdfDictObj } from './extract/objects.js';
import { PdfReader } from './extract/reader.js';
import { loadHarfBuzz } from './shaping/harfbuzz.js';

export { bijoyToUnicode, bijoyConfidence, looksLikeBijoyFontName } from './extract/bijoy.js';
export { PdfReader } from './extract/reader.js';
export { GlyphReverseMap } from './extract/glyph-reverse.js';

/** How the Bangla in a document was encoded. */
export type BanglaTextEncoding =
  /** Real Unicode, read straight out of the text layer. */
  | 'unicode'
  /** Legacy Bijoy/ANSI, converted back to Unicode. */
  | 'bijoy'
  /** Both, in different runs — common when a Bijoy document was partly re-typed. */
  | 'mixed'
  /** No text layer: a scan, or a document whose text could not be read. */
  | 'none';

/** One extracted page. */
export interface ExtractedPage {
  /** 1-based page number. */
  number: number;
  /** The page's text, in reading order. */
  text: string;
  /** How this page's Bangla was encoded. */
  encoding: BanglaTextEncoding;
  /** Whether the page draws any image. */
  hasImages: boolean;
}

/** The result of extracting a document. */
export interface ExtractionResult {
  /** Every page's text, joined by a blank line. */
  text: string;
  /** Per-page results. */
  pages: ExtractedPage[];
  /** How the document as a whole was encoded. */
  encoding: BanglaTextEncoding;
  /**
   * Rough confidence in the extraction, 0 to 1.
   *
   * 1 means the document told us its text outright (`/ActualText` or a complete
   * `/ToUnicode` CMap). Lower values mean more was inferred — a Bijoy
   * conversion, or a font with no usable mapping.
   */
  confidence: number;
  /**
   * Whether the document is encrypted.
   *
   * Encryption on its own is no obstacle: most protected PDFs carry an owner
   * password and an empty user password, and are decrypted transparently. See
   * [isLocked] for the case that actually blocks reading.
   */
  isEncrypted: boolean;
  /**
   * Whether the document is encrypted and could not be opened — a password is
   * genuinely required, or the handler is one this does not implement. The text
   * will be empty.
   */
  isLocked: boolean;
  /** Whether any Bangla was found. */
  hasBangla: boolean;
}

/**
 * Called for a page with no text layer, to supply text from elsewhere.
 *
 * This package does not bundle OCR. Wire in whatever engine you already have —
 * Tesseract with the `ben` language data is the usual choice.
 */
export type BanglaOcrHook = (page: ExtractedPage) => string | null | undefined;

export interface ExtractOptions {
  /**
   * Opens a document that needs a password. Most protected PDFs do not: they
   * carry an owner password and an empty user password, so they are decrypted
   * without one.
   */
  password?: string;
  /** Called for each page with no text layer. */
  ocrHook?: BanglaOcrHook;
}

const BENGALI = /[ঀ-৿]/;

/**
 * Extracts the Bangla text of [bytes].
 *
 * Never throws: an unreadable document comes back as an empty result with
 * encoding `none` rather than an exception, because the documents most worth
 * extracting are also the most likely to be damaged.
 *
 * Asynchronous only because HarfBuzz is loaded from WebAssembly. It is used to
 * check a guess when a document carries no text mapping at all and the glyphs
 * have to be read backwards; everything else is synchronous.
 */
export async function extractBanglaText(
  bytes: Uint8Array,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const replayFactory = await makeReplayFactory();
  const reader = PdfReader.open(bytes, options.password ?? '');
  if (reader === null) {
    return {
      text: '',
      pages: [],
      encoding: 'none',
      confidence: 0,
      isEncrypted: false,
      isLocked: false,
      hasBangla: false,
    };
  }

  const pages: ExtractedPage[] = [];
  let sawUnicode = false;
  let sawBijoy = false;
  let certainty = 0;
  let counted = 0;

  const pageDicts = reader.pages();
  for (let i = 0; i < pageDicts.length; i++) {
    const pageDict = pageDicts[i]!;
    const fonts = fontsOf(reader, pageDict, replayFactory);
    const content = walkContentStream(reader.contentOf(pageDict), fonts);

    let buffer = '';
    let pageUnicode = false;
    let pageBijoy = false;
    let mapped = 0;
    let unmapped = 0;

    let lastY: number | null = null;
    let lastObject = -1;
    for (const run of content.runs) {
      if (run.text.length === 0) continue;
      if (lastY !== null && Math.abs(lastY - run.y) > run.fontSize * 0.4) {
        // A change in device-space Y is a new line.
        buffer += '\n';
      } else if (lastY !== null && run.objectIndex !== lastObject && needsSpaceBetween(buffer, run.text)) {
        // Same line, new text object: a word-by-word producer drew a space by
        // repositioning rather than by emitting one.
        buffer += ' ';
      }
      lastY = run.y;
      lastObject = run.objectIndex;

      const font = run.font;
      // Only a run's own font can say whether its bytes are Bijoy: the byte 'e'
      // is English "e" in one font and ব in another.
      const treatAsBijoy = font !== null && font.isBijoy && bijoyConfidence(run.text) > 0;
      if (treatAsBijoy) {
        buffer += bijoyToUnicode(run.text);
        pageBijoy = true;
        mapped++;
      } else {
        buffer += run.text;
        if (BENGALI.test(run.text)) pageUnicode = true;
        if (font === null || font.toUnicode.size === 0) unmapped++;
        else mapped++;
      }
    }

    let text = buffer.trim();
    let page: ExtractedPage = {
      number: i + 1,
      text,
      encoding: classify(pageUnicode, pageBijoy, text),
      hasImages: content.imageCount > 0,
    };

    if (text.length === 0 && options.ocrHook !== undefined) {
      const recovered = options.ocrHook(page);
      if (recovered !== null && recovered !== undefined && recovered.length > 0) {
        text = recovered;
        page = { ...page, text, encoding: 'unicode' };
      }
    }

    pages.push(page);
    if (pageUnicode) sawUnicode = true;
    if (pageBijoy) sawBijoy = true;

    if (text.length > 0) {
      counted++;
      certainty += content.actualTextUsed
        ? 1
        : mapped + unmapped === 0
          ? 0
          : (mapped / (mapped + unmapped)) * (pageBijoy ? 0.85 : 1);
    }
  }

  const joined = pages
    .map((p) => p.text)
    .filter((t) => t.length > 0)
    .join('\n\n');

  return {
    text: joined,
    pages,
    encoding: classify(sawUnicode, sawBijoy, joined),
    confidence: counted === 0 ? 0 : Math.min(1, Math.max(0, certainty / counted)),
    isEncrypted: reader.isEncrypted,
    isLocked: reader.isLocked,
    hasBangla: BENGALI.test(joined),
  };
}

/** Punctuation that binds to the word before it, so no space is inserted. */
const BINDS_LEFT = '.,:;!?)]}»%/।॥’”';

/** Punctuation that binds to the word after it. */
const BINDS_RIGHT = '([{«/‘“';

/** Whether a space belongs between two runs drawn as separate text objects. */
function needsSpaceBetween(before: string, next: string): boolean {
  if (before.length === 0 || next.length === 0) return false;
  if (before.endsWith(' ') || before.endsWith('\n')) return false;
  if (next.startsWith(' ')) return false;
  const last = before[before.length - 1]!;
  if (BINDS_LEFT.includes(next[0]!)) return false;
  if (BINDS_RIGHT.includes(last)) return false;
  // A separator *between digits* is part of a number or a date rather than the
  // end of a sentence: ৪৬.০০, ০১/০৯/২০২৬, ৳১২,৫০০. It has to be flanked by
  // digits, or "তারিখ:০১" would lose its space too.
  if (
    './,:-'.includes(last) &&
    before.length >= 2 &&
    isDigit(before.charCodeAt(before.length - 2)) &&
    isDigit(next.charCodeAt(0))
  ) {
    return false;
  }
  return true;
}

function isDigit(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x09e6 && c <= 0x09ef);
}

function classify(unicode: boolean, bijoy: boolean, text: string): BanglaTextEncoding {
  if (text.trim().length === 0) return 'none';
  if (unicode && bijoy) return 'mixed';
  if (bijoy) return 'bijoy';
  return 'unicode';
}

function fontsOf(
  reader: PdfReader,
  page: PdfDictObj,
  replayFactory: ReplayFactory | null,
): Map<string, FontInfo> {
  const out = new Map<string, FontInfo>();
  const resources = reader.resolve(get(page, 'Resources'));
  if (resources.kind !== 'dict') return out;
  const fonts = reader.resolve(get(resources, 'Font'));
  if (fonts.kind !== 'dict') return out;
  for (const [key, value] of fonts.entries) {
    const d = reader.resolve(value);
    if (d.kind === 'dict') out.set(key, FontInfo.parse(reader, d, replayFactory));
  }
  return out;
}

/**
 * Builds the "shape this candidate again and see if the glyphs match" hook that
 * un-shaping uses to check its guesses.
 *
 * Returns null when HarfBuzz cannot be loaded, in which case un-shaping still
 * works but keeps its first reading instead of verifying it.
 */
async function makeReplayFactory(): Promise<ReplayFactory | null> {
  let hb: Awaited<ReturnType<typeof loadHarfBuzz>>;
  try {
    hb = await loadHarfBuzz();
  } catch {
    return null;
  }
  return (_font: OtFont, bytes: Uint8Array): Replay | null => {
    try {
      const face = new hb.Face(new hb.Blob(bytes), 0);
      const hbFont = new hb.Font(face);
      return (text: string): number[] => {
        const buffer = new hb.Buffer();
        let index = 0;
        for (const ch of text) {
          buffer.add(ch.codePointAt(0)!, index);
          index += ch.length;
        }
        buffer.setDirection(hb.Direction.LTR);
        buffer.setScript('Beng');
        buffer.setLanguage('en');
        hb.shape(hbFont, buffer);
        return buffer.getGlyphInfosAndPositions().map((g) => g.codepoint);
      };
    } catch {
      return null;
    }
  };
}
