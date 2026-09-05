/** Shared plumbing for the test suite. */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface CorpusCase {
  id: string;
  category: string;
  text: string;
  notes?: string;
}

/** The 253-case conformance corpus, copied verbatim from the Dart package. */
export function corpus(): CorpusCase[] {
  return JSON.parse(readFileSync(join(ROOT, 'test/corpus/bangla_cases.json'), 'utf8'));
}

export function fontBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, 'test/fixtures/fonts', name)));
}

/** Whether [tool] is on PATH. Tests that need external tools skip without them. */
export function hasTool(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Runs `pdftotext -layout` and returns what it recovered. */
export function pdftotext(dir: string, name: string, pdf: Uint8Array): string {
  const file = join(dir, `${name}.pdf`);
  writeFileSync(file, pdf);
  const out = join(dir, `${name}.txt`);
  execFileSync('pdftotext', ['-enc', 'UTF-8', file, out]);
  return readFileSync(out, 'utf8');
}

/** An 8-bit greyscale image, as `pdftoppm -gray` writes it. */
export interface Pgm {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Parses binary PGM (P5). Returns null for anything else. */
export function parsePgm(bytes: Uint8Array): Pgm | null {
  let at = 0;
  const token = (): string => {
    while (at < bytes.length && (bytes[at]! <= 32 || bytes[at]! === 0x23)) {
      if (bytes[at]! === 0x23) {
        while (at < bytes.length && bytes[at] !== 0x0a) at++;
      } else {
        at++;
      }
    }
    const start = at;
    while (at < bytes.length && bytes[at]! > 32) at++;
    return String.fromCharCode(...bytes.subarray(start, at));
  };

  if (token() !== 'P5') return null;
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  if (!width || !height || !max) return null;
  at++; // the single whitespace byte before the data
  if (at + width * height > bytes.length) return null;
  return { width, height, pixels: bytes.subarray(at, at + width * height) };
}

/**
 * Whether the pixel at (x, y) is ink.
 *
 * Anything not near-white counts, so antialiasing at the edge of a stroke is
 * included on both sides alike.
 */
export function ink(image: Pgm, x: number, y: number): boolean {
  return (
    x >= 0 && y >= 0 && x < image.width && y < image.height && image.pixels[y * image.width + x]! < 200
  );
}

/** The tightest box containing ink, or null when the page is blank. */
export function inkBox(image: Pgm): [number, number, number, number] | null {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (!ink(image, x, y)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? null : [left, top, right, bottom];
}

/**
 * How much the ink of [a] and [b] overlaps, once both are cropped to their own
 * ink and laid on top of each other: shared ink over total ink.
 *
 * The two are also nudged against each other by up to a couple of pixels and
 * the best fit is taken. Cropping aligns them only to the nearest whole pixel
 * while the renderers place glyphs on sub-pixel boundaries; without the nudge,
 * a half-pixel offset shears away a big share of the overlap on a script made
 * of thin strokes, and every case looks wrong.
 */
export function inkOverlap(a: Pgm, b: Pgm): number {
  const boxA = inkBox(a);
  const boxB = inkBox(b);
  if (boxA === null || boxB === null) return boxA === boxB ? 1 : 0;

  const width = Math.max(boxA[2] - boxA[0], boxB[2] - boxB[0]) + 1;
  const height = Math.max(boxA[3] - boxA[1], boxB[3] - boxB[1]) + 1;

  let best = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      let shared = 0;
      let total = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const inA = ink(a, boxA[0] + x, boxA[1] + y);
          const inB = ink(b, boxB[0] + x + dx, boxB[1] + y + dy);
          if (inA && inB) shared++;
          if (inA || inB) total++;
        }
      }
      const score = total === 0 ? 1 : shared / total;
      if (score > best) best = score;
    }
  }
  return best;
}

/** Rasterises [pdf] with poppler and reads the result. */
export function rasterise(dir: string, name: string, pdf: Uint8Array, dpi = 150): Pgm | null {
  const file = join(dir, `${name}.pdf`);
  writeFileSync(file, pdf);
  try {
    execFileSync('pdftoppm', ['-gray', '-r', String(dpi), '-singlefile', file, join(dir, name)]);
  } catch {
    return null;
  }
  const out = join(dir, `${name}.pgm`);
  if (!existsSync(out)) return null;
  return parsePgm(new Uint8Array(readFileSync(out)));
}
