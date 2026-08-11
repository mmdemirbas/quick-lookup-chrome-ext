/**
 * Package registries — what a name is, which version is current, where its
 * documentation lives.
 *
 * Exactly one registry is asked per lookup, chosen by what the page is
 * about. Asking all of them would be both wasteful and wrong: package names
 * collide across ecosystems, and a hit from the wrong one is a true fact
 * about something the reader did not mean. When the page gives no ecosystem
 * signal, no registry is asked at all — see `ecosystem.ts`.
 *
 * Endpoint choices come from measurement:
 *
 * - npm: `/{name}/latest` is about 1.5 KB. The package root is far larger
 *   because it carries every version ever published.
 * - crates.io: `/crates/{name}` is 422 KB for the same reason, so the
 *   search route is used and the name checked for an exact match. The
 *   registry also refuses requests it cannot identify, which is why a
 *   command-line probe gets 403 where the browser succeeds.
 * - PyPI: `/pypi/{name}/json` is the only route that carries the summary,
 *   and it includes every release — about 190 KB uncompressed for a
 *   long-lived package. Accepted as the cost of the only complete source,
 *   and it is one request, gzipped, behind a cache.
 */
import type { LinkTarget, Provider, ProviderResult, SlotData } from '../types.ts';
import { detectEcosystems, type Ecosystem } from '../ecosystem.ts';
import { truncate } from '../text.ts';

const DESCRIPTION_CHARS = 240;

export type Registry = 'npm' | 'pypi' | 'crates';

const REGISTRIES: Registry[] = ['npm', 'pypi', 'crates'];

function isRegistry(ecosystem: Ecosystem): ecosystem is Registry {
  return (REGISTRIES as Ecosystem[]).includes(ecosystem);
}

type Hit = {
  name: string;
  version?: string;
  description?: string;
  license?: string;
  homepage?: string;
  downloads?: number;
};

type NpmLatest = {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  homepage?: string;
};

type PypiJson = {
  info?: {
    name?: string;
    version?: string;
    summary?: string;
    license?: string;
    home_page?: string;
  };
};

type CratesSearch = {
  crates?: Array<{
    name?: string;
    max_stable_version?: string;
    newest_version?: string;
    description?: string;
    downloads?: number;
    homepage?: string;
    repository?: string;
  }>;
};

/** Only http(s) reaches the card; a registry field can hold anything. */
function webUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^https?:\/\/\S+$/i.test(value) ? value : undefined;
}

type Spec = {
  label: string;
  /** Names this registry can hold. A name it cannot hold is not requested. */
  accepts: RegExp;
  api: (name: string) => string;
  page: (name: string) => string;
  parse: (body: unknown, name: string) => Hit | undefined;
};

const SPECS: Record<Registry, Spec> = {
  npm: {
    label: 'npm',
    accepts: /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
    api: (name) => `https://registry.npmjs.org/${name.split('/').map(encodeURIComponent).join('/')}/latest`,
    page: (name) => `https://www.npmjs.com/package/${name}`,
    parse: (body) => {
      const doc = body as NpmLatest;
      if (!doc.name) return undefined;
      return {
        name: doc.name,
        ...(doc.version ? { version: doc.version } : {}),
        ...(doc.description ? { description: doc.description } : {}),
        ...(typeof doc.license === 'string' ? { license: doc.license } : {}),
        ...(webUrl(doc.homepage) ? { homepage: webUrl(doc.homepage) as string } : {}),
      };
    },
  },
  pypi: {
    label: 'PyPI',
    accepts: /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    api: (name) => `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
    page: (name) => `https://pypi.org/project/${encodeURIComponent(name)}/`,
    parse: (body) => {
      const info = (body as PypiJson).info;
      if (!info?.name) return undefined;
      return {
        name: info.name,
        ...(info.version ? { version: info.version } : {}),
        ...(info.summary ? { description: info.summary } : {}),
        // PyPI puts whole licence texts in this field often enough that it
        // has to be length-checked rather than trusted.
        ...(info.license && info.license.length <= 40 ? { license: info.license } : {}),
        ...(webUrl(info.home_page) ? { homepage: webUrl(info.home_page) as string } : {}),
      };
    },
  },
  crates: {
    label: 'crates.io',
    accepts: /^[a-z0-9][a-z0-9_-]*$/,
    api: (name) => `https://crates.io/api/v1/crates?q=${encodeURIComponent(name)}&per_page=1`,
    page: (name) => `https://crates.io/crates/${encodeURIComponent(name)}`,
    parse: (body, name) => {
      const first = (body as CratesSearch).crates?.[0];
      // Search is fuzzy, so a near miss comes back looking like a hit.
      if (!first?.name || first.name.toLowerCase() !== name) return undefined;
      const version = first.max_stable_version ?? first.newest_version;
      const home = webUrl(first.homepage) ?? webUrl(first.repository);
      return {
        name: first.name,
        ...(version ? { version } : {}),
        ...(first.description ? { description: first.description } : {}),
        ...(typeof first.downloads === 'number' ? { downloads: first.downloads } : {}),
        ...(home ? { homepage: home } : {}),
      };
    },
  },
};

/** A selection that could be a package name at all. */
export function packageName(text: string): string | undefined {
  const name = text.trim().toLowerCase();
  if (!name || /\s/.test(name) || name.length < 2 || name.length > 64) return undefined;
  return /^[@a-z0-9][a-z0-9._\-/]*$/.test(name) ? name : undefined;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function toResult(registry: Registry, hit: Hit): ProviderResult {
  const spec = SPECS[registry];
  const page = spec.page(hit.name);

  const facts: SlotData['facts'] = [];
  if (hit.version) facts.push({ label: 'Version', value: hit.version, source: registry });
  if (hit.license) facts.push({ label: 'License', value: hit.license, source: registry });
  if (hit.downloads !== undefined) {
    facts.push({ label: 'Downloads', value: formatCount(hit.downloads), source: registry });
  }

  const links: LinkTarget[] = [{ id: `${registry}-package`, label: spec.label, url: page }];
  if (hit.homepage) links.push({ id: `${registry}-homepage`, label: 'Homepage', url: hit.homepage });

  return {
    slots: {
      facts,
      links,
      ...(hit.description
        ? { extract: { text: truncate(hit.description, DESCRIPTION_CHARS), source: registry, url: page } }
        : {}),
    },
  };
}

export const registryProvider: Provider = {
  id: 'registry',
  label: 'Package registry',
  intents: ['technical'],
  slots: ['facts', 'extract', 'links'],
  deadlineMs: 1500,

  async run(request, context): Promise<ProviderResult | null> {
    const name = packageName(request.text);
    if (!name) return null;

    const registry = detectEcosystems(request.page).find(isRegistry);
    if (!registry) return null;

    const spec = SPECS[registry];
    if (!spec.accepts.test(name)) return null;

    try {
      const body = await context.http.json<unknown>(spec.api(name), { signal: context.signal });
      const hit = spec.parse(body, name);
      return hit ? toResult(registry, hit) : null;
    } catch {
      // A name that is not in the registry is a 404, which is the common
      // case rather than an error worth reporting.
      return null;
    }
  },
};
