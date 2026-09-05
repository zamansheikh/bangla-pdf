/**
 * Laying shaped Bangla out into lines.
 *
 * Text is shaped once per (font, script) run, measured cluster by cluster, and
 * wrapped on cluster boundaries so a line can never break inside a conjunct or
 * between a vowel sign and its consonant.
 *
 * Ported from the layout half of `lib/src/widgets/shaped_text.dart` in the
 * `bangla_pdf` Dart package. The painting half lives in `draw.ts`.
 */

import type { BanglaFont } from '../shaping/font.js';
import type { ShapedGlyph } from '../shaping/harfbuzz.js';

export type TextAlign = 'left' | 'center' | 'right' | 'justify';

/** One laid-out glyph, positioned relative to the start of its line. */
export interface PlacedGlyph {
  /** The font this glyph id belongs to. With a fallback chain, one line can draw from several. */
  font: BanglaFont;
  gid: number;
  /** Pen position for this glyph, in points from the line start. */
  x: number;
  /** Vertical offset from the baseline, in points. */
  yOffset: number;
  /** Advance in font units, after GPOS. Written into the font's `/W` array. */
  advance: number;
  /**
   * The source text this glyph is responsible for in `/ToUnicode`.
   *
   * The first spacing glyph of a cluster carries the cluster's whole text; the
   * rest carry none, so extraction yields logical order even though the glyphs
   * are in visual order.
   */
  text: string;
}

export interface LaidOutLine {
  glyphs: PlacedGlyph[];
  /** Full advance width including trailing spaces. */
  width: number;
  /** Width up to the last non-space glyph, used to centre or right-align. */
  visualWidth: number;
  /** The source text of this line, in logical order, for `/ActualText`. */
  text: string;
  /** Whether this line ends its paragraph — such a line is left ragged under justify. */
  endsParagraph: boolean;
}

export interface TextLayout {
  lines: LaidOutLine[];
  /** Widest line, in points. */
  width: number;
  /** Total height of all lines, in points. */
  height: number;
  /** Distance from the top of a line box to its baseline, in points. */
  ascent: number;
  /** Baseline-to-baseline distance, in points. */
  lineHeight: number;
}

export interface LayoutOptions {
  font: BanglaFont;
  size: number;
  fallbackFonts?: BanglaFont[];
  maxWidth?: number;
  /** Baseline-to-baseline distance in points. Defaults to 1.2 times the font's natural height. */
  lineHeight?: number;
  letterSpacing?: number;
  align?: TextAlign;
}

/** One shaped cluster, tagged with the font that produced it. */
interface Cluster {
  font: BanglaFont;
  glyphs: ShapedGlyph[];
  /** What each glyph is responsible for in `/ToUnicode`, aligned with [glyphs]. */
  glyphTexts: string[];
  text: string;
  /** Advance width in points, including letter spacing. */
  width: number;
}

/** Lays [text] out. Line breaks in the string start new paragraphs. */
export function layoutBanglaText(text: string, options: LayoutOptions): TextLayout {
  const { font, size } = options;
  const letterSpacing = options.letterSpacing ?? 0;
  const limit = options.maxWidth ?? Infinity;
  const ascent = font.ascent * size;
  const lineHeight = options.lineHeight ?? (font.ascent - font.descent) * size * 1.2;

  const lines: LaidOutLine[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      lines.push({ glyphs: [], width: 0, visualWidth: 0, text: '', endsParagraph: true });
      continue;
    }
    lines.push(...layoutParagraph(paragraph, limit, options, letterSpacing));
  }

  let width = 0;
  for (const line of lines) width = Math.max(width, line.width);

  return { lines, width, height: lineHeight * lines.length, ascent, lineHeight };
}

