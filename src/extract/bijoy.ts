/**
 * Bijoy / ANSI to Unicode conversion.
 *
 * A Bijoy PDF stores Latin-1 bytes and relies on an 8-bit font to draw Bangla
 * glyphs for them, so the text layer is mojibake: copying `আমার সোনার বাংলা`
 * out of one gives `Avgvi ‡mvbvi evsjv`. Recovering Unicode means undoing the
 * glyph substitutions and then undoing the visual reordering.
 *
 * Ported from `lib/src/extract/bijoy.dart` in the `bangla_pdf` Dart package.
 */

import { BIJOY_TO_UNICODE } from './bijoy-table.js';

/**
 * Bengali pre-base vowel signs. In Bijoy these are stored *before* the
 * consonant they belong to, matching how they render.
 */
const PRE_BASE_MATRAS = new Set(['ি', 'ে', 'ৈ']);

/** U+09CD BENGALI SIGN VIRAMA. */
const VIRAMA = '্';

/** The reph sequence a Bijoy `©` decodes to. */
const REPH = 'র্';

/** Consonants, for walking a cluster during reordering. */
function isConsonant(c: string): boolean {
  if (c.length === 0) return false;
  const r = c.codePointAt(0)!;
  return (
    (r >= 0x0995 && r <= 0x09b9) ||
    r === 0x09dc ||
    r === 0x09dd ||
    r === 0x09df ||
    r === 0x09ce ||
    r === 0x09f0 ||
    r === 0x09f1
  );
}

/** Characters that legitimately follow a consonant inside its cluster. */
function isClusterTail(c: string): boolean {
  return c === '়' || c === 'ঁ' || c === 'ং' || c === 'ঃ';
}

const SINGLE_BYTE_KEYS = new Set(
  BIJOY_TO_UNICODE.filter(([ansi]) => ansi.length === 1).map(([ansi]) => ansi),
);

/**
 * How strongly [text] looks like Bijoy ANSI rather than ordinary Latin.
 *
 * Returns 0 for text with no Bijoy signal and approaches 1 for a pure Bijoy
 * run. Used to classify a PDF whose font name gives nothing away.
 */
export function bijoyConfidence(text: string): number {
  if (text.length === 0) return 0;
  let bijoy = 0;
  let letters = 0;
  for (const ch of text) {
    const rune = ch.codePointAt(0)!;
    if (rune >= 0x0980 && rune <= 0x09ff) return 0; // already Unicode Bangla
    if (rune > 0x20 && rune < 0x7f) letters++;
    // The Latin-1 supplement and Windows-1252 punctuation block carry most of
    // the Bijoy conjunct glyphs; plain English almost never uses them.
    if (rune >= 0xa0 || (rune >= 0x80 && rune <= 0x9f)) {
      bijoy++;
      letters++;
    } else if (SINGLE_BYTE_KEYS.has(ch)) {
      bijoy++;
    }
  }
  if (letters === 0) return 0;
  return Math.min(1, Math.max(0, bijoy / letters));
}

/**
 * Font families that are Bijoy/ANSI rather than Unicode.
 *
 * Name matching alone is unreliable — plenty of PDFs embed a subset with a
 * mangled name — so this only raises confidence; {@link bijoyConfidence}
 * decides.
 */
export const BIJOY_FONT_HINTS = [
  'sutonny',
  'sutonnymj',
  'sutonnyomj',
  'sutonnyemj',
  'boishakhi',
  'chandrabati',
  'modhumati',
  'amarbangla',
  'shreelipi',
  'bijoy',
  'ansi',
  'proshika',
  'ekushey',
];

/** Whether [baseFont] names a known Bijoy/ANSI family. */
export function looksLikeBijoyFontName(baseFont: string): boolean {
  const cleaned = baseFont.toLowerCase().replace(/[^a-z]/g, '');
  return BIJOY_FONT_HINTS.some((hint) => cleaned.includes(hint));
}

/**
 * Consonant + nukta pairs, emitted precomposed.
 *
 * Both spellings exist in the wild and shape identically. Extraction settles on
 * the precomposed form because that is what Bangla keyboards produce and what
 * readers expect to see in a search box.
 */
const NUKTA_COMPOSITION: ReadonlyArray<readonly [string, string]> = [
  ['\u09A1\u09BC', '\u09DC'], // da + nukta  -> rra
  ['\u09A2\u09BC', '\u09DD'], // dha + nukta -> rha
  ['\u09AF\u09BC', '\u09DF'], // ya + nukta  -> yya
];

/** Converts one Bijoy/ANSI run to Unicode Bangla. */
export function bijoyToUnicode(ansi: string): string {
  if (ansi.length === 0) return ansi;
  let text = restoreLogicalOrder(substitute(canonicalBijoy(ansi)));
  for (const [from, to] of NUKTA_COMPOSITION) text = text.split(from).join(to);
  return text;
}

