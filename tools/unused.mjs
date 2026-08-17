/**
 * Finds code nothing reaches.
 *
 * A subsystem that is written, tested and green looks exactly like one that
 * works — the absence of a caller is invisible to every tool that inspects
 * the subsystem itself, and correctness is what makes the gap read as
 * finished work. This project has shipped that twice: a two-list provider
 * registry where one list was never consulted, and `chooseOption()`, which
 * was complete, constrained, commented, and unreachable through several
 * rounds of review while the popup told the reader it was running.
 *
 * The rule here is deliberately strict, so its output is short enough to
 * read every time: a name is reported only when it appears exactly once in
 * the whole repository — its own definition. A helper used inside its own
 * file is not dead, only exported wider than it needs to be, and that is a
 * style question rather than a defect.
 *
 * A test does not count as a caller. Reached only from a test is precisely
 * the shape being looked for.
 *
 * Run with `npm run unused`. It never fails the build: a name can be
 * deliberately kept for a caller arriving in the next commit, and the answer
 * to that is a person reading three lines, not a gate.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOTS = ['src', 'tools'];
/** Build files live at the top level and are real callers — `iconPng` is one. */
const TOP_LEVEL = ['build.mjs', 'manifest.config.js'];

const files = [...TOP_LEVEL];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|mjs|js)$/.test(full)) files.push(full);
  }
};
for (const root of ROOTS) walk(root);

const sources = new Map();
for (const file of files) {
  try {
    sources.set(file, readFileSync(file, 'utf8'));
  } catch {
    // A top-level file this project does not have.
  }
}

const EXPORTED =
  /^export\s+(?:async\s+)?(?:function|const|let|class|type|interface)\s+([A-Za-z_$][\w$]*)/gm;

const dead = [];
for (const [file, body] of sources) {
  for (const [, name] of body.matchAll(EXPORTED)) {
    // Two of them on purpose: `test` on a global regex carries `lastIndex`
    // from the previous call, so one shared object would start each file
    // part-way through the one before and silently miss.
    const every = new RegExp(`\\b${name}\\b`, 'g');
    const anywhere = new RegExp(`\\b${name}\\b`);
    const here = (body.match(every) ?? []).length;
    if (here > 1) continue; // used where it is defined

    const elsewhere = [...sources]
      .filter(([other, otherBody]) => other !== file && anywhere.test(otherBody))
      .map(([other]) => other);
    if (elsewhere.length === 0) dead.push({ file, name });
  }
}

for (const { file, name } of dead.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(`  ${file.padEnd(38)} ${name}`);
}
console.log(
  dead.length === 0
    ? 'Every exported name is reached from somewhere.'
    : `\n${dead.length} name(s) appear once in the repository: their own definition.`,
);
