/**
 * Datamuse — synonyms, related words and collocations.
 *
 * Free to 100,000 requests per day without a key until 2027-01-01. It also
 * returns short definitions, which makes it a third independent check on
 * whether a word exists at all.
 *
 * The requests run as one provider because they are the same shape and,
 * mostly, merge into the same slot.
 */
import type { Provider, ProviderResult, Related, RelatedKind, SlotData } from '../types.ts';
import { dedupeBy } from '../text.ts';
import { frequencyBand, hasFrequency, readFrequencyTag } from '../frequency.ts';

const SOURCE = 'datamuse';

type Row = { word?: string; tags?: string[]; defs?: string[] };

/** Datamuse encodes definitions as "pos<TAB>text". */
function firstDefinition(row: Row): string | undefined {
  const raw = row.defs?.[0];
  if (!raw) return undefined;
  const text = raw.includes('\t') ? raw.slice(raw.indexOf('\t') + 1) : raw;
  return text.trim() || undefined;
}

function kindFor(row: Row, fallback: RelatedKind): RelatedKind {
  if (row.tags?.includes('syn')) return 'synonym';
  if (row.tags?.includes('ant')) return 'antonym';
  return fallback;
}

function toRelated(rows: Row[], fallback: RelatedKind): Related[] {
  const out: Related[] = [];
  for (const row of rows) {
    if (!row.word) continue;
    const definition = firstDefinition(row);
    out.push({
      word: row.word,
      kind: kindFor(row, fallback),
      ...(definition ? { definition } : {}),
      source: SOURCE,
    });
  }
  return out;
}

export const datamuseProvider: Provider = {
  id: 'datamuse',
  label: 'Datamuse',
  intents: ['word', 'phrase'],
  slots: ['related', 'frequency'],
  deadlineMs: 900,

  async run(request, context): Promise<ProviderResult | null> {
    const text = request.text.trim();
    const word = encodeURIComponent(text.toLowerCase());
    const wantsFrequency = hasFrequency(text);

    // A third request rather than a field on the first two: `ml=` and
    // `rel_bgb=` return *other* words, so neither of them ever carries the
    // frequency of the word that was selected.
    const [meaning, collocations, self] = await Promise.allSettled([
      context.http.json<Row[]>(
        `https://api.datamuse.com/words?ml=${word}&max=8&md=d`,
        { signal: context.signal },
      ),
      context.http.json<Row[]>(
        `https://api.datamuse.com/words?rel_bgb=${word}&max=6`,
        { signal: context.signal },
      ),
      wantsFrequency
        ? context.http.json<Row[]>(
            `https://api.datamuse.com/words?sp=${word}&md=f&max=1`,
            { signal: context.signal },
          )
        : Promise.resolve([]),
    ]);

    const related: Related[] = [];
    if (meaning.status === 'fulfilled' && Array.isArray(meaning.value)) {
      related.push(...toRelated(meaning.value, 'related'));
    }
    if (collocations.status === 'fulfilled' && Array.isArray(collocations.value)) {
      related.push(...toRelated(collocations.value, 'collocation'));
    }

    const frequency = self.status === 'fulfilled' ? readFrequency(self.value, text) : undefined;

    if (related.length === 0 && !frequency) return null;
    return {
      slots: {
        ...(related.length
          ? { related: dedupeBy(related, (r) => `${r.kind}:${r.word.toLowerCase()}`) }
          : {}),
        ...(frequency ? { frequency } : {}),
      },
    };
  },
};

/**
 * The selected word's own frequency, or nothing.
 *
 * The spelling is checked rather than trusted. `sp=` is a pattern search, and
 * a row for a near miss would be a true frequency about a different word —
 * the kind of wrong that looks entirely reasonable on the card.
 */
function readFrequency(rows: Row[], text: string): SlotData['frequency'] | undefined {
  const first = Array.isArray(rows) ? rows[0] : undefined;
  if (!first?.word || first.word.toLowerCase() !== text.toLowerCase()) return undefined;

  const perMillion = readFrequencyTag(first.tags);
  if (perMillion === undefined) return undefined;
  return { perMillion, ...frequencyBand(perMillion), source: SOURCE };
}
