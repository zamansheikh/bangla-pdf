/**
 * A one-page Bangla invoice.
 *
 *   node example/invoice.mjs
 *   pdftotext example/invoice.pdf -   # the text comes back as it went in
 *
 * Run from a checkout after `npm run build`, or change the imports to
 * 'bangla-pdf' and 'bangla-pdf/extract' when using the published package.
 */

import { writeFileSync } from 'node:fs';
import { PDFDocument, rgb } from 'pdf-lib';

import { drawBanglaText, loadBanglaFont, measureBanglaText } from '../dist/index.js';
import { extractBanglaText } from '../dist/extract.js';

const doc = await PDFDocument.create();
const font = await loadBanglaFont(); // the bundled Kalpurush
const page = doc.addPage([595, 842]);

const ink = rgb(0.1, 0.1, 0.12);
const muted = rgb(0.42, 0.44, 0.5);
const left = 56;
const right = 595 - 56;

drawBanglaText(page, 'চালান', { font, x: left, y: 762, size: 28, color: ink });
drawBanglaText(page, 'সিলিফটন টেকনোলজিস লিমিটেড', {
  font,
  x: left,
  y: 736,
  size: 11,
  color: muted,
});

// Right-aligned needs a box to align in, which is what maxWidth gives it.
drawBanglaText(page, 'তারিখ: ০১/০৯/২০২৬\nচালান নং: ২০২৬-০৯১২', {
  font,
  x: left,
  y: 762,
  size: 11,
  color: muted,
  maxWidth: right - left,
  align: 'right',
  lineHeight: 16,
});

page.drawLine({
  start: { x: left, y: 714 },
  end: { x: right, y: 714 },
  thickness: 0.75,
  color: rgb(0.85, 0.86, 0.9),
});

const rows = [
  ['পণ্য', 'পরিমাণ', 'একক মূল্য', 'মোট'],
  ['কম্পিউটার যন্ত্রাংশ', '৩', '৳১২,৫০০.০০', '৳৩৭,৫০০.০০'],
  ['কী-বোর্ড ও মাউস', '২', '৳২,২৫০.৫০', '৳৪,৫০১.০০'],
  ['সফটওয়্যার লাইসেন্স', '১', '৳৮,৭৫০.০০', '৳৮,৭৫০.০০'],
];
const columns = [left, left + 210, left + 290, right - 110];

let y = 688;
for (const [index, row] of rows.entries()) {
  const heading = index === 0;
  for (const [column, cell] of row.entries()) {
    drawBanglaText(page, cell, {
      font,
      x: columns[column],
      y,
      size: heading ? 10 : 12,
      color: heading ? muted : ink,
    });
  }
  y -= heading ? 24 : 22;
}

drawBanglaText(page, 'সর্বমোট: ৳৫০,৭৫১.০০', {
  font,
  x: left,
  y: y - 12,
  size: 14,
  color: ink,
  maxWidth: right - left,
  align: 'right',
});

// A wrapped, justified paragraph. Lines break on cluster boundaries, so a
// conjunct is never split and a vowel sign never leaves its consonant.
const terms =
  'শর্তাবলি: চালান প্রাপ্তির পনেরো দিনের মধ্যে সম্পূর্ণ মূল্য পরিশোধ করিতে হইবে। ' +
  'নির্ধারিত সময়ের মধ্যে পরিশোধ না করিলে মাসিক দুই শতাংশ হারে বিলম্ব মাশুল আরোপিত হইবে। ' +
  'পণ্য সরবরাহের পর কোনো প্রকার ফেরত গ্রহণ করা হয় না।';

// measureBanglaText shapes and breaks lines exactly as drawing would, so the
// height it reports is the height that gets drawn.
const measured = measureBanglaText(terms, {
  font,
  size: 11,
  maxWidth: right - left,
  lineHeight: 18,
});
drawBanglaText(page, terms, {
  font,
  x: left,
  y: y - 72,
  size: 11,
  color: muted,
  maxWidth: right - left,
  align: 'justify',
  lineHeight: 18,
});

page.drawLine({
  start: { x: left, y: y - 72 - measured.height + 6 },
  end: { x: right, y: y - 72 - measured.height + 6 },
  thickness: 0.75,
  color: rgb(0.85, 0.86, 0.9),
});

const bytes = await doc.save();
writeFileSync(new URL('invoice.pdf', import.meta.url), bytes);

// Read it straight back, to show the text survived the round trip.
const extracted = await extractBanglaText(bytes);
console.log(`wrote example/invoice.pdf — ${(bytes.length / 1024).toFixed(1)} KB`);
console.log(`extracted ${extracted.text.split('\n').length} lines, confidence ${extracted.confidence}`);
console.log(extracted.text);
