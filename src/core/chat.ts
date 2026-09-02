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
 * Which process answers.
 *
 * Both speak the same wire format — a Messages body in, Anthropic-shaped SSE
 * out — so this picks a URL and a header, not a code path. That is the whole
 * reason the local bridge was cheap to add.
 */
export type ChatBackend = 'api' | 'bridge';

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
  /**
   * The stream stopped without saying it was done, so `text` is a fragment.
   *
   * Distinct from `failed`, which carries our words instead of the model's.
   * A truncated turn holds real output and is worth keeping and replaying —
   * it just must not be read as a finished answer, which is exactly what it
   * looked like before this existed.
   */
  truncated?: boolean;
};

/**
 * What a thread has spent.
 *
 * Lives here rather than in the platform layer because the conversation owns
 * it: it is a property of the thread, not of the transport that carried it.
 */
export type ChatUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /**
   * Tokens written to the cache, billed at about 1.25x input.
   *
   * A separate field in the API's accounting and **not** part of
   * `input_tokens`, which is the trap: on the first question about a page the
   * whole page is cache creation, so a meter that reads only `input_tokens`
   * reports nearly nothing for the turn that costs the most.
   */
  cacheCreationTokens: number;
};

export const emptyUsage = (): ChatUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

export type Conversation = {
  model: string;
  turns: ChatTurn[];
  /**
   * Spend and backend live on the conversation and nowhere else.
   *
   * They were previously a second copy held beside it, which is how a cleared
   * thread went on reporting the spend of the thread before it, and how a
   * bridge thread started quoting dollars again the moment the panel was
   * reopened. One fact, one owner.
   */
  usage: ChatUsage;
  /** Which backend last answered. Decides whether a cost can honestly be shown. */
  backend: ChatBackend;
};

/** A thread with nothing in it yet. */
export function newConversation(model: string): Conversation {
  return { model, turns: [], usage: emptyUsage(), backend: 'api' };
}

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
 * How many pages keep their full text in the request.
 *
 * Every page ever attached used to be re-sent on every later turn, so a
 * thread that wandered across ten pages carried all ten forever — measured
 * at roughly 67,000 tokens per request by the tenth question, growing
 * linearly and with nothing to stop it.
 *
 * Three, because the case this feature exists for needs two: read a post,
 * open the paper it cites, ask whether the paper supports the post. Older
 * pages are not dropped from the conversation — they keep their title and
 * URL, so "the paper you showed me earlier" still refers to something.
 */
export const PAGES_KEPT_IN_FULL = 3;

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
/**
 * Stops page text from closing the container it was put in.
 *
 * Verified rather than assumed: an excerpt containing a literal `</page>`
 * produced two closing tags, and everything after the first read as though it
 * came from outside the page — including a forged `User:` line, which is the
 * exact marker the local bridge uses to separate turns when it flattens the
 * conversation for the CLI. A page is text a stranger wrote; the fence around
 * it has to be one the text cannot reach.
 *
 * Quoting is not available here — this is a prompt, not a parser — so the
 * closing sequences are broken with a zero-width space. The model reads the
 * words unchanged; the fence stays closed.
 */
function fence(text: string): string {
  return text.replace(/<\/(page|selection)>/gi, '<\u200b/$1>');
}

/**
 * Makes a value safe to sit inside a quoted attribute.
 *
 * Dropping the quote is not enough, and the test that says so is worth
 * keeping: the reader of this text is a model, not an XML parser, so a `>`
 * left inside the value still *looks* like the tag ended there. Angle
 * brackets go too. A URL that needs them was already broken.
 */
