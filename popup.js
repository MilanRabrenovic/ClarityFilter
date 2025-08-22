// popup.js — global pause only
const STORAGE_KEY = "cf_settings";
const LEGACY_KEYS = ["pcf_settings"];

const nameInput = document.getElementById("nameInput");
const addBtn = document.getElementById("addBtn");
const chipsEl = document.getElementById("chips");
const modeEl = document.getElementById("mode");
const statusEl = document.getElementById("status");
const masterToggle = document.getElementById("masterToggle");

let state = { names: [], mode: "hide", enabled: true };

// storage helpers
const getSync = (k) => new Promise((res) => chrome.storage.sync.get(k, res));
const getLocal = (k) => new Promise((res) => chrome.storage.local.get(k, res));
const setSync = (o) => new Promise((res) => chrome.storage.sync.set(o, res));
const setLocal = (o) => new Promise((res) => chrome.storage.local.set(o, res));
const removeSync = (k) =>
  new Promise((res) => chrome.storage.sync.remove(k, res));

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
  const raw = Array.isArray(saved.names) ? saved.names : [];
  const names = raw
    .map((n) => (typeof n === "string" ? n : (n && n.text) || ""))
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    names,
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

// UI
function renderChips() {
  chipsEl.innerHTML = "";
  state.names.forEach((text, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = text;

    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.setAttribute("aria-label", `Remove ${text}`);
    x.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      state.names.splice(idx, 1);
      renderChips();
      await save();
    });

    chip.appendChild(x);
    chipsEl.appendChild(chip);
  });
}

async function addName() {
  const raw = (nameInput.value || "").trim();
  if (!raw) return;
  if (!state.names.includes(raw)) {
    state.names.push(raw);
    renderChips();
    await save();
  }
  nameInput.value = "";
  nameInput.focus();
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
  masterToggle.checked = !!state.enabled;
  modeEl.value = state.mode;
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
addBtn.addEventListener("click", addName);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addName();
  }
});
modeEl.addEventListener("change", async () => {
  state.mode = modeEl.value;
  await save();
});
masterToggle.addEventListener("change", async () => {
  state.enabled = masterToggle.checked;
  await save();
});

document.addEventListener("DOMContentLoaded", load);
