const STORAGE_KEY = "cf_settings";

// --- tiny helpers that work in MV2+MV3
const getSync = (keys) =>
  new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (res) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(res);
    });
  });

const setSync = (obj) =>
  new Promise((resolve, reject) => {
    chrome.storage.sync.set(obj, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });

// --- DOM
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const enabledEl = $("#enabled");
const pixelRowEl = $("#pixelRow");
const pixelCellEl = $("#pixelCell");
const pixelCellVal = $("#pixelCellVal");
const saveBtn = $("#save");
const statusEl = $("#status");
const openPopupBtn = $("#openPopup");

// --- state normalize
function normalize(saved = {}) {
  return {
    names: Array.isArray(saved.names) ? saved.names : [],
    mode: saved.mode || "hide",
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : true,
    whitelist: Array.isArray(saved.whitelist) ? saved.whitelist : [],
    pixelCell: Number.isFinite(saved.pixelCell) ? saved.pixelCell : 15,
  };
}

// --- UI <-> storage
async function load() {
  try {
    const all = await getSync([STORAGE_KEY]); // returns { cf_settings: ... }
    const s = normalize(all[STORAGE_KEY]);

    // radios
    const radios = $$('input[name="mode"]');
    radios.forEach((r) => (r.checked = r.value === s.mode));

    // pixel
    pixelRowEl.style.display = s.mode === "pixelate" ? "" : "none";
    pixelCellEl.value = s.pixelCell;
    pixelCellVal.textContent = `${s.pixelCell}px`;

    // enabled
    enabledEl.checked = !!s.enabled;

    status("Loaded");
  } catch (err) {
    console.error("Options load failed:", err);
    status("Load failed");
  }
}

function collect() {
  const picked =
    $$('input[name="mode"]').find((r) => r.checked)?.value || "hide";
  const cell = parseInt(pixelCellEl.value, 10);
  return {
    mode: picked,
    enabled: enabledEl.checked,
    pixelCell: Number.isFinite(cell) ? cell : 15,
  };
}

async function save() {
  try {
    const all = await getSync([STORAGE_KEY]);
    const prev = normalize(all[STORAGE_KEY]);

    const partial = collect();
    const next = {
      ...prev,
      mode: partial.mode,
      enabled: partial.enabled,
      pixelCell: partial.pixelCell,
    };

    await setSync({ [STORAGE_KEY]: next });
    status("Saved");

    // ping active tab to rescan (if content script is there)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab?.id) return;
      try {
        chrome.tabs.sendMessage(tab.id, { type: "cf_rescan" }, () => void 0);
      } catch {}
    });
  } catch (err) {
    console.error("Options save failed:", err);
    status("Save failed");
  }
}

function status(msg) {
  statusEl.textContent = msg;
  setTimeout(() => (statusEl.textContent = ""), 1200);
}

// --- wiring
document.addEventListener("DOMContentLoaded", load);

document.addEventListener("change", (e) => {
  if (e.target?.name === "mode") {
    const val = e.target.value;
    pixelRowEl.style.display = val === "pixelate" ? "" : "none";
  }
});

pixelCellEl.addEventListener("input", () => {
  pixelCellVal.textContent = `${pixelCellEl.value}px`;
});

saveBtn.addEventListener("click", save);

openPopupBtn.addEventListener("click", async () => {
  try {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup();
    } else {
      alert("Click the ClarityFilter toolbar icon to open the popup.");
    }
  } catch {
    alert("Click the ClarityFilter toolbar icon to open the popup.");
  }
});

// reflect external changes (popup/content) into options UI
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" || area === "local") && changes[STORAGE_KEY]) {
    load();
  }
});
