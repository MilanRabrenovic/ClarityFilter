// background.js (Chrome MV3 service worker)
const STORAGE_KEY = "cf_settings";

console.log("[ClarityFilter] background (MV3) loaded");

function normalize(s = {}) {
  return {
    names: Array.isArray(s.names) ? s.names : [],
    mode: s.mode || "hide",
    enabled: typeof s.enabled === "boolean" ? s.enabled : true,
    whitelist: Array.isArray(s.whitelist) ? s.whitelist : [],
  };
}

// Toggle via command (Alt+Shift+F by default)
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-filter") return;

  const all = await chrome.storage.sync.get(STORAGE_KEY);
  const current = normalize(all[STORAGE_KEY]);
  const next = { ...current, enabled: !current.enabled };

  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  console.log("[ClarityFilter] toggled enabled ->", next.enabled);

  // No tabs.query / sendMessage needed — content scripts rescan on storage change.
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
