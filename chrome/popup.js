// ClarityFilter - popup (virtualized lists for terms + whitelist) — RAY-CAST DELETE

const STORAGE_KEY = "cf_settings";
const LEGACY_KEYS = ["pcf_settings"];

// ---------- DOM refs (terms) ----------
const nameInput = document.getElementById("nameInput");
const addBtn = document.getElementById("addBtn");
const addForm = document.getElementById("addForm");
const modeEl = document.getElementById("mode");
const statusEl = document.getElementById("status");
const cfEnabled = document.getElementById("cfEnabled");
const listViewport = document.getElementById("listViewport");
const vlistSpacer = document.getElementById("vlistSpacer");
const vlistInner = document.getElementById("vlistInner");
const termCountEl = document.getElementById("termCount");
const bulkClearBtn = document.getElementById("bulkClear");

// ---------- DOM refs (whitelist) ----------
const wlInput = document.getElementById("wlInput");
const wlAddBtn = document.getElementById("wlAddBtn");
const wlForm = document.getElementById("wlForm");
const wlViewport = document.getElementById("wlViewport");
const wlSpacer = document.getElementById("wlSpacer");
const wlInner = document.getElementById("wlInner");
const wlCountEl = document.getElementById("wlCount");
const wlClearBtn = document.getElementById("wlClearBtn");

// ---------- State ----------
let state = {
  names: [],
  mode: "hide",
  enabled: true,
  whitelist: [],
  pinEnabled: false,
  pinHash: null,
  pinSalt: null,
};

// ---------- Virtualization ----------
const ITEM_HEIGHT = 28; // must match CSS .vlist-row height
const OVERSCAN = 6;

const vlist = { data: [], scrollTop: 0, viewportH: 0 }; // for terms
const wlist = { data: [], scrollTop: 0, viewportH: 0 }; // for whitelist

// ---------- storage helpers ----------
const getSync = (keys) =>
  new Promise((res) => chrome.storage.sync.get(keys, res));
const getLocal = (keys) =>
  new Promise((res) => chrome.storage.local.get(keys, res));
const setSync = (obj) =>
  new Promise((res) => chrome.storage.sync.set(obj, res));
const setLocal = (obj) =>
  new Promise((res) => chrome.storage.local.set(obj, res));
const removeSync = (keys) =>
  new Promise((res) => chrome.storage.sync.remove(keys, res));

async function migrateIfNeeded() {
  const syncAll = await getSync(null);
  if (!syncAll[STORAGE_KEY]) {
    for (const k of LEGACY_KEYS) {
      if (syncAll[k]) {
        await setSync({ [STORAGE_KEY]: syncAll[k] });
        await removeSync(k);
        break;
      }
    }
  }
}

function toHost(value) {
  if (!value) return null;
  let v = String(value).trim().toLowerCase();
  // strip leading dots and trailing slashes early to avoid edge mismatches
  v = v.replace(/^\.+/, "").replace(/\/+$/, "");
  try {
    const u = new URL(v.includes("://") ? v : `https://${v}`);
    return (u.hostname || "").toLowerCase();
  } catch {
    return v
      .replace(/^[a-z]+:\/\//, "")
      .split("/")[0]
      .toLowerCase();
  }
}

// --- PIN helpers (popup) ---
function hasPinLocal() {
  return !!(state.pinHash && state.pinSalt);
}
// ---- Secure crypto functions ----
function requireCrypto() {
  if (!crypto?.subtle || !crypto?.getRandomValues) {
    throw new Error("Secure crypto unavailable");
  }
}

async function sha256Hex(str) {
  requireCrypto();
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(str)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function verifyPinInput() {
  if (!state.pinEnabled || !hasPinLocal()) return true; // not required
  const guess = prompt("Enter PIN:");
  if (guess == null) return false;
  const h = await sha256Hex(`${state.pinSalt}:${guess}`);
  const ok = h === state.pinHash;
  if (!ok) setStatus("Wrong PIN", 1200);
  return ok;
}

async function requirePinFromActiveTab(reason = "change settings") {
  // Ask the active tab’s content script to prompt for PIN.
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab?.id) return resolve(false);
      try {
        chrome.tabs.sendMessage(
          tab.id,
          { type: "cf_require_pin", reason },
          (resp) => resolve(!!resp?.ok)
        );
      } catch {
        resolve(false);
      }
    });
  });
}

