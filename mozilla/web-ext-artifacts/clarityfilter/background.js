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
  };
}

// Debug: prove background loaded
console.log("[ClarityFilter] background loaded");

// Debug: show when commands are recognized
api.commands.onCommand.addListener(async (command) => {
  console.log("[ClarityFilter] command fired:", command);
  if (command !== "toggle-filter") return;

  const all = await api.storage.sync.get(STORAGE_KEY);
  const current = normalize(all[STORAGE_KEY]);
  const next = { ...current, enabled: !current.enabled };

  await api.storage.sync.set({ [STORAGE_KEY]: next });
  console.log("[ClarityFilter] toggled enabled ->", next.enabled);

  // Ping active tab so content script rescans
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id)
      await api.tabs.sendMessage(tabs[0].id, { type: "cf_rescan" });
  } catch (e) {
    // ignore if no content script on that page yet
  }
});

// Optional: init defaults on first install
api.runtime.onInstalled.addListener(async () => {
  const all = await api.storage.sync.get(STORAGE_KEY);
  if (!all[STORAGE_KEY]) {
    await api.storage.sync.set({
      [STORAGE_KEY]: { names: [], mode: "hide", enabled: true, whitelist: [] },
    });
    console.log("[ClarityFilter] initialized default settings");
  }
});
