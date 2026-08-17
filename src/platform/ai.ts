/**
 * The inference adapter.
 *
 * `Translator` and `LanguageDetector` are W3C Web Machine Learning drafts,
 * not Chrome APIs. Chrome, Edge and Brave all expose the same global names
 * over different models, so one implementation covers three browsers.
 * Firefox exposes something different in shape and is detected separately.
 *
 * The language model — the Prompt API — is deliberately absent. It was here
 * to rank senses, never got a caller, and the ranking is done against the
 * page locally instead: deterministic, instant, and the same on every
 * machine. Consulting it only to report that it exists led the options page
 * to ask for two Brave flags in exchange for nothing.
 *
 * Nothing here throws on absence. Callers ask what is available and take
 * the answer, because the no-model path is the default path: Chrome and
 * Edge both refuse the model download on a metered connection.
 */
import { ext } from './browser.ts';

export type Capabilities = {
  detect: boolean;
  translate: boolean;
  /** For the options page: what the user could turn on, and how. */
  reason: string;
};

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

type DownloadMonitor = {
  addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void;
};

type TranslatorGlobal = {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: DownloadMonitor) => void;
  }): Promise<{ translate(text: string): Promise<string>; destroy?(): void }>;
};

type DetectorGlobal = {
  availability(): Promise<Availability>;
  create(): Promise<{
    detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>>;
    destroy?(): void;
  }>;
};

const scope = globalThis as unknown as {
  Translator?: TranslatorGlobal;
  LanguageDetector?: DetectorGlobal;
  browser?: { trial?: { ml?: unknown } };
};

const usable = (a: Availability | undefined) => a === 'available';

/**
 * Reports what is usable right now.
 *
 * `downloadable` is deliberately reported as unusable: triggering a model
 * download needs a user gesture and can be hundreds of megabytes, which is
 * never acceptable as a side effect of selecting a word.
 */
export async function detectCapabilities(): Promise<Capabilities> {
  if (!scope.Translator && !scope.LanguageDetector) {
    return {
      detect: false,
      translate: false,
      reason: scope.browser?.trial?.ml
        ? 'Firefox exposes browser.trial.ml, which is not the translator interface this uses.'
        : 'No built-in translator in this browser. Brave ships the API switched off, and every ' +
          'answer works without it.',
    };
  }

  const detector = await scope.LanguageDetector?.availability().catch(() => undefined);
  return {
    detect: usable(detector),
    // Language-pair availability is per pair and is checked at call time.
    translate: Boolean(scope.Translator),
    // The readiness of a *pair* is reported next to the Download button,
    // where the action is. This says only whether the interface exists.
    reason: scope.Translator
      ? 'This browser exposes a built-in translator. Each language pair is downloaded on request.'
      : 'This browser exposes no built-in translator. Nothing here needs one.',
  };
}

/** Detects the language of a short string. Returns undefined when unavailable. */
export async function detectLanguage(text: string): Promise<string | undefined> {
  if (!scope.LanguageDetector) return undefined;
  try {
    if (!usable(await scope.LanguageDetector.availability())) return undefined;
    const detector = await scope.LanguageDetector.create();
    const results = await detector.detect(text);
    detector.destroy?.();
    const best = results[0];
    return best && best.confidence > 0.5 ? best.detectedLanguage : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Translates a short string. Used for the gloss beside an English answer,
 * never for the answer itself.
 */
export async function translate(
  text: string,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string | undefined> {
  if (!scope.Translator || sourceLanguage === targetLanguage) return undefined;
  try {
    const availability = await scope.Translator.availability({ sourceLanguage, targetLanguage });
    if (!usable(availability)) return undefined;
    const translator = await scope.Translator.create({ sourceLanguage, targetLanguage });
    const out = await translator.translate(text);
    translator.destroy?.();
    return out;
  } catch {
    return undefined;
  }
}

export type TranslationState = Availability | 'absent';

/** Whether one language pair is ready, could be downloaded, or is missing. */
export async function translationAvailability(
  sourceLanguage: string,
  targetLanguage: string,
): Promise<TranslationState> {
  if (!scope.Translator) return 'absent';
  try {
    return await scope.Translator.availability({ sourceLanguage, targetLanguage });
  } catch {
    return 'unavailable';
  }
}

/**
 * Downloads a language pair, reporting progress.
 *
 * Separate from `translate` on purpose, and never called from the lookup
 * path. A language pack is a large download that browsers gate behind a
 * user gesture, so it belongs to an explicit button in settings — the same
 * reason `downloadable` is reported as unusable everywhere else. Without
 * this the translate path could never become live: the browser waits to be
 * asked, and nothing was ever going to ask.
 */
export async function downloadTranslation(
  sourceLanguage: string,
  targetLanguage: string,
  onProgress?: (fraction: number) => void,
): Promise<TranslationState> {
  if (!scope.Translator) return 'absent';
  try {
    const translator = await scope.Translator.create({
      sourceLanguage,
      targetLanguage,
      monitor: (monitor) => {
        monitor.addEventListener('downloadprogress', (event) => {
          onProgress?.(Math.max(0, Math.min(1, event.loaded)));
        });
      },
    });
    translator.destroy?.();
    return await translationAvailability(sourceLanguage, targetLanguage);
  } catch {
    // A refused or failed download leaves the setting exactly as it was.
    return await translationAvailability(sourceLanguage, targetLanguage);
  }
}

/** The browser's UI language, used as the default target for a gloss. */
export function uiLanguage(): string {
  try {
    return ext.i18n?.getUILanguage?.() ?? navigator.language ?? 'en';
  } catch {
    return 'en';
  }
}
