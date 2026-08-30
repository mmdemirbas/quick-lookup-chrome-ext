/**
 * The conversation: shape, request building, and the context budget.
 *
 * A lookup answers "what does this mean". A conversation answers everything
 * else — is this claim true, what is this arguing, how would I reply. The two
 * differ in more than depth: a lookup is one question about one word and is
 * finished when the card is drawn, while a conversation accumulates and is
 * about whatever the reader was looking at when they asked.
 *
 * That last part is the reason this file exists rather than a `messages`
 * array in the panel. What the reader was looking at changes as they browse,
 * so the page travels with the *turn* rather than with the conversation, and
 * a thread can span several pages without lying about which one a question
 * was asked against.
 *
 * Pure: no network, no storage, no `chrome`. Everything here is decided by
 * its inputs, which is what makes the context budget and the cache
 * breakpoint testable without a key.
 */

export type ChatRole = 'user' | 'assistant';

/**
 * The page a question was asked against.
 *
 * Attached to the turn, never to the conversation. Two questions about two
 * pages are the ordinary case: read a post, open the paper it cites, ask
 * whether the paper says what the post claimed.
 */
export type Attachment = {
  url: string;
  host: string;
  title: string;
  /** What was selected when the reader asked, when anything was. */
  selection?: string;
  /** The page's readable text, already within the budget below. */
  excerpt: string;
  /**
   * Characters the page had before clipping. Kept even when nothing was
   * clipped, because the panel shows the size and a number that only
   * appears on failure is a number nobody trusts.
   */
  fullLength: number;
};

/** True when the budget dropped part of the page. */
export function wasClipped(attachment: Attachment): boolean {
  return attachment.fullLength > attachment.excerpt.length;
}

export type ChatTurn = {
  id: string;
  role: ChatRole;
  text: string;
  attachment?: Attachment;
  /**
   * Reasoning, when the model was asked to summarise it. Separate from
   * `text` so the panel can render it quietly and so it is never sent back:
   * a summary is not the reasoning itself and replaying it teaches nothing.
   */
  thinking?: string;
  /**
   * Set on an assistant turn that did not finish. `text` then holds what
   * went wrong, in the API's own words rather than ours.
   */
  failed?: boolean;
};

export type Conversation = {
  model: string;
  turns: ChatTurn[];
};

/**
 * A model the panel offers.
 *
 * `adaptive` is not a preference. Adaptive thinking and the effort control
 * are rejected outright by models older than the 5 family, so sending them
 * to Haiku 4.5 is a 400 rather than a slightly worse answer.
 */
export type ModelChoice = {
  id: string;
  label: string;
  /** US dollars per million tokens, shown so the choice is not blind. */
  inputPrice: number;
  outputPrice: number;
  adaptive: boolean;
};

export const MODELS: readonly ModelChoice[] = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', inputPrice: 2, outputPrice: 10, adaptive: true },
  { id: 'claude-opus-5', label: 'Opus 5', inputPrice: 5, outputPrice: 25, adaptive: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', inputPrice: 1, outputPrice: 5, adaptive: false },
];

/**
 * Sonnet rather than Opus, because most of what gets asked of a page is
 * explain-this and translate-this. Opus is one press away in the picker for
 * the questions that are actually hard.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';

export function modelChoice(id: string): ModelChoice {
  return MODELS.find((model) => model.id === id) ?? MODELS[0]!;
}

/**
 * Characters of page text sent with a question.
 *
 * Roughly six thousand tokens, which covers an article or a post with its
 * comment thread and costs about a cent to send on Sonnet. The cap exists
 * because a page has no upper bound — a docs site with the whole reference
 * on one route will happily hand over a megabyte.
 */
export const DEFAULT_CONTEXT_CHARS = 24_000;

/**
 * Clips page text to the budget, keeping the beginning.
 *
 * The beginning rather than the middle or a summary: on nearly every page
 * the thing the reader is asking about is above the fold, and any cleverer
 * rule would be guessing. The panel says when this happened, because a
 * silently shortened page is how a model comes to answer confidently about
 * a section it never saw.
 */
export function clipExcerpt(text: string, budget = DEFAULT_CONTEXT_CHARS): string {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  // Prefer a paragraph boundary if one is near the end, so the excerpt does
  // not stop mid-sentence and read as if the page itself ended there.
  const boundary = cut.lastIndexOf('\n');
  return boundary > budget * 0.8 ? cut.slice(0, boundary) : cut;
}

export const SYSTEM_PROMPT = `You are reading alongside someone browsing the web. They send you the page they are on and ask about it.

- Answer the question they asked. Do not summarise the page unless asked to.
- The page is what they were reading, not a source you vouch for. When it makes a claim you cannot confirm, say which part is unverified instead of repeating it as fact.
- Say plainly when the page does not contain the answer. An excerpt marked as clipped may be missing the part that did.
- Be brief by default. This is a narrow side panel, not a document. Expand when they ask for depth.
- They may switch pages mid-conversation. Each question says which page it was asked against; use that one.`;

/** A content block in the wire format the Messages API expects. */
type TextBlock = {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
};

type ApiMessage = { role: ChatRole; content: string | TextBlock[] };

