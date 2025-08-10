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
    app.appendChild(h('h2', {}, ['Quick Lookup — Settings']));

    // Trigger modifier
    const modSel = h('select', { value: s.trigger.requireModifier }, [
        h('option', { value: 'none' }, ['none']),
        h('option', { value: 'Alt' }, ['Alt']),
        h('option', { value: 'Ctrl' }, ['Ctrl']),
        h('option', { value: 'Meta' }, ['Cmd/Meta'])
    ]);

    const timeoutInput = h('input', { type: 'number', value: s.limits.timeoutMs, min: 300, max: 5000 });
    const cacheTtlInput = h('input', { type: 'number', value: s.limits.cacheTtlHrs, min: 1, max: 168 });

    const saveBtn = h('button', {}, ['Save']);
    saveBtn.addEventListener('click', async () => {
        s.trigger.requireModifier = (modSel as HTMLSelectElement).value as any;
        s.limits.timeoutMs = Number((timeoutInput as HTMLInputElement).value);
        s.limits.cacheTtlHrs = Number((cacheTtlInput as HTMLInputElement).value);
        await saveSettings(s);
        saveBtn.textContent = 'Saved'; setTimeout(() => (saveBtn.textContent = 'Save'), 800);
    });

    app.appendChild(h('div', {}, [h('label', {}, ['Require modifier: ']), modSel]));
    app.appendChild(h('div', {}, [h('label', {}, ['Timeout (ms): ']), timeoutInput]));
    app.appendChild(h('div', {}, [h('label', {}, ['Cache TTL (hours): ']), cacheTtlInput]));
    app.appendChild(saveBtn);

    app.appendChild(h('hr'));
    app.appendChild(h('h3', {}, ['Providers (Link templates)']));

    const list = h('div', {});
    for (const item of s.providers.links.items) {
        const row = h('div', {}, [
            h('input', { value: item.displayName, oninput: (e: any) => (item.displayName = e.target.value) }),
            h('input', { value: item.template, style: 'width:60%;', oninput: (e: any) => (item.template = e.target.value) })
        ]);
        list.appendChild(row);
    }
    app.appendChild(list);
}