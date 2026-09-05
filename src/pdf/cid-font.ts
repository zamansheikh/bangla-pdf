/**
 * A PDF Type0 font addressed by **glyph id** rather than by character.
 *
 * pdf-lib's own font embedding allocates one code per Unicode rune and picks
 * the glyph through the font's `cmap`. That cannot express a shaped run: a
 * conjunct such as ক্ষ্ম is a single glyph with no `cmap` entry, and a pre-base
 * matra has to be emitted before the consonant it follows.
 *
 * This font instead allocates a CID per *(glyph, source text, advance)* triple
 * and writes an explicit `/CIDToGIDMap`, so:
 *
 *  * any glyph in the font can be drawn, including ligatures and positional
 *    variants that no codepoint maps to;
 *  * the `/ToUnicode` CMap can map one CID to a *multi-character* string, so
 *    copying ক্ষ্ম out of the PDF yields all five original codepoints;
 *  * the glyphs of a cluster can be emitted in visual order while the whole
 *    cluster's text is attached to the first of them, so both stream-order and
 *    position-order text extractors recover the logical Unicode.
 *
 * Ported from `lib/src/pdf/shaped_pdf_font.dart` in the `bangla_pdf` Dart
 * package.
 */

import type { PDFDocument, PDFRef } from 'pdf-lib';
import { PDFName, PDFString } from 'pdf-lib';

import type { BanglaFont } from '../shaping/font.js';
import { subsetTrueType } from './subset.js';

/** Highest CID this font will allocate. */
const MAX_CID = 0xfffd;

export class ShapedCidFont {
  /** The reference a page's `/Font` resource points at. */
  readonly ref: PDFRef;

  private readonly fileRef: PDFRef;
  private readonly toUnicodeRef: PDFRef;
  private readonly cidToGidRef: PDFRef;
  private readonly descriptorRef: PDFRef;
  private readonly widthsRef: PDFRef;

  /** CID 0 is `.notdef` and must stay unused. */
  private readonly gidForCid: number[] = [0];
  private readonly textForCid: string[] = [''];
  private readonly advanceForCid: number[] = [0];
  private readonly cidByKey = new Map<string, number>();

  private subsetTagValue: string | null = null;

  constructor(
    private readonly doc: PDFDocument,
    readonly font: BanglaFont,
  ) {
    const context = doc.context;
    this.ref = context.nextRef();
    this.fileRef = context.nextRef();
    this.toUnicodeRef = context.nextRef();
    this.cidToGidRef = context.nextRef();
    this.descriptorRef = context.nextRef();
    this.widthsRef = context.nextRef();
  }

  /** Number of CIDs allocated so far, including `.notdef`. */
  get cidCount(): number {
    return this.gidForCid.length;
  }

  /** The `/BaseFont` name, carrying a subset tag once the font is cut down. */
  get fontName(): string {
    const base = this.font.postScriptName;
    return this.subsetTagValue === null ? base : `${this.subsetTagValue}+${base}`;
  }

  /**
   * Allocates (or reuses) a CID drawing [gid], extracting as [text], and
   * advancing by [advance] font units.
   *
   * All three are part of the identity. Two CIDs share a GID when the same
   * glyph carries different text — which is how the first glyph of a cluster
   * owns the cluster's whole text while the rest own none. They also differ
   * when GPOS gave the glyph a different advance, so the real advance can go
   * into `/W` and the content stream needs no correcting kerns; without that,
   * text extractors read the corrections as word gaps and insert spaces.
   */
  cidFor(gid: number, text: string, advance: number): number {
    const key = `${gid} ${advance} ${text}`;
    const existing = this.cidByKey.get(key);
    if (existing !== undefined) return existing;
    if (this.gidForCid.length > MAX_CID) return 0;
    const cid = this.gidForCid.length;
    this.gidForCid.push(gid);
    this.textForCid.push(text);
    this.advanceForCid.push(advance);
    this.cidByKey.set(key, cid);
    return cid;
  }

