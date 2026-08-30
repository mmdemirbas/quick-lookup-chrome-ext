import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRequest,
  handoffPrompt,
  DEFAULT_CONTEXT_CHARS,
  clipExcerpt,
  estimateCost,
  modelChoice,
  wasClipped,
  DEFAULT_MODEL,
  type Attachment,
  type Conversation,
  type ChatTurn,
} from './chat.ts';

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  const excerpt = overrides.excerpt ?? 'The post claims deployments got 40% faster.';
  return {
    url: 'https://example.com/post',
    host: 'example.com',
    title: 'A post',
    excerpt,
    fullLength: overrides.fullLength ?? excerpt.length,
    ...overrides,
  };
}

function turn(overrides: Partial<ChatTurn> & { role: ChatTurn['role'] }): ChatTurn {
  return { id: overrides.id ?? 'x', text: overrides.text ?? 'hello', ...overrides };
}

test('clipping keeps the beginning and stops on a paragraph boundary', () => {
  const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50);
  assert.equal(clipExcerpt(text, 200), text, 'nothing under the budget is touched');

  const clipped = clipExcerpt(text, 60);
  assert.equal(clipped, 'a'.repeat(50), 'cut back to the newline rather than mid-word');
});

test('a boundary too far back is ignored so the budget is still used', () => {
  // The only newline sits at 10 of a 90 budget. Honouring it would throw away
  // 80 characters the reader paid for.
  const text = 'a'.repeat(10) + '\n' + 'b'.repeat(200);
  assert.equal(clipExcerpt(text, 90).length, 90);
});

test('clipping is reported by comparing lengths, not by a flag that can drift', () => {
  assert.equal(wasClipped(attachment({ excerpt: 'short', fullLength: 5 })), false);
  assert.equal(wasClipped(attachment({ excerpt: 'short', fullLength: 5000 })), true);
});

test('a question with a page becomes two blocks, page first', () => {
  const conversation: Conversation = {
    model: DEFAULT_MODEL,
    turns: [turn({ role: 'user', text: 'Is that plausible?', attachment: attachment() })],
  };
  const body = buildRequest(conversation);

  const content = body.messages[0]!.content;
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 2);
  assert.match(content[0]!.text, /<page url="https:\/\/example\.com\/post"/);
  assert.match(content[0]!.text, /deployments got 40% faster/);
  assert.equal(content[1]!.text, 'Is that plausible?', 'the question is its own block');
});

test('the cache breakpoint sits on the last attachment, not the first', () => {
  const conversation: Conversation = {
    model: DEFAULT_MODEL,
    turns: [
      turn({ id: '1', role: 'user', text: 'What is this?', attachment: attachment() }),
      turn({ id: '2', role: 'assistant', text: 'A claim about deploys.' }),
      turn({
        id: '3',
        role: 'user',
        text: 'Does the paper agree?',
        attachment: attachment({ url: 'https://example.com/paper', excerpt: 'Methods...' }),
      }),
    ],
  };
  const body = buildRequest(conversation);

  const first = body.messages[0]!.content as { cache_control?: unknown }[];
  const last = body.messages[2]!.content as { cache_control?: unknown }[];
  assert.equal(first[0]!.cache_control, undefined);
  assert.deepEqual(last[0]!.cache_control, { type: 'ephemeral' });
});

test('a follow-up with no page of its own leaves the breakpoint where it was', () => {
  // This is the case caching exists for: five questions about one page must
  // re-send a prefix that has not moved.
  const conversation: Conversation = {
    model: DEFAULT_MODEL,
    turns: [
      turn({ id: '1', role: 'user', text: 'What is this?', attachment: attachment() }),
      turn({ id: '2', role: 'assistant', text: 'A claim.' }),
      turn({ id: '3', role: 'user', text: 'And the sample size?' }),
    ],
  };
  const body = buildRequest(conversation);

  const first = body.messages[0]!.content as { cache_control?: unknown }[];
  assert.deepEqual(first[0]!.cache_control, { type: 'ephemeral' });
  assert.equal(typeof body.messages[2]!.content, 'string', 'no page, no blocks');
});

test('a failed turn is not replayed as something the model said', () => {
  const conversation: Conversation = {
    model: DEFAULT_MODEL,
    turns: [
      turn({ id: '1', role: 'user', text: 'Why?' }),
      turn({ id: '2', role: 'assistant', text: 'HTTP 529: overloaded', failed: true }),
      turn({ id: '3', role: 'user', text: 'Try again' }),
    ],
  };
  const body = buildRequest(conversation);

  assert.equal(body.messages.length, 2);
  assert.ok(
    !body.messages.some((message) => String(message.content).includes('529')),
    'our error text never becomes part of the conversation',
  );
});

test('a clipped page says so inside the block, where the model will read it', () => {
  const long = 'x'.repeat(5000);
  const conversation: Conversation = {
    model: DEFAULT_MODEL,
    turns: [
      turn({
        role: 'user',
        text: 'Summarise',
        attachment: attachment({ excerpt: long, fullLength: 5000 }),
      }),
    ],
  };
  const body = buildRequest(conversation, 1000);

  const content = body.messages[0]!.content as { text: string }[];
  assert.match(content[0]!.text, /clipped="true"/);
  assert.match(content[0]!.text, /clipped to the first 1000 of 5000 characters/);
});

test('adaptive thinking and effort are sent only to models that accept them', () => {
  const sonnet = buildRequest({ model: 'claude-sonnet-5', turns: [] });
  assert.deepEqual(sonnet.thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepEqual(sonnet.output_config, { effort: 'medium' });

  // Haiku 4.5 predates both parameters and answers a 400, not a worse reply.
  const haiku = buildRequest({ model: 'claude-haiku-4-5', turns: [] });
  assert.equal(haiku.thinking, undefined);
  assert.equal(haiku.output_config, undefined);
});

test('an unknown model falls back rather than being sent to the API', () => {
  assert.equal(modelChoice('claude-nonexistent').id, 'claude-sonnet-5');
});

test('cached input is billed at a tenth of fresh input', () => {
  // Sonnet 5: $2 in, $10 out per million.
  const fresh = estimateCost('claude-sonnet-5', {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
  });
  const cached = estimateCost('claude-sonnet-5', {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 1_000_000,
  });
  assert.equal(fresh, 2);
  assert.ok(Math.abs(cached - 0.2) < 1e-9);
});

test('a handoff with no page is just the question', () => {
  assert.equal(handoffPrompt('What is a manifest?'), 'What is a manifest?');
});

test('a handoff puts the page first and the question last', () => {
  const prompt = handoffPrompt('Is that plausible?', attachment());
  assert.match(prompt, /^<page url="https:\/\/example\.com\/post"/);
  assert.ok(prompt.endsWith('Is that plausible?'));
});

test('a clipped page still says so when handed off, not only when sent', () => {
  const prompt = handoffPrompt(
    'Summarise',
    attachment({ excerpt: 'x'.repeat(1000), fullLength: 5000 }),
  );
  assert.match(prompt, /clipped to the first 1000 of 5000 characters/);
});

test('a handoff does not re-clip a budget the reader raised', () => {
  // The worker already cut this to the reader's setting, which is larger than
  // this file's default. Clipping again here would silently undo it.
  const excerpt = 'y'.repeat(DEFAULT_CONTEXT_CHARS + 5_000);
  const prompt = handoffPrompt('Summarise', attachment({ excerpt, fullLength: excerpt.length }));
  assert.ok(prompt.includes(excerpt), 'the whole excerpt survives');
});
