/**
 * A font ready to shape and embed: the raw sfnt bytes, a parsed view of them,
 * and a live HarfBuzz face.
 */

import { OtFont } from '../ot/ot-font.js';
import { loadHarfBuzz, shapeText, type ShapedRun } from './harfbuzz.js';

/** Cache so the same bytes are only parsed and handed to HarfBuzz once. */
const cache = new WeakMap<Uint8Array, BanglaFont>();

export class BanglaFont {
  private constructor(
    /** The original font file, as embedded (before subsetting). */
    readonly bytes: Uint8Array,
    /** A parsed view: `cmap`, metrics, `GSUB`. */
    readonly otf: OtFont,
    private readonly hb: Awaited<ReturnType<typeof loadHarfBuzz>>,
    private readonly hbFont: unknown,
  ) {}

  /**
   * Loads a TrueType or OpenType font.
   *
   * Throws if the bytes are not a usable sfnt font.
   */
  static async load(bytes: Uint8Array | ArrayBuffer): Promise<BanglaFont> {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const cached = cache.get(data);
    if (cached) return cached;

    const otf = OtFont.parse(data);
    if (otf === null) throw new Error('bangla-pdf: not a usable TrueType/OpenType font');

    const hb = await loadHarfBuzz();
    const face = new hb.Face(new hb.Blob(data), 0);
    const hbFont = new hb.Font(face);
    const font = new BanglaFont(data, otf, hb, hbFont);
    cache.set(data, font);
    return font;
  }

  /** Design units per em. HarfBuzz advances are in these units. */
  get unitsPerEm(): number {
    return this.otf.upem;
  }

  /** Ascender as a fraction of the em. */
  get ascent(): number {
    return this.otf.ascender / this.otf.upem;
  }

  /** Descender as a fraction of the em (negative). */
  get descent(): number {
    return this.otf.descender / this.otf.upem;
  }

  get postScriptName(): string {
    return this.otf.postScriptName;
  }

  /** Whether this font has a glyph for [rune]. */
  supports(rune: number): boolean {
    return this.otf.cmap.has(rune);
  }

  /**
   * Shapes [text] with HarfBuzz.
   *
   * The script is left to HarfBuzz to guess unless [script] is given. Runs are
   * split by script before they reach here, so guessing is right by
   * construction for text this package draws.
   */
  shape(text: string, script?: string): ShapedRun {
    return shapeText(this.hb, this.hbFont, text, script ? { script } : {});
  }
}
