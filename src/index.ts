/**
 * bangla-pdf — correctly shaped Bangla (Bengali) text in PDFs.
 *
 * ```ts
 * import { PDFDocument } from 'pdf-lib';
 * import { loadBanglaFont, drawBanglaText } from 'bangla-pdf';
 *
 * const doc = await PDFDocument.create();
 * const font = await loadBanglaFont();
 * const page = doc.addPage();
 * drawBanglaText(page, 'আমার সোনার বাংলা, আমি তোমায় ভালোবাসি।', {
 *   font,
 *   x: 50,
 *   y: 700,
 *   size: 20,
 * });
 * const bytes = await doc.save();
 * ```
 *
 * Reading Bangla back out of a PDF lives in `bangla-pdf/extract`, so generating
 * a PDF costs nothing if you never import it.
 */

import { BanglaFont } from './shaping/font.js';

export { BanglaFont } from './shaping/font.js';
export type { ShapedCluster, ShapedGlyph, ShapedRun } from './shaping/harfbuzz.js';
export {
  drawBanglaText,
  embedBanglaFonts,
  measureBanglaText,
  type DrawBanglaTextOptions,
  type DrawResult,
} from './pdf/draw.js';
export type {
  LaidOutLine,
  LayoutOptions,
  PlacedGlyph,
  TextAlign,
  TextLayout,
} from './pdf/layout.js';
export { subsetTrueType } from './pdf/subset.js';
export { OtFont } from './ot/ot-font.js';

/**
 * Loads a font to shape and draw Bangla with.
 *
 * With no argument, the bundled Kalpurush is used. That only works on Node,
 * where the file can be read off disk; in a browser, pass the bytes yourself
 * (`fetch(url).then((r) => r.arrayBuffer())`).
 *
 * Any TrueType font with Bengali `GSUB`/`GPOS` works. SolaimanLipi, Siyam
 * Rupali, Noto Sans Bengali and Noto Serif Bengali are all covered by this
 * package's tests.
 */
export async function loadBanglaFont(source?: Uint8Array | ArrayBuffer): Promise<BanglaFont> {
  if (source !== undefined) return BanglaFont.load(source);
  return BanglaFont.load(await bundledFontBytes());
}

let bundled: Promise<Uint8Array> | null = null;

/**
 * The bundled Kalpurush, read from the package's `assets` directory.
 *
 * Node only, and deliberately a file rather than a base64 blob in the source,
 * so it costs nothing to anyone who supplies their own font. Bundlers that
 * honour the `browser` field in `package.json` are told to stub the `fs`
 * import out, which lands here as the same error as a browser without one.
 */
function bundledFontBytes(): Promise<Uint8Array> {
  if (bundled === null) {
    bundled = (async () => {
      try {
        const fs = await import('node:fs/promises');
        const url = new URL('../assets/Kalpurush.ttf', import.meta.url);
        return new Uint8Array(await fs.readFile(url));
      } catch (cause) {
        throw new Error(
          'bangla-pdf: the bundled font could not be read, which is expected outside Node. ' +
            'Pass font bytes to loadBanglaFont(), e.g. ' +
            "await fetch('/fonts/Kalpurush.ttf').then((r) => r.arrayBuffer())",
          { cause },
        );
      }
    })();
  }
  return bundled;
}
