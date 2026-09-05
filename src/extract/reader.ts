/**
 * Reads a PDF file: cross-reference tables and streams, indirect objects,
 * object streams, and the page tree.
 *
 * Designed to survive damage. If the cross-reference table is missing, wrong or
 * points into the wrong place — which is common in the scanned and government
 * documents this package exists for — the reader falls back to scanning the
 * whole file for `n g obj` markers.
 *
 * Ported from `lib/src/extract/pdf_reader.dart` in the `bangla_pdf` Dart
 * package.
 */

import { PdfDecryptor } from './decryptor.js';
import { decodeStream } from './filters.js';
import { PdfLexer } from './lexer.js';
import {
  array,
  dict,
  get,
  PDF_NULL,
  ref,
  str,
  type PdfDictObj,
  type PdfObj,
  type PdfStreamObj,
} from './objects.js';

/** A parsed PDF document. */
export class PdfReader {
  private constructor(readonly bytes: Uint8Array) {}

  /** Object number -> byte offset of `n g obj`. */
  private readonly offsets = new Map<number, number>();

  /** Object number -> [object stream number, index within it]. */
  private readonly compressed = new Map<number, [number, number]>();

  private readonly cache = new Map<number, PdfObj>();
  private readonly loading = new Set<number>();

  /** The trailer dictionary, merged across every cross-reference section. */
  trailer: PdfDictObj = dict(new Map());

  private decryptor: PdfDecryptor | null = null;

  /** The object holding `/Encrypt`, which is never itself encrypted. */
  private encryptObject: number | null = null;

  /** Whether the document declares encryption. */
  get isEncrypted(): boolean {
    return this.trailer.entries.has('Encrypt');
  }

  /**
   * Whether the document is encrypted and could *not* be opened.
   *
   * An encrypted document that opens with an empty user password — which is
   * most of them — reads as normal and reports false here.
   */
  get isLocked(): boolean {
    return this.isEncrypted && this.decryptor === null;
  }

  /** Parses [bytes]. Returns null only when the data is not a PDF at all. */
  static open(bytes: Uint8Array, password = ''): PdfReader | null {
    if (bytes.length < 8) return null;
    const head = bytes.subarray(0, Math.min(1024, bytes.length));
    if (indexOfAscii(head, '%PDF-', 0) < 0) return null;
    const reader = new PdfReader(bytes);
    reader.load(password);
    return reader;
  }

  private load(password: string): void {
    try {
      this.readXref();
    } catch {
      // Ignored: the brute-force scan below is the recovery path.
    }
    // Always index by scanning too. It costs one pass and repairs documents
    // whose xref offsets are stale, which is common after naive editing.
    this.scanForObjects();
    if (!this.trailer.entries.has('Root')) this.findRootByScan();
    this.setUpDecryption(password);
  }

  private setUpDecryption(password: string): void {
    const encryptRef = get(this.trailer, 'Encrypt');
    if (encryptRef.kind === 'null') return;
    if (encryptRef.kind === 'ref') this.encryptObject = encryptRef.number;

    const d = this.resolve(encryptRef);
    if (d.kind !== 'dict') return;

    // The first element of /ID goes into the key, and is not encrypted.
    let id: Uint8Array = new Uint8Array(0);
    const ids = this.resolve(get(this.trailer, 'ID'));
    if (ids.kind === 'array' && ids.values.length > 0) {
      const first = this.resolve(ids.values[0]!);
      if (first.kind === 'string') id = first.bytes;
    }

    try {
      this.decryptor = PdfDecryptor.open(d, (o) => this.resolve(o), id, password);
    } catch {
      this.decryptor = null; // a handler we cannot read is simply not supported
    }

    // Anything resolved while setting this up was read undecrypted.
    this.cache.clear();
  }