const attribute = (value: string): string => value.replace(/["<>]/g, '');

export function attachmentBlock(attachment: Attachment): string {
  const clipped = wasClipped(attachment);
  const head = [
    `<page url="${attribute(attachment.url)}" title="${attribute(attachment.title)}"`,
    clipped ? ` clipped="true" full-length="${attachment.fullLength}"` : '',
    '>',
  ].join('');
  const selection = attachment.selection
    ? `\n\nThe reader had this selected:\n<selection>\n${fence(attachment.selection)}\n</selection>`
    : '';
  const notice = clipped
    ? `\n\n[This page was clipped to the first ${attachment.excerpt.length} of ${attachment.fullLength} characters. The rest was not sent.]`
    : '';
  return `${head}\n${fence(attachment.excerpt)}\n</page>${notice}${selection}`;
}

/**
 * A page that has aged out of the budget: named, but no longer quoted.
 *
 * Said out loud rather than silently omitted. A model that is not told the
 * text is gone will answer about it from whatever it can still infer, and
 * that answer is indistinguishable from one grounded in the page.
 */
function referenceBlock(attachment: Attachment): string {
  return (
    `<page url="${attribute(attachment.url)}" title="${attribute(attachment.title)}" text-dropped="true">\n` +
    `[Discussed earlier in this conversation. Its text is no longer included — ` +
    `say so rather than guessing if a question depends on it.]\n</page>`
  );
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

  const withPages = spoken
    .map((turn, index) => (turn.attachment ? index : -1))
    .filter((index) => index !== -1);
  const lastAttachment = withPages.at(-1) ?? -1;
  // The newest few keep their text; everything older keeps only its name.
  const keepInFull = new Set(withPages.slice(-PAGES_KEPT_IN_FULL));

  const messages: ApiMessage[] = spoken.map((turn, index) => {
    if (turn.role !== 'user' || !turn.attachment) {
      return { role: turn.role, content: turn.text };
    }
    const page: TextBlock = {
      type: 'text',
      text: keepInFull.has(index)
        ? attachmentBlock({
            ...turn.attachment,
            excerpt: clipExcerpt(turn.attachment.excerpt, budget),
          })
        : referenceBlock(turn.attachment),
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
export function estimateCost(model: string, usage: ChatUsage): number {
  const choice = modelChoice(model);
  const per = choice.inputPrice / 1_000_000;
  // Three input rates, not one. Cache reads are about a tenth; cache writes
  // are about 1.25x and are the bulk of a first question about a page.
  const input = usage.inputTokens * per;
  const cached = usage.cacheReadTokens * per * 0.1;
  const written = usage.cacheCreationTokens * per * 1.25;
  const output = (usage.outputTokens * choice.outputPrice) / 1_000_000;
  return input + cached + written + output;
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

/**
 * Rebuilds a conversation from whatever was in storage.
 *
 * `JSON.parse` returns `unknown`, and a thread written by an older build is
 * exactly that: one saved before spend and backend moved inside the
 * conversation has neither, and reading `usage.inputTokens` off it throws.
 * That throw used to land in the catch meant for storage failures, so the
 * thread was silently replaced with an empty one — the reader lost the
 * conversation and nothing said so.
 *
 * Returns `undefined` for something that is not a conversation at all, and
 * fills in what a newer field expects for something that merely predates it.
 */
export function reviveConversation(value: unknown): Conversation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.turns)) return undefined;

  const turns: ChatTurn[] = [];
  for (const entry of raw.turns) {
    if (typeof entry !== 'object' || entry === null) continue;
    const turn = entry as Record<string, unknown>;
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    if (typeof turn.text !== 'string') continue;
    turns.push({
      id: typeof turn.id === 'string' ? turn.id : `${turns.length}`,
      role: turn.role,
      text: turn.text,
      ...(typeof turn.thinking === 'string' ? { thinking: turn.thinking } : {}),
      ...(turn.failed === true ? { failed: true } : {}),
      ...(turn.truncated === true ? { truncated: true } : {}),
      ...(isAttachment(turn.attachment) ? { attachment: turn.attachment } : {}),
    });
  }

  const usage = raw.usage as Partial<ChatUsage> | undefined;
  const number = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

  return {
    model: typeof raw.model === 'string' ? raw.model : DEFAULT_MODEL,
    turns,
    usage: {
      inputTokens: number(usage?.inputTokens),
      outputTokens: number(usage?.outputTokens),
      cacheReadTokens: number(usage?.cacheReadTokens),
      cacheCreationTokens: number(usage?.cacheCreationTokens),
    },
    backend: raw.backend === 'bridge' ? 'bridge' : 'api',
  };
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.url === 'string' &&
    typeof a.host === 'string' &&
    typeof a.title === 'string' &&
    typeof a.excerpt === 'string' &&
    typeof a.fullLength === 'number'
  );
}
