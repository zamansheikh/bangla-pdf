/**
 * Parsed view of a TrueType/OpenType font: table directory, `cmap`, `hmtx`,
 * metrics, and the `GSUB` layout table.
 *
 * Read-only and allocation-light. Nothing here throws on malformed input; a
 * font we cannot understand degrades to "no layout data".
 *
 * Ported from `lib/src/ot/ot_font.dart` in the `bangla_pdf` Dart package,
 * minus everything the Dart shaper needed — HarfBuzz does the shaping here, so
 * only what PDF embedding, subsetting and un-shaping need is kept.
 */

import { Coverage, OtData } from './reader.js';

/**
 * A `GSUB`/`GPOS` layout table: script/language/feature/lookup resolution.
 *
 * Only used to read `GSUB` *backwards* during extraction; shaping is HarfBuzz's
 * job.
 */
export class LayoutTable {
  private constructor(
    readonly d: OtData,
    readonly tableOffset: number,
    private readonly scriptList: number,
    private readonly featureList: number,
    private readonly lookupList: number,
  ) {}

  static parse(d: OtData, tableOffset: number | undefined): LayoutTable | null {
    if (tableOffset === undefined || !d.has(tableOffset, 10)) return null;
    if (d.u16(tableOffset) !== 1) return null;
    return new LayoutTable(
      d,
      tableOffset,
      tableOffset + d.u16(tableOffset + 4),
      tableOffset + d.u16(tableOffset + 6),
      tableOffset + d.u16(tableOffset + 8),
    );
  }

  get lookupCount(): number {
    return this.d.u16(this.lookupList);
  }

  hasScript(tag: string): boolean {
    const count = this.d.u16(this.scriptList);
    for (let i = 0; i < count; i++) {
      if (this.d.tag(this.scriptList + 2 + 6 * i) === tag) return true;
    }
    return false;
  }

  /** Byte offset of lookup [index], or null when out of range. */
  lookupOffset(index: number): number | null {
    if (index < 0 || index >= this.lookupCount) return null;
    return this.lookupList + this.d.u16(this.lookupList + 2 + 2 * index);
  }

  private langSys(scriptTags: string[]): number | null {
    const count = this.d.u16(this.scriptList);
    for (const want of [...scriptTags, 'DFLT']) {
      for (let i = 0; i < count; i++) {
        const rec = this.scriptList + 2 + 6 * i;
        if (this.d.tag(rec) !== want) continue;
        const script = this.scriptList + this.d.u16(rec + 4);
        const defaultLangSys = this.d.u16(script);
        if (defaultLangSys !== 0) return script + defaultLangSys;
      }
    }
    return null;
  }

  /** Feature tag -> ordered lookup indices, for the given scripts. */
  featureLookups(scriptTags: string[]): Map<string, number[]> {
    const result = new Map<string, number[]>();
    const langSys = this.langSys(scriptTags);
    const featureCount = this.d.u16(this.featureList);

    const addFeature = (featureIndex: number) => {
      if (featureIndex < 0 || featureIndex >= featureCount) return;
      const rec = this.featureList + 2 + 6 * featureIndex;
      const tag = this.d.tag(rec);
      const table = this.featureList + this.d.u16(rec + 4);
      const n = this.d.u16(table + 2);
      let list = result.get(tag);
      if (!list) {
        list = [];
        result.set(tag, list);
      }
      for (let i = 0; i < n; i++) {
        const lookupIndex = this.d.u16(table + 4 + 2 * i);
        if (!list.includes(lookupIndex)) list.push(lookupIndex);
      }
    };

    if (langSys === null) {
      // No script record at all: expose every feature, so an unusual script
      // list still yields something to invert.
      for (let i = 0; i < featureCount; i++) addFeature(i);
    } else {
      const required = this.d.u16(langSys + 2);
      if (required !== 0xffff) addFeature(required);
      const n = this.d.u16(langSys + 4);
      for (let i = 0; i < n; i++) addFeature(this.d.u16(langSys + 6 + 2 * i));
    }

    for (const list of result.values()) list.sort((a, b) => a - b);
    return result;
  }
}

/** A parsed font, sufficient for PDF embedding, subsetting and un-shaping. */
export class OtFont {
  readonly bytes: Uint8Array;
  readonly d: OtData;
  private readonly tables = new Map<string, number>();
  private readonly tableLengths = new Map<string, number>();

