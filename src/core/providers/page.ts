/**
 * The page the reader is on, as a source.
 *
 * Costs nothing and can answer what no remote source can: what a term means
 * *here*. The sentences were found locally by the content script, so this
 * provider only has to hand them to a slot — it exists so the page takes
 * the same shape as every other source rather than being special-cased in
 * the middle of composition.
 */
import type { Provider, ProviderResult } from '../types.ts';

export const pageProvider: Provider = {
  id: 'page',
  label: 'This page',
  intents: ['word', 'phrase', 'entity', 'technical', 'citation', 'quantity', 'foreign', 'unknown'],
  slots: ['onPage'],
  deadlineMs: 0,

  async run(request): Promise<ProviderResult | null> {
    const definitions = request.page.definitions ?? [];
    return definitions.length > 0 ? { slots: { onPage: definitions } } : null;
  },
};
