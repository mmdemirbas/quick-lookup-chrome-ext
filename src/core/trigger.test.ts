import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DismissalTracker, decideTrigger, selectionFacts } from './trigger.ts';
import { DEFAULT_SETTINGS, mergeSettings, triggerModeFor } from './settings.ts';
import type { Settings } from './settings.ts';

const facts = (text: string, over: Partial<Parameters<typeof selectionFacts>[1]> = {}) =>
  selectionFacts(text, {
    inEditable: false,
    insideOwnUi: false,
    modifierHeld: false,
    ...over,
  });

const settings = (): Settings => structuredClone(DEFAULT_SETTINGS);

test('the default is to open on a normal selection', () => {
  assert.equal(decideTrigger(facts('ephemeral'), settings(), 'auto').action, 'open');
});

test('a long selection offers the handle instead of opening', () => {
  const long = Array.from({ length: 30 }, () => 'word').join(' ');
  const decision = decideTrigger(facts(long), settings(), 'auto');
  assert.equal(decision.action, 'handle');
});

test('a selection inside the card never re-triggers a lookup', () => {
  // Copying the answer is the case this protects.
  assert.equal(decideTrigger(facts('answer', { insideOwnUi: true }), settings(), 'auto').action, 'ignore');
});

test('editable fields are excluded by default and includable by setting', () => {
  const s = settings();
  assert.equal(decideTrigger(facts('draft', { inEditable: true }), s, 'auto').action, 'ignore');
  s.trigger.inEditable = true;
  assert.equal(decideTrigger(facts('draft', { inEditable: true }), s, 'auto').action, 'open');
});

test('modifier mode stays silent until the modifier is held', () => {
  assert.equal(decideTrigger(facts('ephemeral'), settings(), 'modifier').action, 'ignore');
  assert.equal(
    decideTrigger(facts('ephemeral', { modifierHeld: true }), settings(), 'modifier').action,
    'open',
  );
});

test('off means off, and handle mode never opens by itself', () => {
  assert.equal(decideTrigger(facts('ephemeral'), settings(), 'off').action, 'ignore');
  assert.equal(decideTrigger(facts('ephemeral'), settings(), 'handle').action, 'handle');
});

test('a selection past the character limit is ignored entirely', () => {
  const huge = 'x'.repeat(DEFAULT_SETTINGS.limits.maxSelectionChars + 1);
  assert.equal(decideTrigger(facts(huge), settings(), 'auto').action, 'ignore');
});

test('whitespace-only selections are ignored', () => {
  assert.equal(decideTrigger(facts('   \n  '), settings(), 'auto').action, 'ignore');
});

test('a per-site mode overrides the global one', () => {
  const s = settings();
  s.sites['news.example.com'] = { mode: 'off' };
  assert.equal(triggerModeFor(s, 'news.example.com'), 'off');
  assert.equal(triggerModeFor(s, 'other.example.com'), 'auto');
});

test('dismissals accumulate per host and reset on engagement', () => {
  const tracker = new DismissalTracker(3);
  assert.equal(tracker.recordDismissal('a.com'), false);
  assert.equal(tracker.recordDismissal('a.com'), false);
  assert.equal(tracker.recordDismissal('a.com'), true, 'third dismissal crosses the threshold');

  tracker.recordEngagement('a.com');
  assert.equal(tracker.count('a.com'), 0);

  // Hosts are tracked independently.
  tracker.recordDismissal('b.com');
  assert.equal(tracker.count('b.com'), 1);
});

test('stored settings merge over defaults and drop unknown keys', () => {
  const merged = mergeSettings({
    trigger: { mode: 'handle', bogus: 1 },
    unknownGroup: { x: 1 },
  });
  assert.equal(merged.trigger.mode, 'handle');
  assert.equal(merged.trigger.dwellMs, DEFAULT_SETTINGS.trigger.dwellMs);
  assert.equal('bogus' in merged.trigger, false);
});

test('settings of the wrong type fall back to the default', () => {
  const merged = mergeSettings({ trigger: { dwellMs: 'soon' } });
  assert.equal(merged.trigger.dwellMs, DEFAULT_SETTINGS.trigger.dwellMs);
  assert.deepEqual(mergeSettings(null), DEFAULT_SETTINGS);
});