  /** Unicode scalar -> glyph id, from the best available `cmap` subtable. */
  readonly cmap = new Map<number, number>();

  gsub: LayoutTable | null = null;
  gpos: LayoutTable | null = null;

  private advances: number[] = [];
  private numHMetrics = 0;
  private locaCache: number[] | null | undefined;

  private constructor(bytes: Uint8Array, d: OtData) {
    this.bytes = bytes;
    this.d = d;
  }

  /** Parses [bytes]; returns null if this is not a usable sfnt font. */
  static parse(bytes: Uint8Array): OtFont | null {
    const d = new OtData(bytes);
    if (!d.has(0, 12)) return null;
    let base = 0;
    if (d.tag(0) === 'ttcf') {
      if (!d.has(12, 4)) return null;
      base = d.u32(12);
      if (!d.has(base, 12)) return null;
    }
    const sfnt = d.u32(base);
    // 0x00010000 TrueType, 'OTTO' CFF, 'true'/'typ1' Mac.
    if (sfnt !== 0x00010000 && sfnt !== 0x4f54544f && sfnt !== 0x74727565 && sfnt !== 0x74797031) {
      return null;
    }
    const font = new OtFont(bytes, d);
    const numTables = d.u16(base + 4);
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + 16 * i;
      if (!d.has(rec, 16)) break;
      const tag = d.tag(rec);
      font.tables.set(tag, d.u32(rec + 8));
      font.tableLengths.set(tag, d.u32(rec + 12));
    }
    if (!font.tables.has('cmap')) return null;
    font.init();
    return font;
  }

  tableOffset(tag: string): number | undefined {
    return this.tables.get(tag);
  }

  tableLength(tag: string): number | undefined {
    return this.tableLengths.get(tag);
  }

  /** Whether the font has TrueType (`glyf`) outlines rather than CFF. */
  get hasTrueTypeOutlines(): boolean {
    return this.tables.has('glyf') && this.tables.has('loca');
  }

  private init(): void {
    this.parseCmap();
    this.parseHmtx();
    this.gsub = LayoutTable.parse(this.d, this.tables.get('GSUB'));
    this.gpos = LayoutTable.parse(this.d, this.tables.get('GPOS'));
  }

  private memo = new Map<string, unknown>();
  private lazy<T>(key: string, make: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, make());
    return this.memo.get(key) as T;
  }

  get upem(): number {
    return this.lazy('upem', () => {
      const head = this.tables.get('head');
      if (head === undefined) return 1000;
      const v = this.d.u16(head + 18);
      return v === 0 ? 1000 : v;
    });
  }

  get numGlyphs(): number {
    return this.lazy('numGlyphs', () => {
      const maxp = this.tables.get('maxp');
      return maxp === undefined ? 0 : this.d.u16(maxp + 4);
    });
  }

  /** Typographic ascender in font units. */
  get ascender(): number {
    return this.lazy('ascender', () => {
      const os2 = this.tables.get('OS/2');
      if (os2 !== undefined && this.d.u16(os2) >= 2 && this.d.has(os2 + 70, 2)) {
        const typo = this.d.i16(os2 + 68);
        if (typo !== 0) return typo;
      }
      const hhea = this.tables.get('hhea');
      return hhea === undefined ? Math.round(this.upem * 0.8) : this.d.i16(hhea + 4);
    });
  }

  /** Typographic descender in font units (negative). */
  get descender(): number {
    return this.lazy('descender', () => {
      const os2 = this.tables.get('OS/2');
      if (os2 !== undefined && this.d.u16(os2) >= 2 && this.d.has(os2 + 72, 2)) {
        const typo = this.d.i16(os2 + 70);
        if (typo !== 0) return typo;
      }
      const hhea = this.tables.get('hhea');
      return hhea === undefined ? -Math.round(this.upem * 0.2) : this.d.i16(hhea + 6);
    });
  }

  /** Font bounding box in font units, from `head`: [xMin, yMin, xMax, yMax]. */
  get boundingBox(): [number, number, number, number] {
    return this.lazy('bbox', (): [number, number, number, number] => {
      const head = this.tables.get('head');
      if (head === undefined) {
        return [0, -Math.round(this.upem / 4), this.upem, this.upem];
      }
      return [
        this.d.i16(head + 36),
        this.d.i16(head + 38),
        this.d.i16(head + 40),
        this.d.i16(head + 42),
      ];
    });
  }

  /** PostScript name from the `name` table, sanitised for use in a PDF. */
  get postScriptName(): string {
    return this.lazy('psname', () => {
      const name = this.tables.get('name');
      if (name === undefined) return 'BanglaFont';
      const count = this.d.u16(name + 2);
      const storage = name + this.d.u16(name + 4);
      let best: string | null = null;
      for (let i = 0; i < count; i++) {
        const rec = name + 6 + 12 * i;
        const platform = this.d.u16(rec);
        const nameId = this.d.u16(rec + 6);
        if (nameId !== 6) continue;
        const length = this.d.u16(rec + 8);
        const offset = storage + this.d.u16(rec + 10);
        const units: number[] = [];
        if (platform === 3) {
          for (let k = 0; k + 1 < length; k += 2) units.push(this.d.u16(offset + k));
        } else {
          for (let k = 0; k < length; k++) units.push(this.d.u8(offset + k));
        }
        const text = String.fromCharCode(...units);
        if (best === null) best = text;
        if (platform === 3) break;
      }
      const clean = (best ?? 'BanglaFont').replace(/[^A-Za-z0-9_-]/g, '');
      return clean.length === 0 ? 'BanglaFont' : clean;
    });
  }

  private get loca(): number[] | null {
    if (this.locaCache !== undefined) return this.locaCache;
    const loca = this.tables.get('loca');
    const head = this.tables.get('head');
    const maxp = this.tables.get('maxp');
    if (loca === undefined || head === undefined || maxp === undefined || !this.tables.has('glyf')) {
      return (this.locaCache = null);
    }
    const long = this.d.i16(head + 50) !== 0;
    const count = this.d.u16(maxp + 4) + 1;
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      if (long) {
        if (!this.d.has(loca + i * 4, 4)) return (this.locaCache = null);
        out[i] = this.d.u32(loca + i * 4);
      } else {
        if (!this.d.has(loca + i * 2, 2)) return (this.locaCache = null);
        out[i] = this.d.u16(loca + i * 2) * 2;
      }
    }
    return (this.locaCache = out);
  }

  /**
   * Vertical ink extents of [gid] in font units, as `[yMin, yMax]`.
   *
   * Null for an empty glyph such as a space, or a font with no `glyf`.
   */
  glyphExtents(gid: number): [number, number] | null {
    const loca = this.loca;
    const glyf = this.tables.get('glyf');
    if (loca === null || glyf === undefined) return null;
    if (gid < 0 || gid + 1 >= loca.length) return null;
    const start = loca[gid]!;
    if (loca[gid + 1]! <= start) return null;
    const at = glyf + start;
    if (!this.d.has(at, 10)) return null;
    return [this.d.i16(at + 4), this.d.i16(at + 8)];
  }

  /** Horizontal advance of [glyph] in font units. */
  advance(glyph: number): number {
    if (this.advances.length === 0) return Math.round(this.upem * 0.5);
    if (glyph < this.advances.length) return this.advances[glyph]!;
    return this.advances[this.numHMetrics - 1] ?? 0;
  }

  /** Glyph id for [rune], or undefined when the font has no glyph for it. */
  glyphForRune(rune: number): number | undefined {
    return this.cmap.get(rune);
  }

  /** Whether GSUB or GPOS has a Bengali script record (`bng2` or `beng`). */
  get declaresBengaliScript(): boolean {
    return [this.gsub, this.gpos].some(
      (table) => table !== null && (table.hasScript('bng2') || table.hasScript('beng')),
    );
  }

  /**
   * Whether the font covers the Bengali block beyond a token codepoint or two.
   *
   * Tells a real Unicode Bangla font from a legacy 8-bit ANSI (Bijoy) one.
   */
  get hasBengaliCoverage(): boolean {
    return this.lazy('bengaliCoverage', () => {
      // The 11 most common Bangla letters. A Unicode font has all of them; an
      // ANSI font has none.
      const probes = [
        0x0995, 0x0996, 0x0997, 0x099a, 0x09a4, 0x09a6, 0x09a8, 0x09ac, 0x09ae, 0x09b0, 0x09b8,
      ];
      let hits = 0;
      for (const p of probes) if (this.cmap.has(p)) hits++;
      return hits >= probes.length - 1;
    });
  }

  private parseHmtx(): void {
    const hhea = this.tables.get('hhea');
    const hmtx = this.tables.get('hmtx');
    if (hhea === undefined || hmtx === undefined) return;
    this.numHMetrics = this.d.u16(hhea + 34);
    if (this.numHMetrics === 0) return;
    const n = this.numGlyphs > 0 ? this.numGlyphs : this.numHMetrics;
    const out = new Array<number>(n).fill(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      if (i < this.numHMetrics) last = this.d.u16(hmtx + 4 * i);
      out[i] = last;
    }
    this.advances = out;
  }

  private parseCmap(): void {
    const cmapOffset = this.tables.get('cmap');
    if (cmapOffset === undefined) return;
    const numSubtables = this.d.u16(cmapOffset + 2);

    // Preference: (3,10) UCS-4, (3,1) BMP, (0,*) Unicode, (3,0) symbol,
    // (1,0) Mac Roman. The last two are how legacy ANSI Bangla fonts encode.
    const rank = (platform: number, encoding: number): number => {
      if (platform === 3 && encoding === 10) return 0;
      if (platform === 3 && encoding === 1) return 1;
      if (platform === 0) return 2;
      if (platform === 3 && encoding === 0) return 3;
      if (platform === 1 && encoding === 0) return 4;
      return 5;
    };

    let bestRank = 99;
    let bestOffset = -1;
    let bestSymbol = false;
    for (let i = 0; i < numSubtables; i++) {
      const rec = cmapOffset + 4 + 8 * i;
      const platform = this.d.u16(rec);
      const encoding = this.d.u16(rec + 2);
      const sub = cmapOffset + this.d.u32(rec + 4);
      const r = rank(platform, encoding);
      if (r < bestRank) {
        bestRank = r;
        bestOffset = sub;
        bestSymbol = platform === 3 && encoding === 0;
      }
    }
    if (bestOffset < 0) return;
    this.parseCmapSubtable(bestOffset, bestSymbol);
  }

  private parseCmapSubtable(sub: number, symbol: boolean): void {
    const d = this.d;
    switch (d.u16(sub)) {
      case 0:
        for (let c = 0; c < 256; c++) {
          const g = d.u8(sub + 6 + c);
          if (g !== 0) this.cmap.set(c, g);
        }
        break;
      case 4: {
        const segX2 = d.u16(sub + 6);
        const segs = Math.floor(segX2 / 2);
        const endO = sub + 14;
        const startO = endO + segX2 + 2;
        const deltaO = startO + segX2;
        const rangeO = deltaO + segX2;
        for (let s = 0; s < segs; s++) {
          const end = d.u16(endO + 2 * s);
          const start = d.u16(startO + 2 * s);
          const delta = d.u16(deltaO + 2 * s);
          const rangeOffset = d.u16(rangeO + 2 * s);
          if (start === 0xffff) continue;
          for (let c = start; c <= end && c !== 0x10000; c++) {
            let g: number;
            if (rangeOffset === 0) {
              g = (c + delta) & 0xffff;
            } else {
              g = d.u16(rangeO + 2 * s + rangeOffset + 2 * (c - start));
              if (g !== 0) g = (g + delta) & 0xffff;
            }
            if (g === 0) continue;
            this.cmap.set(c, g);
            // Symbol subtables map into F0xx; also expose the low byte so
            // plain Latin-1 lookups succeed.
            if (symbol && c >= 0xf000 && c <= 0xf0ff && !this.cmap.has(c & 0xff)) {
              this.cmap.set(c & 0xff, g);
            }
          }
        }
        break;
      }
      case 6: {
        const first = d.u16(sub + 6);
        const count = d.u16(sub + 8);
        for (let i = 0; i < count; i++) {
          const g = d.u16(sub + 10 + 2 * i);
          if (g !== 0) this.cmap.set(first + i, g);
        }
        break;
      }
      case 12: {
        const nGroups = d.u32(sub + 12);
        for (let i = 0; i < nGroups; i++) {
          const o = sub + 16 + 12 * i;
          const start = d.u32(o);
          const end = d.u32(o + 4);
          const startGlyph = d.u32(o + 8);
          if (end < start || end - start > 0x10ffff) continue;
          for (let c = start; c <= end; c++) this.cmap.set(c, startGlyph + (c - start));
        }
        break;
      }
      default:
        break;
    }
  }
}

export { Coverage, OtData };
