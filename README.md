# bangla-pdf

**Bangla (Bengali) text in PDFs that renders correctly and copies back out correctly.**

```ts
import { PDFDocument } from 'pdf-lib';
import { loadBanglaFont, drawBanglaText } from 'bangla-pdf';

const doc = await PDFDocument.create();
const font = await loadBanglaFont();
const page = doc.addPage();

drawBanglaText(page, 'আমার সোনার বাংলা, আমি তোমায় ভালোবাসি।', {
  font,
  x: 50,
  y: 700,
  size: 20,
});

const bytes = await doc.save();
```

Conjuncts join, `ি` `ে` `ৈ` land on the correct side of their consonant, reph sits
where it belongs — and the text you copy out of the PDF is the text you put in.

Node and the browser, TypeScript, ESM and CJS.

---

## Why this is not a two-line problem

Two things have to be right at once, and they pull in opposite directions.

**Shaping.** `ক` + `ি` is drawn as `ি` then `ক`; `ক` + `্` + `ষ` + `্` + `ম` is drawn
as one glyph that no codepoint maps to. Getting that right needs the font's own
OpenType `GSUB`/`GPOS` tables applied under the Indic shaping model.

**Extraction.** Because the glyphs are reordered, no per-glyph
character mapping can express the original order. A PDF that maps its glyphs
back to characters one at a time gives you `িক` when you copy `কি`. That is why
almost every Bangla PDF in the wild pastes as gibberish.