export type RequestBody = {
  model: string;
  max_tokens: number;
  system: string;
  messages: ApiMessage[];
  stream: true;
  thinking?: { type: 'adaptive'; display: 'summarized' };
  output_config?: { effort: 'medium' };
};

/**
 * Renders one attachment as the block that precedes its question.
 *
 * Delimited rather than run together, because a page contains sentences that
 * look exactly like instructions and the model has to be able to tell the
 * reader's question from the page's prose.
 */
export function attachmentBlock(attachment: Attachment): string {
  const clipped = wasClipped(attachment);
  const head = [
    `<page url="${attachment.url}" title="${attachment.title.replace(/"/g, "'")}"`,
    clipped ? ` clipped="true" full-length="${attachment.fullLength}"` : '',
    '>',
  ].join('');
  const selection = attachment.selection
    ? `\n\nThe reader had this selected:\n<selection>\n${attachment.selection}\n</selection>`
    : '';
  const notice = clipped
    ? `\n\n[This page was clipped to the first ${attachment.excerpt.length} of ${attachment.fullLength} characters. The rest was not sent.]`
    : '';
  return `${head}\n${attachment.excerpt}\n</page>${notice}${selection}`;
}

/**
 * Builds the request for a conversation whose last turn is the new question.
 *
 * Where the cache breakpoint goes is the only interesting decision here.
 * Prompt caching matches a prefix, so the breakpoint belongs on the *last*
 * attachment: every follow-up about the same page then re-sends a prefix
 * that has not changed by a byte and is billed at a tenth. That is the
 * common shape — land on a page, ask five things about it — and without the
 * breakpoint each of those five re-sends the whole page at full price.
 *
 * Attaching a new page moves the breakpoint forward. The older prefix still
 * reads from cache, so switching pages costs one page, not the thread.
 */
export function buildRequest(conversation: Conversation, contextChars?: number): RequestBody {
  const choice = modelChoice(conversation.model);
  const budget = contextChars ?? DEFAULT_CONTEXT_CHARS;

  // Only turns that were actually said. A failed assistant turn holds our
  // error text, not the model's words, and replaying it as if the model had
  // said it would have it apologising for an outage it knows nothing about.
  const spoken = conversation.turns.filter((turn) => !turn.failed && turn.text.trim());

  const lastAttachment = spoken.reduce(
    (found, turn, index) => (turn.attachment ? index : found),
    -1,
  );

  const messages: ApiMessage[] = spoken.map((turn, index) => {
    if (turn.role !== 'user' || !turn.attachment) {
      return { role: turn.role, content: turn.text };
    }
    const page: TextBlock = {
      type: 'text',
      text: attachmentBlock({
        ...turn.attachment,
        excerpt: clipExcerpt(turn.attachment.excerpt, budget),
      }),
      ...(index === lastAttachment ? { cache_control: { type: 'ephemeral' as const } } : {}),
    };
    return { role: turn.role, content: [page, { type: 'text', text: turn.text }] };
  });

  return {
    model: conversation.model,
    // A ceiling, not a spend: the panel streams, so a large cap costs nothing
    // beyond what is actually generated and removes truncation mid-thought.
    max_tokens: 64_000,
    system: SYSTEM_PROMPT,
    messages,
    stream: true,
    // Without `summarized` the panel shows a still, empty box for as long as
    // the model thinks, which reads as a hang. The summary is what fills it.
    ...(choice.adaptive
      ? {
          thinking: { type: 'adaptive' as const, display: 'summarized' as const },
          output_config: { effort: 'medium' as const },
        }
      : {}),
  };
}

/** A rough running cost for the conversation, in US dollars. */
export function estimateCost(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
): number {
  const choice = modelChoice(model);
  // Cache reads bill at about a tenth of the input rate.
  const input = (usage.inputTokens * choice.inputPrice) / 1_000_000;
  const cached = (usage.cacheReadTokens * choice.inputPrice * 0.1) / 1_000_000;
  const output = (usage.outputTokens * choice.outputPrice) / 1_000_000;
  return input + cached + output;
}

/**
 * The same question and page, as one block of text to paste somewhere else.
 *
 * This is the second way to reach a model and the one that needs no key: the
 * panel composes the prompt, puts it on the clipboard and opens claude.ai.
 * You leave the page to talk, which is the whole cost of it, and in exchange
 * it works on a machine with no key, no daemon and no billing.
 *
 * Deliberately the *same* rendering the API path sends. One format means the
 * clipped notice travels here too — an answer about the first third of a page
 * has to say so wherever it is asked for — and it means there is one thing to
 * maintain rather than two that drift.
 */
export function handoffPrompt(question: string, attachment?: Attachment): string {
  if (!attachment) return question;
  // Not re-clipped. The attachment reaching the panel has already been cut to
  // the reader's budget by the worker, which is the only side that read the
  // setting; clipping again against this file's default would quietly undo a
  // budget the reader raised.
  return `${attachmentBlock(attachment)}\n\n${question}`;
}

/**
 * Where a handed-off prompt is pasted.
 *
 * A new conversation rather than a prefilled one. Prefilling by query string
 * is not used: a page excerpt is tens of thousands of characters and would
 * exceed what a URL can carry long before the budget does, so the clipboard
 * is the only route that works for the case this exists to serve.
 */
export const HANDOFF_URL = 'https://claude.ai/new';
