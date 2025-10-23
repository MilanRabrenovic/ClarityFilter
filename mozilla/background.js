// background.js (Firefox MV2)
const STORAGE_KEY = "cf_settings";

// Use browser.* if available (Firefox), else chrome.*
const api = typeof browser !== "undefined" ? browser : chrome;

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

async function activeTabId() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
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

// Debug: prove background loaded
console.log("[ClarityFilter] background loaded");

// Debug: show when commands are recognized
let toggling = false;

api.commands.onCommand.addListener(async (command) => {
  console.log("[ClarityFilter] command fired:", command);
  if (command !== "toggle-filter" || toggling) return;
  toggling = true;

  try {
    // Read current settings
    const all0 = await api.storage.sync.get(STORAGE_KEY);
    const current0 = normalize(all0[STORAGE_KEY]);

    // Gate with PIN if set
    const reason = current0.enabled
      ? "turn filtering OFF"
      : "turn filtering ON";
    const allowed = await ensurePinAuthorized(reason, current0);
    if (!allowed) {
      console.log(
        "[ClarityFilter] toggle cancelled: PIN required or verification failed"
      );
      return;
    }

    // Re-read settings after PIN check to prevent race conditions
    const all1 = await api.storage.sync.get(STORAGE_KEY);
    const current1 = normalize(all1[STORAGE_KEY]);

    // Atomic toggle
    const next = { ...current1, enabled: !current1.enabled };
    await api.storage.sync.set({ [STORAGE_KEY]: next });
    console.log("[ClarityFilter] toggled enabled ->", next.enabled);

    // Ping active tab so content script rescans
    try {
      const id = await activeTabId();
      if (id) await api.tabs.sendMessage(id, { type: "cf_rescan" });
    } catch {
      // ignore if no content script on that page yet
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