  /**
   * Writes every object this font needs into the document.
   *
   * Called at save time, when every glyph the document draws is known. Safe to
   * call more than once: each call overwrites the same objects, so a document
   * saved twice — or drawn on further between saves — stays correct.
   */
  embed(): void {
    const context = this.doc.context;
    const otf = this.font.otf;
    const upem = otf.upem;

    // Embed only the glyphs this document draws. A font that cannot be cut
    // safely — CFF outlines, a damaged directory — is embedded whole.
    const gids = new Set(this.gidForCid);
    const subset = subsetTrueType(this.font.bytes, gids);
    this.subsetTagValue = subset === null ? null : subsetTag(gids);
    const program = subset ?? this.font.bytes;

    context.assign(this.fileRef, context.flateStream(program, { Length1: program.length }));

    const widths = new Array<number>(this.gidForCid.length);
    for (let cid = 0; cid < this.gidForCid.length; cid++) {
      widths[cid] = Math.round((this.advanceForCid[cid]! * 1000) / upem);
    }
    context.assign(this.widthsRef, context.obj(widths));

    // /CIDToGIDMap: two big-endian bytes of GID per CID.
    const map = new Uint8Array(this.cidCount * 2);
    for (let cid = 0; cid < this.cidCount; cid++) {
      const gid = this.gidForCid[cid]!;
      map[cid * 2] = (gid >> 8) & 0xff;
      map[cid * 2 + 1] = gid & 0xff;
    }
    context.assign(this.cidToGidRef, context.flateStream(map));

    context.assign(this.toUnicodeRef, context.flateStream(this.toUnicodeCmap()));

    const scaled = (v: number) => Math.round((v * 1000) / upem);
    const [xMin, yMin, xMax, yMax] = otf.boundingBox;
    context.assign(
      this.descriptorRef,
      context.obj({
        Type: 'FontDescriptor',
        FontName: PDFName.of(this.fontName),
        // Symbolic: the font's own encoding governs, which is what Identity-H
        // requires for a script outside the standard Latin sets.
        Flags: 4,
        FontBBox: [scaled(xMin), scaled(yMin), scaled(xMax), scaled(yMax)],
        Ascent: scaled(otf.ascender),
        Descent: scaled(otf.descender),
        ItalicAngle: 0,
        CapHeight: scaled(otf.ascender),
        StemV: 80,
        FontFile2: this.fileRef,
      }),
    );

    const descendant = context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: PDFName.of(this.fontName),
      CIDSystemInfo: {
        // Strings, not names: a bare JS string would become a /Name here.
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of('Identity'),
        Supplement: 0,
      },
      FontDescriptor: this.descriptorRef,
      DW: 1000,
      W: [0, this.widthsRef],
      CIDToGIDMap: this.cidToGidRef,
    });

    context.assign(
      this.ref,
      context.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: PDFName.of(this.fontName),
        Encoding: 'Identity-H',
        DescendantFonts: [descendant],
        ToUnicode: this.toUnicodeRef,
      }),
    );
  }

  /**
   * The `/ToUnicode` CMap.
   *
   * Unlike an ordinary one, a CID may map to a string of several codepoints,
   * which is what makes conjuncts copy out correctly.
   *
   * A CID with no text of its own is a continuation glyph of a cluster whose
   * text an earlier CID already carries. The spec's way of saying "this glyph
   * contributes nothing" is an empty destination, but pdf.js — and so Firefox's
   * built-in viewer — treats an empty mapping as absent and falls back to
   * `String.fromCharCode(cid)`, putting control characters into the extracted
   * text. U+FEFF is written instead: zero-width and invisible when pasted,
   * wherever an extractor ignores the `/ActualText` spans that carry the real
   * answer.
   */
  private toUnicodeCmap(): string {
    const entries: string[] = [];
    for (let cid = 1; cid < this.cidCount; cid++) {
      const text = this.textForCid[cid]!;
      entries.push(`<${hex4(cid)}> <${utf16beHex(text === '' ? '\uFEFF' : text)}>`);
    }

    const head = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo <<',
      '  /Registry (Adobe)',
      '  /Ordering (UCS)',
      '  /Supplement 0',
      '>> def',
      '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange',
      '',
    ].join('\n');

    let body = '';
    // beginbfchar allows at most 100 entries per block.
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      body += `${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar\n`;
    }

    const tail = ['endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end'].join(
      '\n',
    );

    return head + body + tail;
  }
}

/**
 * The six-letter tag that marks an embedded subset, per the PDF spec.
 *
 * It only has to distinguish subsets of the same font within one file, so it is
 * derived from the glyphs kept.
 */
function subsetTag(gids: Iterable<number>): string {
  let hash = 0x811c9dc5;
  for (const gid of gids) {
    hash = Math.imul(hash ^ gid, 0x01000193) >>> 0;
  }
  let letters = '';
  for (let i = 0; i < 6; i++) {
    letters += String.fromCharCode(0x41 + ((hash >>> (i * 5)) % 26));
  }
  return letters;
}

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** UTF-16BE hex of [text], which is how a `/ToUnicode` destination is written. */
export function utf16beHex(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    out += hex4(text.charCodeAt(i));
  }
  return out;
}
