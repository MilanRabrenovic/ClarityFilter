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
    console.log("[ClarityFilter] Could not get frames, using default:", error);
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
  console.log("[ClarityFilter] Starting PIN prompt for:", reason);

  const id = await activeTabId();
  if (!id) {
    console.log("[ClarityFilter] No active tab found");
    return false;
  }

  // Get the main frame ID to target only the main frame
  const mainFrameId = await getMainFrameId(id);
  console.log("[ClarityFilter] Targeting main frame:", mainFrameId);

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
      console.log(
        "[ClarityFilter] Content script loaded in main frame, requesting PIN..."
      );
      const resp = await sendMessageWithTimeout(
        id,
        { type: "cf_require_pin", reason },
        30000,
        mainFrameId
      );
      console.log("[ClarityFilter] PIN response:", resp);
      return resp?.ok === true;
    } else {
      // Content script not loaded, inject it
      console.log("[ClarityFilter] Injecting content script...");
      await chrome.scripting.executeScript({
        target: { tabId: id, frameIds: [mainFrameId] },
        files: ["content.js"],
      });

      // Wait for content script to initialize
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Now try PIN prompt in main frame
      console.log("[ClarityFilter] Requesting PIN after injection...");
      const resp = await sendMessageWithTimeout(
        id,
        { type: "cf_require_pin", reason },
        30000,
        mainFrameId
      );
      console.log("[ClarityFilter] PIN response after injection:", resp);
      return resp?.ok === true;
    }
  } catch (error) {
    console.log("[ClarityFilter] PIN prompt error:", error);
    return false;
  }
}

async function ensurePinAuthorized(reason, s) {
  if (!s.pinEnabled || !s.pinHash || !s.pinSalt) return true; // no PIN set
  return promptPin(reason);
}

// Global state
let isProcessingCommand = false;

// Service worker startup
console.log("[ClarityFilter] ===== SERVICE WORKER STARTED =====");

// Command handler
chrome.commands.onCommand.addListener(async (command) => {
  console.log("[ClarityFilter] ===== COMMAND RECEIVED =====");
  console.log("[ClarityFilter] Command:", command);
  console.log("[ClarityFilter] Time:", new Date().toISOString());

  if (command !== "toggle-filter") {
    console.log("[ClarityFilter] Ignoring non-toggle command");
    return;
  }

  if (isProcessingCommand) {
    console.log("[ClarityFilter] Already processing command, ignoring");
    return;
  }

  isProcessingCommand = true;
  console.log("[ClarityFilter] Starting toggle process");

  try {
    // Read current settings
    const all0 = await chrome.storage.sync.get(STORAGE_KEY);
    const current0 = normalize(all0[STORAGE_KEY] || {});
    console.log("[ClarityFilter] Current settings:", current0);

    // Check PIN authorization
    const reason = current0.enabled
      ? "turn filtering OFF"
      : "turn filtering ON";
    const allowed = await ensurePinAuthorized(reason, current0);
    if (!allowed) {
      console.log(
        "[ClarityFilter] PIN authorization failed, cancelling toggle"
      );
      return;
    }
    console.log("[ClarityFilter] PIN authorization successful");

    // Re-read settings after PIN check
    const all1 = await chrome.storage.sync.get(STORAGE_KEY);
    const current1 = normalize(all1[STORAGE_KEY] || {});

    // Toggle the setting
    const next = { ...current1, enabled: !current1.enabled };
    await chrome.storage.sync.set({ [STORAGE_KEY]: next });
    console.log("[ClarityFilter] Toggled enabled to:", next.enabled);

    // Notify content script
    const id = await activeTabId();
    if (id) {
      try {
        await chrome.tabs.sendMessage(id, { type: "cf_rescan" });
        console.log("[ClarityFilter] Notified content script");
      } catch (error) {
        console.log("[ClarityFilter] Could not notify content script:", error);
      }
    } else {
      console.log("[ClarityFilter] No active tab to notify");
    }
  } catch (error) {
    console.log("[ClarityFilter] Error in command handler:", error);
  } finally {
    isProcessingCommand = false;
    console.log("[ClarityFilter] Toggle process completed");
  }
});

// Initialize default settings
chrome.runtime.onInstalled.addListener(async () => {
  console.log("[ClarityFilter] Extension installed/updated");

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
      },
    });
    console.log("[ClarityFilter] Initialized default settings");
  }
});

console.log("[ClarityFilter] Background script loaded successfully");