  /**
   * Decrypts every string and stream inside one object.
   *
   * Objects inside an object stream are skipped: the container was decrypted as
   * a whole, so its contents are already plain.
   */
  private decryptObject(o: PdfObj, number: number, generation: number): PdfObj {
    const crypt = this.decryptor;
    if (crypt === null || number === this.encryptObject) return o;

    const walk = (value: PdfObj): PdfObj => {
      switch (value.kind) {
        case 'string':
          return str(crypt.decryptString(value.bytes, number, generation));
        case 'array':
          return array(value.values.map(walk));
        case 'dict': {
          const out = new Map<string, PdfObj>();
          for (const [k, v] of value.entries) out.set(k, walk(v));
          return dict(out);
        }
        case 'stream': {
          const type = get(value.dict, 'Type');
          // Cross-reference streams carry the map to everything else and are
          // never encrypted.
          if (type.kind === 'name' && type.value === 'XRef') return value;
          return {
            kind: 'stream',
            dict: walk(value.dict) as PdfDictObj,
            raw: crypt.decryptStream(value.raw, number, generation),
          };
        }
        default:
          return value;
      }
    };

    return walk(o);
  }

  // --- cross-reference ------------------------------------------------------

  private readXref(): void {
    const from = Math.max(0, this.bytes.length - 2048);
    const marker = lastIndexOfAscii(this.bytes, 'startxref', from);
    if (marker < 0) return;
    const lexer = new PdfLexer(this.bytes, marker + 9);
    const start = lexer.next();
    if (start === null || start.kind !== 'num') return;

    let offset = Math.trunc(start.value);
    const seen = new Set<number>();
    while (offset > 0 && offset < this.bytes.length && !seen.has(offset)) {
      seen.add(offset);
      const next = this.readXrefSection(offset);
      if (next === null) break;
      offset = next;
    }
  }

  /** Reads one xref section, returning the `/Prev` offset if there is one. */
  private readXrefSection(offset: number): number | null {
    const lexer = new PdfLexer(this.bytes, offset);
    lexer.skipWhitespace();
    const first = lexer.next();

    if (first !== null && first.kind === 'op' && first.name === 'xref') {
      // Classic table.
      for (;;) {
        lexer.skipWhitespace();
        const a = lexer.next();
        if (a === null) return null;
        if (a.kind === 'op' && a.name === 'trailer') break;
        if (a.kind !== 'num') return null;
        const b = lexer.next();
        if (b === null || b.kind !== 'num') return null;
        const startNum = Math.trunc(a.value);
        const count = Math.trunc(b.value);
        for (let i = 0; i < count; i++) {
          lexer.skipWhitespace();
          const o = lexer.next();
          const g = lexer.next();
          const type = lexer.next();
          if (o === null || o.kind !== 'num' || g === null || g.kind !== 'num') return null;
          const inUse = type !== null && type.kind === 'op' && type.name === 'n';
          if (inUse && !this.offsets.has(startNum + i)) {
            this.offsets.set(startNum + i, Math.trunc(o.value));
          }
        }
      }
      const d = lexer.next();
      if (d !== null && d.kind === 'dict') {
        this.mergeTrailer(d);
        // A hybrid file points at an xref stream holding the rest.
        const hybrid = get(d, 'XRefStm');
        if (hybrid.kind === 'num') this.readXrefSection(Math.trunc(hybrid.value));
        const prev = get(d, 'Prev');
        if (prev.kind === 'num') return Math.trunc(prev.value);
      }
      return null;
    }

    // Cross-reference stream: `n g obj << … >> stream`.
    if (first !== null && first.kind === 'num') {
      lexer.next(); // generation
      const kw = lexer.next();
      if (kw === null || kw.kind !== 'op' || kw.name !== 'obj') return null;
      const obj = this.readObjectBody(lexer);
      if (obj.kind !== 'stream') return null;
      this.readXrefStream(obj);
      this.mergeTrailer(obj.dict);
      const prev = get(obj.dict, 'Prev');
      if (prev.kind === 'num') return Math.trunc(prev.value);
    }
    return null;
  }

