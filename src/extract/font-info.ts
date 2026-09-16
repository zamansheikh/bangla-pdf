/**
 * What extraction needs to know about a font referenced by a page.
 *
 * Chiefly: how wide a character code is, and what Unicode it maps to. A PDF can
 * say so directly with a `/ToUnicode` CMap, or leave it to be inferred from the
 * encoding — or, in a Bijoy document, say something that is simply wrong, which
 * is why {@link FontInfo.isBijoy} exists.
 *
 * Ported from `lib/src/extract/font_info.dart` in the `bangla_pdf` Dart
 * package.
 */

import { OtFont } from '../ot/ot-font.js';
import { decomposeBengali } from './bengali.js';
import { looksLikeBijoyFontName } from './bijoy.js';
import { GlyphReverseMap, type Replay } from './glyph-reverse.js';
import { PdfLexer } from './lexer.js';
import { asUtf16, get, type PdfDictObj, type PdfObj } from './objects.js';
import type { PdfReader } from './reader.js';

/** Builds a replay function for an embedded font, or null when unavailable. */
export type ReplayFactory = (font: OtFont, bytes: Uint8Array) => Replay | null;

/** A font as seen from the text-extraction side. */
export class FontInfo {
  private constructor(
    /** PostScript name with any subset prefix stripped. */
    readonly baseFont: string,
    /** `Type0`, `TrueType`, `Type1`, … */
    readonly subtype: string,
    /** Whether character codes in a string are two bytes wide. */
    readonly twoByte: boolean,
    /** Code -> Unicode, from the `/ToUnicode` CMap. */
    readonly toUnicode: Map<number, string>,
    /** Code -> glyph name, from `/Encoding /Differences`. */
    readonly differences: Map<number, string>,
    /** The embedded font program, when one could be parsed. */
    readonly embedded: OtFont | null,
    /** CID -> glyph id, from a `/CIDToGIDMap` stream. Empty means identity. */
    readonly cidToGid: Map<number, number>,
    private readonly replayFactory: ReplayFactory | null,
    private readonly embeddedBytes: Uint8Array | null,
  ) {}

  /** Reads the font dictionary [d]. */
  static parse(reader: PdfReader, d: PdfDictObj, replayFactory: ReplayFactory | null): FontInfo {
    const subtypeObj = reader.resolve(get(d, 'Subtype'));
    const subtype = subtypeObj.kind === 'name' ? subtypeObj.value : '';
    const baseObj = reader.resolve(get(d, 'BaseFont'));
    let baseFont = baseObj.kind === 'name' ? baseObj.value : '';
    // Subset fonts are named "ABCDEF+RealName".
    if (baseFont.length > 7 && baseFont[6] === '+') baseFont = baseFont.slice(7);

    let descendant = d;
    if (subtype === 'Type0') {
      const list = reader.resolve(get(d, 'DescendantFonts'));
      if (list.kind === 'array' && list.values.length > 0) {
        const first = reader.resolve(list.values[0]!);
        if (first.kind === 'dict') descendant = first;
      }
    }

    // A Type0 font with Identity encoding uses two-byte codes. Other CMaps
    // exist but are vanishingly rare in Bangla documents.
    let twoByte = false;
    if (subtype === 'Type0') {
      twoByte = true;
      const enc = reader.resolve(get(d, 'Encoding'));
      if (enc.kind === 'name' && enc.value.includes('OneByte')) twoByte = false;
    }

    const toUnicode = new Map<number, string>();
    let declaredTwoByte = twoByte;
    const cmapObj = reader.resolve(get(d, 'ToUnicode'));
    if (cmapObj.kind === 'stream') {
      const data = reader.decoded(cmapObj);
      if (data !== null) declaredTwoByte = parseToUnicode(data, toUnicode) || twoByte;
    }

    const differences = new Map<number, string>();
    const enc = reader.resolve(get(d, 'Encoding'));
    if (enc.kind === 'dict') {
      const diff = reader.resolve(get(enc, 'Differences'));
      if (diff.kind === 'array') {
        let code = 0;
        for (const item of diff.values) {
          const v = reader.resolve(item);
          if (v.kind === 'num') code = Math.trunc(v.value);
          else if (v.kind === 'name') differences.set(code++, v.value);
        }
      }
    }

    let embedded: OtFont | null = null;
    let embeddedBytes: Uint8Array | null = null;
    const descriptor = reader.resolve(get(descendant, 'FontDescriptor'));
    if (descriptor.kind === 'dict') {
      for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
        const file = reader.resolve(get(descriptor, key));
        if (file.kind !== 'stream') continue;
        const data = reader.decoded(file);
        if (data === null || data.length === 0) continue;
        embedded = OtFont.parse(data);
        if (embedded !== null) {
          embeddedBytes = data;
          break;
        }
      }
    }

