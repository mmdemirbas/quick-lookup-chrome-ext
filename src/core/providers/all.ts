/**
 * Every provider, in one list.
 *
 * One list because there used to be two — the service worker's and the smoke
 * test's — and a provider added to the first was silently absent from the
 * second. Nothing failed: the smoke test kept passing, and it simply never
 * exercised the new source. A source that is never asked looks exactly like
 * one that works.
 *
 * Order is the order they are started in, and the local ones lead: a pack
 * can fill a slot before the first request has left the machine.
 */
import type { Provider } from '../types.ts';
import { packProvider } from './pack.ts';
import { wikipediaProvider } from './wikipedia.ts';
import { stackExchangeProvider } from './stackexchange.ts';
import { registryProvider } from './registry.ts';
import { mdnProvider } from './mdn.ts';
import { freeDictionaryProvider } from './free-dictionary.ts';
import { wiktionaryProvider } from './wiktionary.ts';
import { datamuseProvider } from './datamuse.ts';
import { tatoebaProvider } from './tatoeba.ts';

export const PROVIDERS: Provider[] = [
  packProvider,
  wikipediaProvider,
  stackExchangeProvider,
  registryProvider,
  mdnProvider,
  freeDictionaryProvider,
  wiktionaryProvider,
  datamuseProvider,
  tatoebaProvider,
];
