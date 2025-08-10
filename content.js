const STATE = {
    pinned: false,
    requireModifier: "none", // "none" | "Alt" | "Ctrl" | "Meta"
};

chrome.storage.sync.get({ trigger: { requireModifier: "none" } }, (s) => {
    STATE.requireModifier = s?.trigger?.requireModifier || "none";
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.trigger) {
        STATE.requireModifier = changes.trigger.newValue?.requireModifier || "none";
    }
});

// Popup creation (Shadow DOM)
let hostEl = null;
function ensurePopup() {
    if (hostEl) return hostEl;
    hostEl = document.createElement("div");
    hostEl.id = "__ql_popup_host__";
    hostEl.style.position = "fixed";
    hostEl.style.zIndex = "2147483647";
    hostEl.style.top = "20px";
    hostEl.style.left = "20px";
    hostEl.style.width = "360px";
    hostEl.style.boxSizing = "border-box";

    const shadow = hostEl.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
    :host { all: initial; }
    .card{ font: 13px/1.4 system-ui, sans-serif; color:#111; background:#fff;
      border:1px solid rgba(0,0,0,.12); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.15);
      overflow:hidden; }
    @media (prefers-color-scheme: dark){
      .card{ background:#1f1f1f; color:#eaeaea; border-color:#333; }
      .btn{ color:#eaeaea; }
      .link{ color:#9ecbff; }
    }
    .hdr{ display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:move; background:transparent; }
    .title{ font-weight:600; flex:1; }
    .btn{ background:none; border:none; cursor:pointer; font-size:12px; opacity:.8 }
    .btn:hover{ opacity:1 }
    .body{ padding:10px; display:flex; gap:10px; }
    .thumb{ width:68px; height:68px; object-fit:cover; border-radius:8px; flex:0 0 68px; background:#ddd }
    .text{ white-space:normal; }
    .footer{ padding:8px 10px; border-top:1px solid rgba(0,0,0,.1); display:flex; gap:10px; }
    .link{ text-decoration:none; font-size:12px; }
    .hidden{ display:none }
  `;
    const wrapper = document.createElement("div");
    wrapper.className = "card";
    wrapper.innerHTML = `
    <div class="hdr" id="ql-drag">
      <div class="title">Quick Lookup</div>
      <button class="btn" id="ql-pin" title="Pin/Unpin">📌</button>
      <button class="btn" id="ql-close" title="Close">✕</button>
    </div>
    <div class="body">
      <img class="thumb" id="ql-img" alt="">
      <div class="text">
        <div id="ql-heading" style="font-weight:600;margin-bottom:4px;"></div>
        <div id="ql-snippet"></div>
      </div>
    </div>
    <div class="footer">
      <a class="link" target="_blank" id="ql-wiki">Open Wikipedia</a>
    </div>
  `;
    shadow.appendChild(style);
    shadow.appendChild(wrapper);
    document.documentElement.appendChild(hostEl);

    // Close & Pin
    shadow.getElementById("ql-close").onclick = () => { if (!STATE.pinned) hidePopup(); };
    shadow.getElementById("ql-pin").onclick = () => { STATE.pinned = !STATE.pinned; };

    // Drag
    const drag = shadow.getElementById("ql-drag");
    let startX, startY, startTop, startLeft, dragging = false;
    const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        const top = Math.max(8, Math.min(window.innerHeight - 48, startTop + dy));
        const left = Math.max(8, Math.min(window.innerWidth - 48, startLeft + dx));
        hostEl.style.top = `${top}px`; hostEl.style.left = `${left}px`;
    };
    drag.addEventListener("mousedown", (e) => {
        dragging = true; startX = e.clientX; startY = e.clientY;
        startTop = parseInt(hostEl.style.top, 10); startLeft = parseInt(hostEl.style.left, 10);
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", () => { dragging = false; window.removeEventListener("mousemove", onMove); }, { once: true });
    });

    return hostEl;
}

function hidePopup() {
    if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
    hostEl = null;
}

function positionNearSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const top = Math.max(8, Math.min(window.innerHeight - 220, rect.bottom + 8));
    const left = Math.max(8, Math.min(window.innerWidth - 380, rect.left));
    const el = ensurePopup();
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
}

function currentSelectionText() {
    const sel = window.getSelection();
    return sel ? String(sel.toString()).trim() : "";
}

function modifierSatisfied(e) {
    switch (STATE.requireModifier) {
        case "Alt": return e.altKey;
        case "Ctrl": return e.ctrlKey;
        case "Meta": return e.metaKey;
        default: return true;
    }
}

let debounceTimer = null;
function handleLookup(text) {
    const langUI = navigator.language || "en";
    positionNearSelection();
    const shadow = ensurePopup().shadowRoot;

    // Loading UI
    shadow.getElementById("ql-heading").textContent = text.slice(0, 80);
    shadow.getElementById("ql-snippet").textContent = "Loading…";
    shadow.getElementById("ql-img").src = "";
    shadow.getElementById("ql-img").classList.add("hidden");
    shadow.getElementById("ql-wiki").href = "#";

    chrome.runtime.sendMessage({ type: "LOOKUP", text, langUI }, (resp) => {
        if (!resp?.ok) return;
        const r = resp.results[0];
        shadow.getElementById("ql-heading").textContent = r.title || text;
        shadow.getElementById("ql-snippet").textContent = r.snippet || "";
        if (r.imageUrl) {
            shadow.getElementById("ql-img").src = r.imageUrl;
            shadow.getElementById("ql-img").classList.remove("hidden");
        }
        if (r.url) shadow.getElementById("ql-wiki").href = r.url;
    });
}

// Auto-open on selection (your preferred default)
document.addEventListener("mouseup", (e) => {
    if (!modifierSatisfied(e)) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        const text = currentSelectionText();
        if (!text || text.length > 300) return;
        handleLookup(text);
    }, 150);
});

// From context menu
chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "OPEN_FOR_TEXT" && typeof msg.text === "string" && msg.text.trim()) {
        handleLookup(msg.text.trim());
    }
});

// Close on Esc if not pinned
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !STATE.pinned) hidePopup();
});
