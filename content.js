// ClarityFilter - content script (Manifest V3)
// ------------------------------------------------

let lastScanBlockedCount = 0;
const STORAGE_KEY = "cf_settings";
let settings = { names: [], mode: "hide" }; // 'hide' | 'blur' | 'replace'
let nameRegex = null;
let observer = null;

// Toggle to see one alert per match while debugging
const DEBUG_ALERT = false;

// -------------------- Style --------------------
const STYLE_ID = "cf-style";
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .cf-blur { filter: blur(10px) !important; }
    .cf-hidden { display: none !important; }
  `;
  document.documentElement.appendChild(style);
}

// -------------------- Utils --------------------
function debounce(fn, wait = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// Unicode-aware regex; allow short case endings (e.g., "Vučiću")
function buildRegex(names) {
  const cleaned = names
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => n.normalize("NFC"))
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!cleaned.length) return null;

  const core = `(?:${cleaned.join("|")})(?:[\\p{L}]{0,4})?`;
  try {
    return new RegExp(`(?<![\\p{L}\\p{N}_])${core}(?![\\p{L}\\p{N}_])`, "iu");
  } catch {
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${core}($|[^\\p{L}\\p{N}_])`, "iu");
  }
}

function elementMatchesText(text) {
  if (!nameRegex) return false;
  return nameRegex.test((text || "").normalize("NFC"));
}

function shouldTarget(el) {
  if (!el || !el.classList) return true;
  return (
    !el.classList.contains("cf-blur") && !el.classList.contains("cf-hidden")
  );
}

// -------------------- Heuristics --------------------
// Split className to lowercase tokens (handles hyphens/underscores etc.)
function classTokens(el) {
  if (!el || !el.className) return [];
  return String(el.className)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

const ITEM_TOKENS = new Set([
  "card",
  "post",
  "article",
  "story",
  "result",
  "entry",
  "item",
  "tile",
  "teaser",
  "news",
  "media",
  "module",
  "node",
]);

// Anything that usually wraps many items/lists
const WRAPPER_TOKENS = new Set([
  "cards",
  "lists",
  "list",
  "grid",
  "row",
  "rows",
  "wrapper",
  "wrap",
  "container",
  "content",
  "layout",
  "root",
  "app",
  "main",
  "feed",
  "stream",
  "section",
  "group",
  "results",
  "blocks",
  "block",
  "area",
  "zone",
  "columns",
  "column",
  "col",
  "listing",
  "listings",
  "panel",
  "rail",
]);

function tokenHit(tokens, set) {
  for (const t of tokens) if (set.has(t)) return true;
  return false;
}

function looksHuge(el) {
  const r = el.getBoundingClientRect?.();
  if (!r) return false;
  const vw = Math.max(
    320,
    window.innerWidth || document.documentElement.clientWidth || 0
  );
  const vh = Math.max(
    320,
    window.innerHeight || document.documentElement.clientHeight || 0
  );
  return r.width > vw * 0.96 || r.height > vh * 0.9;
}

function looksLikeWrapper(el) {
  const toks = classTokens(el);
  return tokenHit(toks, WRAPPER_TOKENS);
}

function looksLikeItem(el) {
  const toks = classTokens(el);
  // must look like an item and not like a wrapper
  return tokenHit(toks, ITEM_TOKENS) && !tokenHit(toks, WRAPPER_TOKENS);
}

function hasManyHeadlines(el) {
  const n = el.querySelectorAll(
    "h1,h2,h3,[role='heading'],[class*='title' i],[class*='headline' i]"
  ).length;
  return n >= 3; // wrappers typically host many headlines
}

function hasManyCardDescendants(el) {
  const n = el.querySelectorAll(
    "article,[role='article'],.news,.post,.story,.result,.entry,.tile,.card,[class*='card' i]:not([class*='cards' i])"
  ).length;
  return n >= 2; // more than one card-like descendant => likely a list
}

function getContainer(el) {
  // 1) Obvious semantic containers (safe)
  let c = el.closest("article,[role='article'],li");
  if (c && !looksHuge(c) && !hasManyCardDescendants(c)) return c;

  // 2) Climb at most 8 steps to find the nearest "item" but not a wrapper
  let cur = el,
    steps = 0,
    best = null;
  while (
    cur &&
    cur !== document.body &&
    cur !== document.documentElement &&
    steps < 8
  ) {
    if (
      looksLikeItem(cur) &&
      !looksHuge(cur) &&
      !hasManyCardDescendants(cur) &&
      !hasManyHeadlines(cur)
    ) {
      best = cur;
      break;
    }
    if (looksLikeWrapper(cur)) break; // stop before we escape into a list/grid wrapper
    cur = cur.parentElement;
    steps++;
  }

  // 3) Fallback: nearest headline-ish node, else the element itself
  if (!best) {
    best =
      el.closest(
        "h1,h2,h3,h4,h5,h6,[role='heading'],[class*='title' i],[class*='headline' i]"
      ) || el;
  }

  // 4) Final guard: never target the whole page
  if (
    best === document.body ||
    best === document.documentElement ||
    looksHuge(best)
  ) {
    best = el;
  }

  return best;
}

// -------------------- Actions --------------------
function applyAction(el) {
  if (!shouldTarget(el)) return;
  const container = getContainer(el);

  if (DEBUG_ALERT) {
    const sample = (container.innerText || container.textContent || "").slice(
      0,
      200
    );
    alert("Matched in:\n\n" + sample);
  }

  switch (settings.mode) {
    case "hide":
      if (!container.classList.contains("cf-hidden")) {
        container.classList.add("cf-hidden");
        lastScanBlockedCount++;
      }
      break;
    case "blur":
      if (!container.classList.contains("cf-blur")) {
        container.classList.add("cf-blur");
        lastScanBlockedCount++;
      }
      break;
    case "replace":
      replaceText(container);
      lastScanBlockedCount++;
      break;
  }
}

// Replace occurrences in text nodes (for 'replace' mode)
function replaceText(root) {
  if (!nameRegex) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const t = node.nodeValue;
      if (!t || t.trim().length === 0) return NodeFilter.FILTER_REJECT;
      return nameRegex.test(t)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes = [];
  let current;
  while ((current = walker.nextNode())) nodes.push(current);
  nodes.forEach((node) => {
    node.nodeValue = node.nodeValue.replace(nameRegex, "████");
  });
}

// -------------------- Scan --------------------
function scan() {
  if (!nameRegex) return 0;
  ensureStyle();
  lastScanBlockedCount = 0;

  // A) Card-ish containers (strict; avoid wrappers via :not)
  const containers = document.querySelectorAll(`
    article,[role="article"],li,
    .post,.news-item,.story,.card,.teaser,.result,.feed-item,.stream-item,.entry,.tile,.search-result,.list-item,
    [class*="card" i]:not([class*="cards" i]):not([class*="wrapper" i]):not([class*="wrap" i]):not([class*="list" i]):not([class*="grid" i]):not([class*="container" i]):not([class*="content" i]):not([class*="row" i]):not([class*="results" i]):not([class*="blocks" i]):not([class*="block" i]):not([class*="section" i])
  `);
  containers.forEach((c) => {
    if (!shouldTarget(c)) return;
    if (hasManyCardDescendants(c)) return; // skip lists masquerading as cards
    const text = (c.innerText || c.textContent || "").slice(0, 10000);
    if (elementMatchesText(text)) applyAction(c);
  });

  // B) Headline/snippet candidates (div/span allowed only when class suggests usefulness)
  const candidates = document.querySelectorAll(`
    h1,h2,h3,h4,h5,h6,p,a[aria-label],a[title],[role="heading"],[itemprop="headline"],
    [class*="title" i],[class*="headline" i],[class*="post-title" i],
    [class*="story" i],[class*="teaser" i],[class*="desc" i],[class*="description" i],
    [class*="summary" i],[class*="entry" i],[class*="tile" i],[class*="result" i],
    [class*="news" i],[class*="article" i]
  `);
  candidates.forEach((el) => {
    if (!shouldTarget(el)) return;
    const text = (el.textContent || "").slice(0, 5000);
    if (elementMatchesText(text)) applyAction(el);
  });

  return lastScanBlockedCount;
}

// Live updates for infinite scroll/SPAs
const debouncedScan = debounce(scan, 200);
function startObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "childList" && (m.addedNodes?.length || 0) > 0) {
        debouncedScan();
        break;
      }
    }
  });
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
}

