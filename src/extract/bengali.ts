/**
 * Indic syllabic categories and positions for the Bengali block.
 *
 * The Dart package this is ported from needs these for its own shaper. Here
 * HarfBuzz does the shaping, so all that survives is the handful of facts
 * un-shaping needs: which characters are pre-base vowel signs, which are
 * consonants, and which two-part vowels and nukta pairs the shaper splits
 * before it runs.
 *
 * Ported from `lib/src/shaping/bengali_categories.dart` in the `bangla_pdf`
 * Dart package.
 */

export enum IndicCategory {
  other,
  consonant,
  /** The letter RA, which can become a reph or a ra-phala. */
  ra,
  vowel,
  nukta,
  /** Halant / virama, U+09CD. */
  halant,
  zwnj,
  zwj,
  /** Dependent vowel sign (matra). */
  matra,
  /** Candrabindu, anusvara, visarga. */
  syllableModifier,
  placeholder,
  digit,
  symbol,
}

/** U+09CD BENGALI SIGN VIRAMA. */
export const VIRAMA = 0x09cd;

/** U+09B0 BENGALI LETTER RA. */
export const RA = 0x09b0;

/** U+09F0 BENGALI LETTER RA WITH MIDDLE DIAGONAL (Assamese). */
export const ASSAMESE_RA = 0x09f0;

/** U+09BC BENGALI SIGN NUKTA. */
export const NUKTA = 0x09bc;

const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const DOTTED_CIRCLE = 0x25cc;

/**
 * Two-part Bengali vowel signs, decomposed the way the shaping model expects.
 *
 * Fonts write their `GSUB` rules against the decomposed forms, so a glyph read
 * backwards yields the halves and they have to be put back together.
 */
export const MATRA_DECOMPOSITION: ReadonlyArray<readonly [number, number, number]> = [
  [0x09cb, 0x09c7, 0x09be], // ো = e + aa
  [0x09cc, 0x09c7, 0x09d7], // ৌ = e + au length mark
];

/** Canonical compositions for consonant + nukta. */
export const NUKTA_COMPOSITION: ReadonlyMap<number, number> = new Map([
  [0x09a1, 0x09dc], // ড + ় = ড়
  [0x09a2, 0x09dd], // ঢ + ় = ঢ়
  [0x09af, 0x09df], // য + ় = য়
]);

/** Syllabic category of [cp]. */
export function categoryOf(cp: number): IndicCategory {
  switch (cp) {
    case NUKTA:
      return IndicCategory.nukta;
    case VIRAMA:
      return IndicCategory.halant;
    case ZWNJ:
      return IndicCategory.zwnj;
    case ZWJ:
      return IndicCategory.zwj;
    case RA:
    case ASSAMESE_RA:
      return IndicCategory.ra;
    case 0x0981: // candrabindu
    case 0x0982: // anusvara
    case 0x0983: // visarga
      return IndicCategory.syllableModifier;
    case 0x09bd: // avagraha
    case DOTTED_CIRCLE:
      return IndicCategory.placeholder;
    case 0x09ce: // khanda ta — a consonant that never takes a virama
      return IndicCategory.consonant;
    case 0x0980: // anji
      return IndicCategory.placeholder;
    default:
      break;
  }

  // Independent vowels.
  if (
    (cp >= 0x0985 && cp <= 0x098c) ||
    cp === 0x098f ||
    cp === 0x0990 ||
    cp === 0x0993 ||
    cp === 0x0994 ||
    cp === 0x09e0 ||
    cp === 0x09e1
  ) {
    return IndicCategory.vowel;
  }

  // Consonants, including the nukta-composed forms and Assamese wa.
  if (
    (cp >= 0x0995 && cp <= 0x09a8) ||
    (cp >= 0x09aa && cp <= 0x09b0) ||
    cp === 0x09b2 ||
    (cp >= 0x09b6 && cp <= 0x09b9) ||
    cp === 0x09dc ||
    cp === 0x09dd ||
    cp === 0x09df ||
    cp === 0x09f1
  ) {
    return IndicCategory.consonant;
  }

  // Dependent vowel signs.
  if (
    (cp >= 0x09be && cp <= 0x09c4) ||
    cp === 0x09c7 ||
    cp === 0x09c8 ||
    cp === 0x09cb ||
    cp === 0x09cc ||
    cp === 0x09d7 ||
    cp === 0x09e2 ||
    cp === 0x09e3
  ) {
    return IndicCategory.matra;
  }

  if (cp >= 0x09e6 && cp <= 0x09ef) return IndicCategory.digit;
  if (cp >= 0x09f2 && cp <= 0x09fe) return IndicCategory.symbol;

  return IndicCategory.other;
}

/** Whether [cp] is a vowel sign that renders to the LEFT of its cluster. */
export function isPreBaseMatra(cp: number): boolean {
  return cp === 0x09bf || cp === 0x09c7 || cp === 0x09c8; // ি ে ৈ
}