    // A CID font may remap CIDs onto glyph ids with a stream; Identity means
    // the CID is the glyph id, which is by far the common case.
    const cidToGid = new Map<number, number>();
    const mapObj = reader.resolve(get(descendant, 'CIDToGIDMap'));
    if (mapObj.kind === 'stream') {
      const data = reader.decoded(mapObj);
      if (data !== null) {
        for (let cid = 0; cid * 2 + 1 < data.length; cid++) {
          const gid = (data[cid * 2]! << 8) | data[cid * 2 + 1]!;
          if (gid !== 0) cidToGid.set(cid, gid);
        }
      }
    }

    return new FontInfo(
      baseFont,
      subtype,
      declaredTwoByte,
      toUnicode,
      differences,
      embedded,
      cidToGid,
      replayFactory,
      embeddedBytes,
    );
  }

  /**
   * Whether this font says nothing about what its codes mean.
   *
   * Such a font is the case un-shaping exists for: all that survives is which
   * glyph was drawn.
   */
  get hasNoTextMapping(): boolean {
    return this.toUnicode.size === 0 && this.differences.size === 0;
  }

  private contradictsCache: boolean | undefined;

  /**
   * Whether the `/ToUnicode` CMap disagrees with the embedded font's own `cmap`
   * about Bengali glyphs, badly enough that it cannot be trusted.
   *
   * Microsoft Word writes such CMaps. It pairs glyphs with characters by
   * position, which breaks as soon as a cluster is drawn out of typing order:
   * `শি` is drawn `[ি, শ]` but typed `[শ, ি]`, so the CMap records ি→শ and
   * শ→ি. Every reordered pair gets exchanged — ে with দ, র with ে, ৈ with ব —
   * and which pairs depends on which words the document happens to contain, so
   * no fixed correction table can undo it. The glyphs themselves are fine, and
   * so is the font; reading them back through the font is what recovers the
   * text.
   *
   * A glyph the font's `cmap` reaches directly is compared against what the
   * CMap claims for it. An entry that includes the glyph's own character
   * agrees — a cluster's first glyph legitimately carries the whole cluster's
   * text — and an empty entry says nothing either way.
   */
  get toUnicodeContradictsFont(): boolean {
    if (this.contradictsCache !== undefined) return this.contradictsCache;
    return (this.contradictsCache = this.computeContradicts());
  }

  private computeContradicts(): boolean {
    const font = this.embedded;
    if (font === null || this.toUnicode.size === 0 || this.isBijoy) return false;
    if (!this.codesAreGlyphIds) return false;

    const bengaliOfGlyph = new Map<number, number[]>();
    for (const [codepoint, gid] of font.cmap) {
      if (codepoint < 0x0980 || codepoint > 0x09ff) continue;
      const list = bengaliOfGlyph.get(gid);
      if (list === undefined) bengaliOfGlyph.set(gid, [codepoint]);
      else list.push(codepoint);
    }
    if (bengaliOfGlyph.size === 0) return false;

    let agree = 0;
    let disagree = 0;
    for (const [code, text] of this.toUnicode) {
      if (text.length === 0) continue;
      const own = bengaliOfGlyph.get(this.glyphFor(code));
      if (own === undefined) continue;
      const claimed = decomposeBengali(text);
      const matches = own.some((codepoint) =>
        [...decomposeBengali(String.fromCodePoint(codepoint))].every((c) => claimed.includes(c)),
      );
      if (matches) agree++;
      else disagree++;
    }
    // One stray entry is a font with two codepoints on one glyph, or a writer's
    // rounding; a pattern of them is a CMap that was built wrong.
    return disagree >= 3 && disagree * 10 >= agree + disagree;
  }

  /**
   * Whether the document's own statement of what the codes mean should be
   * ignored in favour of reading the glyphs back: there is none, or it
   * contradicts the font it describes.
   */
  get textMappingUntrusted(): boolean {
    // Only a CID font's codes name glyphs. A simple font's code is a byte in an
    // encoding — WinAnsi, a symbol encoding, a Bijoy table — and reading it as
    // a glyph id turns a space into whatever glyph 32 happens to be.
    if (!this.codesAreGlyphIds) return false;
    return this.hasNoTextMapping || this.toUnicodeContradictsFont;
  }

  /** Whether a code in a string is a CID, and so identifies a glyph. */
  get codesAreGlyphIds(): boolean {
    return this.subtype === 'Type0';
  }

  private reverseMapCache: GlyphReverseMap | null | undefined;

  /**
   * The font's glyphs read backwards, built on first use.
   *
   * Only ever consulted when the document offers nothing better, because a
   * reverse map is inference: it reconstructs the text most likely to have
   * produced a glyph, which is not always the text that did.
   */
  get reverseMap(): GlyphReverseMap | null {
    if (this.reverseMapCache !== undefined) return this.reverseMapCache;
    const font = this.embedded;
    if (font === null || !this.textMappingUntrusted) return (this.reverseMapCache = null);
    const replay =
      this.replayFactory !== null && this.embeddedBytes !== null
        ? this.replayFactory(font, this.embeddedBytes)
        : null;
    // What the document claims each glyph is, for the one use the map makes of
    // it: naming vowel signs a subsetter pruned from the font's cmap.
    const documentText = new Map<number, string[]>();
    for (const [code, text] of this.toUnicode) {
      if (text.length === 0) continue;
      const gid = this.glyphFor(code);
      const list = documentText.get(gid);
      if (list === undefined) documentText.set(gid, [text]);
      else list.push(text);
    }
    const map = GlyphReverseMap.build(font, replay, documentText);
    return (this.reverseMapCache = map.isEmpty ? null : map);
  }

  /** The glyph id [code] draws. */
  glyphFor(code: number): number {
    return this.cidToGid.get(code) ?? code;
  }

  /**
   * Recovers the text of a whole run of codes by reading the glyphs back.
   *
   * Done per run rather than per code because Bengali draws a cluster out of
   * order — the reordering can only be undone with the run in hand.
   */
  unshape(codes: number[]): string | null {
    const map = this.reverseMap;
    if (map === null) return null;
    const text = map.decodeRun(
      codes.map((c) => this.glyphFor(c)),
      (i) => this.toUnicode.get(codes[i]!),
    );
    return text.length === 0 ? null : text;
  }

  /**
   * Recovers the text of a collected run, which may span several show
   * operators and contain word gaps.
   *
   * A negative code marks a gap written as a `TJ` adjustment rather than as a
   * space glyph; the run is read back one word at a time between them. When the
   * font cannot be read back at all, the document's own mapping is used, which
   * is no worse than not collecting the run.
   */
  unshapeRun(codes: number[]): string {
    let out = '';
    let gap = false;
    let word: number[] = [];
    const finish = (): void => {
      if (word.length === 0) return;
      const text = this.unshape(word) ?? word.map((c) => this.unicodeFor(c) ?? '').join('');
      // A gap beside a drawn space is the same space, widened by justification.
      if (gap && out.length > 0 && !/\s$/.test(out) && !/^\s/.test(text)) out += ' ';
      out += text;
      gap = false;
      word = [];
    };
    for (const code of codes) {
      if (code < 0) {
        finish();
        gap = true;
      } else {
        word.push(code);
      }
    }
    finish();
    return out;
  }

  private isBijoyCache: boolean | undefined;

  /**
   * Whether this font renders Bangla from Bijoy/ANSI byte values.
   *
   * The giveaway is the embedded font itself: a Bijoy face draws Bangla but has
   * no Bengali in its `cmap`, because it is addressed by Latin-1 byte values.
   * Code width is no help — several writers wrap even an 8-bit font in a Type0
   * CID font, so a Bijoy document can very well use two-byte codes whose
   * `/ToUnicode` maps back to Latin-1.
   */
  get isBijoy(): boolean {
    if (this.isBijoyCache !== undefined) return this.isBijoyCache;
    return (this.isBijoyCache = this.computeIsBijoy());
  }

  private computeIsBijoy(): boolean {
    const font = this.embedded;
    if (font !== null && font.hasBengaliCoverage) return false;
    // A face carrying Bengali shaping rules is a Unicode font, whatever its cmap
    // says. Word subsets a font once per encoding: the WinAnsi copy of NikoshBAN
    // it uses for digits and punctuation keeps GSUB (script `beng`) but none of
    // the Bengali cmap entries, and the name check below would then call it
    // Bijoy and turn its ASCII into noise. A Bijoy face is addressed by Latin
    // byte values and has no use for a Bengali script table.
    if (font !== null && font.declaresBengaliScript) return false;
    if (looksLikeBijoyFontName(this.baseFont)) return true;
    if (font === null) return false;
    if (font.cmap.size === 0) return false;

    // An embedded face with a Bangla-sounding name and no Bengali coverage is
    // the classic Bijoy setup.
    const name = this.baseFont.toLowerCase();
    const banglaish = [
      'bangla',
      'bangali',
      'bengali',
      'lipi',
      'purush',
      'rupali',
      'nikosh',
      'sutonny',
      'tonny',
      'borno',
      'kalpurush',
    ];
    if (banglaish.some((hint) => name.includes(hint))) return true;

    // Last resort: the font covers the Latin-1 supplement densely, which a text
    // font for English has no reason to do, and covers no Bengali.
    let high = 0;
    for (const c of font.cmap.keys()) if (c >= 0xa0 && c <= 0xff) high++;
    return high >= 60;
  }

  /** Splits [bytes] into character codes according to this font's width. */
  codes(bytes: Uint8Array): number[] {
    if (!this.twoByte) return [...bytes];
    const out: number[] = [];
    for (let i = 0; i + 1 < bytes.length; i += 2) out.push((bytes[i]! << 8) | bytes[i + 1]!);
    if (bytes.length % 2 === 1) out.push(bytes[bytes.length - 1]!);
    return out;
  }

  /**
   * The glyph ids [bytes] draw, for reading glyphs back.
   *
   * Unlike [codes], an incomplete trailing byte is dropped rather than kept: it
   * is not a CID, so it names no glyph. Word emits exactly that — `( ) TJ`, one
   * byte, with a two-byte CID font selected — and taking the byte as glyph 32
   * draws whatever glyph 32 is. In NikoshBAN that is `=`.
   */
  glyphCodes(bytes: Uint8Array): number[] {
    const codes = this.codes(bytes);
    if (this.twoByte && bytes.length % 2 === 1) codes.pop();
    return codes;
  }

  /** The text [code] represents, or null when nothing is known. */
  unicodeFor(code: number): string | null {
    const mapped = this.toUnicode.get(code);
    if (mapped !== undefined && mapped.length > 0) return mapped;
    if (this.toUnicode.has(code)) return ''; // deliberately empty
    if (this.twoByte) return null;
    const glyphName = this.differences.get(code);
    if (glyphName !== undefined) {
      const fromName = glyphNameToUnicode(glyphName);
      if (fromName !== null) return fromName;
    }
    // A simple font with no CMap: the code is its own Latin-1 character. For a
    // Bijoy font that is exactly what we want, since the Bijoy converter reads
    // those bytes.
    if (code >= 0x20 && code < 0x100) return String.fromCharCode(code);
    return null;
  }
}

