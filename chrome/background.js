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

let toggleLock = false;

// Debug: prove background loaded
console.log("[ClarityFilter] background loaded");

api.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-filter" || toggleLock) return;
  toggleLock = true;

  try {
    const tabId = await activeTabId();
    if (!tabId) return;

    // Delegate the entire toggle operation to the content script
    // This avoids service worker lifecycle issues with async PIN verification
    try {
      const response = await api.tabs.sendMessage(tabId, {
        type: "cf_toggle_filter",
      });
      if (!response?.success) {
        console.log("[ClarityFilter] Toggle failed or cancelled");
      }
    } catch {
      console.log("[ClarityFilter] No content script available for toggle");
    }
  } finally {
    toggleLock = false;
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
