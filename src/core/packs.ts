/**
 * Installable dictionary packs: parsing, not storage.
 *
 * A pack is a dictionary file the reader already has. Nothing here downloads
 * anything or knows what a browser is — it turns bytes into records, so the
 * awkward parts (a base-64 number that is not base-64 data, a null-terminated
 * binary index) are testable without a file picker.
 *
 * Why packs at all: the online sources answer English well and Turkish
 * poorly, and every one of them has an allowance. A pack has neither problem.
 * FreeDict's English-Turkish edition alone is 36,589 head-words with IPA, and
 * it answers with no network at all.
 *
 * Three formats, chosen because between them they cover what is actually
 * downloadable today:
 *
 * - **dictd** (`.index` + `.dict.dz`) — a text index, so the least that can
 *   go wrong. FreeDict publishes every dictionary in it.
 * - **StarDict** (`.ifo` + `.idx` + `.dict.dz`) — a binary index, and the
 *   format most of the loose dictionary packs on the web come in.
 * - **tab-separated** — one head-word and one definition per line. The escape
 *   hatch: anything can be converted to it in a few lines of script.
 *
 * All three keep their definitions in one blob addressed by offset and
 * length, which is why the record type below is shared.
 */
import { toIso1 } from './language.ts';

export type PackFormat = 'dictd' | 'stardict' | 'tsv';

/** Where one head-word's text sits inside the decompressed blob. */
export type PackRecord = { headword: string; offset: number; length: number };

export type PackMeta = {
  id: string;
  name: string;
  /** Primary language subtags, e.g. `en` and `tr`. Equal means monolingual. */
  source: string;
  target: string;
  format: PackFormat;
  entries: number;
  installedAt: number;
};

/**
 * dictd writes offsets as base-64 *numbers*, not as base-64 data.
 *
 * The alphabet is the familiar one but the digits are most significant
 * first, so `B` is 1 rather than a byte. Decoding it with `atob` returns
 * plausible nonsense — an offset somewhere in the file, pointing at the
 * middle of another entry — which is the kind of wrong that shows up as a
 * garbled definition rather than as an error.
 */
const B64_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function decodeDictdNumber(token: string): number {
  if (token.length === 0) return Number.NaN;
  let value = 0;
  for (const char of token) {
    const digit = B64_DIGITS.indexOf(char);
    if (digit < 0) return Number.NaN;
    value = value * 64 + digit;
  }
  return value;
}

/**
 * Head-words a dictionary uses for its own metadata rather than for a word.
 * Every dictd file carries them and none of them is something to look up.
 */
const METADATA_HEADWORD = /^0{2}[-a-z]*database/i;

export function parseDictdIndex(text: string): PackRecord[] {
  const records: PackRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [headword, offset, length] = line.split('\t');
    if (!headword || !offset || !length) continue;
    if (METADATA_HEADWORD.test(headword)) continue;

    const at = decodeDictdNumber(offset);
    const size = decodeDictdNumber(length);
    if (!Number.isFinite(at) || !Number.isFinite(size) || size <= 0) continue;
    records.push({ headword, offset: at, length: size });
  }
  return records;
}

/** Everything after the header line of a StarDict `.ifo`, as key and value. */
export function parseStarDictIfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/**
 * StarDict's `.idx`: head-word bytes, a zero byte, then the offset and the
 * length as big-endian integers.
 *
 * `idxoffsetbits` in the `.ifo` says whether the offset is 32 or 64 bits. It
 * is 32 in almost every pack in the wild, and reading a 64-bit file as 32
 * would resolve every entry to the wrong place, so the caller passes what the
 * `.ifo` actually said rather than the common case.
 */
