/**
 * The tier-zero affordance: a small button at the end of a selection.
 *
 * It performs no work — no request, no page reflow, no covered text — so
 * ignoring it costs the reader nothing. That is the whole point: it says
 * help is available without deciding that help was wanted.
 */
const SIZE = 22;

const STYLE = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483645;
  contain: layout paint style;
}
button {
  width: ${SIZE}px; height: ${SIZE}px;
  display: grid; place-items: center;
  border-radius: 7px; cursor: pointer;
  border: 1px solid rgba(120, 120, 140, .35);
  background: #ffffff; color: #4f46e5;
  box-shadow: 0 2px 8px rgba(16, 16, 32, .18);
  font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  padding: 0;
}
button:hover { border-color: #4f46e5; }
button:focus-visible { outline: 2px solid #4f46e5; outline-offset: 1px; }
@media (prefers-color-scheme: dark) {
  button { background: #1f1f28; color: #a5a0ff; border-color: rgba(180, 180, 200, .28); }
  button:hover { border-color: #a5a0ff; }
}
`;

export class SelectionHandle {
  #host: HTMLElement | undefined;

  constructor(private readonly onActivate: () => void) {}

  #ensure(): void {
    if (this.#host) return;
    const host = document.createElement('quick-lookup-handle');
    host.style.display = 'none';
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;

    const button = document.createElement('button');
    button.textContent = '⌕';
    button.title = 'Look up this selection';
    button.setAttribute('aria-label', 'Look up this selection');
    // Preventing default on mousedown keeps the selection alive: a plain
    // click would otherwise collapse it before the handler runs.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onActivate();
    });

    root.append(style, button);
    document.documentElement.append(host);
    this.#host = host;
  }

  contains(node: Node | null): boolean {
    return Boolean(node && this.#host?.contains(node));
  }

  showAt(rect: DOMRect): void {
    this.#ensure();
    const host = this.#host;
    if (!host) return;
    const left = Math.min(Math.max(4, rect.right + 6), window.innerWidth - SIZE - 4);
    const top = Math.min(Math.max(4, rect.bottom + 4), window.innerHeight - SIZE - 4);
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
    host.style.display = 'block';
  }

  hide(): void {
    if (this.#host) this.#host.style.display = 'none';
  }

  destroy(): void {
    this.#host?.remove();
    this.#host = undefined;
  }
}
