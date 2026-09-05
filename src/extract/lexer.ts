/**
 * A tokenizer for PDF syntax, shared by the file parser and the content-stream
 * walker.
 *
 * It never throws: a malformed document yields whatever objects could be read
 * and stops. Extraction is best-effort by nature — the PDFs that most need it
 * are the ones produced by the worst tools.
 *
 * Ported from `lib/src/extract/pdf_lexer.dart` in the `bangla_pdf` Dart
 * package.
 */

import { array, dict, name, num, op, PDF_NULL, ref, str, type PdfDictObj, type PdfObj } from './objects.js';

/** Character classification per PDF 32000-1 §7.2.2. */
function isWhitespace(c: number): boolean {
  return c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
}

function isDelimiter(c: number): boolean {
  return (
    c === 0x28 || // (
    c === 0x29 || // )
    c === 0x3c || // <
    c === 0x3e || // >
    c === 0x5b || // [
    c === 0x5d || // ]
    c === 0x7b || // {
    c === 0x7d || // }
    c === 0x2f || // /
    c === 0x25 // %
  );
}

function isRegular(c: number): boolean {
  return !isWhitespace(c) && !isDelimiter(c);
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

/** Reads PDF objects out of a byte buffer. */
export class PdfLexer {
  constructor(
    readonly bytes: Uint8Array,
    public offset = 0,
  ) {}

  get atEnd(): boolean {
    return this.offset >= this.bytes.length;
  }

  private get current(): number {
    return this.offset < this.bytes.length ? this.bytes[this.offset]! : -1;
  }

  /** Skips whitespace and `%` comments. */
  skipWhitespace(): void {
    while (this.offset < this.bytes.length) {
      const c = this.bytes[this.offset]!;
      if (isWhitespace(c)) {
        this.offset++;
      } else if (c === 0x25) {
        while (
          this.offset < this.bytes.length &&
          this.bytes[this.offset] !== 0x0a &&
          this.bytes[this.offset] !== 0x0d
        ) {
          this.offset++;
        }
      } else {
        return;
      }
    }
  }

  /**
   * Reads the next token, or null at end of input.
   *
   * Indirect references (`1 0 R`) are recognised by lookahead. `obj`, `endobj`,
   * `stream` and content operators come back as operators.
   */
  next(): PdfObj | null {
    this.skipWhitespace();
    if (this.atEnd) return null;
    const c = this.current;

    switch (c) {
      case 0x2f: // /
        return name(this.readName());
      case 0x28: // (
        return str(this.readLiteralString());
      case 0x5b: // [
        this.offset++;
        return array(this.readUntil(0x5d));
      case 0x5d: // ]
        this.offset++;
        return op(']');
      case 0x3c: // < or <<
        if (this.offset + 1 < this.bytes.length && this.bytes[this.offset + 1] === 0x3c) {
          this.offset += 2;
          return this.readDict();
        }
        return str(this.readHexString());
      case 0x3e: // >>
        this.offset +=
          this.offset + 1 < this.bytes.length && this.bytes[this.offset + 1] === 0x3e ? 2 : 1;
        return op('>>');
      case 0x7b: // {
      case 0x7d: // }
        this.offset++;
        return op(String.fromCharCode(c));
      default:
        break;
    }

    const token = this.readToken();
    if (token.length === 0) {
      this.offset++;
      return PDF_NULL;
    }
    switch (token) {
      case 'true':
        return { kind: 'bool', value: true };
      case 'false':
        return { kind: 'bool', value: false };
      case 'null':
        return PDF_NULL;
      default:
        break;
    }

    const value = Number(token);
    if (!Number.isFinite(value) || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) return op(token);

    // `n g R` is an indirect reference; `n g obj` starts an object. Both need
    // two-token lookahead, so the position is restored when it is neither.
    if (Number.isInteger(value) && value >= 0) {
      const save = this.offset;
      this.skipWhitespace();
      const genToken = this.readToken();
      const generation = /^\d+$/.test(genToken) ? Number(genToken) : null;
      if (generation !== null) {
        this.skipWhitespace();
        const keywordStart = this.offset;
        const keyword = this.readToken();
        if (keyword === 'R') return ref(value, generation);
        this.offset = keywordStart;
      }
      this.offset = save;
    }
    return num(value);
  }

  /** Reads objects until [closer] or end of input. */
  private readUntil(closer: number): PdfObj[] {
    const out: PdfObj[] = [];
    let guard = 0;
    while (!this.atEnd && ++guard < 1000000) {
      this.skipWhitespace();
      if (this.current === closer) {
        this.offset++;
        break;
      }
      const o = this.next();
      if (o === null) break;
      if (o.kind === 'op' && o.name === String.fromCharCode(closer)) break;
      out.push(o);
    }
    return out;
  }

  private readDict(): PdfDictObj {
    const map = new Map<string, PdfObj>();
    let guard = 0;
    while (!this.atEnd && ++guard < 1000000) {
      this.skipWhitespace();
      if (this.current === 0x3e) {
        this.offset +=
          this.offset + 1 < this.bytes.length && this.bytes[this.offset + 1] === 0x3e ? 2 : 1;
        break;
      }
      if (this.current !== 0x2f) {
        // Not a name where a key must be: skip a token and keep going rather
        // than abandoning the whole dictionary.
        if (this.next() === null) break;
        continue;
      }
      const key = this.readName();
      const value = this.next();
      if (value === null) break;
      if (value.kind === 'op' && value.name === '>>') break;
      map.set(key, value);
    }
    return dict(map);
  }

  private readName(): string {
    this.offset++; // skip '/'
    let out = '';
    while (this.offset < this.bytes.length && isRegular(this.bytes[this.offset]!)) {
      let c = this.bytes[this.offset++]!;
      if (c === 0x23 && this.offset + 1 < this.bytes.length) {
        const hi = hexValue(this.bytes[this.offset]!);
        const lo = hexValue(this.bytes[this.offset + 1]!);
        if (hi >= 0 && lo >= 0) {
          c = hi * 16 + lo;
          this.offset += 2;
        }
      }
      out += String.fromCharCode(c);
    }
    return out;
  }

  private readToken(): string {
    const start = this.offset;
    while (this.offset < this.bytes.length && isRegular(this.bytes[this.offset]!)) this.offset++;
    let out = '';
    for (let i = start; i < this.offset; i++) out += String.fromCharCode(this.bytes[i]!);
    return out;
  }

  private readLiteralString(): Uint8Array {
    this.offset++; // skip '('
    const out: number[] = [];
    let depth = 1;
    while (this.offset < this.bytes.length) {
      let c = this.bytes[this.offset++]!;
      if (c === 0x5c) {
        // backslash
        if (this.offset >= this.bytes.length) break;
        c = this.bytes[this.offset++]!;
        switch (c) {
          case 0x6e:
            out.push(0x0a);
            break;
          case 0x72:
            out.push(0x0d);
            break;
          case 0x74:
            out.push(0x09);
            break;
          case 0x62:
            out.push(0x08);
            break;
          case 0x66:
            out.push(0x0c);
            break;
          case 0x0a:
            break; // line continuation
          case 0x0d:
            if (this.offset < this.bytes.length && this.bytes[this.offset] === 0x0a) this.offset++;
            break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let value = c - 0x30;
              for (let i = 0; i < 2; i++) {
                const d = this.bytes[this.offset];
                if (d !== undefined && d >= 0x30 && d <= 0x37) {
                  value = value * 8 + (d - 0x30);
                  this.offset++;
                } else {
                  break;
                }
              }
              out.push(value & 0xff);
            } else {
              out.push(c);
            }
        }
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29) {
        depth--;
        if (depth === 0) break;
      }
      out.push(c);
    }
    return Uint8Array.from(out);
  }

  private readHexString(): Uint8Array {
    this.offset++; // skip '<'
    const out: number[] = [];
    let high = -1;
    while (this.offset < this.bytes.length) {
      const c = this.bytes[this.offset++]!;
      if (c === 0x3e) break;
      const v = hexValue(c);
      if (v < 0) continue;
      if (high < 0) {
        high = v;
      } else {
        out.push(high * 16 + v);
        high = -1;
      }
    }
    // An odd number of digits is padded with a trailing zero.
    if (high >= 0) out.push(high * 16);
    return Uint8Array.from(out);
  }
}