export function parseStarDictIdx(bytes: Uint8Array, offsetBits: 32 | 64 = 32): PackRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8');
  const offsetSize = offsetBits / 8;
  const records: PackRecord[] = [];

  let at = 0;
  while (at < bytes.length) {
    const end = bytes.indexOf(0, at);
    // A trailing byte with no terminator is a truncated file, not a record.
    if (end < 0 || end + offsetSize + 4 >= bytes.length + 1) break;

    const headword = decoder.decode(bytes.subarray(at, end));
    let cursor = end + 1;
    if (cursor + offsetSize + 4 > bytes.length) break;

    const offset =
      offsetBits === 64
        ? Number(view.getBigUint64(cursor, false))
        : view.getUint32(cursor, false);
    cursor += offsetSize;
    const length = view.getUint32(cursor, false);
    cursor += 4;
    at = cursor;

    if (headword && length > 0) records.push({ headword, offset, length });
  }
  return records;
}

/**
 * A tab-separated file, turned into records over a blob the caller builds by
 * concatenating the definitions in order.
 *
 * The offsets are byte offsets, not character offsets, because that is what
 * the other two formats mean by the word and the reader downstream cannot
 * tell which kind it was handed.
 */
export function parseTsv(text: string): { records: PackRecord[]; blob: string } {
  const records: PackRecord[] = [];
  const parts: string[] = [];
  const encoder = new TextEncoder();
  let offset = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('\t');
    if (at <= 0) continue;

    const headword = trimmed.slice(0, at).trim();
    // Some exports escape the newlines inside a definition rather than
    // dropping them, and a definition printed with a literal \n in it looks
    // like a bug in this extension.
    const body = trimmed.slice(at + 1).replace(/\\n/g, '\n').trim();
    if (!headword || !body) continue;

    const length = encoder.encode(body).length;
    records.push({ headword, offset, length });
    parts.push(body);
    offset += length;
  }
  return { records, blob: parts.join('') };
}

/** One head-word's text, split into the parts a card can show separately. */
export type PackEntry = {
  headword: string;
  ipa?: string;
  /** One per numbered meaning, in the pack's own order. */
  senses: string[];
};

/** A pronunciation written between slashes on the head line. */
const IPA = /\/([^/\n]{2,60})\//;

/** `1.` or `2)` at the start of a line opens a new meaning. */
const NUMBERED = /^\s*\d{1,2}[.)]\s*/;

/** What may follow the head-word on a head line and nothing else: a
 * pronunciation, a bracketed tag, or nothing. */
const HEAD_TAIL = /^\s*(?:\/[^/\n]*\/)?\s*(?:\[[^\]\n]*\])?\s*$/;

/**
 * Whether a line is the entry's heading rather than one of its meanings.
 *
 * Checked on every line, not only the first, because two entries for one
 * spelling — a noun and a verb, say — are merged into a single record at
 * import time, which puts a second heading in the middle of the text. Left
 * in, it would render as a meaning whose whole content is the word itself.
 */
function isHeadLine(line: string, headword: string): boolean {
  const lower = line.toLowerCase();
  const head = headword.toLowerCase();
  return lower.startsWith(head) && HEAD_TAIL.test(line.slice(headword.length));
}

/**
 * Turns a raw definition block into head line and meanings.
 *
 * Every format stores this part as free text, so this is shape-reading rather
 * than parsing: a first line that repeats the head-word is a heading and not
 * a definition, and numbered lines are separate meanings. A pack that follows
 * neither convention still works — the whole block becomes one meaning, which
 * is what the reader would have seen anyway.
 */
export function parseEntryText(headword: string, text: string): PackEntry {
  let ipa: string | undefined;
  const senses: string[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (isHeadLine(line, headword)) {
      ipa ??= IPA.exec(line)?.[1]?.trim();
      continue;
    }
    if (NUMBERED.test(line) || senses.length === 0) {
      senses.push(line.replace(NUMBERED, ''));
    } else {
      // A wrapped continuation of the meaning above it.
      senses[senses.length - 1] += ` ${line}`;
    }
  }

  return {
    headword,
    ...(ipa ? { ipa } : {}),
    senses: senses.map((s) => s.trim()).filter(Boolean),
  };
}

