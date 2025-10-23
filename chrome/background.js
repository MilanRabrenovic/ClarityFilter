// background.js (Chrome MV3) - Minimal Working Implementation
const STORAGE_KEY = "cf_settings";

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

async function activeTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

async function getMainFrameId(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    // Find the main frame (frameId: 0)
    const mainFrame = frames.find((frame) => frame.frameId === 0);
    return mainFrame ? mainFrame.frameId : 0;
  } catch (error) {
    return 0; // Default to main frame
  }
}

function sendMessageWithTimeout(tabId, msg, ms = 20000, frameId = null) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) resolve(null);
    }, ms);
    try {
      chrome.tabs.sendMessage(tabId, msg, { frameId }, (resp) => {
        done = true;
        clearTimeout(t);
        if (chrome.runtime.lastError) return resolve(null);
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
  if (!id) {
    return false;
  }

  // Get the main frame ID to target only the main frame
  const mainFrameId = await getMainFrameId(id);

  try {
    // First, try to ping the content script in the main frame
    const pingResp = await sendMessageWithTimeout(
      id,
      { type: "cf_ping" },
      1000,
      mainFrameId
    );

    if (pingResp?.ok) {
      // Content script is loaded in main frame, request PIN
      const resp = await sendMessageWithTimeout(
        id,
        { type: "cf_require_pin", reason },
        30000,
        mainFrameId
      );
      return resp?.ok === true;
    } else {
      // Content script not loaded, inject it
      await chrome.scripting.executeScript({
        target: { tabId: id, frameIds: [mainFrameId] },
        files: ["content.js"],
      });

      // Wait for content script to initialize
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Now try PIN prompt in main frame
      const resp = await sendMessageWithTimeout(
        id,
        { type: "cf_require_pin", reason },
        30000,
        mainFrameId
      );
      return resp?.ok === true;
    }
  } catch (error) {
    return false;
  }
}

async function ensurePinAuthorized(reason, s) {
  if (!s.pinEnabled || !s.pinHash || !s.pinSalt) return true; // no PIN set
  return promptPin(reason);
}

// Global state
let isProcessingCommand = false;

// Command handler
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-filter") {
    return;
  }

  if (isProcessingCommand) {
    return;
  }

  isProcessingCommand = true;

  try {
    // Read current settings
    const all0 = await chrome.storage.sync.get(STORAGE_KEY);
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
    const all1 = await chrome.storage.sync.get(STORAGE_KEY);
    const current1 = normalize(all1[STORAGE_KEY] || {});

    // Toggle the setting
    const next = { ...current1, enabled: !current1.enabled };
    await chrome.storage.sync.set({ [STORAGE_KEY]: next });

    // Notify content script
    const id = await activeTabId();
    if (id) {
      try {
        await chrome.tabs.sendMessage(id, { type: "cf_rescan" });
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
chrome.runtime.onInstalled.addListener(async () => {
  const all = await chrome.storage.sync.get(STORAGE_KEY);
  if (!all[STORAGE_KEY]) {
    await chrome.storage.sync.set({
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
      },
    });
  }
});
