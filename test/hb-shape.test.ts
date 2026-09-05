/**
 * Differential shaping test against the `hb-shape` command line tool.
 *
 * This package does not contain a shaper — it calls HarfBuzz compiled to
 * WebAssembly — so this is not the "does our shaper match HarfBuzz?" test the
 * Dart package needs. It is the narrower question that is still worth asking:
 * are the buffer this package builds and the clusters it reads back the same
 * thing HarfBuzz's own tool produces? A wrong script tag, a mishandled
 * surrogate pair or a cluster read at the wrong offset would all show up here.
 *
 * Skips unless `hb-shape` is installed: `brew install harfbuzz`.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BanglaFont } from '../src/shaping/font.js';
import { corpus, fontBytes, hasTool, ROOT } from './helpers.js';

interface HbGlyph {
  g: number;
  cl: number;
  dx: number;
  dy: number;
  ax: number;
}

function hbShape(fontPath: string, text: string): HbGlyph[] {
  const out = execFileSync(
    'hb-shape',
    ['--no-glyph-names', '--script=Beng', '--output-format=json', fontPath, text],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

const FONTS = [
  'Kalpurush-Subset.ttf',
  'Kalpurush-Unicode.ttf',
  'SolaimanLipi.ttf',
  'SiyamRupali.ttf',
  'NotoSansBengali-Regular.ttf',
  'NotoSerifBengali-Regular.ttf',
];

describe('shaping matches hb-shape', () => {
  const available = hasTool('hb-shape');

  for (const name of FONTS) {
    it.skipIf(!available)(`glyph for glyph over the corpus (${name})`, async () => {
      const font = await BanglaFont.load(fontBytes(name));
      const path = join(ROOT, 'test/fixtures/fonts', name);

      let compared = 0;
      const mismatches: string[] = [];
      for (const testCase of corpus()) {
        if (testCase.text.trim().length === 0) continue;
        const ours = font.shape(testCase.text, 'Beng').glyphs;
        const theirs = hbShape(path, testCase.text);
        compared++;

        const oursText = ours.map((g) => `${g.gid}@${g.xAdvance},${g.xOffset},${g.yOffset}`).join(' ');
        const theirsText = theirs.map((g) => `${g.g}@${g.ax},${g.dx},${g.dy}`).join(' ');
        if (oursText !== theirsText) {
          mismatches.push(`[${testCase.id}] ${testCase.text}\n  ours   ${oursText}\n  theirs ${theirsText}`);
        }
      }

      console.log(`hb-shape ${name}: ${compared - mismatches.length}/${compared}`);
      if (mismatches.length > 0) console.log(mismatches.slice(0, 5).join('\n'));
      expect(mismatches).toEqual([]);
    });
  }

  it.skipIf(!available)('cluster values are our own string indices, not UTF-8 offsets', async () => {
    const font = await BanglaFont.load(fontBytes('Kalpurush-Subset.ttf'));
    // Every character here is three UTF-8 bytes, so byte offsets and string
    // indices differ from the second character on.
    const run = font.shape('কমল', 'Beng');
    expect(run.glyphs.map((g) => g.cluster)).toEqual([0, 1, 2]);
    expect(run.clusters.map((c) => c.text)).toEqual(['ক', 'ম', 'ল']);
  });
});