function normalize(saved) {
  return {
    names: Array.isArray(saved.names) ? saved.names.slice(0, 200) : [],
    mode: saved.mode || "hide",
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : true,
    whitelist: Array.isArray(saved.whitelist)
      ? saved.whitelist.slice(0, 200)
      : [],
    // NEW:
    pinEnabled: !!saved.pinEnabled,
    pinHash: typeof saved.pinHash === "string" ? saved.pinHash : null,
    pinSalt: typeof saved.pinSalt === "string" ? saved.pinSalt : null,
  };
}

async function loadState() {
  await migrateIfNeeded();
  const [syncRes, localRes] = await Promise.all([
    getSync([STORAGE_KEY]),
    getLocal([STORAGE_KEY]),
  ]);
  return normalize(syncRes[STORAGE_KEY] || localRes[STORAGE_KEY] || {});
}

async function saveState(s) {
  await Promise.allSettled([
    setSync({ [STORAGE_KEY]: s }),
    setLocal({ [STORAGE_KEY]: s }),
  ]);
}

// ---------- UI helpers ----------
function updateTermCount() {
  const n = state.names.length;
  termCountEl.textContent = n
    ? `${n} term${n === 1 ? "" : "s"}`
    : "No terms yet";
}
function updateWLCount() {
  const n = state.whitelist.length;
  wlCountEl.textContent = n ? `${n} site${n === 1 ? "" : "s"}` : "No sites yet";
}

function setStatus(msg, ms = 900) {
  statusEl.textContent = msg;
  if (ms > 0) setTimeout(() => (statusEl.textContent = ""), ms);
}

function rescanActiveTabAndShowCount() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "cf_rescan" }, (resp) => {
      if (chrome.runtime.lastError) {
        setStatus("Refresh the page", 1500);
        return;
      }
      // Optionally show filtered count or whitelisted host in status
      // if (resp?.whitelisted) setStatus(`Whitelisted: ${resp.host}`, 1200);
    });
  });
}

// Ensure hit-testing is sane even if CSS didn’t load as expected
function ensureHitTest(elViewport, elSpacer, elInner) {
  elViewport.style.position = "relative";
  elViewport.style.overflow = "auto";
  elSpacer.style.pointerEvents = "none";
  elInner.style.position = "absolute";
  elInner.style.top = "0";
  elInner.style.left = "0";
  elInner.style.right = "0";
  elInner.style.zIndex = "2";
  elInner.style.pointerEvents = "auto";
}

// ---------- Virtualized list renderers (TERMS) ----------
function vlistSetData(arr) {
  vlist.data = Array.isArray(arr) ? arr : [];
  vlistSpacer.style.height = `${vlist.data.length * ITEM_HEIGHT}px`;
  vlistRender();
}
function vlistRender() {
  const total = vlist.data.length;
  vlist.scrollTop = listViewport.scrollTop;
  vlist.viewportH = listViewport.clientHeight;

  const startIndex = Math.max(
    0,
    Math.floor(vlist.scrollTop / ITEM_HEIGHT) - OVERSCAN
  );
  const visibleCount = Math.ceil(vlist.viewportH / ITEM_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(total, startIndex + visibleCount);
  const offsetY = startIndex * ITEM_HEIGHT;

  vlistInner.style.transform = `translateY(${offsetY}px)`;

  const frag = document.createDocumentFragment();
  for (let i = startIndex; i < endIndex; i++) {
    const term = vlist.data[i] ?? "";

    const row = document.createElement("div");
    row.className = "vlist-row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-label", term);

    const span = document.createElement("span");
    span.className = "vlist-term";
    span.title = term;
    span.textContent = term;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row-del vlist-del";
    btn.dataset.index = String(i);
    btn.title = `Remove ${term}`;
    btn.setAttribute("aria-label", `Remove ${term}`);
    btn.textContent = "×"; // safe, not HTML

    row.append(span, btn);
    frag.appendChild(row);
  }

  vlistInner.replaceChildren(frag);
}

// ---------- Virtualized list renderers (WHITELIST) ----------
function wlistSetData(arr) {
  wlist.data = Array.isArray(arr) ? arr : [];
  wlSpacer.style.height = `${wlist.data.length * ITEM_HEIGHT}px`;
  wlistRender();
}

