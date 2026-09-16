/**
 * Recovers text from glyph ids when a PDF gives no other way to.
 *
 * A document with no `/ToUnicode` CMap and no `/ActualText` has thrown its text
 * away: all that survives is which glyph was drawn where. For Latin that is
 * nearly enough, because most glyphs are reachable from the font's `cmap`. For
 * Bengali it is not — a conjunct like `ক্ষ্ম` is a single glyph that no
 * codepoint maps to, produced by `GSUB` from several that do.
 *
 * So this reads the font's own `GSUB` backwards. Every substitution it can
 * enumerate — single, multiple, alternate and ligature — is inverted into "this
 * output glyph came from those input glyphs", then resolved until every glyph
 * is expressed as codepoints the `cmap` knows.
 *
 * The result is inference by nature and is only ever used as a last resort.
 *
 * Ported from `lib/src/extract/glyph_reverse.dart` in the `bangla_pdf` Dart
 * package. The one change: where the Dart version replays a candidate through
 * its own shaper to check it, this replays it through HarfBuzz.
 */

import type { OtFont } from '../ot/ot-font.js';
import { Coverage, type OtData } from '../ot/reader.js';
import {
  categoryOf,
  decomposeBengali,
  IndicCategory,
  isDependentSign,
  isPreBaseMatra,
  MATRA_DECOMPOSITION,
  NUKTA_COMPOSITION,
  RA,
  VIRAMA,
} from './bengali.js';

/**
 * Features that build a form written virama-first.
 *
 * A below-base or post-base consonant form — ba-phala `্ব`, ya-phala `্য` — is
 * typed virama then consonant, but a font lists its components the other way
 * round, because that is the order the shaper hands them over after reordering.
 * Reph and half forms are typed consonant then virama and must be left alone,
 * which is why this cannot be a blanket rule.
 */
const VIRAMA_FIRST_FEATURES = new Set(['blwf', 'pstf', 'pref', 'vatu']);

/** One inverted substitution. */
interface Source {
  components: number[];
  viramaFirst: boolean;
}

/** Shapes text with the embedded font, to check a decode by replaying it. */
export type Replay = (text: string) => number[];

/** Maps a font's glyph ids back to the text most likely to have produced them. */
export class GlyphReverseMap {
  private constructor(
    private readonly textForGid: Map<number, string>,
    /**
     * Share of the font's glyphs that could be expressed as text at all.
     *
     * Well under 1 for any real font: ornaments, dotted circles and internal
     * forms have no text to give back.
     */
    readonly confidence: number,
    private readonly replay: Replay | null,
  ) {}

  /**
   * Builds the map for [font]. Cheap enough to do once per font.
   *
   * [documentText] is what the document itself claims each glyph id stands
   * for, when it says anything. It is never taken at its word — see
   * [learnPrunedSigns] for the one narrow use made of it.
   */
  static build(
    font: OtFont,
    replay: Replay | null,
    documentText?: ReadonlyMap<number, readonly string[]>,
  ): GlyphReverseMap {
    // Seed with what the cmap says outright. Lower codepoints win when several
    // map to one glyph, which keeps the base character rather than a variant.
    const direct = new Map<number, number>();
    for (const [codepoint, gid] of font.cmap) {
      const existing = direct.get(gid);
      if (existing === undefined || codepoint < existing) direct.set(gid, codepoint);
    }

    // Invert every substitution the font declares, remembering which feature
    // each lookup belongs to so component order can be read correctly.
    const sources = new Map<number, Source>();
    const gsub = font.gsub;
    if (gsub !== null) {
      const byFeature = gsub.featureLookups(['bng2', 'beng', 'DFLT']);
      const viramaFirst = new Set<number>();
      for (const feature of VIRAMA_FIRST_FEATURES) {
        for (const index of byFeature.get(feature) ?? []) viramaFirst.add(index);
      }
      for (let i = 0; i < gsub.lookupCount; i++) {
        invertLookup(font.d, gsub.lookupOffset(i), sources, viramaFirst.has(i));
      }
    }

    if (documentText !== undefined) learnPrunedSigns(direct, sources, documentText);

    // Resolve each glyph to codepoints, expanding substitutions until only
    // cmap-reachable glyphs remain.
    const text = new Map<number, string>();
    let resolved = 0;
    const total = new Set<number>([...direct.keys(), ...sources.keys()]);
    for (const gid of total) {
      const runes = resolveGlyph(gid, direct, sources, new Set(), 0);
      if (runes === null) continue;
      text.set(gid, String.fromCodePoint(...preBaseMatraLast(runes)));
      resolved++;
    }

    return new GlyphReverseMap(text, total.size === 0 ? 0 : resolved / total.size, replay);
  }

