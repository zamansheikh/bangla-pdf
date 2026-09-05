/**
 * The PDF object model used when *reading* a document.
 *
 * pdf-lib models objects for writing only, and the extraction entry point does
 * not depend on it at all, so reading needs its own representation. Kept
 * deliberately small: enough to walk a page tree, resolve fonts and decode
 * content streams.
 *
 * Ported from `lib/src/extract/pdf_object.dart` in the `bangla_pdf` Dart
 * package.
 */

/** `null`, and the value returned for anything unresolvable. */
export interface PdfNullObj {
  kind: 'null';
}

export interface PdfBoolObj {
  kind: 'bool';
  value: boolean;
}

/** An integer or real. */
export interface PdfNumObj {
  kind: 'num';
  value: number;
}

/** A name, stored without the leading slash. */
export interface PdfNameObj {
  kind: 'name';
  value: string;
}

/**
 * A literal `(…)` or hex `<…>` string, kept as raw bytes.
 *
 * PDF strings are byte strings; how they decode depends on the font, so the
 * bytes are preserved and interpreted later.
 */
export interface PdfStringObj {
  kind: 'string';
  bytes: Uint8Array;
}

export interface PdfArrayObj {
  kind: 'array';
  values: PdfObj[];
}

/** A dictionary. Keys are stored without the leading slash. */
export interface PdfDictObj {
  kind: 'dict';
  entries: Map<string, PdfObj>;
}

/** A stream: a dictionary plus its raw, still-encoded bytes. */
export interface PdfStreamObj {
  kind: 'stream';
  dict: PdfDictObj;
  raw: Uint8Array;
}

/** An indirect reference, `n g R`. */
export interface PdfRefObj {
  kind: 'ref';
  number: number;
  generation: number;
}

/** A bare keyword such as `obj`, `endobj`, `stream` or a content operator. */
export interface PdfOperatorObj {
  kind: 'op';
  name: string;
}

export type PdfObj =
  | PdfNullObj
  | PdfBoolObj
  | PdfNumObj
  | PdfNameObj
  | PdfStringObj
  | PdfArrayObj
  | PdfDictObj
  | PdfStreamObj
  | PdfRefObj
  | PdfOperatorObj;

export const PDF_NULL: PdfNullObj = { kind: 'null' };

export const num = (value: number): PdfNumObj => ({ kind: 'num', value });
export const name = (value: string): PdfNameObj => ({ kind: 'name', value });
export const str = (bytes: Uint8Array): PdfStringObj => ({ kind: 'string', bytes });
export const array = (values: PdfObj[]): PdfArrayObj => ({ kind: 'array', values });
export const dict = (entries: Map<string, PdfObj>): PdfDictObj => ({ kind: 'dict', entries });
export const ref = (number: number, generation: number): PdfRefObj => ({
  kind: 'ref',
  number,
  generation,
});
export const op = (name: string): PdfOperatorObj => ({ kind: 'op', name });

/** Value for [key] in [d], unresolved; null-object when absent. */
export function get(d: PdfDictObj, key: string): PdfObj {
  return d.entries.get(key) ?? PDF_NULL;
}

/** Element [i] of [a]; null-object when out of range. */
export function at(a: PdfArrayObj, i: number): PdfObj {
  return a.values[i] ?? PDF_NULL;
}

/** The bytes as Latin-1, which is how single-byte PDF encodings work. */
export function asLatin1(s: PdfStringObj): string {
  let out = '';
  for (const byte of s.bytes) out += String.fromCharCode(byte);
  return out;
}

/**
 * A PDF text string decoded as UTF-16BE, dropping any byte-order mark.
 *
 * `/ActualText` and `/ToUnicode` destinations are written this way.
 */
export function asUtf16(bytes: Uint8Array): string {
  const units: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    units.push((bytes[i]! << 8) | bytes[i + 1]!);
  }
  if (units.length > 0 && units[0] === 0xfeff) units.shift();
  if (units.length === 0) return String.fromCharCode(...bytes);
  return String.fromCharCode(...units);
}