function wlistRender() {
  const total = wlist.data.length;
  wlist.scrollTop = wlViewport.scrollTop;
  wlist.viewportH = wlViewport.clientHeight;

  const startIndex = Math.max(
    0,
    Math.floor(wlist.scrollTop / ITEM_HEIGHT) - OVERSCAN
  );
  const visibleCount = Math.ceil(wlist.viewportH / ITEM_HEIGHT) + OVERSCAN * 2;
  const endIndex = Math.min(total, startIndex + visibleCount);
  const offsetY = startIndex * ITEM_HEIGHT;

  // position the inner window
  wlInner.style.transform = `translateY(${offsetY}px)`;

  // build rows safely (no innerHTML)
  const frag = document.createDocumentFragment();
  for (let i = startIndex; i < endIndex; i++) {
    const host = wlist.data[i] ?? "";

    const row = document.createElement("div");
    row.className = "vlist-row";
    row.setAttribute("role", "option");
    row.setAttribute("aria-label", host);

    const span = document.createElement("span");
    span.className = "vlist-term";
    span.title = host;
    span.textContent = host;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "row-del wl-del";
    btn.dataset.index = String(i);
    btn.title = `Remove ${host}`;
    btn.setAttribute("aria-label", `Remove ${host}`);
    btn.textContent = "×";

    row.append(span, btn);
    frag.appendChild(row);
  }

  wlInner.replaceChildren(frag);
}

// ---------- Scroll/resize ----------
listViewport.addEventListener("scroll", vlistRender);
wlViewport.addEventListener("scroll", wlistRender);
window.addEventListener("resize", () => {
  vlistRender();
  wlistRender();
});

// ---------- Ray-cast helpers ----------
function hitTestButton(selector, clientX, clientY) {
  const stack = document.elementsFromPoint(clientX, clientY) || [];
  for (const el of stack) {
    if (el && el.matches?.(selector)) return el;
  }
  return null;
}

// ---------- Delete (TERMS) ----------
async function removeTermByIndex(idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= state.names.length) {
    setStatus("Bad index", 900);
    return;
  }
  if (!(await verifyPinInput())) return;

  state.names.splice(idx, 1);
  updateTermCount();
  await save();
  vlistSetData(state.names);
  setStatus("Removed", 700);
}

vlistInner.addEventListener(
  "pointerdown",
  (e) => {
    const btn =
      hitTestButton("button.vlist-del", e.clientX, e.clientY) ||
      (e.target instanceof Element
        ? e.target.closest("button.vlist-del")
        : null);
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = parseInt(btn.getAttribute("data-index"), 10);
    removeTermByIndex(idx);
  },
  { capture: true }
);

// ---------- Delete (WHITELIST) ----------
async function removeWLByIndex(idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= state.whitelist.length) {
    setStatus("Bad index", 900);
    return;
  }
  if (!(await verifyPinInput())) return;

  state.whitelist.splice(idx, 1);
  updateWLCount();
  await save();
  wlistSetData(state.whitelist);
  setStatus("Removed", 700);
}

wlInner.addEventListener(
  "pointerdown",
  (e) => {
    const btn =
      hitTestButton("button.wl-del", e.clientX, e.clientY) ||
      (e.target instanceof Element ? e.target.closest("button.wl-del") : null);
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const idx = parseInt(btn.getAttribute("data-index"), 10);
    removeWLByIndex(idx);
  },
  { capture: true }
);

// ---------- Clear all ----------
bulkClearBtn.addEventListener("click", async () => {
  if (!state.names.length) return;

  const all = await getSync([STORAGE_KEY]);
  const s = all[STORAGE_KEY] || {};
  if (s.pinEnabled && s.pinHash && s.pinSalt) {
    const ok = await requirePinFromActiveTab("clear all blocked terms");
    if (!ok) {
      setStatus("PIN required", 1200);
      return;
    }
  }

  if (!confirm("Remove all terms?")) return;
  state.names = [];
  updateTermCount();
  await save();
  vlistSetData(state.names);
  setStatus("Cleared", 900);
});

wlClearBtn.addEventListener("click", async () => {
  if (!state.whitelist.length) return;
  if (!confirm("Remove all sites from whitelist?")) return;
  state.whitelist = [];
  updateWLCount();
  await save();
  wlistSetData(state.whitelist);
  setStatus("Cleared", 900);
});

