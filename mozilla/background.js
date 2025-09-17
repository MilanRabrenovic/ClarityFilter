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

// Fallback: inject a simple prompt() in the page and verify here in background
async function verifyViaInjectedPrompt(reason, salt, expectedHash) {
  try {
    const id = await activeTabId();
    if (!id) return false;
    const [pin] = await api.tabs.executeScript(id, {
      code: `prompt(${JSON.stringify("Enter PIN to " + reason + ":")})`,
    });
    if (pin == null) return false;
    const hash = await sha256Hex(`${salt}|${pin}`);
    return hash === expectedHash;
  } catch {
    // Some pages disallow injection (addons store, internal pages, etc.)
    return false;
  }
}

async function ensurePinAuthorized(reason, s) {
  if (!s.pinEnabled || !s.pinHash || !s.pinSalt) return true; // no PIN set

  // 1) Try the content-script path first (your nice modal / prompt there)
  const ok = await verifyViaContentScript(reason);
  if (ok === true) return true;
  if (ok === false) return false;

  // 2) Fallback to injected page prompt (works even without content script)
  return await verifyViaInjectedPrompt(reason, s.pinSalt, s.pinHash);
}

// Debug: prove background loaded
console.log("[ClarityFilter] background loaded");

// Debug: show when commands are recognized
api.commands.onCommand.addListener(async (command) => {
  console.log("[ClarityFilter] command fired:", command);
  if (command !== "toggle-filter") return;

  const all = await api.storage.sync.get(STORAGE_KEY);
  const current = normalize(all[STORAGE_KEY]);

  // Gate with PIN if set
  const reason = current.enabled ? "turn filtering OFF" : "turn filtering ON";
  const allowed = await ensurePinAuthorized(reason, current);
  if (!allowed) {
    console.log(
      "[ClarityFilter] toggle cancelled: PIN required or verification failed"
    );
    return;
  }

  const next = { ...current, enabled: !current.enabled };
  await api.storage.sync.set({ [STORAGE_KEY]: next });
  console.log("[ClarityFilter] toggled enabled ->", next.enabled);

  // Ping active tab so content script rescans
  try {
    const id = await activeTabId();
    if (id) await api.tabs.sendMessage(id, { type: "cf_rescan" });
  } catch {
    // ignore if no content script on that page yet
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
