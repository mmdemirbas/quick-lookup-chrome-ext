import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../shared/settings';

const app = document.getElementById('app')!;

function h(tag: string, attrs: Record<string, any> = {}, children: (Node | string)[] = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v; else if (k === 'for') e.setAttribute('for', v); else if (k in e) (e as any)[k] = v; else e.setAttribute(k, v);
    }
    for (const c of children) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
}

(async function init() {
    const s = await getSettings();
    render(s);
})();

function render(s: any) {
    app.innerHTML = '';

    const container = h('div', { class: 'container' });

    // Header
    const header = h('div', { class: 'page-header' }, [
        h('h1', {}, ['Quick Lookup — Settings']),
        h('p', { class: 'subtitle' }, ['Configure how Quick Lookup behaves on pages.'])
    ]);
    container.appendChild(header);

    // General settings card
    const generalCard = h('div', { class: 'card' }, [h('h2', {}, ['General'])]);

    // Trigger modifier
    const modId = 'modSel';
    const modSel = h('select', { id: modId, class: 'input', value: s.trigger.requireModifier }, [
        h('option', { value: 'none' }, ['None']),
        h('option', { value: 'Alt' }, ['Alt']),
        h('option', { value: 'Ctrl' }, ['Ctrl']),
        h('option', { value: 'Meta' }, ['Cmd/Meta'])
    ]);
    generalCard.appendChild(
        h('div', { class: 'form-row' }, [
            h('label', { class: 'label', for: modId }, ['Require modifier']),
            modSel,
            h('div', { class: 'hint' }, ['Choose if a keyboard modifier is required to trigger the lookup.'])
        ])
    );

    // Timeout
    const timeoutId = 'timeoutMs';
    const timeoutInput = h('input', { id: timeoutId, class: 'input', type: 'number', value: s.limits.timeoutMs, min: 300, max: 5000 });
    generalCard.appendChild(
        h('div', { class: 'form-row' }, [
            h('label', { class: 'label', for: timeoutId }, ['Timeout (ms)']),
            timeoutInput,
            h('div', { class: 'hint' }, ['How long to wait for providers before giving up.'])
        ])
    );

    // Cache TTL
    const cacheId = 'cacheTtlHrs';
    const cacheTtlInput = h('input', { id: cacheId, class: 'input', type: 'number', value: s.limits.cacheTtlHrs, min: 1, max: 168 });
    generalCard.appendChild(
        h('div', { class: 'form-row' }, [
            h('label', { class: 'label', for: cacheId }, ['Cache TTL (hours)']),
            cacheTtlInput,
            h('div', { class: 'hint' }, ['How long results are cached to speed up repeated queries.'])
        ])
    );

    const actions = h('div', { class: 'actions' });
    const saveBtn = h('button', { class: 'btn primary', id: 'saveBtn' }, ['Save']);
    actions.appendChild(saveBtn);
    generalCard.appendChild(actions);

    container.appendChild(generalCard);

    // Providers card
    const providersCard = h('div', { class: 'card' });
    providersCard.appendChild(h('h2', {}, ['Providers (Link templates)']));
    providersCard.appendChild(h('p', { class: 'subtitle' }, ['Customize quick links opened from the popup. Use {q} for the selected text and {lang} for the detected language.']));

    const list = h('div', { class: 'provider-list' });
    for (const item of s.providers.links.items) {
        const row = h('div', { class: 'provider-row' }, [
            h('input', { class: 'input', value: item.displayName, placeholder: 'Display name', oninput: (e: any) => (item.displayName = e.target.value) }),
            h('input', { class: 'input', value: item.template, placeholder: 'URL template (https://...)', oninput: (e: any) => (item.template = e.target.value) })
        ]);
        list.appendChild(row);
    }
    providersCard.appendChild(list);

    container.appendChild(providersCard);

    app.appendChild(container);

    // Save
    saveBtn.addEventListener('click', async () => {
        s.trigger.requireModifier = (modSel as HTMLSelectElement).value as any;
        s.limits.timeoutMs = Number((timeoutInput as HTMLInputElement).value);
        s.limits.cacheTtlHrs = Number((cacheTtlInput as HTMLInputElement).value);
        await saveSettings(s);
        const btn = document.getElementById('saveBtn');
        if (btn) { btn.textContent = 'Saved'; setTimeout(() => (btn.textContent = 'Save'), 900); }
    });
}