// ---------- Add items ----------
async function addNameImmediate() {
  const raw = (nameInput.value || "").trim();
  if (!raw) return;
  nameInput.value = "";
  nameInput.focus();
  const parts = raw
    .split(/[;,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let changed = false;
  for (const p of parts) {
    const term = p.normalize("NFC");
    if (term && !state.names.includes(term)) {
      state.names.push(term);
      changed = true;
    }
  }
  if (changed) {
    updateTermCount();
    await save();
    vlistSetData(state.names);
    setStatus("Added", 700);
  } else setStatus("No new terms", 900);
}

async function addWLImmediate() {
  const raw = (wlInput.value || "").trim();
  if (!raw) return;
  wlInput.value = "";
  wlInput.focus();

  const all = await getSync([STORAGE_KEY]);
  const s = all[STORAGE_KEY] || {};
  if (s.pinEnabled && s.pinHash && s.pinSalt) {
    const ok = await verifyPinInput();
    if (!ok) {
      setStatus("PIN required", 1200);
      return;
    }
  }

  const host = toHost(raw); // <— use the same logic
  if (!host) {
    setStatus("Invalid site", 900);
    return;
  }

  if (!state.whitelist.includes(host)) {
    state.whitelist.push(host);
    updateWLCount();
    await save();
    wlistSetData(state.whitelist);
    setStatus(`Whitelisted: ${host}`, 900);
    rescanActiveTabAndShowCount(); // will clear page effects
  } else {
    setStatus("Already whitelisted", 900);
  }
}

// ---------- Load/save wrappers ----------
async function load() {
  // hit-test sanity for both lists
  ensureHitTest(listViewport, vlistSpacer, vlistInner);
  ensureHitTest(wlViewport, wlSpacer, wlInner);

  state = await loadState();
  modeEl.value = state.mode;
  cfEnabled.checked = !!state.enabled;

  updateTermCount();
  updateWLCount();

  vlistSetData(state.names);
  wlistSetData(state.whitelist);

  rescanActiveTabAndShowCount();
}
async function save() {
  await saveState(state);
  setStatus("Saved", 700);
  rescanActiveTabAndShowCount();
}

// ---------- Events ----------
addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  addNameImmediate();
});
addBtn.addEventListener("click", (e) => {
  e.preventDefault();
  addNameImmediate();
});

wlForm.addEventListener("submit", (e) => {
  e.preventDefault();
  addWLImmediate();
});
wlAddBtn.addEventListener("click", (e) => {
  e.preventDefault();
  addWLImmediate();
});

modeEl.addEventListener("change", async () => {
  state.mode = modeEl.value;
  await save();
});

document.addEventListener("keydown", async (e) => {
  const t = e.target;
  const tag = (t && t.tagName) || "";
  const isTyping =
    tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable;
  if (isTyping) return;

  if (e.altKey && e.shiftKey && e.code === "KeyF" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();

    const nextEnabled = !cfEnabled.checked;

    const all = await getSync([STORAGE_KEY]);
    const s = all[STORAGE_KEY] || {};
    if (s.pinEnabled && s.pinHash && s.pinSalt) {
      const ok = await requirePinFromActiveTab(
        nextEnabled ? "turn filtering ON" : "turn filtering OFF"
      );
      if (!ok) {
        setStatus("PIN required", 1200);
        return;
      }
    }

    cfEnabled.checked = nextEnabled;
    state.enabled = nextEnabled;
    await save();
    setStatus(
      nextEnabled ? "Filtering ON (shortcut)" : "Filtering OFF (shortcut)",
      1200
    );
  }
});

const openOptionsPageBtn = document.getElementById("openOptionsPage");
openOptionsPageBtn?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

cfEnabled.addEventListener("change", async () => {
  const wantsEnabled = cfEnabled.checked;

  const all = await getSync([STORAGE_KEY]);
  const s = all[STORAGE_KEY] || {};
  if (s.pinEnabled && s.pinHash && s.pinSalt) {
    const ok = await verifyPinInput(); // prompt INSIDE popup
    if (!ok) {
      cfEnabled.checked = !wantsEnabled;
      setStatus("PIN required", 1200);
      return;
    }
  }

  state.enabled = wantsEnabled;
  await save();
});

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", () => {
  load();
});
