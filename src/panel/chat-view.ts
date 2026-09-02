/**
 * The conversation, rendered.
 *
 * The panel owns the thread rather than the service worker, because the
 * worker is torn down after about thirty seconds of inactivity and this
 * document is not. It outlives navigation for the same reason the card does
 * not: it is browser chrome, and the page it was opened over has no say in
 * whether it stays.
 *
 * Everything is inserted as text. Answers arrive from a model reading pages
 * the reader did not write, so treating any of it as markup would be handing
 * a stranger's page a script tag in the extension's own origin.
 */
import {
  MODELS,
  handoffPrompt,
  estimateCost,
  modelChoice,
  newConversation,
  wasClipped,
  type Attachment,
  type ChatTurn,
  type ChatBackend,
  type ChatUsage,
  type Conversation,
} from '../core/chat.ts';

export type ChatCallbacks = {
  onSend: (conversation: Conversation, requestId: string) => void;
  onCancel: () => void;
  /** Take this question and page somewhere with no key and no bill. */
  onHandoff: (prompt: string) => void;
  /** Called whenever the thread changes, so it can be written to storage. */
  onChanged: (conversation: Conversation) => void;
};

type Elements = {
  log: HTMLElement;
  /**
   * Shown while the thread is empty. Held as an element rather than redrawn,
   * because it carries the one instruction that says how to start — and the
   * panel replaces its text when there is no key to start with.
   */
  empty: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  model: HTMLSelectElement;
  attachment: HTMLElement;
  meter: HTMLElement;
  clear: HTMLButtonElement;
  handoff: HTMLButtonElement;
  /**
   * Where state changes are announced to a screen reader.
   *
   * A live region on the log itself would re-announce the whole answer on
   * every token, which is worse than silence. What a listener needs is the
   * transitions — it started, it finished, it was cut off — and then the
   * ability to go and read it.
   */
  status: HTMLElement;
};

export class ChatView {
  private conversation: Conversation;
  /** The page waiting to go with the next question, if the reader staged one. */
  private staged: Attachment | undefined;
  /** The turn currently being streamed into, and the request that owns it. */
  private streaming: { requestId: string; turn: ChatTurn } | undefined;
  /**
   * The element the streaming turn is drawn into.
   *
   * Held so a delta can replace one turn instead of the whole thread.
   * Rebuilding everything per token measured 103ms for 300 deltas into an
   * empty thread and 450ms into a sixty-turn one — the cost of a token
   * scaled with how long the conversation already was, which is the wrong
   * way round for something that only ever appends to the end.
   */
  private streamingElement: HTMLElement | undefined;

  constructor(
    private readonly elements: Elements,
    private readonly callbacks: ChatCallbacks,
    initial: Conversation,
  ) {
    this.conversation = initial;
    this.buildModelPicker();
    this.bind();
    this.draw();
  }

  /**
   * Restores a thread saved by a previous life of this document.
   *
   * Spend and backend ride along inside the conversation, which is the point
   * of them living there: reopening the panel used to reset the backend to
   * `api` and start quoting dollars for answers a subscription had paid for.
   */
  restore(conversation: Conversation): void {
    this.conversation = conversation;
    this.elements.model.value = conversation.model;
    this.draw();
  }

