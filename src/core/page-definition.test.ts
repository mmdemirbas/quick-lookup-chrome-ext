import { test } from 'node:test';
import assert from 'node:assert/strict';
import { definitionScore, findDefinitions } from './page-definition.ts';

/** Prose in the shape technical documentation actually uses. */
const SPEC = `
Apache Iceberg table specification. This document describes the format.
A snapshot is the state of a table at some time. Each snapshot lists all of
the data files that make up the table contents. Writers produce a new
snapshot on every commit, and readers use the current one.
The query planner is the component that turns a logical plan into a set of
concrete file scans. Before planning begins the planner reads the manifest
list. Planning is not the same as optimisation, and the planner may be
asked to plan the same query twice.
Manifest: a file that lists data files along with their partition values
and per-column statistics.
`;

test('a sentence that defines the term outranks the many that only use it', () => {
  const found = findDefinitions('planner', SPEC);
  assert.equal(found.length > 0, true);
  assert.match(found[0]?.text ?? '', /^The query planner is the component/);
  // "the planner reads the manifest list" and "the planner may be asked to
  // plan" both contain the word and define nothing.
  for (const definition of found) assert.doesNotMatch(definition.text, /reads the manifest list/);
});

test('a glossary entry counts, and so does a naming sentence', () => {
  const glossary = findDefinitions('manifest', SPEC);
  assert.match(glossary[0]?.text ?? '', /^Manifest: a file that lists data files/);

  assert.equal(
    definitionScore('planner', 'The component that does this is called the planner.') > 0,
    true,
  );
});

test('a term the page never defines produces nothing', () => {
  // The word appears four times in the text and is defined nowhere.
  assert.deepEqual(findDefinitions('table', SPEC), []);
  assert.deepEqual(findDefinitions('', SPEC), []);
  assert.deepEqual(findDefinitions('planner', ''), []);
});

test('whole words only', () => {
  const text = 'Planning is scheduled work. A plan is a sequence of steps that a planner emits.';
  // "plan" must not match inside "Planning" or "planner".
  assert.match(findDefinitions('plan', text)[0]?.text ?? '', /^A plan is a sequence/);
});

test('a sentence too long or too short to be a definition is rejected', () => {
  assert.equal(definitionScore('planner', 'A planner is a query component.') > 0, true);
  assert.equal(definitionScore('planner', 'A planner is.'), 0);
  assert.equal(definitionScore('planner', `A planner is ${'very '.repeat(80)}complex.`), 0);
});

test('the term may head a noun phrase rather than open the sentence', () => {
  // The shape documentation actually uses, and the one the feature exists
  // for. By seven words in, the term is an object and this is a usage.
  assert.equal(definitionScore('planner', 'The query planner is the component that plans scans.') > 0, true);
  assert.equal(definitionScore('planner', 'Before planning begins the planner reads the manifest list.'), 0);
});

test('the same sentence reached twice is only reported once', () => {
  const text = 'A planner is a planner that plans, and the planner is central to this.';
  const found = findDefinitions(text.includes('planner') ? 'planner' : '', text);
  assert.equal(found.length, 1);
});
