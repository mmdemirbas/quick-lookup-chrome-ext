import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SPEECH_CHARS, speakable, utteranceLanguage } from './speech.ts';

test('a declared page language is used when it is shaped like one', () => {
  assert.equal(utteranceLanguage('tr'), 'tr');
  assert.equal(utteranceLanguage('en-GB'), 'en-GB');
  assert.equal(utteranceLanguage('zh-Hans-CN'), 'zh-Hans-CN');
});

test('anything that is not a language tag falls back rather than being passed on', () => {
  // A bad tag makes the engine pick a default voice silently, so the reader
  // hears a confident mispronunciation with nothing to explain it.
  for (const declared of ['', '   ', 'English', 'tr_TR', '1234', null, undefined]) {
    assert.equal(utteranceLanguage(declared), 'en', JSON.stringify(declared));
  }
  assert.equal(utteranceLanguage('', 'tr'), 'tr', 'the caller chooses the fallback');
});

test('a selection long enough to be a paragraph is not read aloud', () => {
  assert.ok(speakable('partition'));
  assert.ok(speakable('A manifest lists the data files making up a snapshot.'));
  assert.ok(!speakable('   '));
  assert.ok(!speakable(''));

  assert.ok(speakable('a'.repeat(MAX_SPEECH_CHARS)));
  assert.ok(
    !speakable('a'.repeat(MAX_SPEECH_CHARS + 1)),
    'a mis-selected paragraph must not commit the reader to minutes of audio',
  );
});