  /** The text [gid] most likely stands for, or undefined when nothing is known. */
  textFor(gid: number): string | undefined {
    return this.textForGid.get(gid);
  }

  /** Whether anything at all could be recovered. */
  get isEmpty(): boolean {
    return this.textForGid.size === 0;
  }

  /**
   * Turns a run of glyph ids in visual order into text in logical order.
   *
   * Decoding alone is not enough: Bengali draws a pre-base vowel sign before
   * its consonant and a reph after the base it belongs to, so the glyphs arrive
   * in an order no reader would type. This undoes both, which is the inverse of
   * what the shaper did on the way in.
   *
   * [fallback] supplies text for a glyph the font itself cannot name — one a
   * subsetter left in the font but pruned from its `cmap`, as Word does with
   * `ূ`. It is asked only for those, so a document's mapping never overrides
   * what the font says about a glyph it does know.
   */
  decodeRun(gids: number[], fallback?: (index: number) => string | undefined): string {
    const pieces: string[] = [];
    for (let i = 0; i < gids.length; i++) {
      const text = this.textForGid.get(gids[i]!) ?? fallback?.(i);
      if (text !== undefined && text.length > 0) pieces.push(text);
    }
    return this.verify(
      recompose(signsAfterConjuncts(toLogicalOrder(withoutInsertedDottedCircles(pieces)))),
      gids,
    );
  }

  /**
   * Confirms a decode by shaping it again, and repairs it when it fails.
   *
   * Inverting `GSUB` cannot always tell which side of a consonant its virama
   * belongs on: a reph is typed `র` then virama, a ya-phala the other way
   * round, and a font lists both the same way. Rather than guess from the
   * feature a lookup happens to sit in, this shapes the candidate back and
   * keeps it only if the glyphs come out as they went in.
   *
   * When they do not, the virama positions are flipped one combination at a
   * time. The search is bounded, so a long run with many ambiguities keeps its
   * unverified reading rather than costing exponential time.
   */
  private verify(candidate: string, want: number[]): string {
    if (this.replay === null) return candidate;
    if (this.matches(candidate, want)) return candidate;

    const runes = [...candidate].map((c) => c.codePointAt(0)!);
    const swappable: number[] = [];
    for (let i = 1; i < runes.length; i++) {
      if (runes[i] === VIRAMA && categoryOf(runes[i - 1]!) !== IndicCategory.ra) swappable.push(i);
    }
    if (swappable.length === 0 || swappable.length > 8) return candidate;

    for (let combo = 1; combo < 1 << swappable.length; combo++) {
      const trial = [...runes];
      for (let b = 0; b < swappable.length; b++) {
        if ((combo & (1 << b)) === 0) continue;
        const at = swappable[b]!;
        const virama = trial[at]!;
        trial[at] = trial[at - 1]!;
        trial[at - 1] = virama;
      }
      const text = String.fromCodePoint(...trial);
      if (this.matches(text, want)) return text;
    }
    return candidate;
  }

  private matches(text: string, want: number[]): boolean {
    if (text.length === 0 || this.replay === null) return false;
    const got = this.replay(text);
    if (got.length !== want.length) return false;
    for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) return false;
    return true;
  }
}

/** Reorders decoded pieces from visual to logical order. */
function toLogicalOrder(drawn: string[]): string {
  const pieces = splitFusedReph(drawn).filter(
    (piece, i, all) => !(piece.trim().length === 0 && startsWithDependent(all[i + 1])),
  );
  const out: string[] = [];
  let i = 0;
  while (i < pieces.length) {
    const piece = pieces[i]!;

    // A pre-base vowel sign is drawn first; in logical order it follows the
    // consonant it attaches to.
    if (isPreBaseMatraPiece(piece)) {
      let j = i + 1;
      // Skip over anything that is itself only a mark to find the base.
      while (j < pieces.length && isPreBaseMatraPiece(pieces[j]!)) j++;
      if (j < pieces.length && isBaseLike(pieces[j]!)) {
        // The sign follows the whole consonant cluster, not just its first
        // glyph: a phala or nukta drawn after the base belongs before it, or
        // লক্ষ্যে comes back as লক্ষে্য.
        let end = j + 1;
        while (end < pieces.length && extendsCluster(pieces[end]!)) end++;
        for (let k = j; k < end; k++) out.push(pieces[k]!);
        for (let k = i; k < j; k++) out.push(pieces[k]!);
        i = end;
        continue;
      }
    }

    // A reph is drawn after the base and its below-base forms, but is typed
    // first: `র` + virama + the rest of the cluster.
    if (isReph(piece) && out.length > 0) {
      let start = out.length - 1;
      while (start > 0 && !isBaseLike(out[start]!)) start--;
      out.splice(start, 0, piece);
      i++;
      continue;
    }

    out.push(piece);
    i++;
  }
  return out.join('');
}

