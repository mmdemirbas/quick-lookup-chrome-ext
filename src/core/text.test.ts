import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml } from './text.ts';

test('numeric character references become the characters they name', () => {
  assert.equal(stripHtml('caf&#233;'), 'café');
  assert.equal(stripHtml('caf&#xE9;'), 'café');
  assert.equal(stripHtml('<b>bold</b> &amp; plain'), 'bold & plain');
});

test('a reference no character can have is left as it was written', () => {
  // This runs on text a remote source wrote, and String.fromCodePoint throws
  // above U+10FFFF — an uncaught throw here costs the whole slot.
  assert.equal(stripHtml('over &#1114112; the top'), 'over &#1114112; the top');
  assert.equal(stripHtml('half a pair &#xD800;'), 'half a pair &#xD800;');
  assert.equal(stripHtml('the largest &#1114111; is fine'), 'the largest \u{10FFFF} is fine');
});
