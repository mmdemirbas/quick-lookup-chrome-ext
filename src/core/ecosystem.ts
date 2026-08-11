/**
 * Which software ecosystem the page belongs to.
 *
 * This exists to keep a source from answering confidently about the wrong
 * thing. `iceberg` is a real npm package — "just a pretty iceberg in the
 * console" — so looking up the word on a page about Apache Iceberg would
 * otherwise produce a fact that is true about a package nobody meant. The
 * cheapest defence is to ask a registry only when the page is about that
 * registry's ecosystem.
 *
 * The signal is deliberately weak and cheap: the host, and the vocabulary
 * of the page around the selection. It decides which source to *ask*, never
 * what to believe, so being wrong costs one unnecessary request.
 */
import type { PageContext } from './types.ts';
import { contentWords } from './text.ts';

export type Ecosystem = 'npm' | 'pypi' | 'crates' | 'web';

/** Declaration order, which also breaks ties between equal scores. */
export const ECOSYSTEMS: Ecosystem[] = ['npm', 'pypi', 'crates', 'web'];

/** A host is much stronger evidence than a word in the prose. */
const HOST_WEIGHT = 3;

const HOSTS: Record<Ecosystem, string[]> = {
  npm: ['npmjs.com', 'nodejs.org', 'yarnpkg.com', 'pnpm.io', 'jsr.io', 'typescriptlang.org'],
  pypi: [
    'pypi.org',
    'python.org',
    'readthedocs.io',
    'pydata.org',
    'numpy.org',
    'scipy.org',
    'djangoproject.com',
  ],
  crates: ['crates.io', 'docs.rs', 'rust-lang.org'],
  web: ['developer.mozilla.org', 'w3.org', 'whatwg.org', 'caniuse.com', 'web.dev'],
};

const KEYWORDS: Record<Ecosystem, string[]> = {
  npm: [
    'npm', 'node', 'nodejs', 'javascript', 'typescript', 'react', 'vue',
    'angular', 'svelte', 'yarn', 'pnpm', 'eslint', 'webpack', 'vite',
  ],
  pypi: [
    'python', 'pip', 'pypi', 'django', 'flask', 'pandas', 'numpy',
    'pytorch', 'conda', 'pytest', 'jupyter',
  ],
  crates: ['rust', 'cargo', 'crate', 'crates', 'rustc', 'tokio', 'clippy'],
  web: ['css', 'html', 'dom', 'browser', 'stylesheet', 'viewport', 'javascript'],
};

/**
 * Every ecosystem the page shows evidence of, strongest first.
 *
 * More than one is a normal answer rather than a failure to decide: a page
 * about React is evidence for both the npm registry and the web platform,
 * and the two callers want different things from it.
 */
export function detectEcosystems(page: PageContext): Ecosystem[] {
  const host = (page.host ?? '').toLowerCase();
  const words = new Set([
    ...(page.topicTerms ?? []).map((w) => w.toLowerCase()),
    ...contentWords(
      `${page.title ?? ''} ${page.siteName ?? ''} ${page.nearestHeading ?? ''} ${page.description ?? ''}`,
    ),
  ]);

  return ECOSYSTEMS.map((ecosystem) => {
    const onHost = HOSTS[ecosystem].some((h) => host === h || host.endsWith(`.${h}`));
    const mentions = KEYWORDS[ecosystem].filter((k) => words.has(k)).length;
    return { ecosystem, score: (onHost ? HOST_WEIGHT : 0) + mentions };
  })
    .filter((s) => s.score > 0)
    // Sort is stable, so equal scores keep ECOSYSTEMS order.
    .sort((a, b) => b.score - a.score)
    .map((s) => s.ecosystem);
}
