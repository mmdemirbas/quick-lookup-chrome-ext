import type { Query } from '../types';
import { isSingleWord, looksNamedEntity } from '../shared/util';

export function planProviders(q: Query, providersOrder: string[]): string[] {
    const order: string[] = ['ai'];
    const differentLang = q.langDetected && q.langDetected !== q.langUI;
    if (differentLang) order.push('translate'); // handled as links for now
    if (looksNamedEntity(q.text)) order.push('wikidata', 'wikipedia');
    if (isSingleWord(q.text)) order.push('dictionary');
    order.push('links');

    // Respect user order but keep only present ones
    const set = new Set(order);
    const final: string[] = [];
    for (const id of providersOrder) if (set.has(id)) final.push(id);
    for (const id of order) if (!final.includes(id)) final.push(id);
    return Array.from(new Set(final));
}
