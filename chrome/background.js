// background.js (Chrome MV3 service worker)
const STORAGE_KEY = "cf_settings";

// Use chrome.* for Chrome MV3
const api = chrome;

function normalize(s = {}) {
  return {
    names: Array.isArray(s.names) ? s.names : [],
    mode: s.mode || "hide",
    enabled: typeof s.enabled === "boolean" ? s.enabled : true,
    whitelist: Array.isArray(s.whitelist) ? s.whitelist : [],
    pixelCell: Number.isFinite(s.pixelCell) ? s.pixelCell : 15,
    pinEnabled: !!s.pinEnabled,
    pinHash: typeof s.pinHash === "string" ? s.pinHash : null,
    pinSalt: typeof s.pinSalt === "string" ? s.pinSalt : null,
    pinAlgo: typeof s.pinAlgo === "string" ? s.pinAlgo : null,
    pinIter: Number.isFinite(s.pinIter) ? s.pinIter : null,
  };
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(str)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getSettings() {
  const all = await api.storage.sync.get(STORAGE_KEY);
  return normalize(all[STORAGE_KEY] || {});
}

async function activeTabId() {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

// Ask the content script to handle the PIN prompt (nice UI path)
async function verifyViaContentScript(reason) {
  try {
    const id = await activeTabId();
    if (!id) return null; // no active tab
    const resp = await api.tabs.sendMessage(id, {
      type: "cf_require_pin",
      reason,
    });
    if (resp && typeof resp.ok === "boolean") return resp.ok;
    return null;
  } catch {
    return null; // no content script on this page, or message failed
  }
}

async function ensurePinAuthorized(reason, s) {
  if (!s.pinEnabled || !s.pinHash || !s.pinSalt) return true; // no PIN set

  // Only ask via content script; do NOT inject prompt into the page/iframes.
  const ok = await verifyViaContentScript(reason);
  // ok can be true/false/null; we only proceed when explicitly true
  return ok === true;
}

let toggling = false;

// Debug: prove background loaded
console.log("[ClarityFilter] background loaded");

api.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-filter" || toggling) return;
  toggling = true;

  try {
    // Read current settings
    const all0 = await api.storage.sync.get(STORAGE_KEY);
    const cur0 = normalize(all0[STORAGE_KEY] || {});

    // Check PIN authorization
    if (
      !(await ensurePinAuthorized(
        cur0.enabled ? "turn filtering OFF" : "turn filtering ON",
        cur0
      ))
    ) {
      return;
    }

    // Re-read settings after PIN check to prevent race conditions
    const all1 = await api.storage.sync.get(STORAGE_KEY);
    const cur1 = normalize(all1[STORAGE_KEY] || {});

    // Atomic toggle
    await api.storage.sync.set({
      [STORAGE_KEY]: { ...cur1, enabled: !cur1.enabled },
    });

    // Notify content script to rescan
    const tabId = await activeTabId();
    if (tabId) {
      try {
        await api.tabs.sendMessage(tabId, { type: "cf_rescan" });
      } catch {
        // Content script not available, that's okay
      }
    }
  } finally {
    toggling = false;
  }
});

// Optional: init defaults on first install
api.runtime.onInstalled.addListener(async () => {
  const all = await api.storage.sync.get(STORAGE_KEY);
  if (!all[STORAGE_KEY]) {
    await api.storage.sync.set({
      [STORAGE_KEY]: {
        names: [],
        mode: "hide",
        enabled: true,
        whitelist: [],
        pixelCell: 15,
        pinEnabled: false,
        pinHash: null,
        pinSalt: null,
      },
    });
    console.log("[ClarityFilter] initialized default settings");
  }
});
