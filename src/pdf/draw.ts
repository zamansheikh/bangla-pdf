/**
 * Painting shaped Bangla onto a pdf-lib page.
 *
 * Spacing glyphs go into a single `TJ` array with no kerning corrections, so a
 * text extractor sees one uninterrupted run and does not invent word breaks.
 * Zero-width attached marks are painted afterwards at absolute positions; they
 * carry no `/ToUnicode` text, so they add nothing to the extracted string.
 *
 * Each line is wrapped in a `/Span <</ActualText …>> BDC … EMC` marked-content
 * span. This is what makes copy/paste survive Bengali's glyph reordering: `কি`
 * draws `ি` first, so no per-glyph mapping alone can express logical order.
 *
 * Ported from the painting half of `lib/src/widgets/shaped_text.dart` in the
 * `bangla_pdf` Dart package.
 */

import type { Color, PDFDocument, PDFPage } from 'pdf-lib';
import {
  PDFName,
  PDFOperator,
  popGraphicsState,
  pushGraphicsState,
  setFillingColor,
  setGraphicsState,
} from 'pdf-lib';

import type { BanglaFont } from '../shaping/font.js';
import { ShapedCidFont, utf16beHex } from './cid-font.js';
import {
  alignOffset,
  justifyShifts,
  layoutBanglaText,
  type LaidOutLine,
  type TextAlign,
  type TextLayout,
} from './layout.js';

export interface DrawBanglaTextOptions {
  /** The font to shape and draw with. Required. */
  font: BanglaFont;
  /** Left edge of the text box, in points from the left of the page. Default 0. */
  x?: number;
  /** Baseline of the first line, in points from the bottom of the page. Default 0. */
  y?: number;
  /** Font size in points. Default 12. */
  size?: number;
  /** Fill colour. Default black. */
  color?: Color;
  /** Fill opacity, 0 to 1. Default 1 (opaque). */
  opacity?: number;
  /** Wrap width in points. Unset means no wrapping. */
  maxWidth?: number;
  /** Baseline-to-baseline distance in points. Default 1.2 times the font's natural height. */
  lineHeight?: number;
  /** Horizontal alignment within [maxWidth]. Default `left`. */
  align?: TextAlign;
  /** Extra space after each cluster, in points. Default 0. */
  letterSpacing?: number;
  /**
   * Fonts to try, in order, for characters [font] has no glyph for.
   *
   * No Bangla typeface covers accented Latin, arrows, symbols or emoji. Bengali
   * is never affected — it is always drawn by [font], and a fallback boundary
   * never falls inside a conjunct.
   */
  fallbackFonts?: BanglaFont[];
}

/** What `drawBanglaText` measured and drew. */
export interface DrawResult extends TextLayout {
  /** Baseline of the last line drawn, in points from the bottom of the page. */
  lastBaseline: number;
}

/** Per-document CID fonts, so one font is embedded once however often it is used. */
const fontsByDoc = new WeakMap<PDFDocument, Map<BanglaFont, ShapedCidFont>>();

/** Per-page resource names, so a font gets one `/Font` entry per page. */
const namesByPage = new WeakMap<PDFPage, Map<ShapedCidFont, PDFName>>();

/** Per-page ExtGState names, keyed by opacity. */
const alphaByPage = new WeakMap<PDFPage, Map<number, PDFName>>();

/**
 * Measures [text] without drawing it.
 *
 * Shapes with HarfBuzz and breaks lines exactly as `drawBanglaText` would, so
 * the returned width and height are what would be drawn.
 */
export function measureBanglaText(
  text: string,
  options: Omit<DrawBanglaTextOptions, 'x' | 'y' | 'color' | 'opacity'>,
): TextLayout {
  return layoutBanglaText(text, {
    font: options.font,
    size: options.size ?? 12,
    fallbackFonts: options.fallbackFonts,
    maxWidth: options.maxWidth,
    lineHeight: options.lineHeight,
    letterSpacing: options.letterSpacing,
    align: options.align,
  });
}

