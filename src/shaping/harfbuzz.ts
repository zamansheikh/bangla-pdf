/**
 * The HarfBuzz binding.
 *
 * The Dart package this is ported from carries a hand-written Bengali
 * OpenType shaper, because Dart cannot call HarfBuzz on the web. JavaScript
 * can: `harfbuzzjs` is HarfBuzz itself compiled to WebAssembly, so there is no
 * shaper in this package at all. Everything here is loading, buffer setup and
 * turning HarfBuzz's output into clusters.
 */

export interface ShapedGlyph {
  /** Glyph id in the font. */
  gid: number;
  /** Index into the source string of the first character of this glyph's cluster. */
  cluster: number;
  /**
   * Index of the character that produced this glyph, from a second shaping
   * pass with cluster merging turned off.
   *
   * This is HarfBuzz's own character-to-glyph correspondence. Where it runs in
   * order, each glyph can be given its own slice of the source text; where
   * Bengali reordering breaks the order, it cannot, and the whole cluster's
   * text goes on one glyph instead.
   */
  source: number;
  /** Horizontal advance in font units, after GPOS. */
  xAdvance: number;
  /** Horizontal offset from the pen position, in font units. */
  xOffset: number;
  /** Vertical offset from the baseline, in font units. */
  yOffset: number;
}

/**
 * One shaped cluster: a range of glyphs and the source text they render.
 *
 * A cluster is the unit line breaking may not split. Bengali reorders glyphs
 * *within* a cluster — `কি` draws `ি` before `ক` — so the cluster, not the
 * glyph, is what maps back to text.
 */
export interface ShapedCluster {
  /** Index of the first glyph of this cluster in the run. */
  glyphStart: number;
  /** Index just past the last glyph of this cluster. */
  glyphEnd: number;
  /** The source text this cluster renders, in logical order. */
  text: string;
  /**
   * What each glyph of the cluster is responsible for in `/ToUnicode`, aligned
   * with `glyphs[glyphStart..glyphEnd]`. Concatenating them in glyph order
   * gives back `text` exactly. See {@link assignGlyphTexts}.
   */
  glyphTexts: string[];
}

export interface ShapedRun {
  glyphs: ShapedGlyph[];
  clusters: ShapedCluster[];
}

/** The subset of the `harfbuzzjs` module this package uses. */
interface HarfBuzzModule {
  Blob: new (data: Uint8Array) => { ptr: number };
  Face: new (blob: { ptr: number }, index?: number) => { ptr: number; upem: number };
  Font: new (face: { ptr: number }) => { ptr: number };
  Buffer: new () => HbBuffer;
  shape: (font: unknown, buffer: unknown, features?: unknown[]) => void;
  Direction: { LTR: number; RTL: number };
  ClusterLevel: { MONOTONE_GRAPHEMES: number; CHARACTERS: number };
  versionString: () => string;
}

interface HbBuffer {
  add(codePoint: number, cluster: number): void;
  setScript(script: string): void;
  setDirection(dir: number): void;
  setLanguage(language: string): void;
  setClusterLevel(level: number): void;
  guessSegmentProperties(): void;
  getGlyphInfosAndPositions(): Array<{
    codepoint: number;
    cluster: number;
    xAdvance?: number;
    xOffset?: number;
    yOffset?: number;
  }>;
}

export type { HarfBuzzModule };

let modulePromise: Promise<HarfBuzzModule> | null = null;

/**
 * Loads (once) and returns the HarfBuzz WebAssembly module.
 *
 * `harfbuzzjs` is an ESM module with a top-level `await`, so it can only ever
 * be reached by dynamic import — `require()` of it throws
 * `ERR_REQUIRE_ASYNC_MODULE`. esbuild leaves this `import()` alone in the CJS
 * build because the package is marked external, so both builds load the same
 * way. That is also why every entry point into this package is async.
 */
export function loadHarfBuzz(): Promise<HarfBuzzModule> {
  if (modulePromise === null) {
    modulePromise = import('harfbuzzjs').then((m) => m as unknown as HarfBuzzModule);
  }
  return modulePromise;
}