// Message from popup: rescan & report count
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "cf_rescan") {
    const count = scan();
    sendResponse({
      count,
      regex: nameRegex ? nameRegex.toString() : null,
      mode: settings.mode,
    });
    return true;
  }
});

// Settings init & changes
function loadSettingsAndInit() {
  // Migrate legacy key if present
  chrome.storage.sync.get(null, (all) => {
    if (!all[STORAGE_KEY] && all["pcf_settings"]) {
      chrome.storage.sync.set({ [STORAGE_KEY]: all["pcf_settings"] });
    }
  });

  // Load from sync first, then local as fallback
  chrome.storage.sync.get([STORAGE_KEY], (syncRes) => {
    chrome.storage.local.get([STORAGE_KEY], (localRes) => {
      const saved = syncRes[STORAGE_KEY] || localRes[STORAGE_KEY] || {};
      settings = {
        names: Array.isArray(saved.names) ? saved.names : [],
        mode: saved.mode || "hide",
      };
      nameRegex = buildRegex(settings.names);
      scan();
      startObserver();
    });
  });
}

// optional migrate legacy key to cf_settings
chrome.storage.sync.get(null, (all) => {
  if (!all[STORAGE_KEY] && all["pcf_settings"]) {
    chrome.storage.sync.set({ [STORAGE_KEY]: all["pcf_settings"] });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area !== "sync" && area !== "local") || !changes[STORAGE_KEY]) return;
  const newVal = changes[STORAGE_KEY].newValue || {};
  settings = {
    names: Array.isArray(newVal.names) ? newVal.names : [],
    mode: newVal.mode || "hide",
  };
  nameRegex = buildRegex(settings.names);

  document
    .querySelectorAll(".cf-hidden")
    .forEach((n) => n.classList.remove("cf-hidden"));
  document
    .querySelectorAll(".cf-blur")
    .forEach((n) => n.classList.remove("cf-blur"));

  scan();
});

loadSettingsAndInit();
// ------------------------------------------------