/**
 * Moves a vowel sign that precedes a virama to after the consonant it joins.
 *
 * A vowel sign follows the whole cluster in Unicode, so a sign directly before
 * a virama is never a spelling. Fonts draw one anyway: `ন্যূ` is shown as `নূ`
 * with the ya-phala after it, and read back in drawing order that is `নূ্য`.
 */
function signsAfterConjuncts(text: string): string {
  return text.replace(
    /([\u09BE-\u09CC\u09D7]+)((?:\u09CD[\u0995-\u09B9\u09DC-\u09DF]\u09BC?)+)/gu,
    '$2$1',
  );
}

/**
 * Puts a pre-base vowel sign that leads a ligature's components after them.
 *
 * Many fonts fuse a pre-base vowel sign with its consonant into one glyph —
 * `টি` is a single glyph in NikoshBAN — and they build it after reordering, so
 * its components are listed in drawing order, `ি` first. Read back as they
 * stand they give `িট`, which nobody types. A single glyph covers one cluster,
 * so the sign belongs at the end of it.
 */
function preBaseMatraLast(runes: number[]): number[] {
  if (runes.length < 2) return runes;
  const first = runes[0]!;
  if (categoryOf(first) !== IndicCategory.matra || !isPreBaseMatra(first)) return runes;
  return [...runes.slice(1), first];
}

function isPreBaseMatraPiece(piece: string): boolean {
  const runes = [...piece];
  if (runes.length !== 1) return false;
  const cp = runes[0]!.codePointAt(0)!;
  return categoryOf(cp) === IndicCategory.matra && isPreBaseMatra(cp);
}

/**
 * Separates a reph a font has fused with the mark after it.
 *
 * Fonts commonly draw `র্` and a following vowel sign as one glyph — `র্ী` in
 * শিক্ষার্থী — so the piece is not a bare reph and would stay where it was
 * drawn. Split off, the reph moves to the front of its cluster and the sign
 * stays behind the base.
 */
function splitFusedReph(pieces: string[]): string[] {
  const out: string[] = [];
  for (const piece of pieces) {
    const runes = [...piece].map((c) => c.codePointAt(0)!);
    if (runes.length > 2 && runes[0] === RA && runes[1] === VIRAMA && runes.slice(2).every(isMark)) {
      out.push(String.fromCodePoint(RA, VIRAMA), String.fromCodePoint(...runes.slice(2)));
    } else {
      out.push(piece);
    }
  }
  return out;
}

/**
 * Whether [piece] begins with something that cannot begin a word — a virama or
 * a dependent sign.
 *
 * A blank piece in front of one is not a word break. Fonts often give the
 * zero-width joiner the same glyph as a space, so `ল‍্যা`, typed with a joiner,
 * is drawn as ল, space glyph, ্যা; read back literally it becomes `ল ্যা`.
 */
/**
 * Drops the dotted circles a shaper inserted inside a word.
 *
 * A shaper draws `◌` before a sign that has no consonant to attach to. Word
 * shapes each formatting span on its own, so a word split across two spans —
 * `মূল` then `্যায়নের` — is drawn with a dotted circle where they meet, and
 * its CMap names that glyph `্`: nobody typed it. A circle an author did type,
 * to show a sign by itself (`◌া`), does not follow a Bangla letter, and stays.
 */
function withoutInsertedDottedCircles(pieces: string[]): string[] {
  return pieces.filter((piece, i) => {
    if (piece !== DOTTED_CIRCLE || i === 0) return true;
    const before = pieces[i - 1]!;
    const last = before.codePointAt(before.length - 1)!;
    const inWord = last >= 0x0980 && last <= 0x09ff;
    const first = pieces[i + 1]?.codePointAt(0);
    const sign = first !== undefined && (first === VIRAMA || isMark(first));
    return !(inWord && sign);
  });
}

