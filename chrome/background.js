// background.js (Chrome MV3) - Minimal Working Implementation
const api = typeof browser !== "undefined" ? browser : chrome;
const STORAGE_KEY = "cf_settings";
const MENU_BLOCK_SELECTION = "cf_block_selection";
const MENU_BLOCK_IMAGE = "cf_block_image";

function canonicalImageUrl(u) {
  if (!u) return null;
  try {
    return new URL(u).href;
  } catch {
    return String(u);
  }
}

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
    blockedImages: Array.isArray(s.blockedImages)
      ? s.blockedImages
          .filter((u) => typeof u === "string" && u.length <= 500)
          .slice(0, 500)
      : [],
  };
}

async function activeTabId() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

function sendMessageWithTimeout(tabId, msg, ms = 20000, frameId = null) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) resolve(null);
    }, ms);
    try {
      api.tabs.sendMessage(tabId, msg, { frameId }, (resp) => {
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
  const id = await activeTabId();
  if (!id) return false;

  // Try main frame (0). If content script isn't there (e.g., chrome://), deny.
  const resp = await sendMessageWithTimeout(
    id,
    { type: "cf_require_pin", reason },
    30000,
    0 // top frame
  );
  return resp?.ok === true;
}

async function ensurePinAuthorized(reason, s) {
  if (!s.pinEnabled || !s.pinHash || !s.pinSalt) return true; // no PIN set
  return promptPin(reason);
}

// Global state
let isProcessingCommand = false;

// Command handler
api.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-filter") {
    return;
  }

  if (isProcessingCommand) {
    return;
  }

  isProcessingCommand = true;

  try {
    // Read current settings
    const all0 = await api.storage.sync.get(STORAGE_KEY);
    const current0 = normalize(all0[STORAGE_KEY] || {});

    // Check PIN authorization
    const reason = current0.enabled
      ? "turn filtering OFF"
      : "turn filtering ON";
    const allowed = await ensurePinAuthorized(reason, current0);
    if (!allowed) {
      return;
    }

    // Re-read settings after PIN check
    const all1 = await api.storage.sync.get(STORAGE_KEY);
    const current1 = normalize(all1[STORAGE_KEY] || {});

    // Toggle the setting
    const next = { ...current1, enabled: !current1.enabled };
    await api.storage.sync.set({ [STORAGE_KEY]: next });

    // Notify content script
    const id = await activeTabId();
    if (id) {
      try {
        await api.tabs.sendMessage(id, { type: "cf_rescan" });
      } catch (error) {
        // Ignore if no content script on that page yet
      }
    }
  } catch (error) {
    // Handle error silently
  } finally {
    isProcessingCommand = false;
  }
});

// Initialize default settings
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
        pinAlgo: "PBKDF2",
        pinIter: 150000,
        blockedImages: [],
      },
    });
  }
  setupContextMenus();
});

function setupContextMenus() {
  if (!api.contextMenus?.create) return;
  try {
    api.contextMenus.removeAll(() => {
      api.contextMenus.create({
        id: MENU_BLOCK_SELECTION,
        title: "Block this term",
        contexts: ["selection"],
      });
      api.contextMenus.create({
        id: MENU_BLOCK_IMAGE,
        title: "Block this image",
        contexts: ["image"],
      });
    });
  } catch {
    // ignore
  }
}

if (api.runtime?.onStartup?.addListener) {
  api.runtime.onStartup.addListener(setupContextMenus);
}

api.contextMenus?.onClicked?.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_BLOCK_SELECTION) {
    const raw = (info.selectionText || "").trim();
    if (!raw || raw.length > 100) return;
    await addBlockedTerm(raw, tab);
    return;
  }
  if (info.menuItemId === MENU_BLOCK_IMAGE) {
    const src = (info.srcUrl || "").trim();
    if (!src) return;
    await addBlockedImage(src, tab);
  }
});

async function addBlockedTerm(term, tab) {
  try {
    const all = await api.storage.sync.get(STORAGE_KEY);
    const current = normalize(all[STORAGE_KEY]);
    if (current.names.includes(term)) return;
    const next = { ...current, names: [...current.names, term] };
    await api.storage.sync.set({ [STORAGE_KEY]: next });
    await notifyTabRescan(tab, next);
  } catch {}
}

async function addBlockedImage(src, tab) {
  const normalizedSrc = canonicalImageUrl(src);
  if (!normalizedSrc) return;
  try {
    const all = await api.storage.sync.get(STORAGE_KEY);
    const current = normalize(all[STORAGE_KEY]);
    if (current.blockedImages.includes(normalizedSrc)) return;
    const next = {
      ...current,
      blockedImages: [...current.blockedImages, normalizedSrc].slice(-500),
    };
    await api.storage.sync.set({ [STORAGE_KEY]: next });
    await notifyTabRescan(tab, next);
  } catch {}
}

async function notifyTabRescan(tab, next) {
  if (!tab?.id) return;
  try {
    await api.tabs.sendMessage(tab.id, { type: "cf_rescan", next });
  } catch {}
}