  private readXrefStream(stream: PdfStreamObj): void {
    const data = decodeStream(stream.raw, stream.dict, (o) => this.resolve(o));
    if (data === null) return;
    const w = this.resolve(get(stream.dict, 'W'));
    if (w.kind !== 'array' || w.values.length < 3) return;
    const widths = w.values.map((v) => (v.kind === 'num' ? Math.trunc(v.value) : 0));
    const rowLength = widths.reduce((a, b) => a + b, 0);
    if (rowLength <= 0) return;

    const ranges: [number, number][] = [];
    const index = this.resolve(get(stream.dict, 'Index'));
    if (index.kind === 'array') {
      for (let i = 0; i + 1 < index.values.length; i += 2) {
        const a = index.values[i]!;
        const b = index.values[i + 1]!;
        if (a.kind === 'num' && b.kind === 'num') {
          ranges.push([Math.trunc(a.value), Math.trunc(b.value)]);
        }
      }
    } else {
      const size = this.resolve(get(stream.dict, 'Size'));
      ranges.push([0, size.kind === 'num' ? Math.trunc(size.value) : 0]);
    }

    let pos = 0;
    const field = (width: number, fallback: number): number => {
      if (width === 0) return fallback;
      let v = 0;
      for (let i = 0; i < width; i++) v = v * 256 + (pos < data.length ? data[pos++]! : 0);
      return v;
    };

    for (const [start, count] of ranges) {
      for (let i = 0; i < count; i++) {
        if (pos + rowLength > data.length) return;
        const type = field(widths[0]!, 1);
        const f2 = field(widths[1]!, 0);
        const f3 = field(widths[2]!, 0);
        const number = start + i;
        if (type === 1) {
          if (!this.offsets.has(number)) this.offsets.set(number, f2);
        } else if (type === 2) {
          if (!this.compressed.has(number)) this.compressed.set(number, [f2, f3]);
        }
      }
    }
  }

  private mergeTrailer(d: PdfDictObj): void {
    const merged = new Map(d.entries);
    for (const [k, v] of this.trailer.entries) merged.set(k, v);
    this.trailer = dict(merged);
  }

  // --- brute-force recovery -------------------------------------------------

  /**
   * Indexes every `n g obj` in the file.
   *
   * Later definitions win, matching how incremental updates work.
   */
  private scanForObjects(): void {
    const bytes = this.bytes;
    for (let i = 0; i + 2 < bytes.length; i++) {
      if (bytes[i] !== 0x6f || bytes[i + 1] !== 0x62 || bytes[i + 2] !== 0x6a) continue; // "obj"
      // Walk back over "  g  n".
      let j = i - 1;
      while (j >= 0 && (bytes[j] === 0x20 || bytes[j] === 0x0d || bytes[j] === 0x0a)) j--;
      const genEnd = j + 1;
      while (j >= 0 && bytes[j]! >= 0x30 && bytes[j]! <= 0x39) j--;
      const genStart = j + 1;
      if (genStart === genEnd) continue;
      while (j >= 0 && (bytes[j] === 0x20 || bytes[j] === 0x0d || bytes[j] === 0x0a)) j--;
      const numEnd = j + 1;
      while (j >= 0 && bytes[j]! >= 0x30 && bytes[j]! <= 0x39) j--;
      const numStart = j + 1;
      if (numStart === numEnd) continue;
      if (j >= 0 && !isDelimiterOrSpace(bytes[j]!)) continue;
      let text = '';
      for (let k = numStart; k < numEnd; k++) text += String.fromCharCode(bytes[k]!);
      const number = Number(text);
      if (!Number.isInteger(number)) continue;
      this.offsets.set(number, numStart);
    }
  }

  private findRootByScan(): void {
    for (const number of [...this.offsets.keys()]) {
      const o = this.object(number);
      if (o.kind === 'dict') {
        const type = get(o, 'Type');
        if (type.kind === 'name' && type.value === 'Catalog') {
          this.mergeTrailer(dict(new Map([['Root', ref(number, 0)]])));
          return;
        }
      }
    }
  }

  // --- object access --------------------------------------------------------