This package solves the first with HarfBuzz and the second with
`/ActualText` — see [How it works](#how-it-works).

---

## Install

```bash
npm install bangla-pdf pdf-lib
```

`pdf-lib` is a peer dependency. A Bangla font (Kalpurush, ~118 KB) ships with the
package and is used by `loadBanglaFont()` with no arguments on Node.

In a browser, supply the font bytes yourself:

```ts
const font = await loadBanglaFont(
  await fetch('/fonts/Kalpurush.ttf').then((r) => r.arrayBuffer()),
);
```

---

## API

### `loadBanglaFont(bytes?)`

Loads a TrueType/OpenType font. With no argument, the bundled Kalpurush (Node
only). Any font with Bengali `GSUB`/`GPOS` works.

### `drawBanglaText(page, text, options)`

Draws shaped Bangla onto a pdf-lib page and returns the layout it used.

| option | default | what it does |
|---|---|---|
| `font` | *required* | the `BanglaFont` to shape and draw with |
| `x`, `y` | `0` | left edge, and baseline of the first line, in points |
| `size` | `12` | font size in points |
| `color` | black | any pdf-lib `Color` (`rgb()`, `cmyk()`, `grayscale()`) |
| `opacity` | `1` | fill opacity |
| `maxWidth` | none | wrap width; also the box `align` aligns within |
| `lineHeight` | 1.2 × natural | baseline-to-baseline distance in points |
| `align` | `'left'` | `left` · `center` · `right` · `justify` |
| `letterSpacing` | `0` | extra space after each cluster |
| `fallbackFonts` | `[]` | fonts to try for characters the main one lacks |

`\n` in `text` starts a new paragraph. Lines break on cluster boundaries, so a
line never splits inside a conjunct or between a vowel sign and its consonant.

The font is embedded when you call `doc.save()`, and only the glyphs the
document actually draws are embedded.

### `measureBanglaText(text, options)`

Shapes and breaks lines exactly as `drawBanglaText` would, without drawing.
Returns `{ lines, width, height, ascent, lineHeight }`.

### `extractBanglaText(bytes, options?)` — from `bangla-pdf/extract`

```ts
import { extractBanglaText } from 'bangla-pdf/extract';

const result = await extractBanglaText(bytes);
result.text;       // the document's text
result.encoding;   // 'unicode' | 'bijoy' | 'mixed' | 'none'
result.confidence; // 1 when the document told us outright; lower when inferred
result.isLocked;   // encrypted and could not be opened
```

A separate entry point on purpose: it does not import pdf-lib, so generating a
PDF costs nothing if you never use it. It handles three kinds of document:

- **Unicode** — a `/ToUnicode` CMap or `/ActualText` spans. Read directly.
- **Bijoy / ANSI** — the legacy encoding behind most Bangladeshi government and
  newspaper PDFs, where copying gives `Avgvi ‡mvbvi evsjv` instead of
  `আমার সোনার বাংলা`. Detected per text run — only a run's own font can tell
  Bijoy bytes from real English — and converted back.
- **Scanned** — no text layer. Reported as `'none'` rather than guessed at, with
  an `ocrHook` option to plug in whatever OCR you already use.

Encrypted documents open too. Most "protected" PDFs carry an owner password and
an empty user password; those are decrypted transparently. Pass `password` for
one that genuinely needs it.

It never throws: an unreadable document comes back empty, because the documents
most worth extracting are the most likely to be damaged.

---

## How it works

1. **Shape with HarfBuzz.** `harfbuzzjs` is HarfBuzz — the engine behind Chrome,
   Android and LibreOffice — compiled to WebAssembly. There is no shaper in this
   package, which is the single most important design decision in it.
2. **Itemise by script first.** HarfBuzz guesses a buffer's script from its first
   strong character, so `Hello বাংলা` shaped in one buffer gets no Indic
   reordering at all. Runs are split by script, and by font, before shaping.
3. **Emit a Type0/Identity-H CID font addressed by glyph id**, with an explicit
   `/CIDToGIDMap` and a `/ToUnicode` CMap whose entries may span several
   codepoints — so a conjunct copies back as its whole sequence. A CID is
   allocated per *(glyph, text, advance)* triple, so the real post-GPOS advance
   goes into `/W` and the content stream needs no correcting kerns; without that,
   extractors read the corrections as word gaps and insert spaces.
4. **Wrap each line in `/Span <</ActualText …>> BDC … EMC`.** This is what makes
   copy-paste survive the reordering, and it is the difference between 100% and
   scrambled output.
5. **Subset the font.** Only drawn glyphs keep their outlines; the rest are
   blanked and glyph ids are preserved, so nothing needs remapping. `GSUB`,
   `GPOS`, `GDEF`, `kern` and the hinting tables are dropped — a reader never
   consults them for already-shaped text. A one-page Bangla notice is **7.1 KB**.

Reading back is the inverse, plus a last resort: when a document has no
`/ToUnicode` and no `/ActualText`, the embedded font's `GSUB` is read *backwards*
to work out which characters would have produced the glyphs on the page.

Ported from [`bangla_pdf`](https://github.com/zamansheikh/bangla_pdf), a mature
Dart package solving the same problem. Its hand-written Bengali shaper is
deliberately **not** ported — it exists only because Dart cannot call HarfBuzz on
the web.

---

## How well does it work?

Every number below is produced by `npm test`, over the 253-case corpus in
[`test/corpus/bangla_cases.json`](test/corpus/bangla_cases.json) (copied verbatim
from the Dart package; 251 of the 253 have text to draw). All of them reproduce
in [CI](.github/workflows/ci.yml) on Ubuntu, against a different build of
HarfBuzz and poppler than the one they were developed against.

### Text survives the round trip

Each case is drawn to a PDF and read back with `pdftotext` (poppler):

| font | recovered exactly |
|---|---|
| Kalpurush *(bundled)* | **251 / 251** |
| Kalpurush Unicode (full) | **251 / 251** |
| SolaimanLipi | **251 / 251** |
| Siyam Rupali | **251 / 251** |
| Noto Sans Bengali | **251 / 251** |
| Noto Serif Bengali | **251 / 251** |

### Shaping matches HarfBuzz's own tool

Glyph ids, advances and offsets compared against `hb-shape`: **251 / 251** for
each of the six fonts. This does not prove HarfBuzz is right — it *is* the
reference — but it does prove the buffer this package builds and the clusters it
reads back are what HarfBuzz means.

### The pixels match too

Glyph ids cannot catch a wrong advance in `/W`, a glyph drawn at the wrong
offset, or a subsetter that dropped an outline. So each case is also drawn by
this package and by `hb-view`, rasterised by the same poppler at the same size,
cropped to its ink and overlaid:

**238 cases · 98.2% mean ink overlap · 91.4% at worst** on macOS;
**98.9% mean · 94.7% at worst** on the Ubuntu CI runner.

It cannot reach 100% — two renderings of identical glyphs disagree along every
antialiased edge, and how much they disagree depends on the rasteriser, which is
why the two platforms differ. The other 13 cases are longer than 24 characters
and would be clipped by the fixed comparison page rather than laid out
differently, so they are not pixel-compared.

### Reading Bangla back out

- **8 of 8** text-bearing fixture documents recovered exactly (Unicode and
  Bijoy), and both scans correctly reported as having no text layer rather than
  being given invented text.
- **241 of 251** corpus cases recovered from glyph ids alone, with no
  `/ToUnicode` and no `/ActualText` anywhere in the document.
- Encrypted fixtures open for RC4 40-bit, RC4 128-bit, AES-128 and AES-256; a
  document with a real user password is reported as `isLocked` and opens when
  the password is supplied.
- **A real Word export, repaired.** The NCTB primary assessment guideline (56
  pages, Word 2013, NikoshBAN and SutonnyMJ) has a text layer Word scrambles:
  its `/ToUnicode` maps pair glyphs with characters by position, so every pair
  Bengali reorders comes out exchanged. Measured by the share of words Unicode
  spelling rules out:

  | reader | malformed Bangla words |
  |---|---|
  | poppler (`pdftotext`) | 24.8% |
  | this package, 0.1.0 | 23.4% |
  | this package, 0.2.0 | 1 of 14,448 |
  | this package, 0.2.1 | **1 of 13,993** |

  The swaps depend on each document's words, so a fixed correction table
  cannot undo them; the extractor notices a CMap that contradicts its own font
  and reads the glyphs back through the font instead. Its SutonnyMJ runs are
  genuine Bijoy and convert cleanly, and the four scanned pages among them are
  offered to `ocrHook`. Since 0.2.0, vowel signs Word's subset pruned from the
  font (`তৃতীয়` had come back `র্ততীয়`, all 37 times) are recovered, and words
  in table cells are no longer split (`ব ণ্ট ন`); the word count falls because
  about 450 such splits are gone.

**80 tests.** `hb-shape`, `hb-view` and `pdftotext` are needed for the
differential tests (`brew install harfbuzz poppler`); those tests skip without
them, and the rest of the suite runs anyway.

---

## Known limitations

These are measured, not guessed.

- **pdf.js — and so Firefox's built-in viewer — inserts spurious spaces.**
  Measured: **225 of 251** cases come back exactly through pdf.js, against
  251/251 through poppler. The rest are the right characters with an extra space
  in the middle: `নির্মাণ` comes back as `নি র্মা ণ`. pdf.js has no `/ActualText`
  support in its text layer, and it classifies a whole `/ToUnicode` entry as a
  zero-width diacritic if it merely *contains* one — its regexp is
  `/^(\s)|(\p{Mn})|(\p{Cf})$/u`, whose middle branch is unanchored — and then
  advances its pen by nothing for that glyph. Every correct mapping of a Bengali
  conjunct contains a virama, so every one trips it. Not something this package
  can encode around without giving up multi-codepoint mappings, which are the
  whole point. Readers that honour `/ActualText` — poppler, and so `pdftotext`,
  Chrome and Acrobat — are unaffected.
- **The browser is not exercised by the test suite.** The code has no Node-only
  dependency on the drawing or extraction path, and both bundle cleanly for the
  browser, but every number above was measured on Node. Treat browser support as
  designed-for and unverified.
- **One real-world document has been measured.** The Word export above is the
  only PDF this package did not produce that the suite reads; every other
  extraction fixture is generated, so its expected text is known exactly but it
  cannot surprise you the way a real document would. That document's Bijoy runs
  are real SutonnyMJ text, but a document written *entirely* in Bijoy has not
  been tested.
- **Repairing a Word export is inference.** When a `/ToUnicode` contradicts its
  font, the text is reconstructed from the glyphs and checked by re-shaping it
  with HarfBuzz, and `confidence` counts such text at 0.75 rather than 1. It
  needs the embedded font to keep its `cmap` and `GSUB`, which Word's subsets
  do. A vowel sign the subset pruned from the font's `cmap` is named only when
  the document's other ligatures agree on it.
- **Un-shaping needs the font's `GSUB`.** Recovering text from glyph ids alone
  reconstructs what most likely drew them. If the producer's subsetter dropped
  `GSUB` — many do, **this one included** — only characters the `cmap` reaches
  come back, so conjuncts are lost. Nothing invisible can be recovered either: a
  ZWJ draws no glyph. That is most of the 10 corpus cases that do not come back.
- **Emoji and symbols need a fallback font.** No Bangla typeface contains them,
  and the bundled Kalpurush is a 206-glyph subset with no accented Latin either.
  Pass `fallbackFonts` and they render; the boundary never falls inside a
  Bengali cluster. A character no font in the chain has simply does not draw.
- **A legacy 8-bit Bijoy font is not a Unicode font, and cannot be used as one.**
  Pass one to `loadBanglaFont` and Latin text comes out as Bangla nonsense: an
  ANSI face reaches Bangla glyphs *through* Latin-1 codepoints, so it honestly
  reports a glyph for `a`, and that glyph is Bangla. Extraction still returns the
  right text — `/ActualText` carries what you asked for, not what was drawn —
  which makes this a rendering bug that no round-trip test can catch. Reading
  Bijoy documents is supported; writing with a Bijoy font is not.
- **A CFF (`.otf`) font is embedded whole.** Subsetting rebuilds TrueType
  outlines; a font with PostScript outlines is embedded unchanged rather than
  risk corrupting it. All six tested faces are TrueType.
- **Six fonts are measured.** Others should work but are untested.
- **Right-to-left text is not reordered.** Bengali is left-to-right, so this only
  matters for Arabic or Hebrew mixed into a string — that needs a bidi pass,
  which is not implemented.
- **pdf-lib only.** pdfkit is not supported.
- **Copy-paste is checked automatically with poppler and pdf.js only.** Acrobat,
  Preview and the mobile viewers have not been tested.

---

## Development

```bash
npm install
npm test          # 69 tests
npm run build     # ESM + CJS + types
node example/invoice.mjs
```

Found Bangla that renders wrong? Add the string to
`test/corpus/bangla_cases.json` with an `id`, `category` and `notes`, and every
differential test picks it up.

---

## License

BSD 3-Clause — see [LICENSE](LICENSE).

The bundled **Kalpurush** is by Md. Tanbin Islam Siyam (Avro Font Development
Project) under the SIL Open Font License 1.0. Font licences are in
[LICENSE-FONTS.txt](LICENSE-FONTS.txt).

Ported from [`bangla_pdf`](https://github.com/zamansheikh/bangla_pdf) by
[Zaman Sheikh](https://github.com/zamansheikh).
