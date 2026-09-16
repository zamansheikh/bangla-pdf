/**
 * Walks a page's content stream and produces text runs.
 *
 * Only the text operators matter here. Everything else is skipped, including
 * paths and images — except that an image with no accompanying text is what
 * tells us a page is a scan.
 *
 * Ported from `lib/src/extract/content_stream.dart` in the `bangla_pdf` Dart
 * package.
 */

import type { FontInfo } from './font-info.js';
import { PdfLexer } from './lexer.js';
import { asLatin1, asUtf16, get, type PdfObj, type PdfStringObj } from './objects.js';

/**
 * Stands for a large negative `TJ` adjustment inside a collected glyph run: the
 * way most producers write a space without drawing one. Glyph ids are never
 * negative, so it cannot be mistaken for a glyph.
 */
export const WORD_GAP = -1;

/**
 * Operators that end a run of glyphs being collected for reading back.
 *
 * Text objects and positioning are deliberately absent. Word places every glyph
 * with its own `Tm`, and on a justified line gives every glyph its own `BT` …
 * `ET` as well, so neither says where a word ends. Geometry does: a run carries
 * on while each glyph starts where the last one finished, gains a word gap when
 * there is empty space between them, and ends when the line changes.
 *
 * Marked content is absent too, for the same reason: a tagged PDF wraps every
 * text object in a structure tag (`/P <</MCID 13>> BDC … EMC`). Only a span that
 * carries `/ActualText` changes what its glyphs mean, and that is handled where
 * the span opens and closes.
 *
 * So is the graphics state. Word clips each glyph of a table cell to the cell
 * with `q … re W* n … Q`, mid-word, and a transformation is taken into account
 * by comparing positions in device space.
 */
const RUN_BREAKING_OPERATORS = new Set(["'", '"', 'Do', 'BI']);


/** One run of text drawn with a single font. */
export interface TextRun {
  /** The text as recovered from the font's own mapping, before any Bijoy conversion. */
  text: string;
  /** The font it was drawn with, or null when the resource was missing. */
  font: FontInfo | null;
  /** Position in device space; enough to order runs on the page. */
  x: number;
  y: number;
  /** Size in text space units. */
  fontSize: number;
  /**
   * Which text object (`BT` … `ET`) this run came from.
   *
   * Producers that lay out word by word emit one text object per word and no
   * space glyph between them. A change of text object on the same line
   * therefore implies a space.
   */
  objectIndex: number;
}

/** What a page walk found. */
export interface PageContent {
  /** Text runs in content-stream order. */
  runs: TextRun[];
  /** How many images the page draws. A page with images and no text is a scan. */
  imageCount: number;
  /**
   * Whether any `/ActualText` span was honoured, which means the producer told
   * us the logical text directly.
   */
  actualTextUsed: boolean;
}

/**
 * Extracts the text runs of one page.
 *
 * [fonts] maps a resource name to its parsed font.
 */
