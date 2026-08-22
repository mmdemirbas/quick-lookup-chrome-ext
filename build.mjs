/**
 * Build script. Produces a directory that loads unpacked, per target.
 *
 * esbuild is used directly rather than through a bundler plugin because an
 * extension has several unrelated entry points with different output
 * formats, and that is simpler to state than to configure.
 */
import * as esbuild from 'esbuild';
import { mkdir, writeFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestFor } from './manifest.config.js';
import { iconPng } from './tools/make-icons.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const targets = process.argv.includes('--firefox') ? ['firefox'] : ['chromium'];

/** Content scripts cannot be modules, so they are bundled as an IIFE. */
const ENTRIES = [
  { in: 'src/background/index.ts', out: 'background', format: 'esm' },
  { in: 'src/content/index.ts', out: 'content', format: 'iife' },
  { in: 'src/options/main.ts', out: 'options', format: 'iife' },
  { in: 'src/action/main.ts', out: 'action', format: 'iife' },
  { in: 'src/panel/main.ts', out: 'panel', format: 'iife' },
];

async function buildTarget(target) {
  const outdir = join(root, 'dist', target);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, 'icons'), { recursive: true });

  const options = {
    bundle: true,
    minify: !watch,
    sourcemap: watch ? 'inline' : false,
    target: ['chrome116', 'firefox128'],
    legalComments: 'none',
    logLevel: 'warning',
    define: { __DEV__: String(watch) },
  };

  const contexts = [];
  for (const entry of ENTRIES) {
    if (!existsSync(join(root, entry.in))) continue;
    const config = {
      ...options,
      entryPoints: [join(root, entry.in)],
      outfile: join(outdir, `${entry.out}.js`),
      format: entry.format,
    };
    if (watch) {
      const ctx = await esbuild.context(config);
      await ctx.watch();
      contexts.push(ctx);
    } else {
      await esbuild.build(config);
    }
  }

  await writeFile(
    join(outdir, 'manifest.json'),
    JSON.stringify(manifestFor(target), null, 2) + '\n',
  );

  for (const size of [16, 32, 48, 128]) {
    await writeFile(join(outdir, 'icons', `${size}.png`), iconPng(size));
  }

  for (const page of ['options.html', 'action.html', 'panel.html']) {
    const src = join(root, 'src', 'pages', page);
    if (existsSync(src)) await cp(src, join(outdir, page));
  }

  return { outdir, contexts };
}

const results = [];
for (const target of targets) results.push(await buildTarget(target));

for (const { outdir } of results) {
  console.log(`${watch ? 'watching' : 'built'} → ${outdir}`);
}

if (!watch) process.exit(0);
