/**
 * Low-level OpenType binary primitives: bounds-checked readers and Coverage.
 *
 * Every reader returns a benign default rather than throwing, because fonts
 * come from users at runtime and a malformed table must never abort PDF
 * generation.
 *
 * Ported from `lib/src/ot/ot_reader.dart` in the `bangla_pdf` Dart package.
 */

/** A bounds-checked cursor over a font's bytes. */
export class OtData {
  readonly view: DataView;
  private readonly len: number;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.len = bytes.byteLength;
  }

  get length(): number {
    return this.len;
  }

  has(offset: number, length: number): boolean {
    return offset >= 0 && length >= 0 && offset + length <= this.len;
  }

  u8(o: number): number {
    return this.has(o, 1) ? this.view.getUint8(o) : 0;
  }

  u16(o: number): number {
    return this.has(o, 2) ? this.view.getUint16(o) : 0;
  }

  i16(o: number): number {
    return this.has(o, 2) ? this.view.getInt16(o) : 0;
  }

  u32(o: number): number {
    return this.has(o, 4) ? this.view.getUint32(o) : 0;
  }

  tag(o: number): string {
    if (!this.has(o, 4)) return '    ';
    return String.fromCharCode(this.u8(o), this.u8(o + 1), this.u8(o + 2), this.u8(o + 3));
  }
}

interface CovRange {
  start: number;
  end: number;
  value: number;
}

/**
 * OpenType Coverage table (formats 1 and 2): glyph id -> coverage index.
 */
export class Coverage {
  private constructor(
    private readonly single: Map<number, number>,
    private readonly ranges: CovRange[],
  ) {}

  static parse(d: OtData, offset: number): Coverage {
    switch (d.u16(offset)) {
      case 1: {
        const count = d.u16(offset + 2);
        const map = new Map<number, number>();
        for (let i = 0; i < count; i++) map.set(d.u16(offset + 4 + 2 * i), i);
        return new Coverage(map, []);
      }
      case 2: {
        const count = d.u16(offset + 2);
        const ranges: CovRange[] = [];
        for (let i = 0; i < count; i++) {
          const o = offset + 4 + 6 * i;
          ranges.push({ start: d.u16(o), end: d.u16(o + 2), value: d.u16(o + 4) });
        }
        return new Coverage(new Map(), ranges);
      }
      default:
        return new Coverage(new Map(), []);
    }
  }

  indexOf(glyph: number): number | undefined {
    const direct = this.single.get(glyph);
    if (direct !== undefined) return direct;
    let lo = 0;
    let hi = this.ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.ranges[mid]!;
      if (glyph < r.start) hi = mid - 1;
      else if (glyph > r.end) lo = mid + 1;
      else return r.value + (glyph - r.start);
    }
    return undefined;
  }

  covers(glyph: number): boolean {
    return this.indexOf(glyph) !== undefined;
  }

  /**
   * Covered glyph ids in coverage-index order.
   *
   * Needed to walk a subtable's parallel arrays, where entry *i* belongs to
   * the glyph whose coverage index is *i*.
   */
  get glyphs(): number[] {
    const out: number[] = [];
    const put = (index: number, glyph: number) => {
      while (out.length <= index) out.push(0);
      out[index] = glyph;
    };
    for (const [glyph, index] of this.single) put(index, glyph);
    for (const range of this.ranges) {
      for (let g = range.start; g <= range.end; g++) {
        put(range.value + (g - range.start), g);
      }
    }
    return out;
  }
}
