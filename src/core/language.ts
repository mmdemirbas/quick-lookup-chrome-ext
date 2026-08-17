/**
 * Language codes, in the two shapes this extension has to speak.
 *
 * Browsers, dictionaries and this extension's settings all use two-letter
 * codes; Tatoeba and FreeDict both use three-letter ones. The table is small
 * on purpose — it covers the languages the sources actually carry, and
 * anything outside it is reported as unknown rather than guessed at, because
 * a wrong language code returns a confident answer about the wrong language.
 */

/** ISO 639-3 (and the older bibliographic variants) to ISO 639-1. */
const ISO3_TO_ISO1: Record<string, string> = {
  ara: 'ar', ces: 'cs', cze: 'cs', deu: 'de', ell: 'el', eng: 'en', fin: 'fi',
  fra: 'fr', fre: 'fr', ger: 'de', gre: 'el', hun: 'hu', ita: 'it', jpn: 'ja',
  kor: 'ko', kur: 'ku', nld: 'nl', dut: 'nl', pol: 'pl', por: 'pt', rus: 'ru',
  spa: 'es', swe: 'sv', tur: 'tr', ukr: 'uk', zho: 'zh', chi: 'zh',
};

/**
 * The reverse. Built from the table above rather than written out, so the two
 * directions cannot drift — but only from the first spelling of each, since
 * several three-letter codes map to one two-letter code and only one of them
 * can be the answer coming back.
 */
const ISO1_TO_ISO3 = new Map<string, string>();
for (const [three, two] of Object.entries(ISO3_TO_ISO1)) {
  if (!ISO1_TO_ISO3.has(two)) ISO1_TO_ISO3.set(two, three);
}

/** The two-letter form, or nothing when the code is not one we handle. */
export function toIso1(code: string): string | undefined {
  const lower = code.trim().toLowerCase();
  if (ISO3_TO_ISO1[lower]) return ISO3_TO_ISO1[lower];
  return lower.length === 2 ? lower : undefined;
}

/** The three-letter form, or nothing when the code is not one we handle. */
export function toIso3(code: string): string | undefined {
  const lower = code.trim().toLowerCase().split('-')[0] ?? '';
  if (ISO1_TO_ISO3.has(lower)) return ISO1_TO_ISO3.get(lower);
  return ISO3_TO_ISO1[lower] ? lower : undefined;
}

/**
 * A declared language tag, or nothing when what was declared is not one.
 *
 * `lang` attributes carry whatever an author typed — empty strings, `x-none`,
 * a whole sentence. Everything downstream treats a tag as authoritative, so
 * the check belongs here rather than at each use.
 */
export function languageTag(declared: string | null | undefined): string | undefined {
  const tag = (declared ?? '').trim();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag) ? tag : undefined;
}

/**
 * Whether two tags name the same language, ignoring region and script.
 *
 * `en-GB` and `en-US` are one language for every purpose here: translating
 * between them is not a translation, and asking a service to do it wastes a
 * request to be told the input back.
 */
export function sameLanguage(a: string, b: string): boolean {
  const primary = (tag: string) => tag.trim().toLowerCase().split('-')[0] ?? '';
  const left = primary(a);
  return left.length > 0 && left === primary(b);
}
