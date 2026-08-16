/** Domain types shared by every layer. No browser APIs appear here. */
import type { PackLookup } from './packs.ts';
import type { Frequency } from './frequency.ts';

/** What kind of thing the selection is. Decides the card layout. */
export type Intent =
  | 'word'
  | 'phrase'
  | 'entity'
  | 'technical'
  | 'citation'
  | 'quantity'
  | 'foreign'
  | 'unknown';

/** Named regions of a card. Providers write into these. */
export type SlotId =
  | 'headword'
  | 'pronunciation'
  | 'frequency'
  | 'gloss'
  | 'senses'
  | 'examples'
  | 'related'
  | 'translation'
  | 'entity'
  | 'facts'
  | 'extract'
  | 'onPage'
  | 'inContext'
  | 'links';

/**
 * What the page around the selection says about it.
 *
 * `topicTerms` is the page-level profile — used to disambiguate a term
 * that means different things in different fields. The rest is local to
 * the selection.
 */
export type PageContext = {
  url?: string;
  host?: string;
  title?: string;
  siteName?: string;
  description?: string;
  topicTerms?: string[];
  nearestHeading?: string;
  sentence?: string;
  inCode?: boolean;
  /**
   * Sentences on the page that define the selection, best first. Found
   * locally by the content script, because the page is the only source that
   * knows what a term means *here*.
   */
  definitions?: string[];
};

export type LookupRequest = {
  id: string;
  text: string;
  uiLang: string;
  page: PageContext;
  /**
   * Language to translate into, when the reader wants one. Absent means no
   * translation was asked for, and sources must not pay for one.
   */
  glossLanguage?: string;
};

export type Pronunciation = {
  ipa?: string;
  audio?: string;
  dialect?: string;
};

export type Sense = {
  partOfSpeech?: string;
  definition: string;
  example?: string;
  labels?: string[];
  source: string;
};

export type RelatedKind = 'synonym' | 'antonym' | 'related' | 'collocation';

export type Related = {
  word: string;
  kind: RelatedKind;
  definition?: string;
  source: string;
};

export type EntitySummary = {
  title: string;
  description?: string;
  extract?: string;
  imageUrl?: string;
  url?: string;
  source: string;
};

export type LinkTarget = {
  id: string;
  label: string;
  url: string;
};

/** The data a slot can hold. Keyed so merging can stay type safe. */
export type SlotData = {
  headword: string;
  pronunciation: Pronunciation[];
  frequency: Frequency;
  gloss: string;
  senses: Sense[];
  /**
   * The word in a real sentence, with that sentence translated where a
   * translation exists. Separate from `Sense.example`, which is a dictionary's
   * own illustration of one meaning and belongs beside that meaning.
   */
  examples: Array<{ text: string; translation?: string; source: string }>;
  related: Related[];
  /**
   * `text` renders the selection in the target language. `equivalents` are
   * dictionary head-words for it — a different kind of answer, curated per
   * sense rather than produced by a translator, so the two are shown
   * together rather than one standing in for the other.
   */
  translation: {
    text: string;
    lang: string;
    source: string;
    equivalents?: Array<{ word: string; source: string }>;
  };
  entity: EntitySummary;
  facts: Array<{ label: string; value: string; source: string }>;
  extract: { text: string; source: string; url?: string };
  onPage: string[];
  /**
   * The sentence the selection was made in, split around it. Empty `term`
   * means the word could not be located inside its own sentence, which
   * happens when the page shows an inflected form.
   */
  inContext: { before: string; term: string; after: string };
  links: LinkTarget[];
};

export type SlotState = 'pending' | 'filled' | 'empty' | 'failed';

export type Slot<K extends SlotId = SlotId> = {
  id: K;
  state: SlotState;
  data?: SlotData[K];
};

/** Everything the UI needs in order to draw. */
export type Card = {
  requestId: string;
  query: string;
  intent: Intent;
  /** Slot order is the render order. */
  order: SlotId[];
  slots: { [K in SlotId]?: Slot<K> };
  sources: string[];
  /** Milliseconds from request start to the most recent update. */
  elapsedMs: number;
  done: boolean;
};

/** A minimal HTTP surface, injected so core stays testable without a network. */
export type HttpClient = {
  json<T = unknown>(url: string, init?: { signal?: AbortSignal }): Promise<T>;
};

export type ProviderContext = {
  http: HttpClient;
  signal: AbortSignal;
  uiLang: string;
  /**
   * Installed dictionary packs, absent when none are installed. Injected like
   * the HTTP client so the pure core never touches storage.
   */
  packs?: PackLookup;
};

/** What a provider produced. Absent slots simply were not filled. */
export type ProviderResult = {
  slots: { [K in SlotId]?: SlotData[K] };
};

export type Provider = {
  id: string;
  label: string;
  /** Intents this provider is useful for. */
  intents: Intent[];
  /** Slots it can fill. Used to build the skeleton before any data lands. */
  slots: SlotId[];
  /** Milliseconds after which this provider's result is no longer waited for. */
  deadlineMs: number;
  run(request: LookupRequest, context: ProviderContext): Promise<ProviderResult | null>;
};
