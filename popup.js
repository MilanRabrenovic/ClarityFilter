// popup.js
const STORAGE_KEY = "cf_settings";
const LEGACY_KEYS = ["pcf_settings"]; // migrate old installs

const nameInput = document.getElementById("nameInput");
const addBtn = document.getElementById("addBtn");
const addForm = document.getElementById("addForm"); // NEW
const chipsEl = document.getElementById("chips");
const modeEl = document.getElementById("mode");
const statusEl = document.getElementById("status");
const cfEnabled = document.getElementById("cfEnabled");

let state = { names: [], mode: "hide", enabled: true };

// ------ storage helpers ------
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

function normalize(saved) {
  return {
    names: Array.isArray(saved.names) ? saved.names.slice(0, 200) : [],
    mode: saved.mode || "hide",
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : true,
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

// ------ UI ------
function renderChips() {
  chipsEl.innerHTML = "";
  state.names.forEach((n, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = n;

    const x = document.createElement("button");
    x.className = "x";
    x.setAttribute("aria-label", `Remove ${n}`);
    x.textContent = "×";
    x.addEventListener("click", async () => {
      state.names.splice(idx, 1);
      renderChips();
      await save();
    });

    chip.appendChild(x);
    chipsEl.appendChild(chip);
  });
}

// NEW: robust add that clears input immediately and supports comma/semicolon lists
async function addNameImmediate() {
  const raw = (nameInput.value || "").trim();
  if (!raw) return;

  // Clear immediately for snappy UX (prevents async races)
  nameInput.value = "";
  // keep focus for rapid entry
  nameInput.focus();

  const parts = raw
    .split(/[;,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let changed = false;
  for (const p of parts) {
    if (p && !state.names.includes(p)) {
      state.names.push(p);
      changed = true;
    }
  }
  if (changed) {
    renderChips();
    await save();
  } else {
    // no-op, still show saved status briefly so user gets feedback
    statusEl.textContent = "No new terms";
    setTimeout(() => (statusEl.textContent = ""), 900);
  }
}

function rescanActiveTabAndShowCount() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab?.id) return;

    chrome.tabs.sendMessage(tab.id, { type: "cf_rescan" }, (resp) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Refresh the page";
        setTimeout(() => (statusEl.textContent = ""), 1500);
        return;
      }
      statusEl.textContent = state.enabled
        ? `Filtered: ${resp?.count ?? 0}`
        : "Paused";
      setTimeout(() => (statusEl.textContent = ""), 1500);
    });
  });
}

async function load() {
  state = await loadState();
  modeEl.value = state.mode;
  cfEnabled.checked = !!state.enabled;
  renderChips();
  rescanActiveTabAndShowCount();
}

async function save() {
  await saveState(state);
  statusEl.textContent = "Saved";
  setTimeout(() => (statusEl.textContent = ""), 900);
  rescanActiveTabAndShowCount();
}

// events
// CHANGED: handle both click and Enter via form submit
addForm.addEventListener("submit", (e) => {
  e.preventDefault();
  addNameImmediate();
});

// If you still want the button to work without a form submit (redundant but fine)
addBtn.addEventListener("click", (e) => {
  e.preventDefault();
  addNameImmediate();
});

// No need for a keydown listener now, submit covers Enter.
// mode & toggle stay the same
modeEl.addEventListener("change", async () => {
  state.mode = modeEl.value;
  await save();
});
cfEnabled.addEventListener("change", async () => {
  state.enabled = cfEnabled.checked;
  await save();
});

// init
document.addEventListener("DOMContentLoaded", () => {
  load();
});
