// ClarityFilter - content script (MV3) — global pause only
let lastScanBlockedCount = 0;
const STORAGE_KEY = "cf_settings";
let settings = { names: [], mode: "hide", enabled: true };
let nameRegex = null;
let observer = null;

const STYLE_ID = "cf-style";
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `.cf-blur{filter:blur(10px)!important}.cf-hidden{display:none!important}`;
  document.documentElement.appendChild(style);
}

const debounce = (fn, wait = 150) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), wait);
  };
};

function buildRegex(names) {
  const cleaned = (names || [])
    .map((n) => String(n || "").trim())
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
const elementMatchesText = (t) =>
  !!nameRegex && nameRegex.test((t || "").normalize("NFC"));
const shouldTarget = (el) =>
  !(el?.classList?.contains("cf-blur") || el?.classList?.contains("cf-hidden"));

const classTokens = (el) =>
  ("" + (el?.className || ""))
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
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
const tokenHit = (t, s) => {
  for (const x of t) if (s.has(x)) return true;
  return false;
};
function looksHuge(el) {
  const r = el?.getBoundingClientRect?.();
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
const looksLikeWrapper = (el) => tokenHit(classTokens(el), WRAPPER_TOKENS);
const looksLikeItem = (el) => {
  const t = classTokens(el);
  return tokenHit(t, ITEM_TOKENS) && !tokenHit(t, WRAPPER_TOKENS);
};
const hasManyHeadlines = (el) =>
  el.querySelectorAll(
    "h1,h2,h3,[role='heading'],[class*='title' i],[class*='headline' i]"
  ).length >= 3;
const hasManyCardDescendants = (el) =>
  el.querySelectorAll(
    "article,[role='article'],.news,.post,.story,.result,.entry,.tile,.card,[class*='card' i]:not([class*='cards' i])"
  ).length >= 2;

function getContainer(el) {
  let c = el.closest("article,[role='article'],li");
  if (c && !looksHuge(c) && !hasManyCardDescendants(c)) return c;
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
    if (looksLikeWrapper(cur)) break;
    cur = cur.parentElement;
    steps++;
  }
  if (!best)
    best =
      el.closest(
        "h1,h2,h3,h4,h5,h6,[role='heading'],[class*='title' i],[class*='headline' i]"
      ) || el;
  if (
    best === document.body ||
    best === document.documentElement ||
    looksHuge(best)
  )
    best = el;
  return best;
}

function applyAction(el) {
  if (!shouldTarget(el)) return;
  const container = getContainer(el);
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
function replaceText(root) {
  if (!nameRegex) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const t = n.nodeValue;
      if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
      return nameRegex.test(t)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  let cur;
  while ((cur = w.nextNode())) nodes.push(cur);
  nodes.forEach((n) => {
    n.nodeValue = n.nodeValue.replace(nameRegex, "████");
  });
}
function clearEffects() {
  document
    .querySelectorAll(".cf-hidden")
    .forEach((n) => n.classList.remove("cf-hidden"));
  document
    .querySelectorAll(".cf-blur")
    .forEach((n) => n.classList.remove("cf-blur"));
}

function activeNames() {
  return settings.enabled ? settings.names || [] : [];
}

function scan() {
  if (!settings.enabled) {
    clearEffects();
    return 0;
  }
  nameRegex = buildRegex(activeNames());
  if (!nameRegex) {
    clearEffects();
    return 0;
  }
  ensureStyle();
  lastScanBlockedCount = 0;

  document
    .querySelectorAll(
      `
    article,[role="article"],li,
    .post,.news-item,.story,.card,.teaser,.result,.feed-item,.stream-item,.entry,.tile,.search-result,.list-item,
    [class*="card" i]:not([class*="cards" i]):not([class*="wrapper" i]):not([class*="wrap" i]):not([class*="list" i]):not([class*="grid" i]):not([class*="container" i]):not([class*="content" i]):not([class*="row" i]):not([class*="results" i]):not([class*="blocks" i]):not([class*="block" i]):not([class*="section" i])
  `
    )
    .forEach((c) => {
      if (!shouldTarget(c) || hasManyCardDescendants(c)) return;
      const text = (c.innerText || c.textContent || "").slice(0, 10000);
      if (elementMatchesText(text)) applyAction(c);
    });

  document
    .querySelectorAll(
      `
    h1,h2,h3,h4,h5,h6,p,a[aria-label],a[title],[role="heading"],[itemprop="headline"],
    [class*="title" i],[class*="headline" i],[class*="post-title" i],
    [class*="story" i],[class*="teaser" i],[class*="desc" i],[class*="description" i],
    [class*="summary" i],[class*="entry" i],[class*="tile" i],[class*="result" i],
    [class*="news" i],[class*="article" i]
  `
    )
    .forEach((el) => {
      if (!shouldTarget(el)) return;
      const text = (el.textContent || "").slice(0, 5000);
      if (elementMatchesText(text)) applyAction(el);
    });

  return lastScanBlockedCount;
}

const debouncedScan = debounce(scan, 200);
function startObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver((m) => {
    for (const x of m) {
      if (x.type === "childList" && (x.addedNodes?.length || 0) > 0) {
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

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type === "cf_rescan") {
    const count = scan();
    sendResponse({
      count,
      regex: nameRegex ? nameRegex.toString() : null,
      mode: settings.mode,
      enabled: settings.enabled,
    });
    return true;
  }
});

// normalization: accept old formats
function normalizeSettings(saved) {
  const raw = Array.isArray(saved.names) ? saved.names : [];
  const names = raw
    .map((n) => (typeof n === "string" ? n : (n && n.text) || ""))
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    names,
    mode: saved.mode || "hide",
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : true,
  };
}

function loadSettingsAndInit() {
  chrome.storage.sync.get(null, (all) => {
    if (!all[STORAGE_KEY] && all["pcf_settings"]) {
      chrome.storage.sync.set({ [STORAGE_KEY]: all["pcf_settings"] });
    }
  });
  chrome.storage.sync.get([STORAGE_KEY], (syncRes) => {
    chrome.storage.local.get([STORAGE_KEY], (localRes) => {
      settings = normalizeSettings(
        syncRes[STORAGE_KEY] || localRes[STORAGE_KEY] || {}
      );
      scan();
      startObserver();
    });
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area !== "sync" && area !== "local") || !changes[STORAGE_KEY]) return;
  settings = normalizeSettings(changes[STORAGE_KEY].newValue || {});
  if (!settings.enabled) clearEffects();
  scan();
});
loadSettingsAndInit();
