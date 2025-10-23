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

function sendMessageWithTimeout(tabId, msg, ms = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) resolve(null);
    }, ms);
    try {
      api.tabs.sendMessage(tabId, msg, (resp) => {
        done = true;
        clearTimeout(t);
        if (api.runtime.lastError) return resolve(null);
        resolve(resp ?? null);
      });
    } catch {
      done = true;
      clearTimeout(t);
      resolve(null);
    }
  });
}

async function promptPin(reason) {
  // Try content-script path first (best UX)
  const id = await activeTabId();
  if (id) {
    const resp = await sendMessageWithTimeout(
      id,
      { type: "cf_require_pin", reason },
      60_000
    );
    if (resp?.ok === true) return true;
  }

  // Fallback: inject content script to use custom PIN modal
  if (id) {
    try {
      // Inject content script if not already present
      await api.tabs.executeScript(id, {
        file: "content.js",
      });

      // Now try the PIN prompt again
      const resp = await sendMessageWithTimeout(
        id,
        { type: "cf_require_pin", reason },
        60_000
      );
      if (resp?.ok === true) return true;
    } catch (error) {

    }
  }

  // Final fallback: open popup (for chrome:// pages or other edge cases)
  try {
    await api.action.openPopup();
  } catch {}

  const resp2 = await new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) resolve(null);
    }, 60_000);
    api.runtime.sendMessage({ type: "cf_require_pin_popup", reason }, (r) => {
      done = true;
      clearTimeout(t);
      resolve(r);
    });
  });
  return resp2?.ok === true;
}

async function ensurePinAuthorized(reason, s) {
  if (!s.pinEnabled || !s.pinHash || !s.pinSalt) return true; // no PIN set
  return promptPin(reason);
}




let toggling = false;

api.commands.onCommand.addListener(async (command) => {

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
    
      return;
    }

    // Re-read settings after PIN check to prevent race conditions
    const all1 = await api.storage.sync.get(STORAGE_KEY);
    const current1 = normalize(all1[STORAGE_KEY]);

    // Atomic toggle
    const next = { ...current1, enabled: !current1.enabled };
    await api.storage.sync.set({ [STORAGE_KEY]: next });


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

  }
});