  private buildModelPicker(): void {
    for (const model of MODELS) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = model.label;
      // Priced per million tokens, which is the only unit that lets two
      // models be compared without doing arithmetic in your head.
      option.title = `$${model.inputPrice} in / $${model.outputPrice} out per million tokens`;
      this.elements.model.append(option);
    }
    this.elements.model.value = this.conversation.model;
  }

  private bind(): void {
    this.elements.model.addEventListener('change', () => {
      this.conversation.model = this.elements.model.value;
      this.callbacks.onChanged(this.conversation);
      this.drawMeter();
    });

    this.elements.send.addEventListener('click', () => {
      if (this.streaming) this.cancel();
      else this.send();
    });

    this.elements.input.addEventListener('keydown', (event) => {
      // Enter sends, shift-enter breaks the line. A side panel is narrow
      // enough that a multi-line question is the exception, not the rule.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      }
    });

    // Grows with the question, up to a third of the panel. Beyond that the
    // thread it is about would be off screen, which defeats the point.
    this.elements.input.addEventListener('input', () => {
      const input = this.elements.input;
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    });

    // The same question and page, composed and handed to claude.ai instead.
    // Useful with no key at all, and useful with one when a question wants
    // the full app rather than a column 380 pixels wide.
    this.elements.handoff.addEventListener('click', () => {
      const text = this.elements.input.value.trim();
      if (!text) return;
      this.callbacks.onHandoff(handoffPrompt(text, this.staged));
    });

    this.elements.clear.addEventListener('click', () => {
      // One object replaced, so nothing can survive the clear by being held
      // somewhere else. The spend used to, and an emptied thread went on
      // reporting the cost of the thread before it.
      this.conversation = newConversation(this.conversation.model);
      this.staged = undefined;
      this.callbacks.onChanged(this.conversation);
      this.draw();
    });
  }

  /** A page arrived from the context menu and goes with the next question. */
  attach(attachment: Attachment): void {
    this.staged = attachment;
    this.drawStaged();
    this.elements.input.focus();
  }

  private send(): void {
    const text = this.elements.input.value.trim();
    if (!text || this.streaming) return;

    const question: ChatTurn = {
      id: turnId(),
      role: 'user',
      text,
      ...(this.staged ? { attachment: this.staged } : {}),
    };
    const answer: ChatTurn = { id: turnId(), role: 'assistant', text: '' };
    this.conversation.turns.push(question);

    const requestId = turnId();
    // Sent before the empty answer is pushed, so the request carries the
    // question and not a blank assistant turn the model would have to skip.
    this.callbacks.onSend(structuredClone(this.conversation), requestId);

    this.conversation.turns.push(answer);
    this.streaming = { requestId, turn: answer };
    this.staged = undefined;
    this.elements.input.value = '';
    this.elements.input.style.height = 'auto';
    this.callbacks.onChanged(this.conversation);
    this.draw();
  }

  private cancel(): void {
    this.callbacks.onCancel();
    const turn = this.streaming?.turn;
    // An answer that never started is not an answer. Left in place it draws
    // as a blank block under the question and is saved that way, so a stopped
    // question kept an empty reply beneath it for the life of the thread.
    // A turn that did produce text keeps it: those are the model's own words
    // and belong in the thread and in the next request.
    if (turn && !turn.text.trim()) {
      const at = this.conversation.turns.indexOf(turn);
      if (at !== -1) this.conversation.turns.splice(at, 1);
    }
    this.finish();
  }

  /** One fragment of the answer. */
  delta(requestId: string, kind: 'text' | 'thinking', text: string): void {
    if (this.streaming?.requestId !== requestId) return;
    const turn = this.streaming.turn;
    if (kind === 'thinking') turn.thinking = (turn.thinking ?? '') + text;
    else turn.text += text;

    // Only the turn being written to. Everything above it is unchanged, and
    // redrawing it was the whole of the cost.
    const current = this.streamingElement;
    if (!current) {
      this.draw();
      return;
    }
    const fresh = this.turnElement(turn);
    current.replaceWith(fresh);
    this.streamingElement = fresh;
    this.elements.log.scrollTop = this.elements.log.scrollHeight;
  }

  done(
    requestId: string,
    usage: ChatUsage,
    backend: ChatBackend = 'api',
    complete = true,
  ): void {
    if (this.streaming?.requestId !== requestId) return;
    if (!complete) this.streaming.turn.truncated = true;
    const running = this.conversation.usage;
    this.conversation.backend = backend;
    this.conversation.usage = {
      inputTokens: running.inputTokens + usage.inputTokens,
      outputTokens: running.outputTokens + usage.outputTokens,
      cacheReadTokens: running.cacheReadTokens + usage.cacheReadTokens,
      cacheCreationTokens: running.cacheCreationTokens + usage.cacheCreationTokens,
    };
    this.finish();
  }

  failed(requestId: string, message: string, retryable: boolean): void {
    if (this.streaming?.requestId !== requestId) return;
    const turn = this.streaming.turn;
    // Replacing rather than appending: a half-written answer followed by an
    // error reads as if the model said both, and the fragment is not an
    // answer to anything. `failed` keeps it out of the next request.
    turn.text = retryable ? `${message} Worth trying again.` : message;
    turn.failed = true;
    this.finish();
  }

  private finish(): void {
    this.streaming = undefined;
    this.streamingElement = undefined;
    this.callbacks.onChanged(this.conversation);
    this.draw();
  }

  private draw(): void {
    const log = this.elements.log;
    log.replaceChildren();

    if (this.conversation.turns.length === 0) log.append(this.elements.empty);
    this.streamingElement = undefined;
    for (const turn of this.conversation.turns) {
      const element = this.turnElement(turn);
      if (this.streaming?.turn === turn) this.streamingElement = element;
      log.append(element);
    }

    this.elements.send.textContent = this.streaming ? 'Stop' : 'Ask';
    this.announce();
    this.elements.send.classList.toggle('streaming', Boolean(this.streaming));
    this.elements.clear.hidden = this.conversation.turns.length === 0;
    this.drawStaged();
    this.drawMeter();

    // Follow the answer as it is written, which is what a reader watching it
    // arrive expects. Scrolling up to read stops that until the next turn.
    log.scrollTop = log.scrollHeight;
  }

  private turnElement(turn: ChatTurn): HTMLElement {
    const element = document.createElement('article');
    element.className = `turn ${turn.role}${turn.failed || turn.truncated ? ' failed' : ''}`;
    // Without this a listener hears two runs of prose with nothing saying
    // which of them was the question.
    element.setAttribute('aria-label', turn.role === 'user' ? 'Your question' : 'Answer');

    if (turn.attachment) element.append(attachmentChip(turn.attachment));

    if (turn.thinking) {
      const thinking = document.createElement('details');
      thinking.className = 'thinking';
      const summary = document.createElement('summary');
      summary.textContent = 'Reasoning';
      const body = document.createElement('p');
      body.textContent = turn.thinking;
      thinking.append(summary, body);
      element.append(thinking);
    }

    const body = document.createElement('div');
    body.className = 'body';
    if (turn.truncated) {
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = 'Cut off';
      label.title = 'The stream ended before the answer did. What is here is a fragment.';
      body.append(label);
    }
    if (turn.failed) {
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = 'Not answered';
      body.append(label);
    }
    if (turn.text) {
      // Paragraph per blank line. Not markdown: rendering a model's output as
      // markup is the one place this extension would be injecting HTML it did
      // not compose, and plain paragraphs read fine in a column this narrow.
      for (const paragraph of turn.text.split(/\n{2,}/)) {
        const p = document.createElement('p');
        p.textContent = paragraph;
        body.append(p);
      }
    } else if (this.streaming?.turn === turn) {
      body.classList.add('waiting');
      body.textContent = 'Thinking…';
    }
    element.append(body);
    return element;
  }

  private drawStaged(): void {
    const holder = this.elements.attachment;
    holder.replaceChildren();
    holder.hidden = !this.staged;
    if (!this.staged) return;

    const chip = attachmentChip(this.staged);
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'drop';
    drop.textContent = '×';
    drop.title = 'Ask without the page';
    drop.setAttribute('aria-label', 'Ask without the page');
    drop.addEventListener('click', () => {
      this.staged = undefined;
      this.drawStaged();
    });
    chip.append(drop);
    holder.append(chip);
  }

  /** One short sentence per state change, for anyone not watching the box. */
  private announce(): void {
    const last = this.conversation.turns.at(-1);
    if (this.streaming) {
      this.elements.status.textContent = 'Answering.';
    } else if (last?.failed) {
      this.elements.status.textContent = `Not answered. ${last.text}`;
    } else if (last?.truncated) {
      this.elements.status.textContent = 'The answer was cut off before it finished.';
    } else if (last?.role === 'assistant' && last.text) {
      this.elements.status.textContent = 'Answer finished.';
    } else {
      this.elements.status.textContent = '';
    }
  }

  private drawMeter(): void {
    const usage = this.conversation.usage;
    const spent =
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
    if (!spent) {
      this.elements.meter.textContent = '';
      return;
    }
    // The bridge spends a subscription, not dollars. Pricing its answers at
    // the API's rates would be inventing a number that nobody is billed.
    if (this.conversation.backend === 'bridge') {
      this.elements.meter.textContent =
        `${modelChoice(this.conversation.model).label} \u00b7 via Claude Code on this machine`;
      return;
    }
    const cost = estimateCost(this.conversation.model, usage);
    const cached = usage.cacheReadTokens
      ? `, ${Math.round(usage.cacheReadTokens / 1000)}k from cache`
      : '';
    this.elements.meter.textContent =
      `${modelChoice(this.conversation.model).label} · ` +
      `about ${cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`} this thread${cached}`;
  }
}

/** The page a question was asked against, as one scannable line. */
function attachmentChip(attachment: Attachment): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'attachment';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = attachment.title || attachment.host;
  title.title = attachment.url;

  const host = document.createElement('span');
  host.className = 'host';
  host.textContent = attachment.host;

  chip.append(title, host);

  if (attachment.selection) {
    const quoted = document.createElement('span');
    quoted.className = 'selected';
    quoted.textContent = `“${attachment.selection.slice(0, 80)}”`;
    chip.append(quoted);
  }

  // Said out loud rather than left to be inferred. An answer about the first
  // half of a page is a different thing from an answer about the page, and
  // only this line distinguishes them.
  if (wasClipped(attachment)) {
    const clipped = document.createElement('span');
    clipped.className = 'clipped';
    const shown = Math.round((attachment.excerpt.length / attachment.fullLength) * 100);
    clipped.textContent = `first ${shown}% sent`;
    clipped.title =
      `The page is ${attachment.fullLength.toLocaleString()} characters; ` +
      `${attachment.excerpt.length.toLocaleString()} were sent. ` +
      'Raise the context budget in settings to send more.';
    chip.append(clipped);
  }

  return chip;
}

function turnId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
