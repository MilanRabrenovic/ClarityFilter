const STORAGE_KEY = "cf_settings";

// ---- storage helpers (MV2/MV3-safe) ----
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

// ---- DOM ----
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const enabledEl = $("#enabled");
const pixelRowEl = $("#pixelRow");
const pixelCellEl = $("#pixelCell");
const pixelCellVal = $("#pixelCellVal");
const saveBtn = $("#save");
const statusEl = $("#status");
const openPopupBtn = $("#openPopup");

// NEW: PIN DOM
const pinEnabledEl = $("#pinEnabled");
const setPinBtn = $("#setPinBtn");
const pinHintEl = $("#pinHint");

// ---- utils ----
function normalize(saved = {}) {
  return {
    names: Array.isArray(saved.names) ? saved.names : [],
    mode: saved.mode || "hide",
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : true,
    whitelist: Array.isArray(saved.whitelist) ? saved.whitelist : [],
    pixelCell: Number.isFinite(saved.pixelCell) ? saved.pixelCell : 15,

    // NEW
    pinEnabled: !!saved.pinEnabled,
    pinHash: typeof saved.pinHash === "string" ? saved.pinHash : null,
    pinSalt: typeof saved.pinSalt === "string" ? saved.pinSalt : null,
  };
}

function hasPin(s) {
  return !!(s.pinHash && s.pinSalt);
}
function validPinFormat(pin) {
  // 4–32 characters; you can tighten to digits-only if you want: /^[0-9]{4,12}$/.test(pin)
  return typeof pin === "string" && pin.length >= 4 && pin.length <= 32;
}
function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto?.getRandomValues?.(a) ?? a.fill(0);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(str) {
  try {
    const enc = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // Fallback (not cryptographically strong, but avoids hard errors on ancient builds)
    let h1 = 0,
      h2 = 0;
    for (let i = 0; i < str.length; i++) {
      h1 = (h1 * 31 + str.charCodeAt(i)) | 0;
      h2 = (h2 * 131 + str.charCodeAt(i)) | 0;
    }
    return (
      Math.abs(h1).toString(16).padStart(8, "0") +
      Math.abs(h2).toString(16).padStart(8, "0") +
      Math.abs(h1 ^ h2)
        .toString(16)
        .padStart(8, "0") +
      Math.abs(h1 + h2)
        .toString(16)
        .padStart(8, "0")
    );
  }
}
async function hashPin(pin, salt) {
  return sha256Hex(`${salt}:${pin}`);
}
async function verifyPinAgainstState(pin, s) {
  if (!hasPin(s)) return false;
  const h = await hashPin(pin, s.pinSalt);
  return h === s.pinHash;
}

function status(msg) {
  statusEl.textContent = msg;
  setTimeout(() => (statusEl.textContent = ""), 1200);
}

// ---- load UI ----
async function load() {
  try {
    const all = await getSync([STORAGE_KEY]);
    const s = normalize(all[STORAGE_KEY]);

    // radios
    const radios = $$('input[name="mode"]');
    radios.forEach((r) => (r.checked = r.value === s.mode));

    // pixel
    pixelRowEl.style.display = s.mode === "pixelate" ? "" : "none";
    pixelCellEl.value = s.pixelCell;
    pixelCellVal.textContent = `${s.pixelCell}px`;

    // enabled
    if (enabledEl) enabledEl.checked = !!s.enabled;

    // NEW: PIN UI
    if (pinEnabledEl) pinEnabledEl.checked = !!s.pinEnabled;
    if (setPinBtn) setPinBtn.textContent = hasPin(s) ? "Change PIN" : "Set PIN";
    if (pinHintEl) {
      pinHintEl.textContent = hasPin(s)
        ? s.pinEnabled
          ? "PIN set and protection enabled."
          : "PIN set (protection currently off)."
        : "No PIN set.";
    }

    status("Loaded");
  } catch (err) {
    console.error("Options load failed:", err);
    status("Load failed");
  }
}

// ---- collect/save general (mode/enabled/pixel) ----
function collectGeneral() {
  const picked =
    $$('input[name="mode"]').find((r) => r.checked)?.value || "hide";
  const cell = parseInt(pixelCellEl.value, 10);
  return {
    mode: picked,
    enabled: enabledEl?.checked ?? true,
    pixelCell: Number.isFinite(cell) ? cell : 15,
  };
}

