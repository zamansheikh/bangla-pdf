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

  const push = (text: string): void => {
    const [x, y] = devicePosition();
    runs.push({ text, font: currentFont, x, y, fontSize, objectIndex });
  };

  const emit = (text: string): void => {
    // An empty show is how a producer reopens a text object after a marked
    // content operator; it must not decide where the span sits.
    if (text.length === 0) return;
    if (pendingActualText !== null) {
      const pending = pendingActualText;
      pendingActualText = null;
      push(pending);
    }
    if (suppressDepth > 0) return; // inside an /ActualText span
    push(text);
  };

  const decode = (s: PdfStringObj): string => {
    const font = currentFont;
    if (font === null) return asLatin1(s);

    // Nothing in the document says what these codes mean, so read the glyphs
    // back through the embedded font. Last resort, and only for a font that
    // offers no mapping at all.
    if (font.hasNoTextMapping) {
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
        if (s !== undefined && s.kind === 'string') emit(decode(s));
        break;
      }
      case 'TJ': {
        const arr = operands[operands.length - 1];
        if (arr !== undefined && arr.kind === 'array') {
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

  return { runs, imageCount, actualTextUsed };
}