/**
 * Alternate glyph codes some Bijoy fonts use, and the canonical code each one
 * stands for.
 *
 * The conversion table is generated from the forward Unicode-to-Bijoy mapping,
 * which only ever writes the canonical code, so these can never appear in it.
 * SutonnyMJ has a second e-kar and a second ra-phala, fitted to consonants the
 * first ones clash with; a Word document using it writes প্রথম শ্রেণি as
 * `cÖ_g †kÖwY` rather than `cª_g ‡kªwY`.
 */
const BIJOY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['\u2020', '\u2021'], // † -> ‡, e-kar
  ['\u00D6', '\u00AA'], // Ö -> ª, ra-phala
];

function canonicalBijoy(ansi: string): string {
  let text = ansi;
  for (const [alias, canonical] of BIJOY_ALIASES) text = text.split(alias).join(canonical);
  return text;
}

/** Greedy longest-match replacement using the inverted table. */
function substitute(ansi: string): string {
  let out = '';
  let i = 0;
  outer: while (i < ansi.length) {
    for (const [key, value] of BIJOY_TO_UNICODE) {
      if (key.length <= ansi.length - i && ansi.startsWith(key, i)) {
        out += value;
        i += key.length;
        continue outer;
      }
    }
    out += ansi[i];
    i++;
  }
  return out;
}

/**
 * Moves pre-base vowel signs and rephs back to logical order.
 *
 * Bijoy stores text the way it looks: `ি` before its consonant, and the reph
 * after the cluster it sits above. Unicode stores it the way it is spoken.
 */
function restoreLogicalOrder(visual: string): string {
  const units = [...visual];
  const out: string[] = [];
  let i = 0;

  while (i < units.length) {
    const c = units[i]!;

    if (PRE_BASE_MATRAS.has(c)) {
      // Emit the following consonant cluster first, then the vowel sign.
      const cluster = readCluster(units, i + 1);
      if (cluster.length === 0) {
        out.push(c);
        i++;
        continue;
      }
      out.push(...cluster, c);
      i += 1 + cluster.length;
      continue;
    }

    out.push(c);
    i++;
  }

  // Two-part vowels are recomposed last: moving the reph can separate the
  // halves, so this has to run after the reordering rather than inline.
  return recomposeTwoPartVowels(moveRephs(out).join(''));
}

/** Rejoins `ে` + `া` into `ো` and `ে` + `ৗ` into `ৌ`. */
function recomposeTwoPartVowels(text: string): string {
  return text
    .split('\u09C7\u09BE')
    .join('\u09CB')
    .split('\u09C7\u09D7')
    .join('\u09CC');
}

/**
 * Reads a consonant cluster starting at [start]: a consonant, plus any
 * virama-joined consonants that follow it.
 */
function readCluster(units: string[], start: number): string[] {
  if (start >= units.length || !isConsonant(units[start]!)) return [];
  const cluster: string[] = [units[start]!];
  let i = start + 1;
  while (i < units.length) {
    if (isClusterTail(units[i]!)) {
      cluster.push(units[i]!);
      i++;
      continue;
    }
    if (units[i] === VIRAMA && i + 1 < units.length && isConsonant(units[i + 1]!)) {
      cluster.push(units[i]!, units[i + 1]!);
      i += 2;
      continue;
    }
    break;
  }
  return cluster;
}

/** Moves each `র্` that follows a cluster to the front of that cluster. */
function moveRephs(units: string[]): string[] {
  if (!units.join('').includes(REPH)) return units;

  const out: string[] = [];
  for (let i = 0; i < units.length; i++) {
    // A reph decodes as র + virama. A ra-phala decodes as virama + র and can be
    // followed by another virama (গ্র্য), which looks identical unless the
    // preceding character is checked.
    const isReph =
      units[i] === 'র' &&
      i + 1 < units.length &&
      units[i + 1] === VIRAMA &&
      (i === 0 || units[i - 1] !== VIRAMA);
    if (!isReph) {
      out.push(units[i]!);
      continue;
    }
    i++; // consume the virama too

    // Walk back over the consonant cluster it belongs to and insert before it.
    let at = out.length;
    // Skip any vowel signs or marks the reph was written after.
    while (at > 0 && !isConsonant(out[at - 1]!)) at--;
    // Then step over the cluster itself.
    while (at > 0 && isConsonant(out[at - 1]!)) {
      at--;
      if (at >= 2 && out[at - 1] === VIRAMA && isConsonant(out[at - 2]!)) at -= 1;
      else break;
    }
    out.splice(at, 0, 'র', VIRAMA);
  }
  return out;
}
