// background.js (Chrome MV3 service worker)
const STORAGE_KEY = "cf_settings";

// Debug: prove background loaded (see chrome://extensions → your extension → Service worker)
console.log("[ClarityFilter] background (MV3) loaded");

function normalize(s = {}) {
  return {
    names: Array.isArray(s.names) ? s.names : [],
    mode: s.mode || "hide",
    enabled: typeof s.enabled === "boolean" ? s.enabled : true,
    whitelist: Array.isArray(s.whitelist) ? s.whitelist : [],
  };
}

// Toggle command
chrome.commands.onCommand.addListener(async (command) => {
  console.log("[ClarityFilter] command fired:", command);
  if (command !== "toggle-filter") return;

  const all = await chrome.storage.sync.get(STORAGE_KEY);
  const current = normalize(all[STORAGE_KEY]);
  const next = { ...current, enabled: !current.enabled };

  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  console.log("[ClarityFilter] toggled enabled ->", next.enabled);

  // Ping active tab so content script rescans
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: "cf_rescan" });
    }
  } catch (e) {
    // No content script on that page yet — ignore
  }
});

// Initialize defaults on first install
chrome.runtime.onInstalled.addListener(async () => {
  const all = await chrome.storage.sync.get(STORAGE_KEY);
  if (!all[STORAGE_KEY]) {
    await chrome.storage.sync.set({
      [STORAGE_KEY]: { names: [], mode: "hide", enabled: true, whitelist: [] },
    });
    console.log("[ClarityFilter] initialized default settings");
  }
});