function glyphNameToUnicode(name: string): string | null {
  if (name.startsWith('uni') && name.length >= 7) {
    const v = Number.parseInt(name.slice(3, 7), 16);
    if (Number.isFinite(v)) return String.fromCharCode(v);
  }
  if (name.startsWith('u') && name.length >= 5 && name.length <= 7) {
    const v = Number.parseInt(name.slice(1), 16);
    if (Number.isFinite(v)) return String.fromCharCode(v);
  }
  return null;
}

/**
 * Parses a `/ToUnicode` CMap into [out].
 *
 * Returns true when the CMap declares two-byte codes.
 */
function parseToUnicode(data: Uint8Array, out: Map<number, string>): boolean {
  const lexer = new PdfLexer(data);
  let twoByte = false;
  let pending: PdfObj[] = [];

  const textOf = (o: PdfObj): string => (o.kind === 'string' ? asUtf16(o.bytes) : '');
  const codeOf = (o: PdfObj): number => {
    if (o.kind !== 'string') return -1;
    let v = 0;
    for (const b of o.bytes) v = v * 256 + b;
    return v;
  };

  for (;;) {
    const token = lexer.next();
    if (token === null) break;
    if (token.kind !== 'op') {
      pending.push(token);
      if (pending.length > 600) pending = pending.slice(300);
      continue;
    }
    switch (token.name) {
      case 'endcodespacerange':
        for (const o of pending) if (o.kind === 'string' && o.bytes.length >= 2) twoByte = true;
        pending = [];
        break;
      case 'endbfchar':
        for (let i = 0; i + 1 < pending.length; i += 2) {
          const code = codeOf(pending[i]!);
          if (code >= 0) out.set(code, textOf(pending[i + 1]!));
        }
        pending = [];
        break;
      case 'endbfrange':
        for (let i = 0; i + 2 < pending.length; i += 3) {
          const lo = codeOf(pending[i]!);
          const hi = codeOf(pending[i + 1]!);
          const dst = pending[i + 2]!;
          if (lo < 0 || hi < lo || hi - lo > 0xffff) continue;
          if (dst.kind === 'array') {
            for (let k = 0; k <= hi - lo && k < dst.values.length; k++) {
              out.set(lo + k, textOf(dst.values[k]!));
            }
          } else if (dst.kind === 'string') {
            const base = textOf(dst);
            if (base.length === 0) continue;
            const units = [...base].map((c) => c.charCodeAt(0));
            for (let k = 0; k <= hi - lo; k++) {
              const shifted = [...units];
              shifted[shifted.length - 1] = shifted[shifted.length - 1]! + k;
              out.set(lo + k, String.fromCharCode(...shifted));
            }
          }
        }
        pending = [];
        break;
      case 'begincodespacerange':
      case 'beginbfchar':
      case 'beginbfrange':
        pending = [];
        break;
      default:
        break;
    }
  }
  return twoByte;
}