const DOTTED_CIRCLE = '\u25CC';

function startsWithDependent(piece: string | undefined): boolean {
  const first = piece?.codePointAt(0);
  if (first === undefined) return false;
  // A pre-base vowel sign is the exception: it is drawn before its consonant,
  // so in drawing order it does begin a word — the space before থেকে is real.
  if (categoryOf(first) === IndicCategory.matra && isPreBaseMatra(first)) return false;
  return first === VIRAMA || isMark(first);
}

/** Whether [rune] is a dependent sign rather than a letter of its own. */
function isMark(rune: number): boolean {
  const category = categoryOf(rune);
  return (
    category === IndicCategory.matra ||
    category === IndicCategory.syllableModifier ||
    category === IndicCategory.nukta
  );
}

/**
 * Whether [piece], drawn after a base consonant, is still part of its cluster
 * ahead of any vowel sign: a phala or other virama-led form, or a nukta.
 */
function extendsCluster(piece: string): boolean {
  const first = piece.codePointAt(0);
  if (first === undefined) return false;
  return first === VIRAMA || categoryOf(first) === IndicCategory.nukta;
}

/** Whether [piece] is the reph form: `র` followed by a virama. */
function isReph(piece: string): boolean {
  const runes = [...piece].map((c) => c.codePointAt(0)!);
  return runes.length === 2 && runes[0] === RA && runes[1] === VIRAMA;
}

/** Whether [piece] can carry a pre-base vowel sign, and so starts a cluster. */
function isBaseLike(piece: string): boolean {
  if (piece.length === 0) return false;
  const category = categoryOf(piece.codePointAt(0)!);
  return (
    category === IndicCategory.consonant ||
    category === IndicCategory.ra ||
    category === IndicCategory.placeholder
  );
}

/**
 * Reads one lookup and records, for each output glyph, the glyphs it came from.
 *
 * Extension lookups are unwrapped; contextual ones are skipped, because their
 * substitutions are performed by the nested lookups already covered.
 */
function invertLookup(
  d: OtData,
  lookup: number | null,
  out: Map<number, Source>,
  viramaFirst: boolean,
): void {
  if (lookup === null || !d.has(lookup, 6)) return;
  const type = d.u16(lookup);
  const subtableCount = d.u16(lookup + 4);

  const dispatch = (kind: number, sub: number): void => {
    switch (kind) {
      case 1:
        invertSingle(d, sub, out, viramaFirst);
        break;
      case 2:
        invertMultiple(d, sub, out, viramaFirst);
        break;
      case 3:
        invertAlternate(d, sub, out, viramaFirst);
        break;
      case 4:
        invertLigature(d, sub, out, viramaFirst);
        break;
      default:
        break;
    }
  };

  for (let i = 0; i < subtableCount; i++) {
    const sub = lookup + d.u16(lookup + 6 + 2 * i);
    if (type === 7) {
      // Extension: a type and a 32-bit offset to the real subtable.
      if (!d.has(sub, 8)) continue;
      dispatch(d.u16(sub + 2), sub + d.u32(sub + 4));
    } else {
      dispatch(type, sub);
    }
  }
}

function put(out: Map<number, Source>, gid: number, source: Source): void {
  if (!out.has(gid)) out.set(gid, source);
}

function invertSingle(d: OtData, sub: number, out: Map<number, Source>, vf: boolean): void {
  if (!d.has(sub, 6)) return;
  const format = d.u16(sub);
  const coverage = Coverage.parse(d, sub + d.u16(sub + 2));
  if (format === 1) {
    const delta = d.i16(sub + 4);
    for (const gid of coverage.glyphs) {
      put(out, (gid + delta) & 0xffff, { components: [gid], viramaFirst: vf });
    }
  } else if (format === 2) {
    const count = d.u16(sub + 4);
    let index = 0;
    for (const gid of coverage.glyphs) {
      if (index >= count) break;
      put(out, d.u16(sub + 6 + 2 * index), { components: [gid], viramaFirst: vf });
      index++;
    }
  }
}