function layoutParagraph(
  paragraph: string,
  limit: number,
  options: LayoutOptions,
  letterSpacing: number,
): LaidOutLine[] {
  const clusters = measure(paragraph, options, letterSpacing);
  if (clusters.length === 0) {
    return [{ glyphs: [], width: 0, visualWidth: 0, text: paragraph, endsParagraph: true }];
  }

  const lines: LaidOutLine[] = [];
  let start = 0;
  while (start < clusters.length) {
    let end = start;
    let width = 0;
    let lastBreak = -1;
    while (end < clusters.length) {
      const next = width + clusters[end]!.width;
      if (Number.isFinite(limit) && next > limit && end > start) break;
      width = next;
      if (isBreakable(clusters[end]!.text)) lastBreak = end;
      end++;
    }
    // Prefer breaking after the last space rather than mid-word.
    if (end < clusters.length && lastBreak >= start && lastBreak < end - 1) {
      end = lastBreak + 1;
    }
    lines.push(placeLine(clusters, start, end, options.size, letterSpacing));
    start = end;
  }
  lines[lines.length - 1] = { ...lines[lines.length - 1]!, endsParagraph: true };
  return lines;
}

/** Shapes [paragraph], one stretch per (font, script), and measures every cluster. */
function measure(paragraph: string, options: LayoutOptions, letterSpacing: number): Cluster[] {
  const out: Cluster[] = [];
  for (const segment of segments(paragraph, options.font, options.fallbackFonts ?? [])) {
    if (segment.text.length === 0) continue;
    const run = segment.font.shape(segment.text, segment.script);
    if (run.glyphs.length === 0) continue;
    const scale = options.size / segment.font.unitsPerEm;
    for (const cluster of run.clusters) {
      const glyphs = run.glyphs.slice(cluster.glyphStart, cluster.glyphEnd);
      let width = 0;
      for (const glyph of glyphs) width += glyph.xAdvance * scale;
      out.push({
        font: segment.font,
        glyphs,
        glyphTexts: cluster.glyphTexts,
        text: cluster.text,
        width: width + letterSpacing,
      });
    }
  }
  return out;
}

function placeLine(
  clusters: Cluster[],
  from: number,
  to: number,
  size: number,
  letterSpacing: number,
): LaidOutLine {
  const placed: PlacedGlyph[] = [];
  let pen = 0;

  // Trailing whitespace must not count towards the line width, or centred and
  // right-aligned text drifts.
  let visualEnd = to;
  while (visualEnd > from && isBreakable(clusters[visualEnd - 1]!.text)) visualEnd--;
  let visualWidth = 0;

  for (let c = from; c < to; c++) {
    const cluster = clusters[c]!;
    const scale = size / cluster.font.unitsPerEm;
    for (let g = 0; g < cluster.glyphs.length; g++) {
      const glyph = cluster.glyphs[g]!;
      placed.push({
        font: cluster.font,
        gid: glyph.gid,
        x: pen + glyph.xOffset * scale,
        yOffset: glyph.yOffset * scale,
        advance: glyph.xAdvance,
        text: cluster.glyphTexts[g] ?? '',
      });
      pen += glyph.xAdvance * scale;
    }
    pen += letterSpacing;
    if (c < visualEnd) visualWidth = pen;
  }

  let source = '';
  for (let c = from; c < to; c++) source += clusters[c]!.text;

  return { glyphs: placed, width: pen, visualWidth, text: source, endsParagraph: false };
}

function isBreakable(clusterText: string): boolean {
  return clusterText.length > 0 && clusterText.trim().length === 0;
}

interface Segment {
  font: BanglaFont;
  script: string | undefined;
  text: string;
}

/**
 * Splits [text] into the longest stretches that share one font and one script.
 *
 * Both splits matter. HarfBuzz guesses a buffer's script from its first strong
 * character, so `Hello বাংলা` shaped in one buffer is shaped as Latin
 * throughout and gets no Indic reordering at all — a real text engine itemises
 * by script first, and so does this. The font split is what lets a fallback
 * font draw the characters a Bangla face has no glyph for.
 *
 * A combining mark never starts a new segment, so a boundary can never fall
 * inside a cluster.
 */
