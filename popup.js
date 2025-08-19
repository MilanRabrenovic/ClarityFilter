// popup.js
const STORAGE_KEY = "cf_settings";
const LEGACY_KEYS = ["pcf_settings"]; // migrate old installs

const nameInput = document.getElementById("nameInput");
const addBtn = document.getElementById("addBtn");
const chipsEl = document.getElementById("chips");
const modeEl = document.getElementById("mode");
const statusEl = document.getElementById("status");

let names = [];

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

async function loadState() {
  await migrateIfNeeded();
  const [syncRes, localRes] = await Promise.all([
    getSync([STORAGE_KEY]),
    getLocal([STORAGE_KEY]),
  ]);
  const saved = syncRes[STORAGE_KEY] || localRes[STORAGE_KEY] || {};
  return {
    names: Array.isArray(saved.names) ? saved.names.slice(0, 200) : [],
    mode: saved.mode || "hide",
  };
}

async function saveState(state) {
  await Promise.allSettled([
    setSync({ [STORAGE_KEY]: state }),
    setLocal({ [STORAGE_KEY]: state }),
  ]);
}

// ------ UI ------
function renderChips() {
  chipsEl.innerHTML = "";
  names.forEach((n, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = n;

    const x = document.createElement("button");
    x.className = "x";
    x.setAttribute("aria-label", `Remove ${n}`);
    x.textContent = "×";
    x.addEventListener("click", async () => {
      names.splice(idx, 1);
      renderChips();
      await save(); // persist immediately
    });

    chip.appendChild(x);
    chipsEl.appendChild(chip);
  });
}

async function addName() {
  const raw = (nameInput.value || "").trim();
  if (!raw) return;
  if (!names.includes(raw)) {
    names.push(raw);
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
      statusEl.textContent = `Filtered: ${resp?.count ?? 0}`;
      setTimeout(() => (statusEl.textContent = ""), 1500);
    });
  });
}

async function load() {
  const state = await loadState();
  names = state.names;
  modeEl.value = state.mode;
  renderChips();
  rescanActiveTabAndShowCount();
}

async function save() {
  await saveState({ names, mode: modeEl.value });
  statusEl.textContent = "Saved";
  setTimeout(() => (statusEl.textContent = ""), 900);
  rescanActiveTabAndShowCount();
}

// events (no Save button!)
addBtn.addEventListener("click", addName);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addName();
  }
});
modeEl.addEventListener("change", () => save());

// init
document.addEventListener("DOMContentLoaded", () => {
  load();
});
