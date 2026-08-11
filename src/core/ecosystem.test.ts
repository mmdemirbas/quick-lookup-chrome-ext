import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEcosystems } from './ecosystem.ts';

test('the host is enough on its own', () => {
  assert.deepEqual(detectEcosystems({ host: 'docs.rs' }), ['crates']);
  assert.deepEqual(detectEcosystems({ host: 'docs.python.org' }), ['pypi']);
  // A subdomain of a known host counts; an unrelated host does not.
  assert.deepEqual(detectEcosystems({ host: 'blog.rust-lang.org' }), ['crates']);
  assert.deepEqual(detectEcosystems({ host: 'news.example.com' }), []);
});

test('page vocabulary decides when the host says nothing', () => {
  const page = {
    host: 'blog.example.com',
    title: 'Reading Parquet files with pandas',
    topicTerms: ['python', 'dataframe', 'pandas', 'parquet'],
  };
  assert.equal(detectEcosystems(page)[0], 'pypi');
});

test('a page can belong to more than one ecosystem, strongest first', () => {
  // A React article is evidence for both the npm registry and the web
  // platform. Collapsing that to one answer would lose a real caller.
  const found = detectEcosystems({
    host: 'developer.mozilla.org',
    title: 'Using the DOM with React and TypeScript',
    topicTerms: ['dom', 'browser', 'react', 'typescript'],
  });
  assert.equal(found[0], 'web', 'the host outweighs vocabulary alone');
  assert.ok(found.includes('npm'));
});

test('a page with no software vocabulary claims no ecosystem', () => {
  assert.deepEqual(
    detectEcosystems({
      host: 'iceberg.apache.org',
      title: 'Apache Iceberg table specification',
      topicTerms: ['iceberg', 'table', 'metadata', 'snapshot', 'partition'],
    }),
    [],
    'this is what stops the npm package "iceberg" from answering here',
  );
});