/**
 * Draws correctly shaped Bangla onto [page].
 *
 * ```ts
 * const doc = await PDFDocument.create();
 * const font = await loadBanglaFont();
 * const page = doc.addPage();
 * drawBanglaText(page, 'আমার সোনার বাংলা', { font, x: 50, y: 700, size: 24 });
 * const bytes = await doc.save();
 * ```
 *
 * The font is embedded when the document is saved, by which time every glyph
 * the document draws is known and only those are embedded.
 */
export function drawBanglaText(
  page: PDFPage,
  text: string,
  options: DrawBanglaTextOptions,
): DrawResult {
  const size = options.size ?? 12;
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const align = options.align ?? 'left';

  const layout = layoutBanglaText(text, {
    font: options.font,
    size,
    fallbackFonts: options.fallbackFonts,
    maxWidth: options.maxWidth,
    lineHeight: options.lineHeight,
    letterSpacing: options.letterSpacing,
    align,
  });

  const doc = page.doc;
  const operators: PDFOperator[] = [pushGraphicsState()];
  if (options.color) operators.push(setFillingColor(options.color));
  if (options.opacity !== undefined && options.opacity < 1) {
    operators.push(setGraphicsState(alphaStateFor(page, options.opacity)));
  }

  // Alignment needs a box to align in; without maxWidth there is none, so the
  // widest line stands in for it and `left` and `justify` behave identically.
  const available = options.maxWidth ?? layout.width;

  let baseline = y;
  for (let i = 0; i < layout.lines.length; i++) {
    const line = layout.lines[i]!;
    baseline = y - i * layout.lineHeight;
    if (line.glyphs.length === 0) continue;
    const originX = x + alignOffset(align, available, line.visualWidth);
    const shifts = align === 'justify' ? justifyShifts(line, available) : null;
    paintLine(page, doc, operators, line, originX, baseline, size, shifts);
  }

  operators.push(popGraphicsState());
  page.pushOperators(...operators);

  return { ...layout, lastBaseline: baseline };
}

function paintLine(
  page: PDFPage,
  doc: PDFDocument,
  operators: PDFOperator[],
  line: LaidOutLine,
  originX: number,
  baseline: number,
  size: number,
  shifts: number[] | null,
): void {
  const flow: Array<{ glyph: (typeof line.glyphs)[number]; shift: number }> = [];
  const marks: Array<{ glyph: (typeof line.glyphs)[number]; shift: number }> = [];
  for (let i = 0; i < line.glyphs.length; i++) {
    const glyph = line.glyphs[i]!;
    const shift = shifts === null ? 0 : shifts[i]!;
    if (glyph.advance === 0 && (glyph.x !== 0 || glyph.yOffset !== 0)) {
      marks.push({ glyph, shift });
    } else {
      flow.push({ glyph, shift });
    }
  }

  const spanned = line.text.length > 0;
  if (spanned) {
    operators.push(
      PDFOperator.of('BDC' as never, ['/Span', `<</ActualText <FEFF${utf16beHex(line.text)}>>>`]),
    );
  }

  // Consecutive glyphs sharing a font go out as one show, so a fallback costs
  // an extra text object only where the font actually changes.
  let i = 0;
  while (i < flow.length) {
    const runFont = flow[i]!.glyph.font;
    const cidFont = cidFontFor(doc, runFont);
    const name = resourceNameFor(page, cidFont);
    const scale = size / runFont.unitsPerEm;
    const startX = originX + flow[i]!.glyph.x + flow[i]!.shift;

    let pen = startX;
    let array = '[';
    while (i < flow.length && flow[i]!.glyph.font === runFont) {
      const { glyph, shift } = flow[i]!;
      const want = originX + glyph.x + shift;
      // TJ numbers move the pen left, in thousandths of the font size.
      const adjust = Math.round(((pen - want) * 1000) / size);
      if (adjust !== 0) array += `${adjust} `;
      array += `<${hex4(cidFont.cidFor(glyph.gid, glyph.text, glyph.advance))}>`;
      pen = want + glyph.advance * scale;
      i++;
    }
    array += ']';

    operators.push(
      PDFOperator.of('BT' as never),
      PDFOperator.of('Tf' as never, [name, String(size)]),
      PDFOperator.of('Tm' as never, ['1', '0', '0', '1', fmt(startX), fmt(baseline)]),
      PDFOperator.of('TJ' as never, [array]),
      PDFOperator.of('ET' as never),
    );
  }

  for (const { glyph, shift } of marks) {
    const cidFont = cidFontFor(doc, glyph.font);
    const name = resourceNameFor(page, cidFont);
    const cid = cidFont.cidFor(glyph.gid, glyph.text, glyph.advance);
    operators.push(
      PDFOperator.of('BT' as never),
      PDFOperator.of('Tf' as never, [name, String(size)]),
      PDFOperator.of('Tm' as never, [
        '1',
        '0',
        '0',
        '1',
        fmt(originX + glyph.x + shift),
        fmt(baseline + glyph.yOffset),
      ]),
      PDFOperator.of('TJ' as never, [`[<${hex4(cid)}>]`]),
      PDFOperator.of('ET' as never),
    );
  }

  if (spanned) operators.push(PDFOperator.of('EMC' as never));
}

