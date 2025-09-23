// ClarityFilter - content script (Manifest V3)
// ------------------------------------------------

let lastScanBlockedCount = 0;
const STORAGE_KEY = "cf_settings";
let settings = { names: [], mode: "hide", enabled: true, whitelist: [] };
let nameRegex = null;
let observer = null;

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

// ---- Whitelist helpers ----
function toHost(value) {
  if (!value) return null;
  let v = String(value).trim().toLowerCase();
  // try parse as URL
  try {
    const u = new URL(v.includes("://") ? v : `https://${v}`);
    return u.hostname || null;
  } catch {
    // last resort: strip any leading scheme-like text
    return v.replace(/^[a-z]+:\/\//, "").split("/")[0] || null;
  }
}
function isHostMatch(currentHost, patternHost) {
  if (!currentHost || !patternHost) return false;
  if (currentHost === patternHost) return true;
  // subdomain suffix match (e.g. news.bbc.co.uk matches bbc.co.uk)
  return currentHost.endsWith("." + patternHost);
}
function isWhitelisted(url, list) {
  const h = toHost(url);
  if (!h || !Array.isArray(list) || !list.length) return false;
  for (const ent of list) {
    const ph = toHost(ent);
    if (ph && isHostMatch(h, ph)) return true;
  }
  return false;
}

// Unicode-aware regex; allow short case endings (e.g., "Vučiću")
function buildRegex(names) {
  const cleaned = (names || [])
    .map((n) => String(n || "").trim())
    .filter(Boolean)
    .map((n) => n.normalize("NFC"))
    // Proper escaping: [, ], and \ must be escaped inside the class
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  if (!cleaned.length) return null;

  // Join all terms. No suffix allowance here.
  const core = cleaned.join("|");

  // Whole-word boundaries against Unicode letters/numbers/underscore.
  // Hyphen and other punctuation count as boundaries, so "AI-" matches.
  const pattern = `(?<![\\p{L}\\p{N}_])(?:${core})(?![\\p{L}\\p{N}_])`;

  try {
    return new RegExp(pattern, "iu"); // Unicode + case-insensitive
  } catch {
    // Fallback for environments without lookbehind.
    // This includes the boundary chars in the match, so replacement keeps them.
    return new RegExp(
      `(^|[^\\p{L}\\p{N}_])(?:${core})(?=[^\\p{L}\\p{N}_]|$)`,
      "iu"
    );
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
  const tooWide = r.width >= vw * 0.9;
  const tooTall = r.height >= vh * 0.6;
  return (tooWide && tooTall) || r.height >= 1200;
}
function looksLikeWrapper(el) {
  return tokenHit(classTokens(el), WRAPPER_TOKENS);
}
function looksLikeItem(el) {
  const toks = classTokens(el);
  return tokenHit(toks, ITEM_TOKENS) && !tokenHit(toks, WRAPPER_TOKENS);
}
function hasManyHeadlines(el) {
  return (
    el.querySelectorAll(
      "h1,h2,h3,[role='heading'],[class*='title' i],[class*='headline' i]"
    ).length >= 3
  );
}
function hasManyCardDescendants(el) {
  return (
    el.querySelectorAll(
      "article,[role='article'],.news,.post,.story,.result,.entry,.tile,.card,[class*='card' i]:not([class*='cards' i])"
    ).length >= 2
  );
}
function isForbiddenContainer(el) {
  if (!el) return true;
  if (el === document.body || el === document.documentElement) return true;
  const tag = el.tagName;
  return ["MAIN", "HEADER", "FOOTER", "NAV"].includes(tag);
}

// -------------------- Domain-agnostic container picker --------------------
const CANDIDATE_MAX_DEPTH = 8;

function hasSchemaArticle(el) {
  const t = (el.getAttribute("itemtype") || "").toLowerCase();
  return (
    t.includes("schema.org/article") || t.includes("schema.org/newsarticle")
  );
}
function hasMedia(el) {
  return !!el.querySelector(
    "img, picture, video, [style*='background-image' i], [class*='media' i], [data-testid*='media' i]"
  );
}
function hasCardText(el) {
  return !!el.querySelector(
    "h1,h2,h3,[role='heading'],[class*='title' i],[class*='headline' i],[class*='description' i],[data-testid*='text' i],p"
  );
}
function hasLinkImgTime(el) {
  const a = el.querySelector("a[href]");
  const img = el.querySelector("img, picture, [style*='background-image' i]");
  const timeEl = el.querySelector("time,[datetime]");
  let score = 0;
  if (a) score += 6;
  if (img) score += 6;
  if (timeEl) score += 6;
  return score;
}
function classTokenSet(el) {
  const cn = (el.className || "").toString().toLowerCase();
  return cn.split(/[^a-z0-9]+/g).filter(Boolean);
}
const ITEM_HINTS = new Set([
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
const WRAPPER_HINTS = new Set([
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
function tokenScore(el) {
  const toks = classTokenSet(el);
  let s = 0;
  for (const t of toks) if (ITEM_HINTS.has(t)) s += 8;
  for (const t of toks) if (WRAPPER_HINTS.has(t)) s -= 8;
  const dt = (el.getAttribute("data-testid") || "").toLowerCase();
  if (dt.includes("card") || dt.includes("promo") || dt.includes("article"))
    s += 10;
  if (dt.includes("grid") || dt.includes("list") || dt.includes("wrapper"))
    s -= 10;
  return s;
}
function isArticleish(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.tagName === "ARTICLE") return true;
  if (el.getAttribute("role") === "article") return true;
  const toks = classTokenSet(el);
  return (
    toks.includes("post") ||
    toks.includes("article") ||
    toks.includes("story") ||
    toks.includes("tile")
  );
}
function similarSiblingCount(el) {
  if (!el || !el.parentElement) return 0;
  const sibs = [...el.parentElement.children].filter((n) => n !== el);
  if (!sibs.length) return 0;
  const selfTokens = new Set(classTokenSet(el).map((t) => t.slice(0, 6)));
  const selfDT = (el.getAttribute("data-testid") || "").toLowerCase();
  let similar = 0;
  for (const s of sibs) {
    const st = classTokenSet(s).map((t) => t.slice(0, 6));
    const dt = (s.getAttribute("data-testid") || "").toLowerCase();
    if (
      st.some((t) => selfTokens.has(t)) ||
      (selfDT && dt && selfDT.split("-")[0] === dt.split("-")[0])
    )
      similar++;
  }
  return similar;
}
function badBigOrCluster(el) {
  return looksHuge(el) || hasManyCardDescendants(el) || hasManyHeadlines(el);
}
function shrinkIfTooBig(el) {
  if (!el) return el;
  const isRoot = el === document.body || el === document.documentElement;
  if (isRoot || badBigOrCluster(el)) {
    const smaller = el.querySelector(`
      article,[role='article'],li,
      .post,.news-item,.story,.card,.teaser,.result,.entry,.tile,.search-result,.list-item,
      [class*="card" i]:not([class*="cards" i]):not([class*="wrapper" i]):not([class*="wrap" i]):not([class*="list" i]):not([class*="grid" i]):not([class*="container" i]):not([class*="content" i]):not([class*="row" i]):not([class*="results" i]):not([class*="blocks" i]):not([class*="block" i]):not([class*="section" i])
    `);
    if (smaller && !badBigOrCluster(smaller) && !isForbiddenContainer(smaller))
      return smaller;
  }
  return el;
}
function computeCandidateScore(el, depthFromMatch) {
  if (!el || el === document.body || el === document.documentElement)
    return -1e6;
  if (badBigOrCluster(el)) return -500;
  let score = 0;
  if (isArticleish(el)) score += 40;
  if (hasSchemaArticle(el)) score += 20;
  score += tokenScore(el);
  const sibs = similarSiblingCount(el);
  if (sibs >= 1 && sibs <= 50) score += Math.min(24, 6 + sibs * 2);
  if (
    el.querySelector(
      "h1,h2,h3,[role='heading'],[class*='title' i],[class*='headline' i]"
    )
  )
    score += 12;
  score += hasLinkImgTime(el);
  score -= depthFromMatch * 3;
  if (looksLikeWrapper(el)) score -= 15;
  return score;
}
function collectCandidates(startEl) {
  const out = [];
  let cur = startEl,
    depth = 0;
  while (
    cur &&
    cur !== document.body &&
    cur !== document.documentElement &&
    depth <= CANDIDATE_MAX_DEPTH
  ) {
    out.push({ el: cur, depth });
    cur = cur.parentElement;
    depth++;
  }
  return out;
}
function promoteAcrossSiblings(el) {
  if (!el || !el.parentElement) return el;
  const parent = el.parentElement;
  const parentHasMedia = !!parent.querySelector(
    "img, picture, video, [style*='background-image' i], [class*='media' i], [data-testid*='media' i]"
  );
  const parentHasText = !!parent.querySelector(
    "h1,h2,h3,[role='heading'],[class*='title' i],[class*='headline' i],[class*='description' i],p,[data-testid*='text' i]"
  );
  const looksMulti =
    hasManyCardDescendants(parent) ||
    looksLikeWrapper(parent) ||
    looksHuge(parent);
  if (
    parentHasMedia &&
    parentHasText &&
    !looksMulti &&
    !isForbiddenContainer(parent)
  )
    return parent;
  return el;
}
function promoteToCardBoundary(el) {
  let cur = el;
  for (let i = 0; i < 4 && cur && cur.parentElement; i++) {
    const p = cur.parentElement;
    if (
      !isForbiddenContainer(p) &&
      !badBigOrCluster(p) &&
      hasMedia(p) &&
      hasCardText(p)
    ) {
      if (!hasManyCardDescendants(p)) return p;
    }
    cur = p;
  }
  return el;
}
function pickContainer(el) {
  const headingBias = el.closest(
    "h1,h2,h3,[role='heading'],[class*='title' i],[class*='headline' i]"
  );
  const headingCard = headingBias?.closest(`
    article,[role='article'],li,
    .post,.news-item,.story,.card,.teaser,.result,.entry,.tile,.search-result,.list-item,
    [class*="card" i]:not([class*="cards" i]):not([class*="wrapper" i]):not([class*="wrap" i]):not([class*="list" i]):not([class*="grid" i]):not([class*="container" i]):not([class*="content" i]):not([class*="row" i]):not([class*="results" i]):not([class*="blocks" i]):not([class*="block" i]):not([class*="section" i])
  `);

  const cands = collectCandidates(el);
  let best = null,
    bestScore = -1e9;
  for (const { el: cand, depth } of cands) {
    const s = computeCandidateScore(cand, depth);
    if (s > bestScore) {
      bestScore = s;
      best = cand;
    }
  }
  if (headingCard && !badBigOrCluster(headingCard)) {
    const sHead = computeCandidateScore(headingCard, 0);
    if (sHead >= bestScore - 5) best = headingCard;
  }
  best = shrinkIfTooBig(best) || el;
  best = promoteToCardBoundary(best);
  best = promoteAcrossSiblings(best);

  if (isForbiddenContainer(best) || badBigOrCluster(best)) {
    const smaller =
      el.closest?.("article,[role='article'],li") ||
      el.querySelector?.("article,[role='article'],li,.card,.story,.post") ||
      null;
    if (smaller && !badBigOrCluster(smaller) && !isForbiddenContainer(smaller))
      return smaller;
    return el;
  }
  return best;
}

// -------------------- Text-node anchoring --------------------
function findFirstMatchingTextNode(root, maxNodes = 3000) {
  if (!nameRegex || !root) return null;
  if (root.matches?.("script,style,noscript,template")) return null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const t = node.nodeValue;
      if (!t || t.trim().length === 0) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (p && typeof getComputedStyle === "function") {
        const cs = getComputedStyle(p);
        if (cs && (cs.display === "none" || cs.visibility === "hidden")) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return nameRegex.test(t)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  let n = 0,
    current = walker.nextNode();
  while (current) {
    n++;
    if (n > maxNodes) break;
    return current;
  }
  return null;
}

// -------------------- Pause helpers --------------------
function clearEffects() {
  document
    .querySelectorAll(".cf-hidden")
    .forEach((n) => n.classList.remove("cf-hidden"));
  document
    .querySelectorAll(".cf-blur")
    .forEach((n) => n.classList.remove("cf-blur"));
}

// -------------------- Actions --------------------
function applyAction(el) {
  if (!shouldTarget(el)) return;

  const container = pickContainer(el) || el;

  if (!DEBUG_ALERT && container && container.style) {
    const old = container.style.outline;
    setTimeout(() => (container.style.outline = old || ""), 600);
  }
  if (DEBUG_ALERT) {
    const sample = (container.innerText || container.textContent || "").slice(
      0,
      200
    );
    alert("Matched in:\n\n" + sample);
  }
  if (isForbiddenContainer(container)) return;

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
  // Whitelist takes precedence
  if (isWhitelisted(location.href, settings.whitelist)) {
    clearEffects();
    return 0;
  }

  if (!settings.enabled) {
    clearEffects();
    return 0;
  }
  if (!settings.names || !settings.names.length) {
    clearEffects();
    return 0;
  }

  nameRegex = buildRegex(settings.names);
  if (!nameRegex) {
    clearEffects();
    return 0;
  }

  ensureStyle();
  lastScanBlockedCount = 0;

  // Pass 1: likely item containers -> anchor via text node
  const containers = document.querySelectorAll(`
    article,[role="article"],li,
    .post,.news-item,.story,.card,.teaser,.result,.feed-item,.stream-item,.entry,.tile,.search-result,.list-item,
    [class*="card" i]:not([class*="cards" i]):not([class*="wrapper" i]):not([class*="wrap" i]):not([class*="list" i]):not([class*="grid" i]):not([class*="container" i]):not([class*="content" i]):not([class*="row" i]):not([class*="results" i]):not([class*="blocks" i]):not([class*="block" i]):not([class*="section" i])
  `);
  containers.forEach((c) => {
    if (!shouldTarget(c)) return;
    if (hasManyCardDescendants(c)) return;
    const tn = findFirstMatchingTextNode(c);
    if (tn) applyAction(tn.parentElement || tn);
  });

  // Pass 2: general textual nodes -> anchor via text node
  const candidates = document.querySelectorAll(`
    h1,h2,h3,h4,h5,h6,p,a[aria-label],a[title],[role="heading"],[itemprop="headline"],
    [class*="title" i],[class*="headline" i],[class*="post-title" i],
    [class*="story" i],[class*="teaser" i],[class*="desc" i],[class*="description" i],
    [class*="summary" i],[class*="entry" i],[class*="tile" i],[class*="result" i],
    [class*="news" i],[class*="article" i]
  `);
  candidates.forEach((el) => {
    if (!shouldTarget(el)) return;
    const tn = findFirstMatchingTextNode(el);
    if (tn) applyAction(tn.parentElement || tn);
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
      enabled: settings.enabled,
      whitelisted: isWhitelisted(location.href, settings.whitelist),
      host: location.hostname,
    });
    return true;
  }
});

// Settings init & changes
function loadSettingsAndInit() {
  // one-time legacy migration for overall object
  chrome.storage.sync.get(null, (all) => {
    if (!all[STORAGE_KEY] && all["pcf_settings"]) {
      chrome.storage.sync.set({ [STORAGE_KEY]: all["pcf_settings"] });
    }
  });

  chrome.storage.sync.get([STORAGE_KEY], (syncRes) => {
    chrome.storage.local.get([STORAGE_KEY], (localRes) => {
      const saved = syncRes[STORAGE_KEY] || localRes[STORAGE_KEY] || {};
      settings = {
        names: Array.isArray(saved.names) ? saved.names : [],
        mode: saved.mode || "hide",
        enabled: typeof saved.enabled === "boolean" ? saved.enabled : true,
        whitelist: Array.isArray(saved.whitelist) ? saved.whitelist : [],
      };
      nameRegex = buildRegex(settings.names);
      scan();
      startObserver();
    });
  });
}

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
    enabled: typeof newVal.enabled === "boolean" ? newVal.enabled : true,
    whitelist: Array.isArray(newVal.whitelist) ? newVal.whitelist : [],
  };
  nameRegex = buildRegex(settings.names);

  if (!settings.enabled || isWhitelisted(location.href, settings.whitelist)) {
    clearEffects();
    return;
  }

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