  /** Resolves [o] if it is a reference, otherwise returns it unchanged. */
  resolve(o: PdfObj | undefined): PdfObj {
    if (o === undefined) return PDF_NULL;
    if (o.kind === 'ref') return this.object(o.number);
    return o;
  }

  /** The object numbered [number], or null-object when unavailable. */
  object(number: number): PdfObj {
    const cached = this.cache.get(number);
    if (cached !== undefined) return cached;
    if (this.loading.has(number)) return PDF_NULL; // cycle guard
    this.loading.add(number);
    try {
      let result: PdfObj = PDF_NULL;
      const offset = this.offsets.get(number);
      if (offset !== undefined && offset >= 0 && offset < this.bytes.length) {
        result = this.parseAt(offset, number);
      }
      if (result.kind === 'null' && this.compressed.has(number)) {
        result = this.fromObjectStream(number);
      }
      this.cache.set(number, result);
      return result;
    } finally {
      this.loading.delete(number);
    }
  }

  private parseAt(offset: number, expected: number): PdfObj {
    const lexer = new PdfLexer(this.bytes, offset);
    const n = lexer.next();
    if (n === null || n.kind !== 'num' || Math.trunc(n.value) !== expected) return PDF_NULL;
    const gen = lexer.next();
    const kw = lexer.next();
    if (kw === null || kw.kind !== 'op' || kw.name !== 'obj') return PDF_NULL;
    return this.decryptObject(
      this.readObjectBody(lexer),
      expected,
      gen !== null && gen.kind === 'num' ? Math.trunc(gen.value) : 0,
    );
  }

  /** Reads the value after `obj`, attaching stream bytes when present. */
  private readObjectBody(lexer: PdfLexer): PdfObj {
    const value = lexer.next();
    if (value === null) return PDF_NULL;
    if (value.kind !== 'dict') return value;

    lexer.skipWhitespace();
    const save = lexer.offset;
    const maybeStream = lexer.next();
    if (maybeStream === null || maybeStream.kind !== 'op' || maybeStream.name !== 'stream') {
      lexer.offset = save;
      return value;
    }

    // The keyword is followed by CRLF or LF, then the data.
    let start = lexer.offset;
    if (start < this.bytes.length && this.bytes[start] === 0x0d) start++;
    if (start < this.bytes.length && this.bytes[start] === 0x0a) start++;

    let length = -1;
    const lengthObj = this.resolve(get(value, 'Length'));
    if (lengthObj.kind === 'num') length = Math.trunc(lengthObj.value);

    let end = length >= 0 && start + length <= this.bytes.length ? start + length : -1;
    // Trust `endstream` over a wrong /Length, which broken writers do emit.
    const marker = indexOfAscii(this.bytes, 'endstream', start);
    if (end < 0 || marker < 0 || Math.abs(marker - end) > 2) {
      if (marker >= 0) {
        end = marker;
        while (end > start && (this.bytes[end - 1] === 0x0a || this.bytes[end - 1] === 0x0d)) end--;
      }
    }
    if (end < start) end = start;
    return { kind: 'stream', dict: value, raw: this.bytes.subarray(start, end) };
  }

  private fromObjectStream(number: number): PdfObj {
    const entry = this.compressed.get(number);
    if (entry === undefined) return PDF_NULL;
    const container = this.object(entry[0]);
    if (container.kind !== 'stream') return PDF_NULL;
    const data = decodeStream(container.raw, container.dict, (o) => this.resolve(o));
    if (data === null) return PDF_NULL;

    const n = this.resolve(get(container.dict, 'N'));
    const first = this.resolve(get(container.dict, 'First'));
    if (n.kind !== 'num' || first.kind !== 'num') return PDF_NULL;

    const header = new PdfLexer(data);
    for (let i = 0; i < n.value; i++) {
      const num = header.next();
      const off = header.next();
      if (num === null || num.kind !== 'num' || off === null || off.kind !== 'num') break;
      if (Math.trunc(num.value) !== number) continue;
      const at = Math.trunc(first.value) + Math.trunc(off.value);
      if (at < 0 || at >= data.length) break;
      return new PdfLexer(data, at).next() ?? PDF_NULL;
    }
    return PDF_NULL;
  }