function invertMultiple(d: OtData, sub: number, out: Map<number, Source>, vf: boolean): void {
  if (d.u16(sub) !== 1 || !d.has(sub, 6)) return;
  const coverage = Coverage.parse(d, sub + d.u16(sub + 2));
  const count = d.u16(sub + 4);
  let index = 0;
  for (const gid of coverage.glyphs) {
    if (index >= count) break;
    const seq = sub + d.u16(sub + 6 + 2 * index);
    const glyphCount = d.u16(seq);
    // One glyph became several. Only the first carries the original text;
    // giving it to all of them would repeat the character.
    if (glyphCount > 0) {
      put(out, d.u16(seq + 2), { components: [gid], viramaFirst: vf });
      for (let g = 1; g < glyphCount; g++) {
        put(out, d.u16(seq + 2 + 2 * g), { components: [], viramaFirst: false });
      }
    }
    index++;
  }
}

function invertAlternate(d: OtData, sub: number, out: Map<number, Source>, vf: boolean): void {
  if (d.u16(sub) !== 1 || !d.has(sub, 6)) return;
  const coverage = Coverage.parse(d, sub + d.u16(sub + 2));
  const count = d.u16(sub + 4);
  let index = 0;
  for (const gid of coverage.glyphs) {
    if (index >= count) break;
    const set = sub + d.u16(sub + 6 + 2 * index);
    const altCount = d.u16(set);
    for (let a = 0; a < altCount; a++) {
      put(out, d.u16(set + 2 + 2 * a), { components: [gid], viramaFirst: vf });
    }
    index++;
  }
}

function invertLigature(d: OtData, sub: number, out: Map<number, Source>, vf: boolean): void {
  if (d.u16(sub) !== 1 || !d.has(sub, 6)) return;
  const coverage = Coverage.parse(d, sub + d.u16(sub + 2));
  const setCount = d.u16(sub + 4);
  let index = 0;
  for (const first of coverage.glyphs) {
    if (index >= setCount) break;
    const set = sub + d.u16(sub + 6 + 2 * index);
    const ligCount = d.u16(set);
    for (let l = 0; l < ligCount; l++) {
      const lig = set + d.u16(set + 2 + 2 * l);
      const ligGlyph = d.u16(lig);
      const compCount = d.u16(lig + 2);
      if (compCount === 0) continue;
      const components = [first];
      for (let c = 0; c < compCount - 1; c++) components.push(d.u16(lig + 4 + 2 * c));
      put(out, ligGlyph, { components, viramaFirst: vf });
    }
    index++;
  }
}

/**
 * Puts a trailing virama back in front of the consonant it kills.
 *
 * A font lists a half or phala form's components consonant-first — the ya-phala
 * `্য` is stored as `য` then virama — because that is the order the shaper feeds
 * it after reordering. Typing order is the other way round.
 */
function fixViramaOrder(runes: number[]): number[] {
  if (runes.length >= 2 && runes[runes.length - 1] === VIRAMA) {
    const out = [...runes];
    const last = out.pop()!;
    out.splice(out.length - 1, 0, last);
    return out;
  }
  return runes;
}

/**
 * Recomposes the pairs Unicode writes as one character.
 *
 * The shaper splits `ো` into `ে` + `া` and composes `ড` + nukta into `ড়` before
 * it runs, so both have to be undone on the way back.
 */
function recompose(text: string): string {
  const runes = [...text].map((c) => c.codePointAt(0)!);
  const out: number[] = [];
  let i = 0;
  while (i < runes.length) {
    const rune = runes[i]!;
    const next = i + 1 < runes.length ? runes[i + 1]! : -1;

    // Two-part vowel signs: `ে` + `া` is written `ো`.
    let joined = false;
    for (const [composed, first, second] of MATRA_DECOMPOSITION) {
      if (first === rune && second === next) {
        out.push(composed);
        i += 2;
        joined = true;
        break;
      }
    }
    if (joined) continue;

    // Consonant + nukta: `ড` + `়` is written `ড়`.
    const nukta = NUKTA_COMPOSITION.get(rune);
    if (next === 0x09bc && nukta !== undefined) {
      out.push(nukta);
      i += 2;
      continue;
    }

    out.push(rune);
    i++;
  }
  return String.fromCodePoint(...out);
}

/**
 * Expands [gid] into codepoints, following substitutions as far as needed.
 *
 * [seen] breaks the cycles a font can declare — a ligature whose component
 * substitutes back to itself — and [depth] bounds pathological nesting.
 */
