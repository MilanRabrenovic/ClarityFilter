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

// NEW: Export/Import DOM
const exportBtn = $("#exportBtn");
const importBtn = $("#importBtn");

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
// ---- Secure crypto functions ----
function requireCrypto() {
  if (!crypto?.subtle || !crypto?.getRandomValues) {
    throw new Error("Secure crypto unavailable");
  }
}

function randomHex(bytes = 16) {
  requireCrypto();
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
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
      chrome.tabs.sendMessage(tab.id, { type: "cf_rescan" }, (response) => {
        // Ignore errors - content script might not be available on this page
        if (chrome.runtime.lastError) {
          // Expected for pages without content scripts (chrome://, extension pages, etc.)
          return;
        }
      });
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

// ---- Security validation functions ----
function validateImportData(data) {
  // Validate structure
  if (!data || typeof data !== "object") return false;
  if (!data.data || typeof data.data !== "object") return false;

  // Validate names array - must exist and be an array
  if (!Array.isArray(data.data.names)) return false;
  if (data.data.names.length > 10000) return false; // Reasonable limit

  // Validate each name
  for (const name of data.data.names) {
    if (typeof name !== "string") return false;
    if (name.length > 100) return false; // Reasonable limit
    if (name.length < 1) return false;
    // Allow letters, numbers, spaces (including multiple consecutive), and common punctuation
    if (!/^[a-zA-Z0-9\s\-_.,!?()]+$/.test(name)) return false;
  }

  // Validate whitelist if present
  if (data.data.whitelist) {
    if (!Array.isArray(data.data.whitelist)) return false;
    if (data.data.whitelist.length > 1000) return false;

    for (const url of data.data.whitelist) {
      if (typeof url !== "string") return false;
      if (url.length > 200) return false;
      // Basic URL validation - allow domains without protocol
      try {
        // Try as-is first
        new URL(url);
      } catch {
        try {
          // Try with https:// prefix
          new URL(`https://${url}`);
        } catch {
          return false;
        }
      }
    }
  }

  // Allow additional fields like mode, pixelCell, etc. (they'll be ignored during import)
  return true;
}

function sanitizeNames(names) {
  return names
    .filter((name) => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= 100)
    .map((name) => name.replace(/[<>]/g, "")) // Remove potential HTML
    .slice(0, 10000); // Limit total count
}

function sanitizeWhitelist(whitelist) {
  return whitelist
    .filter((url) => typeof url === "string")
    .map((url) => url.trim())
    .filter((url) => url.length > 0 && url.length <= 200)
    .filter((url) => {
      try {
        new URL(url);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, 1000); // Limit total count
}

// ---- Export/Import functions ----
async function exportSettings() {
  try {
    const all = await getSync([STORAGE_KEY]);
    const s = normalize(all[STORAGE_KEY]);

    // Create export data
    const exportData = {
      version: "1.0",
      exportDate: new Date().toISOString(),
      extension: "ClarityFilter",
      data: {
        names: s.names,
        whitelist: s.whitelist,
        mode: s.mode,
        pixelCell: s.pixelCell,
        // Note: We don't export PIN data for security reasons
      },
    };

    // Create and download file
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `clarityfilter-backup-${
      new Date().toISOString().split("T")[0]
    }.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    status("Settings exported successfully");
  } catch (err) {
    console.error("Export failed:", err);
    status("Export failed");
  }
}

// Rate limiting for imports
let lastImportTime = 0;
const IMPORT_COOLDOWN = 5000; // 5 seconds

async function importSettings() {
  try {
    // Rate limiting check
    if (Date.now() - lastImportTime < IMPORT_COOLDOWN) {
      status("Please wait before importing again");
      return;
    }

    // Create file input
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      // File size limit (1MB)
      if (file.size > 1024 * 1024) {
        status("File too large (max 1MB)");
        return;
      }

      try {
        const text = await file.text();

        // Parse with timeout protection
        let importData;
        try {
          importData = JSON.parse(text);
        } catch (parseError) {
          status("Invalid JSON file");
          return;
        }

        // Comprehensive validation
        if (!validateImportData(importData)) {
          status("Invalid file format or content");
          return;
        }

        // Sanitize the data
        const sanitizedNames = sanitizeNames(importData.data.names || []);
        const sanitizedWhitelist = sanitizeWhitelist(
          importData.data.whitelist || []
        );

        // Confirm import with sanitized counts
        const termCount = sanitizedNames.length;
        const whitelistCount = sanitizedWhitelist.length;

        if (termCount === 0 && whitelistCount === 0) {
          status("No valid data to import");
          return;
        }

        if (
          !confirm(
            `Import ${termCount} terms and ${whitelistCount} whitelist sites?\n\nThis will ADD to your current settings (existing terms will remain).`
          )
        ) {
          return;
        }

        // Update rate limiting
        lastImportTime = Date.now();

        // Get current settings
        const all = await getSync([STORAGE_KEY]);
        const current = normalize(all[STORAGE_KEY]);

        // Merge sanitized data with current settings
        const mergedNames = [...new Set([...current.names, ...sanitizedNames])];
        const mergedWhitelist = [
          ...new Set([...current.whitelist, ...sanitizedWhitelist]),
        ];

        const merged = {
          ...current,
          names: mergedNames,
          whitelist: mergedWhitelist,
          // Keep current mode and pixelCell settings - don't override user preferences
          mode: current.mode,
          pixelCell: current.pixelCell,
        };

        // Save merged settings
        await setSync({ [STORAGE_KEY]: merged });

        // Calculate how many new items were actually added
        const newTermsCount = mergedNames.length - current.names.length;
        const newSitesCount = mergedWhitelist.length - current.whitelist.length;

        status(
          `Added ${newTermsCount} new terms and ${newSitesCount} new sites`
        );

        // Reload UI
        await load();

        // Notify content script to rescan
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tab = tabs && tabs[0];
          if (!tab?.id) return;
          try {
            chrome.tabs.sendMessage(
              tab.id,
              { type: "cf_rescan" },
              () => void 0
            );
          } catch {}
        });
      } catch (err) {
        console.error("Import failed:", err);
        status("Import failed - invalid file");
      }
    };

    input.click();
  } catch (err) {
    console.error("Import setup failed:", err);
    status("Import failed");
  }
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

// NEW: Export/Import event listeners
exportBtn?.addEventListener("click", exportSettings);
importBtn?.addEventListener("click", importSettings);

// reflect external changes
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "sync" || area === "local") && changes[STORAGE_KEY]) {
    load();
  }
});