/**
 * Shapes [text] with [font] and groups the result into clusters.
 *
 * Cluster values are set explicitly to JavaScript string indices, so a cluster
 * maps straight back onto a `String.slice`. HarfBuzz's own `addText` numbers
 * clusters by UTF-8 byte offset, which does not.
 *
 * The text is shaped twice, at two cluster levels. The default level merges
 * clusters across ligatures and reordering, which is what line breaking needs.
 * The second pass turns merging off, which is what tells us which character
 * produced which glyph. The glyph sequence is identical either way — the
 * cluster level only changes the numbering — so the two are read side by side.
 */
export function shapeText(
  hb: HarfBuzzModule,
  hbFont: unknown,
  text: string,
  options: { script?: string; language?: string } = {},
): ShapedRun {
  if (text.length === 0) return { glyphs: [], clusters: [] };

  const merged = shapeOnce(hb, hbFont, text, options, hb.ClusterLevel.MONOTONE_GRAPHEMES);
  const perCharacter = shapeOnce(hb, hbFont, text, options, hb.ClusterLevel.CHARACTERS);

  const glyphs: ShapedGlyph[] = merged.map((g, i) => ({
    gid: g.codepoint,
    cluster: g.cluster,
    // The two passes agree glyph for glyph; if a future HarfBuzz ever made
    // them differ, falling back to the merged value costs only the per-glyph
    // text refinement, never correctness.
    source: perCharacter.length === merged.length ? perCharacter[i]!.cluster : g.cluster,
    xAdvance: g.xAdvance ?? 0,
    xOffset: g.xOffset ?? 0,
    yOffset: g.yOffset ?? 0,
  }));

  return { glyphs, clusters: groupClusters(glyphs, text) };
}

function shapeOnce(
  hb: HarfBuzzModule,
  hbFont: unknown,
  text: string,
  options: { script?: string; language?: string },
  clusterLevel: number,
): ReturnType<HbBuffer['getGlyphInfosAndPositions']> {
  const buffer = new hb.Buffer();
  let index = 0;
  for (const ch of text) {
    buffer.add(ch.codePointAt(0)!, index);
    index += ch.length;
  }
  buffer.setClusterLevel(clusterLevel);
  buffer.setDirection(hb.Direction.LTR);
  if (options.script) buffer.setScript(options.script);
  if (options.language) buffer.setLanguage(options.language);
  if (!options.script || !options.language) buffer.guessSegmentProperties();
  hb.shape(hbFont, buffer);
  return buffer.getGlyphInfosAndPositions();
}

/**
 * Groups glyphs into clusters and gives each the source text it renders.
 *
 * HarfBuzz merges cluster values across a ligature or a reordering, so the
 * distinct values that come back are exactly the cluster boundaries, and a
 * cluster's text runs from its own value to the next one.
 */
function groupClusters(glyphs: ShapedGlyph[], text: string): ShapedCluster[] {
  if (glyphs.length === 0) return [];

  const boundaries: number[] = [];
  const starts: number[] = [];
  for (let i = 0; i < glyphs.length; i++) {
    if (i === 0 || glyphs[i]!.cluster !== glyphs[i - 1]!.cluster) {
      boundaries.push(glyphs[i]!.cluster);
      starts.push(i);
    }
  }

  // Cluster values must climb for the slice arithmetic below to mean anything.
  // They always do for left-to-right text; if a font or a future HarfBuzz ever
  // produced something else, one cluster covering the whole run is wrong-ish
  // but never corrupting: the text still comes back in one piece.
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i]! <= boundaries[i - 1]!) {
      return [
        {
          glyphStart: 0,
          glyphEnd: glyphs.length,
          text,
          glyphTexts: assignGlyphTexts(glyphs, 0, glyphs.length, 0, text.length, text),
        },
      ];
    }
  }

  const clusters: ShapedCluster[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = boundaries[i]!;
    const to = i + 1 < boundaries.length ? boundaries[i + 1]! : text.length;
    const glyphStart = starts[i]!;
    const glyphEnd = i + 1 < starts.length ? starts[i + 1]! : glyphs.length;
    clusters.push({
      glyphStart,
      glyphEnd,
      text: text.slice(from, to),
      glyphTexts: assignGlyphTexts(glyphs, glyphStart, glyphEnd, from, to, text),
    });
  }
  return clusters;
}