  /** Decoded bytes of [stream], or null for image data. */
  decoded(stream: PdfStreamObj): Uint8Array | null {
    return decodeStream(stream.raw, stream.dict, (o) => this.resolve(o));
  }

  // --- page tree ------------------------------------------------------------

  /**
   * Every page dictionary, in document order, with inherited attributes
   * (`Resources`, `MediaBox`) folded in.
   */
  pages(): PdfDictObj[] {
    const root = this.resolve(get(this.trailer, 'Root'));
    const out: PdfDictObj[] = [];
    if (root.kind === 'dict') {
      const tree = this.resolve(get(root, 'Pages'));
      if (tree.kind === 'dict') this.collectPages(tree, dict(new Map()), out, new Set());
    }
    if (out.length === 0) {
      // Damaged page tree: fall back to every object that looks like a page.
      for (const number of [...this.offsets.keys()].sort((a, b) => a - b)) {
        const o = this.object(number);
        if (o.kind === 'dict') {
          const type = get(o, 'Type');
          if (type.kind === 'name' && type.value === 'Page') out.push(o);
        }
      }
    }
    return out;
  }

  private static readonly INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

  private collectPages(
    node: PdfDictObj,
    inherited: PdfDictObj,
    out: PdfDictObj[],
    seen: Set<number>,
  ): void {
    if (out.length > 20000) return;
    const merged = new Map(inherited.entries);
    for (const key of PdfReader.INHERITABLE) {
      if (node.entries.has(key)) merged.set(key, node.entries.get(key)!);
    }

    const type = get(node, 'Type');
    const kids = this.resolve(get(node, 'Kids'));
    if (kids.kind === 'array') {
      for (const kid of kids.values) {
        if (kid.kind === 'ref') {
          if (seen.has(kid.number)) continue;
          seen.add(kid.number);
        }
        const child = this.resolve(kid);
        if (child.kind === 'dict') this.collectPages(child, dict(merged), out, seen);
      }
      return;
    }
    if (type.kind === 'name' && type.value === 'Pages') return;
    const page = new Map(merged);
    for (const [k, v] of node.entries) page.set(k, v);
    out.push(dict(page));
  }

  /** Concatenated, decoded content streams of [page]. */
  contentOf(page: PdfDictObj): Uint8Array {
    const contents = this.resolve(get(page, 'Contents'));
    const parts: Uint8Array[] = [];
    const add = (o: PdfObj): void => {
      const s = this.resolve(o);
      if (s.kind === 'stream') {
        const data = this.decoded(s);
        if (data !== null) {
          parts.push(data, Uint8Array.from([0x0a]));
        }
      }
    };

    if (contents.kind === 'array') {
      for (const c of contents.values) add(c);
    } else {
      add(contents);
    }

    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

function isDelimiterOrSpace(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x3e || c === 0x00;
}

function indexOfAscii(haystack: Uint8Array, needle: string, from: number): number {
  const n: number[] = [];
  for (let i = 0; i < needle.length; i++) n.push(needle.charCodeAt(i));
  outer: for (let i = Math.max(0, from); i + n.length <= haystack.length; i++) {
    for (let k = 0; k < n.length; k++) {
      if (haystack[i + k] !== n[k]) continue outer;
    }
    return i;
  }
  return -1;
}

function lastIndexOfAscii(haystack: Uint8Array, needle: string, from: number): number {
  const n: number[] = [];
  for (let i = 0; i < needle.length; i++) n.push(needle.charCodeAt(i));
  outer: for (let i = haystack.length - n.length; i >= Math.max(0, from); i--) {
    for (let k = 0; k < n.length; k++) {
      if (haystack[i + k] !== n[k]) continue outer;
    }
    return i;
  }
  return -1;
}