/**
 * The CID font for [font] in [doc], created on first use.
 *
 * Creating it also arranges for it to be written when the document is saved:
 * pdf-lib flushes everything in its font list before serialising, and the list
 * asks only for an `embed()` method.
 */
function cidFontFor(doc: PDFDocument, font: BanglaFont): ShapedCidFont {
  let byFont = fontsByDoc.get(doc);
  if (!byFont) {
    byFont = new Map();
    fontsByDoc.set(doc, byFont);
  }
  let cidFont = byFont.get(font);
  if (!cidFont) {
    cidFont = new ShapedCidFont(doc, font);
    byFont.set(font, cidFont);
    const embeddables = (doc as unknown as { fonts?: Array<{ embed: () => Promise<void> }> }).fonts;
    if (Array.isArray(embeddables)) {
      const target = cidFont;
      embeddables.push({
        embed: async () => {
          target.embed();
        },
      });
    }
  }
  return cidFont;
}

/**
 * Embeds every Bangla font used in [doc].
 *
 * `PDFDocument.save()` already does this, so calling it is only necessary when
 * a document is serialised by some other route.
 */
export function embedBanglaFonts(doc: PDFDocument): void {
  const byFont = fontsByDoc.get(doc);
  if (!byFont) return;
  for (const cidFont of byFont.values()) cidFont.embed();
}

function resourceNameFor(page: PDFPage, cidFont: ShapedCidFont): PDFName {
  let byFont = namesByPage.get(page);
  if (!byFont) {
    byFont = new Map();
    namesByPage.set(page, byFont);
  }
  let name = byFont.get(cidFont);
  if (!name) {
    name = page.node.newFontDictionary('BnF', cidFont.ref);
    byFont.set(cidFont, name);
  }
  return name;
}

function alphaStateFor(page: PDFPage, opacity: number): PDFName {
  let byAlpha = alphaByPage.get(page);
  if (!byAlpha) {
    byAlpha = new Map();
    alphaByPage.set(page, byAlpha);
  }
  let name = byAlpha.get(opacity);
  if (!name) {
    name = page.node.newExtGState(
      'BnGS',
      page.doc.context.obj({ Type: 'ExtGState', ca: opacity }),
    );
    byAlpha.set(opacity, name);
  }
  return name;
}

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** Six decimal places is more precision than a PDF point can express. */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, '');
}