/**
 * Recovers the characters of vowel signs a subsetter pruned from the `cmap`,
 * using the document's own text — but only where the font vouches for it.
 *
 * Word's subsets drop `ৃ`, `ূ` and friends from the `cmap` while keeping their
 * glyphs and every ligature built from them. Such a glyph cannot be read back,
 * and neither can `তৃ`, one glyph built from ত and it. The document's
 * `/ToUnicode` does name them, but that is exactly the mapping that could not
 * be trusted in the first place: for `তৃ` Word wrote `র্ত`, having first met the
 * glyph in `কর্তৃপক্ষ`, where the reph is drawn after it.
 *
 * So a claim counts only when it fits the ligature's structure. `তৃ` is built
 * from `[ত, ?]`; a claim for it must be ত followed by one dependent sign, and
 * `র্ত` is not. Claims that do fit — `পৃ`, `কৃ`, `গৃ` from the same document —
 * vote on what `?` is, and a sign is adopted only when the votes clearly agree.
 * A glyph shown on its own may vote too, if the document names it as a single
 * sign. Nothing else about the document's mapping is used.
 */
function learnPrunedSigns(
  direct: Map<number, number>,
  sources: Map<number, Source>,
  documentText: ReadonlyMap<number, readonly string[]>,
): void {
  const votes = new Map<number, Map<number, number>>();
  const vote = (gid: number, codepoint: number): void => {
    const tally = votes.get(gid) ?? new Map<number, number>();
    tally.set(codepoint, (tally.get(codepoint) ?? 0) + 1);
    votes.set(gid, tally);
  };
  const singleSign = (claim: string): number | null => {
    const runes = [...decomposeBengali(claim)];
    if (runes.length !== 1) return null;
    const cp = runes[0]!.codePointAt(0)!;
    return isDependentSign(cp) ? cp : null;
  };

  // Ligatures with exactly one component the font cannot name.
  for (const [gid, source] of sources) {
    if (source.components.length < 2) continue;
    const claims = documentText.get(gid);
    if (claims === undefined) continue;
    const parts = source.components.map((c) => resolveGlyph(c, direct, sources, new Set(), 0));
    const unknown = parts.flatMap((part, i) => (part === null ? [i] : []));
    if (unknown.length !== 1) continue;
    const at = unknown[0]!;
    const missing = source.components[at]!;
    if (direct.has(missing)) continue;
    const before = decomposeBengali(String.fromCodePoint(...parts.slice(0, at).flat() as number[]));
    const after = decomposeBengali(String.fromCodePoint(...parts.slice(at + 1).flat() as number[]));
    for (const claim of claims) {
      const whole = decomposeBengali(claim);
      if (whole.length <= before.length + after.length) continue;
      if (!whole.startsWith(before) || !whole.endsWith(after)) continue;
      const sign = singleSign(whole.slice(before.length, whole.length - after.length));
      if (sign !== null) vote(missing, sign);
    }
  }

  // A glyph the font knows nothing about, named by the document as one sign.
  for (const [gid, claims] of documentText) {
    if (direct.has(gid) || sources.has(gid)) continue;
    for (const claim of claims) {
      const sign = singleSign(claim);
      if (sign !== null) vote(gid, sign);
    }
  }

  for (const [gid, tally] of votes) {
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const [best, count] = ranked[0]!;
    const others = ranked.slice(1).reduce((sum, [, n]) => sum + n, 0);
    // Clear agreement only: a swapped claim can slip through the structure
    // test when a sign is exchanged with a sign, and must not decide it.
    if (count >= 2 * others && count > others) direct.set(gid, best);
  }
}

function resolveGlyph(
  gid: number,
  direct: Map<number, number>,
  sources: Map<number, Source>,
  seen: Set<number>,
  depth: number,
): number[] | null {
  if (depth > 8 || seen.has(gid)) return null;
  seen.add(gid);
  try {
    // A codepoint of its own wins over any substitution that also produces this
    // glyph: `ৎ` is built from ত + virama, but it is its own character.
    const own = direct.get(gid);
    if (own !== undefined) return [own];

    const source = sources.get(gid);
    if (source !== undefined) {
      if (source.components.length === 0) return []; // no text
      const out: number[] = [];
      for (const component of source.components) {
        const part = resolveGlyph(component, direct, sources, seen, depth + 1);
        if (part === null) return null;
        out.push(...part);
      }
      return source.viramaFirst ? fixViramaOrder(out) : out;
    }
    return null;
  } finally {
    seen.delete(gid);
  }
}