function* segments(
  text: string,
  primary: BanglaFont,
  fallbacks: BanglaFont[],
): Generator<Segment> {
  const fontForRune = (rune: number): BanglaFont => {
    if (primary.supports(rune)) return primary;
    for (const candidate of fallbacks) {
      if (candidate.supports(rune)) return candidate;
    }
    return primary;
  };

  let current: Segment | null = null;
  for (const ch of text) {
    const rune = ch.codePointAt(0)!;
    const script = scriptOf(rune);
    const font: BanglaFont =
      isCombining(rune) && current !== null ? current.font : fontForRune(rune);

    if (current !== null && (current.font !== font || !scriptCompatible(current.script, script))) {
      yield current;
      current = null;
    }
    if (current === null) {
      current = { font, script: script === COMMON ? undefined : script, text: '' };
    } else if (current.script === undefined && script !== COMMON) {
      current.script = script;
    }
    current.text += ch;
  }
  if (current !== null) yield current;
}

/** Sentinel for characters that take on the script of whatever surrounds them. */
const COMMON = 'Zyyy';

/**
 * The script [rune] belongs to, as far as this package cares.
 *
 * Only Bengali needs naming: everything else is handed to HarfBuzz to guess,
 * which is what it does well. Spaces, digits and punctuation are common and
 * join whichever run they land in.
 */
function scriptOf(rune: number): string {
  if (rune >= 0x0980 && rune <= 0x09ff) return 'Beng';
  if (rune === 0x200c || rune === 0x200d) return COMMON; // ZWNJ / ZWJ
  if (rune <= 0x0040) return COMMON; // space, digits, ASCII punctuation
  if (rune >= 0x005b && rune <= 0x0060) return COMMON;
  if (rune >= 0x007b && rune <= 0x00bf) return COMMON;
  if (rune >= 0x2000 && rune <= 0x206f) return COMMON; // general punctuation
  if (rune >= 0x20a0 && rune <= 0x20cf) return COMMON; // currency symbols
  return 'Other';
}

function scriptCompatible(a: string | undefined, b: string): boolean {
  return b === COMMON || a === undefined || a === b;
}

/** Whether [rune] is a combining mark that must not start a new segment. */
function isCombining(rune: number): boolean {
  return (
    (rune >= 0x0300 && rune <= 0x036f) || // combining diacriticals
    (rune >= 0x0900 && rune <= 0x0dff) || // Indic marks live inside these
    rune === 0x200c ||
    rune === 0x200d ||
    (rune >= 0xfe00 && rune <= 0xfe0f) // variation selectors
  );
}

/**
 * Extra x for each glyph so the line fills [available], for `justify`.
 * Returns null when the line is left as it is.
 *
 * The slack is shared equally between word gaps, and every glyph after a gap
 * moves by the running total. Marks carry absolute positions, so they shift
 * with the glyph they sit over.
 */
export function justifyShifts(line: LaidOutLine, available: number): number[] | null {
  if (line.endsParagraph) return null;
  const slack = available - line.visualWidth;
  if (slack <= 0 || line.glyphs.length === 0) return null;

  let lastVisible = -1;
  for (let i = line.glyphs.length - 1; i >= 0; i--) {
    if (line.glyphs[i]!.text !== ' ') {
      lastVisible = i;
      break;
    }
  }
  const gaps: number[] = [];
  for (let i = 0; i < lastVisible; i++) {
    if (line.glyphs[i]!.text === ' ') gaps.push(i);
  }
  if (gaps.length === 0) return null;

  const per = slack / gaps.length;
  const shifts = new Array<number>(line.glyphs.length).fill(0);
  let running = 0;
  let next = 0;
  for (let i = 0; i < line.glyphs.length; i++) {
    shifts[i] = running;
    if (next < gaps.length && i === gaps[next]) {
      running += per;
      next++;
    }
  }
  return shifts;
}

/** Horizontal offset of a line of [lineWidth] within [available], for [align]. */
export function alignOffset(align: TextAlign, available: number, lineWidth: number): number {
  switch (align) {
    case 'center':
      return (available - lineWidth) / 2;
    case 'right':
      return available - lineWidth;
    default:
      return 0;
  }
}