async function saveGeneralOnly() {
  try {
    const all = await getSync([STORAGE_KEY]);
    const prev = normalize(all[STORAGE_KEY]);

    const partial = collectGeneral();
    const next = { ...prev, ...partial };

    await setSync({ [STORAGE_KEY]: next });
    status("Saved");

    // ping active tab so content script can rescan
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

// ---- PIN flows ----
async function enablePinFlow() {
  const all = await getSync([STORAGE_KEY]);
  const s = normalize(all[STORAGE_KEY]);

  if (hasPin(s)) {
    const guess = prompt("Enter PIN to enable protection:");
    if (guess == null) return false;
    const ok = await verifyPinAgainstState(guess, s);
    if (!ok) {
      status("Wrong PIN");
      return false;
    }
  } else {
    // No PIN yet -> set a new one (and enable)
    const p1 = prompt("Set new PIN (4–32 chars):");
    if (p1 == null || !validPinFormat(p1)) {
      status("Canceled");
      return false;
    }
    const p2 = prompt("Confirm new PIN:");
    if (p2 == null || p1 !== p2) {
      status("PINs didn’t match");
      return false;
    }
    const salt = randomHex(16);
    const pinHash = await hashPin(p1, salt);
    s.pinSalt = salt;
    s.pinHash = pinHash;
  }

  s.pinEnabled = true;
  await setSync({ [STORAGE_KEY]: s });
  status("PIN protection enabled");
  await load();
  return true;
}

async function disablePinFlow() {
  const all = await getSync([STORAGE_KEY]);
  const s = normalize(all[STORAGE_KEY]);

  const guess = prompt("Enter PIN to disable protection:");
  if (guess == null) return false;
  const ok = await verifyPinAgainstState(guess, s);
  if (!ok) {
    status("Wrong PIN");
    return false;
  }

  s.pinEnabled = false;
  await setSync({ [STORAGE_KEY]: s });
  status("PIN protection disabled");
  await load();
  return true;
}

async function setOrChangePinFlow() {
  const all = await getSync([STORAGE_KEY]);
  const s = normalize(all[STORAGE_KEY]);

  if (hasPin(s)) {
    const cur = prompt("Enter current PIN:");
    if (cur == null) return;
    const ok = await verifyPinAgainstState(cur, s);
    if (!ok) {
      status("Wrong PIN");
      return;
    }
  }

  const p1 = prompt("New PIN (4–32 chars):");
  if (p1 == null || !validPinFormat(p1)) {
    status("Canceled");
    return;
  }
  const p2 = prompt("Confirm new PIN:");
  if (p2 == null || p1 !== p2) {
    status("PINs didn’t match");
    return;
  }

  s.pinSalt = randomHex(16);
  s.pinHash = await hashPin(p1, s.pinSalt);

  await setSync({ [STORAGE_KEY]: s });
  status(hasPin(s) ? "PIN updated" : "PIN set");
  await load();
}

// ---- wire UI ----
document.addEventListener("DOMContentLoaded", load);

document.addEventListener("change", (e) => {
  if (e.target?.name === "mode") {
    const val = e.target.value;
    pixelRowEl.style.display = val === "pixelate" ? "" : "none";
  }
});

pixelCellEl?.addEventListener("input", () => {
  pixelCellVal.textContent = `${pixelCellEl.value}px`;
});

saveBtn?.addEventListener("click", saveGeneralOnly);

openPopupBtn?.addEventListener("click", async () => {
  try {
    if (chrome.action?.openPopup) await chrome.action.openPopup();
    else alert("Click the ClarityFilter toolbar icon to open the popup.");
  } catch {
    alert("Click the ClarityFilter toolbar icon to open the popup.");
  }
});

// NEW: pin toggle & set/change
pinEnabledEl?.addEventListener("change", async () => {
  if (pinEnabledEl.checked) {
    const ok = await enablePinFlow();
    if (!ok) pinEnabledEl.checked = false;
  } else {
    const ok = await disablePinFlow();
    if (!ok) pinEnabledEl.checked = true;
  }
});

setPinBtn?.addEventListener("click", setOrChangePinFlow);

// reflect external changes
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" || area === "local") && changes[STORAGE_KEY]) {
    load();
  }
});
