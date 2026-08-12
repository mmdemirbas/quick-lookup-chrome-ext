/**
 * Orchestration: run the providers for a decision, merge as they land.
 *
 * Pure with respect to the browser — the HTTP client and the clock are
 * injected — so the whole pipeline is testable without a network or an
 * extension host.
 *
 * Providers never block each other. Each gets its own deadline, and a
 * provider that misses it leaves its slot empty rather than delaying the
 * card. A new lookup aborts everything still in flight.
 */
import type { Card, HttpClient, LookupRequest, Provider } from './types.ts';
import type { Decision } from './intent/router.ts';
import { applyResult, createCard, finalise } from './card.ts';
import { makeLinksProvider } from './providers/links.ts';
import { pageProvider } from './providers/page.ts';
import { contentWords } from './text.ts';

export type LookupDeps = {
  http: HttpClient;
  providers: Provider[];
  now?: () => number;
};

export type LookupOptions = {
  signal?: AbortSignal;
  /** Called whenever a provider lands, and once more when everything settles. */
  onUpdate?: (card: Card) => void;
};

/**
 * Chooses providers for the primary intent plus any the router asked to
 * widen to. Deduplicated by id so a provider serving two intents runs once.
 */
export function selectProviders(all: Provider[], decision: Decision): Provider[] {
  const wanted = new Set<string>([decision.intent, ...decision.alsoFetch]);
  const chosen = all.filter((p) => p.intents.some((i) => wanted.has(i)));
  const seen = new Set<string>();
  return chosen.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

/** Page topic plus the enclosing sentence, used to rank senses. */
export function rankingContext(request: LookupRequest): string[] {
  const parts = [
    ...(request.page.topicTerms ?? []),
    ...(request.page.nearestHeading ? contentWords(request.page.nearestHeading) : []),
    ...(request.page.sentence ? contentWords(request.page.sentence) : []),
    ...(request.page.title ? contentWords(request.page.title) : []),
  ];
  // The selection itself is not context; it would match every sense equally.
  const selfWords = new Set(contentWords(request.text));
  return parts.filter((w) => !selfWords.has(w));
}

/** Rejects after `ms`, so a slow provider cannot hold the card open. */
function deadline(ms: number, signal: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort('deadline');
  const timer = ms > 0 ? setTimeout(abort, ms) : undefined;
  const forward = () => controller.abort(signal.reason);
  if (signal.aborted) forward();
  else signal.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal,
    done: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', forward);
    },
  };
}

export async function runLookup(
  request: LookupRequest,
  decision: Decision,
  deps: LookupDeps,
  options: LookupOptions = {},
): Promise<Card> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const outerSignal = options.signal ?? new AbortController().signal;

  const card = createCard(request.id, request.text, decision.intent);
  // The page and the quick links are always available and cost nothing, so
  // they are added rather than selected: every card has something in it
  // even when every network source fails.
  const providers = [
    ...selectProviders(deps.providers, decision),
    pageProvider,
    makeLinksProvider(decision.intent),
  ];

  const emit = () => {
    card.elapsedMs = now() - started;
    options.onUpdate?.(card);
  };
  emit();

  await Promise.all(
    providers.map(async (provider) => {
      const scope = deadline(provider.deadlineMs, outerSignal);
      try {
        const result = await provider.run(request, {
          http: deps.http,
          signal: scope.signal,
          uiLang: request.uiLang,
        });
        if (outerSignal.aborted) return;
        if (result) {
          applyResult(card, provider.id, result);
          emit();
        }
      } catch {
        // A failed source removes a slot, never the card. Nothing to report
        // to the user here: the slot simply renders as unavailable.
      } finally {
        scope.done();
      }
    }),
  );

  if (outerSignal.aborted) return card;

  finalise(card, rankingContext(request));
  card.elapsedMs = now() - started;
  options.onUpdate?.(card);
  return card;
}
