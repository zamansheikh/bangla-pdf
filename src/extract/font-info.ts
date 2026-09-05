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
    if (font === null || !this.hasNoTextMapping) return (this.reverseMapCache = null);
    const replay =
      this.replayFactory !== null && this.embeddedBytes !== null
        ? this.replayFactory(font, this.embeddedBytes)
        : null;
    const map = GlyphReverseMap.build(font, replay);
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
    const text = map.decodeRun(codes.map((c) => this.glyphFor(c)));
    return text.length === 0 ? null : text;
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