/**
 * The equivalents inside one meaning of a bilingual entry.
 *
 * A bilingual pack answers with words, not sentences: `bundan başka, bundan
 * fazla, üstelik.` is three ways to say the head-word, and showing it as one
 * string would hide two of them. A meaning long enough to be prose is left
 * whole, because splitting a sentence on its commas produces fragments.
 */
const PROSE_CHARS = 90;

export function splitEquivalents(sense: string): string[] {
  const text = sense.trim();
  if (!text) return [];
  // Prose keeps its punctuation: it is a sentence, and a sentence with its
  // full stop shaved off reads as truncated.
  if (text.length > PROSE_CHARS) return [text];
  return text
    .replace(/[.;]\s*$/, '')
    .split(/\s*[,;]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** One pack's answer for one head-word. */
export type PackHit = { pack: PackMeta; entry: PackEntry };

/**
 * Reading installed packs, as the lookup pipeline sees it.
 *
 * One head-word at a time and nothing about files or storage, so the pure
 * side can decide *which* forms to try and in what order without knowing
 * where the packs live.
 */
export type PackLookup = {
  entries(headword: string): Promise<PackHit[]>;
  /**
   * A token that changes when the installed set does.
   *
   * It belongs in the cache key for the same reason the gloss language does:
   * installing a dictionary changes what a card contains, and the words a
   * reader tries first are the ones already answered from a card composed
   * before the pack existed. Without it, the pack appears to do nothing.
   */
  signature(): Promise<string>;
  /** Forgets what is installed, after something has been installed or removed. */
  refresh(): void;
};

/**
 * Forms to try when the selected word is not itself a head-word.
 *
 * Dictionaries index base forms, and readers select what is on the page:
 * `partitions`, `partitioned`, `partitioning`. Guessing costs one extra
 * index read against a store that is already local, and the alternative is a
 * pack that appears not to know most of the words in a paragraph.
 *
 * These are guesses, not morphology. A wrong guess finds nothing, which is
 * the same outcome as not guessing.
 */
export function candidateForms(word: string): string[] {
  const base = word.trim().toLowerCase();
  if (!base) return [];

  const forms = [base];
  const add = (form: string) => {
    if (form.length >= 2 && !forms.includes(form)) forms.push(form);
  };

  if (base.endsWith('ies') && base.length > 4) add(`${base.slice(0, -3)}y`);
  if (base.endsWith('es') && base.length > 3) add(base.slice(0, -2));
  if (base.endsWith('s') && !base.endsWith('ss')) add(base.slice(0, -1));
  if (base.endsWith('ing') && base.length > 5) {
    add(base.slice(0, -3));
    add(`${base.slice(0, -3)}e`);
  }
  if (base.endsWith('ed') && base.length > 4) {
    add(base.slice(0, -2));
    add(base.slice(0, -1));
  }
  // Doubled final consonant: `stopped` -> `stop`, `running` -> `run`.
  const doubled = /(.*)([bdfglmnprt])\2(?:ed|ing)$/.exec(base);
  if (doubled?.[1] && doubled[2]) add(doubled[1] + doubled[2]);

  return forms;
}

/**
 * The language pair a file name implies.
 *
 * FreeDict names every release `eng-tur`, `deu-tur` and so on, so the guess
 * is right for the whole catalogue. It is only ever a default: the import
 * form shows it and the reader can correct it, because a pack named after
 * its publisher tells us nothing.
 */
export function languagePairFromName(name: string): { source: string; target: string } | undefined {
  const match = /(?:^|[^a-z])([a-z]{2,3})[-_]([a-z]{2,3})(?:[^a-z]|$)/i.exec(name.toLowerCase());
  const from = match?.[1];
  const to = match?.[2];
  if (!from || !to) return undefined;

  const source = toIso1(from);
  const target = toIso1(to);
  return source && target ? { source, target } : undefined;
}
