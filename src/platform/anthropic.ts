/**
 * The Messages API, streamed, over plain `fetch`.
 *
 * Not the official SDK, and the reason is the runtime rather than taste: its
 * credential chain does `await import('node:fs')` to find profiles on disk,
 * which esbuild cannot resolve for a browser target and which an extension
 * has no use for — the key is handed in explicitly. Working around it means
 * a stub plugin in the build for a dependency this repo would otherwise be
 * the first of. The wire format below is small enough to own.
 *
 * If the SDK later ships a browser entry point without that chain, this file
 * is the only thing that has to change: `src/core/chat.ts` builds the body
 * and nothing above here knows how it is sent.
 */

import type { RequestBody } from '../core/chat.ts';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

/** The dated contract version, sent on every request. */
const API_VERSION = '2023-06-01';

/**
 * Where a request goes and what it carries to be let in.
 *
 * Two backends, one wire format: the local bridge answers with the same
 * Anthropic-shaped SSE, so switching between them is a different URL and a
 * different header and nothing else. Everything below this line is shared.
 *
 * `credential` and `unreachable` exist so failures stay specific. "The API
 * key was rejected" and "the bridge is not running" are the two things a
 * reader can actually act on, and a single "request failed" hides both.
 */
export type ChatTarget = {
  url: string;
  headers: Record<string, string>;
  /** What a 401 was rejecting, in the words the reader would use. */
  credential: string;
  /** What to say when the connection never happened at all. */
  unreachable: string;
};

export function apiTarget(apiKey: string): ChatTarget {
  return {
    url: ENDPOINT,
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      // The API refuses browser-origin requests by default, because a key in
      // a web page is a key the world has. An extension service worker is not
      // a web page, but it carries an origin, so the acknowledgement is
      // required. The key never reaches a content script.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    credential: 'The API key',
    unreachable: 'Could not reach api.anthropic.com.',
  };
}

export function bridgeTarget(baseUrl: string, token: string): ChatTarget {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return {
    url: `${base}/v1/messages`,
    headers: { authorization: `Bearer ${token}` },
    credential: 'The bridge token',
    unreachable: `Could not reach the bridge at ${base}. Start it with \`node bridge/server.mjs\`.`,
  };
}

export type ChatDelta =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string };

export type ChatUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

/**
 * A failure with the API's own words kept.
 *
 * One generic "something went wrong" would have the reader retrying a bad key
 * forever and giving up on an overload that would have cleared in a second.
 * The status and the message are what tell those apart, so both survive to
 * the panel.
 */
export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** True when trying the same thing again could plausibly work. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

/** Turns an error body into something a reader can act on. */
function describe(status: number, body: string, credential: string): ChatError {
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // Not JSON. An HTML error page from something in front of the API, most
    // likely; the raw prefix is still more useful than a generic sentence.
  }

  switch (status) {
    case 401:
    case 403:
      return new ChatError(status, `${credential} was rejected. ${detail}`, false);
    case 429:
      return new ChatError(status, `Rate limited. ${detail}`, true);
    case 400:
      return new ChatError(status, `The request was refused. ${detail}`, false);
    default:
      return new ChatError(status, detail || `HTTP ${status}`, status >= 500);
  }
}

type StreamEvent = {
  type?: string;
  delta?: { type?: string; text?: string; thinking?: string };
  message?: { usage?: Record<string, number> };
  usage?: Record<string, number>;
  error?: { message?: string };
};

/**
 * Splits an SSE body into events.
 *
 * Events are separated by a blank line and a single event can straddle any
 * number of network chunks, so the tail of each chunk is carried forward
 * rather than parsed. Only the `data:` line matters here — the `event:` line
 * repeats the `type` field that is already inside the JSON.
 */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf('\n\n');

        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            yield JSON.parse(payload) as StreamEvent;
          } catch {
            // A malformed frame is not worth killing the answer over; the
            // stream carries on and the missing delta shows as a gap.
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {
      // Already closed, or the request was aborted. Nothing to recover.
    });
  }
}

/**
 * Sends a conversation and calls back with each fragment as it arrives.
 *
 * Resolves with what the turn cost once the stream ends. Rejects with a
 * `ChatError` on anything the API refused, and with an `AbortError` when the
 * reader stopped it — the caller has to tell those apart, because one is
 * worth showing and the other is not.
 */
export async function streamChat(options: {
  target: ChatTarget;
  body: RequestBody;
  signal: AbortSignal;
  onDelta: (delta: ChatDelta) => void;
}): Promise<ChatUsage> {
  let response: Response;
  try {
    response = await fetch(options.target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.target.headers },
      body: JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    // Aborts are the caller's business and must not be dressed as failures.
    if (options.signal.aborted) throw error;
    // A `fetch` that throws never reached anything, so there is no status and
    // no body to read. For the bridge this is the everyday case — the process
    // is not running — and saying so beats a TypeError.
    const detail = error instanceof Error ? error.message : String(error);
    throw new ChatError(0, `${options.target.unreachable} (${detail})`, true);
  }

  if (!response.ok || !response.body) {
    throw describe(
      response.status,
      await response.text().catch(() => ''),
      options.target.credential,
    );
  }

  const usage: ChatUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  for await (const event of events(response.body)) {
    switch (event.type) {
      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          options.onDelta({ kind: 'text', text: event.delta.text });
        } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          options.onDelta({ kind: 'thinking', text: event.delta.thinking });
        }
        break;

      case 'message_start':
        usage.inputTokens = event.message?.usage?.input_tokens ?? 0;
        usage.cacheReadTokens = event.message?.usage?.cache_read_input_tokens ?? 0;
        break;

      case 'message_delta':
        usage.outputTokens = event.usage?.output_tokens ?? usage.outputTokens;
        break;

      // An error can arrive mid-stream, after a 200 and some text. Throwing
      // here is what stops a truncated answer being presented as a whole one.
      case 'error':
        throw new ChatError(200, event.error?.message ?? 'The stream failed.', true);

      default:
        break;
    }
  }

  return usage;
}
