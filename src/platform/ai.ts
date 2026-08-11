/**
 * The inference adapter.
 *
 * `LanguageModel`, `Translator` and `LanguageDetector` are W3C Web Machine
 * Learning drafts, not Chrome APIs. Chrome, Edge and Brave all expose the
 * same global names over different models, so one implementation covers
 * three browsers. Firefox exposes something different in shape and is
 * detected separately.
 *
 * Nothing here throws on absence. Callers ask what is available and take
 * the answer, because the no-model path is the default path: Chrome and
 * Edge both refuse the model download on a metered connection.
 */
import { ext } from './browser.ts';

export type Capabilities = {
  detect: boolean;
  translate: boolean;
  classify: boolean;
  generate: boolean;
  /** For the options page: what the user could turn on, and how. */
  reason: string;
};

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

type LanguageModelGlobal = {
  availability(options?: unknown): Promise<Availability>;
  create(options?: unknown): Promise<{
    prompt(input: string, options?: { responseConstraint?: unknown }): Promise<string>;
    destroy?(): void;
  }>;
};

type TranslatorGlobal = {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
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
  LanguageModel?: LanguageModelGlobal;
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
  const none = (reason: string): Capabilities => ({
    detect: false,
    translate: false,
    classify: false,
    generate: false,
    reason,
  });

  if (!scope.LanguageModel && !scope.Translator && !scope.LanguageDetector) {
    if (scope.browser?.trial?.ml) {
      return {
        ...none('Firefox exposes browser.trial.ml, which cannot generate free-form text.'),
        classify: true,
      };
    }
    return none(
      'No built-in model in this browser. In Brave, enable the Prompt API and the ' +
        'optimization guide flags, then download the component from brave://components.',
    );
  }

  const [model, detector] = await Promise.all([
    scope.LanguageModel?.availability().catch(() => undefined),
    scope.LanguageDetector?.availability().catch(() => undefined),
  ]);

  const generate = usable(model);
  return {
    detect: usable(detector),
    // Language-pair availability is per pair and is checked at call time.
    translate: Boolean(scope.Translator),
    classify: generate,
    generate,
    reason: generate
      ? 'Built-in model available.'
      : model === 'downloadable' || model === 'downloading'
        ? 'A built-in model is available but not downloaded. Downloads are skipped on metered connections.'
        : 'This device or browser cannot run the built-in model.',
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

/**
 * Picks one of `options` for the given question.
 *
 * Constrained to an index into a list the caller already holds, so the model
 * can rank what a source returned but can never introduce a fact. An
 * out-of-range or unparsable answer falls back to the first option.
 */
export async function chooseOption(
  question: string,
  options: string[],
): Promise<number | undefined> {
  if (!scope.LanguageModel || options.length === 0) return undefined;
  try {
    if (!usable(await scope.LanguageModel.availability())) return undefined;
    const session = await scope.LanguageModel.create({
      initialPrompts: [
        {
          role: 'system',
          content:
            'You choose the best option from a numbered list. Reply with the number only. ' +
            'Never invent an option that is not listed.',
        },
      ],
    });
    const numbered = options.map((o, i) => `${i}. ${o}`).join('\n');
    const answer = await session.prompt(`${question}\n\n${numbered}`, {
      responseConstraint: { type: 'integer', minimum: 0, maximum: options.length - 1 },
    });
    session.destroy?.();
    const index = Number.parseInt(answer.trim(), 10);
    return Number.isInteger(index) && index >= 0 && index < options.length ? index : undefined;
  } catch {
    return undefined;
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