/**
 * Decides which glyph of a cluster carries which part of its text.
 *
 * Two cases, and the difference matters more than it looks:
 *
 *  * **HarfBuzz's correspondence runs in order.** `কা` draws `ক` then `া`, in
 *    the order they are typed, so each glyph can be given its own characters.
 *    Every glyph then has real text and a reader that ignores `/ActualText`
 *    still gets the whole string.
 *  * **It does not.** `কি` draws `ি` first and `কর্ম` draws its reph last, so
 *    no per-glyph assignment can express the typed order. The whole cluster's
 *    text goes on its first spacing glyph and the rest carry none — extraction
 *    then yields logical order even though the glyphs are in visual order.
 *
 * Marks with no advance are painted separately, after the line's spacing
 * glyphs, so their text would surface out of order. Their share is folded into
 * the spacing glyph in front of them instead.
 */
function assignGlyphTexts(
  glyphs: ShapedGlyph[],
  glyphStart: number,
  glyphEnd: number,
  from: number,
  to: number,
  text: string,
): string[] {
  const count = glyphEnd - glyphStart;
  const out = new Array<string>(count).fill('');
  if (count === 0) return out;
  if (count === 1) {
    out[0] = text.slice(from, to);
    return out;
  }

  let ordered = glyphs[glyphStart]!.source === from;
  for (let i = glyphStart + 1; ordered && i < glyphEnd; i++) {
    if (glyphs[i]!.source <= glyphs[i - 1]!.source) ordered = false;
  }

  if (ordered) {
    for (let i = glyphStart; i < glyphEnd; i++) {
      const sliceEnd = i + 1 < glyphEnd ? glyphs[i + 1]!.source : to;
      out[i - glyphStart] = text.slice(glyphs[i]!.source, sliceEnd);
    }
    // Fold each attached mark's text back into the spacing glyph before it.
    let lastSpacing = -1;
    for (let i = 0; i < count; i++) {
      if (glyphs[glyphStart + i]!.xAdvance !== 0) {
        lastSpacing = i;
      } else if (lastSpacing >= 0) {
        out[lastSpacing] = out[lastSpacing]! + out[i]!;
        out[i] = '';
      }
    }
    carryFormatCharsForward(out);
    return out;
  }

  // Attach everything to the first spacing glyph. A mark must never be the
  // carrier, for the reason above.
  let carrier = 0;
  for (let i = 0; i < count; i++) {
    if (glyphs[glyphStart + i]!.xAdvance !== 0) {
      carrier = i;
      break;
    }
  }
  out[carrier] = text.slice(from, to);
  return out;
}

/** Zero-width formatting characters: ZWJ, ZWNJ, the bidi controls, U+FEFF. */
const TRAILING_FORMAT = /\p{Cf}+$/u;

/**
 * Moves a trailing run of invisible formatting characters onto the next glyph.
 *
 * Purely a concession to pdf.js, which classifies a whole `/ToUnicode` entry by
 * whether it *ends* with a formatting character and drops the glyph entirely if
 * it does. `র‍্য` is the case that bites: its first glyph covers `র` plus the
 * ZWJ after it, and Firefox's viewer would silently lose the `র`.
 *
 * The concatenation of the entries is unchanged, so nothing about the text this
 * package writes depends on it.
 */
function carryFormatCharsForward(texts: string[]): void {
  for (let i = 0; i + 1 < texts.length; i++) {
    const match = TRAILING_FORMAT.exec(texts[i]!);
    if (match === null) continue;
    texts[i] = texts[i]!.slice(0, match.index);
    texts[i + 1] = match[0] + texts[i + 1]!;
  }
}