export function walkContentStream(
  content: Uint8Array,
  fonts: Map<string, FontInfo>,
): PageContent {
  const lexer = new PdfLexer(content);
  let operands: PdfObj[] = [];
  const runs: TextRun[] = [];
  let imageCount = 0;
  let actualTextUsed = false;

  let currentFont: FontInfo | null = null;
  let fontSize = 0;
  // Text-space translation.
  let tx = 0;
  let ty = 0;

  // The current transformation matrix, as [a, b, c, d, e, f]. Producers often
  // wrap each block in its own `cm`, so text-space coordinates repeat and only
  // the CTM separates one line from the next.
  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack: number[][] = [];
  let objectIndex = 0;
  let lineX = 0;
  let lineY = 0;
  let leading = 0;

  // /ActualText replaces everything drawn inside its marked-content span. The
  // span is emitted at the position of the first glyph *inside* it, not at the
  // BDC, which is typically still at the origin.
  const actualTextStack: (string | null)[] = [];
  let suppressDepth = 0;
  let pendingActualText: string | null = null;

  const numOf = (o: PdfObj | undefined): number =>
    o !== undefined && o.kind === 'num' ? o.value : 0;

  /** Device-space position of the current text origin. */
  const devicePosition = (): [number, number] => [
    ctm[0]! * tx + ctm[2]! * ty + ctm[4]!,
    ctm[1]! * tx + ctm[3]! * ty + ctm[5]!,
  ];

  const push = (text: string, font: FontInfo | null = currentFont): void => {
    const [x, y] = devicePosition();
    runs.push({ text, font, x, y, fontSize, objectIndex });
  };

  // Glyphs from a font whose mapping cannot be trusted, collected until the run
  // they belong to ends. They are read back through the font as a whole,
  // because Bengali is drawn out of typing order and a producer is free to split
  // a cluster across operators: Word shows one glyph per `Tj`, so no single
  // operator ever holds a vowel sign together with the consonant it precedes.
  let glyphRun: number[] = [];
  let glyphRunFont: FontInfo | null = null;
  // Where the run started. Positioning inside it moves the pen, so the run is
  // placed where its first glyph was drawn, not where the pen ends up.
  let glyphRunAt: Omit<TextRun, 'text' | 'font'> | null = null;
  // Device x where the run's next glyph would start if nothing moved the pen,
  // and the pen position the last show began from. This parser does not
  // advance the pen on a show, so an unchanged position means "continue".
  let glyphRunPenX = 0;
  let lastShowAt: [number, number] | null = null;

  const flushGlyphRun = (): void => {
    const font = glyphRunFont;
    const codes = glyphRun;
    const at = glyphRunAt;
    glyphRun = [];
    glyphRunFont = null;
    glyphRunAt = null;
    lastShowAt = null;
    if (font === null || at === null || codes.length === 0) return;
    const text = font.unshapeRun(codes);
    if (text.length > 0) runs.push({ text, font, ...at });
  };

  /**
   * Adds the glyphs of one show to the pending run.
   *
   * [width] is how far the show moves the pen, in text space units per unit of
   * font size, as drawn — glyph advances less any `TJ` adjustments.
   */
  const collect = (font: FontInfo, codes: number[], width: number): void => {
    if (!codes.some((code) => code >= 0)) {
      // Nothing drawn, but perhaps a space meant: see [shownCodes].
      if (codes.includes(WORD_GAP) && glyphRunAt !== null && glyphRun[glyphRun.length - 1] !== WORD_GAP) {
        glyphRun.push(WORD_GAP);
      }
      return;
    }
    const [x, y] = devicePosition();
    const scale = Math.abs(ctm[0]!) || 1;
    const em = fontSize * scale;

    if (glyphRunAt !== null) {
      const sameLine = Math.abs(y - glyphRunAt.y) <= Math.max(glyphRunAt.fontSize, fontSize) * 0.4;
      if (glyphRunFont !== font || !sameLine) flushGlyphRun();
    }

    const moved = lastShowAt === null || lastShowAt[0] !== x || lastShowAt[1] !== y;
    const start = glyphRunAt === null || moved ? x : glyphRunPenX;
    if (glyphRunAt === null) {
      glyphRunAt = { x, y, fontSize, objectIndex };
    } else if (start - glyphRunPenX > em * 0.25 && glyphRun[glyphRun.length - 1] !== WORD_GAP) {
      // Empty space between the last glyph and this one, with nothing drawn in
      // it: a word gap written by moving the pen rather than with a space.
      glyphRun.push(WORD_GAP);
    }

    glyphRunFont = font;
    glyphRun.push(...codes);
    glyphRunPenX = start + width * em;
    lastShowAt = [x, y];
  };

  /**
   * The glyph codes one string shows, for reading glyphs back.
   *
   * Word writes the spaces of Bangla text as `( ) TJ` — a single space byte
   * with the two-byte font still selected. That byte names no glyph and moves
   * no pen in [FontInfo.glyphCodes], but it is where the author typed a space,
   * and the next word is often placed less than a quarter em further on.
   */
  const shownCodes = (font: FontInfo, bytes: Uint8Array): number[] => {
    const codes = font.glyphCodes(bytes);
    if (font.twoByte && bytes.length % 2 === 1 && bytes[bytes.length - 1] === 0x20) codes.push(WORD_GAP);
    return codes;
  };

  /** How far [codes] move the pen, in units of the font size. */
  const widthOf = (font: FontInfo, codes: number[]): number => {
    const face = font.embedded;
    if (face === null || face.upem === 0) return 0;
    let units = 0;
    for (const code of codes) if (code >= 0) units += face.advance(font.glyphFor(code));
    return units / face.upem;
  };

  const emit = (text: string, font: FontInfo | null = currentFont): void => {
    // An empty show is how a producer reopens a text object after a marked
    // content operator; it must not decide where the span sits.
    if (text.length === 0) return;
    if (pendingActualText !== null) {
      const pending = pendingActualText;
      pendingActualText = null;
      push(pending);
    }
    if (suppressDepth > 0) return; // inside an /ActualText span
    push(text, font);
  };

  /** Whether glyphs shown with [font] are collected and read back as a run. */
  const readsGlyphsBack = (font: FontInfo): boolean =>
    font.textMappingUntrusted && suppressDepth === 0 && pendingActualText === null;

  const decode = (s: PdfStringObj): string => {
    const font = currentFont;
    if (font === null) return asLatin1(s);

    // Nothing trustworthy says what these codes mean — no mapping at all, or a
    // /ToUnicode that contradicts the font it describes — so read the glyphs
    // back through the embedded font instead. Never for a font whose mapping
    // agrees with it: that is authoritative, and this is inference.
    if (font.textMappingUntrusted) {
      const unshaped = font.unshape(font.codes(s.bytes));
      if (unshaped !== null) return unshaped;
    }

    let out = '';
    for (const code of font.codes(s.bytes)) {
      const mapped = font.unicodeFor(code);
      if (mapped !== null) out += mapped;
      else if (!font.twoByte && code >= 0x20 && code < 0x100) out += String.fromCharCode(code);
    }
    return out;
  };

  for (;;) {
    const token = lexer.next();
    if (token === null) break;
    if (token.kind !== 'op') {
      operands.push(token);
      if (operands.length > 64) operands.shift();
      continue;
    }

    // A run ends at anything that moves the pen to a new place or changes what
    // the glyphs mean: a new text object or line, a transformation, a marked-
    // content boundary, an image. Colour and spacing changes do not end it; a
    // font change is caught when the next glyph arrives.
    if (RUN_BREAKING_OPERATORS.has(token.name)) flushGlyphRun();

    switch (token.name) {
      case 'q':
        ctmStack.push([...ctm]);
        break;
      case 'Q':
        if (ctmStack.length > 0) ctm = ctmStack.pop()!;
        break;
      case 'cm':
        if (operands.length >= 6) {
          const m: number[] = [];
          for (let i = 6; i >= 1; i--) m.push(numOf(operands[operands.length - i]));
          // CTM' = m x CTM
          ctm = [
            m[0]! * ctm[0]! + m[1]! * ctm[2]!,
            m[0]! * ctm[1]! + m[1]! * ctm[3]!,
            m[2]! * ctm[0]! + m[3]! * ctm[2]!,
            m[2]! * ctm[1]! + m[3]! * ctm[3]!,
            m[4]! * ctm[0]! + m[5]! * ctm[2]! + ctm[4]!,
            m[4]! * ctm[1]! + m[5]! * ctm[3]! + ctm[5]!,
          ];
        }
        break;
      case 'BT':
        objectIndex++;
        tx = ty = lineX = lineY = 0;
        break;
      case 'ET':
        break;
      case 'Tf':
        if (operands.length >= 2) {
          const resourceName = operands[operands.length - 2]!;
          if (resourceName.kind === 'name') currentFont = fonts.get(resourceName.value) ?? null;
          fontSize = numOf(operands[operands.length - 1]);
        }
        break;
      case 'TL':
        if (operands.length > 0) leading = numOf(operands[operands.length - 1]);
        break;
      case 'Td':
        if (operands.length >= 2) {
          lineX += numOf(operands[operands.length - 2]);
          lineY += numOf(operands[operands.length - 1]);
          tx = lineX;
          ty = lineY;
        }
        break;
      case 'TD':
        if (operands.length >= 2) {
          leading = -numOf(operands[operands.length - 1]);
          lineX += numOf(operands[operands.length - 2]);
          lineY += numOf(operands[operands.length - 1]);
          tx = lineX;
          ty = lineY;
        }
        break;
      case 'Tm':
        if (operands.length >= 6) {
          lineX = numOf(operands[operands.length - 2]);
          lineY = numOf(operands[operands.length - 1]);
          tx = lineX;
          ty = lineY;
        }
        break;
      case 'T*':
        lineY -= leading;
        tx = lineX;
        ty = lineY;
        break;
      case 'Tj':
      case "'":
      case '"': {
        if (token.name !== 'Tj') {
          lineY -= leading;
          tx = lineX;
          ty = lineY;
        }
        const s = operands[operands.length - 1];
        if (s === undefined || s.kind !== 'string') break;
        if (currentFont !== null && readsGlyphsBack(currentFont)) {
          const codes = shownCodes(currentFont, s.bytes);
          collect(currentFont, codes, widthOf(currentFont, codes));
        } else {
          flushGlyphRun();
          emit(decode(s));
        }
        break;
      }
      case 'TJ': {
        const arr = operands[operands.length - 1];
        if (arr !== undefined && arr.kind === 'array') {
          const font = currentFont;
          if (font !== null && readsGlyphsBack(font)) {
            const codes: number[] = [];
            let width = 0;
            for (const item of arr.values) {
              if (item.kind === 'string') {
                const shown = shownCodes(font, item.bytes);
                codes.push(...shown);
                width += widthOf(font, shown);
              } else if (item.kind === 'num') {
                // Adjustments are in thousandths of the font size, subtracted.
                width -= item.value / 1000;
                if (item.value <= -120) codes.push(WORD_GAP);
              }
            }
            collect(font, codes, width);
            break;
          }
          flushGlyphRun();
          let out = '';
          for (const item of arr.values) {
            if (item.kind === 'string') out += decode(item);
            else if (item.kind === 'num' && item.value <= -120) {
              // A large negative kern is how most producers write a space.
              out += ' ';
            }
          }
          emit(out);
        }
        break;
      }
      case 'BDC': {
        let actual: string | null = null;
        if (operands.length >= 2) {
          const props = operands[operands.length - 1]!;
          if (props.kind === 'dict') {
            const at = get(props, 'ActualText');
            if (at.kind === 'string') actual = asUtf16(at.bytes);
          }
        }
        actualTextStack.push(actual);
        if (actual !== null) {
          flushGlyphRun();
          // The span's own text is authoritative; the glyphs inside it are
          // ignored, and it is positioned by the first of them.
          pendingActualText = actual;
          actualTextUsed = true;
          suppressDepth++;
        }
        break;
      }
      case 'BMC':
        actualTextStack.push(null);
        break;
      case 'EMC':
        if (actualTextStack.length > 0) {
          const popped = actualTextStack.pop()!;
          if (popped !== null) {
            flushGlyphRun();
            if (suppressDepth > 0) suppressDepth--;
            // A span that drew nothing still carries its text.
            if (pendingActualText !== null) {
              const pending = pendingActualText;
              pendingActualText = null;
              push(pending);
            }
          }
        }
        break;
      case 'Do':
        // An XObject: could be an image or a nested form. Counting it is enough
        // to recognise a scanned page.
        imageCount++;
        break;
      case 'BI':
        imageCount++;
        break;
      default:
        break;
    }
    operands = [];
  }
  flushGlyphRun();

  return { runs, imageCount, actualTextUsed };
}
