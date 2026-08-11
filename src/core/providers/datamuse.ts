/**
 * Datamuse — synonyms, related words and collocations.
 *
 * Free to 100,000 requests per day without a key until 2027-01-01. It also
 * returns short definitions, which makes it a third independent check on
 * whether a word exists at all.
 *
 * Two requests run as one provider because they are the same shape and the
 * results merge into the same slot.
 */
import type { Provider, ProviderResult, Related, RelatedKind } from '../types.ts';
import { dedupeBy } from '../text.ts';

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
  slots: ['related'],
  deadlineMs: 900,

  async run(request, context): Promise<ProviderResult | null> {
    const word = encodeURIComponent(request.text.trim().toLowerCase());
    const [meaning, collocations] = await Promise.allSettled([
      context.http.json<Row[]>(
        `https://api.datamuse.com/words?ml=${word}&max=8&md=d`,
        { signal: context.signal },
      ),
      context.http.json<Row[]>(
        `https://api.datamuse.com/words?rel_bgb=${word}&max=6`,
        { signal: context.signal },
      ),
    ]);

    const related: Related[] = [];
    if (meaning.status === 'fulfilled' && Array.isArray(meaning.value)) {
      related.push(...toRelated(meaning.value, 'related'));
    }
    if (collocations.status === 'fulfilled' && Array.isArray(collocations.value)) {
      related.push(...toRelated(collocations.value, 'collocation'));
    }

    if (related.length === 0) return null;
    return {
      slots: {
        related: dedupeBy(related, (r) => `${r.kind}:${r.word.toLowerCase()}`),
      },
    };
  },
};
