// ClarityFilter - content script (Manifest V2)
// ------------------------------------------------

// Prevent multiple content script executions
if (window.CF_CONTENT_SCRIPT_LOADED) {

  // Exit early to prevent duplicate execution
  throw new Error("Content script already loaded");
}
window.CF_CONTENT_SCRIPT_LOADED = true;

let lastScanBlockedCount = 0;
const STORAGE_KEY = "cf_settings";

function normalize(s = {}) {
  return {
    names: Array.isArray(s.names) ? s.names : [],
    mode: typeof s.mode === "string" ? s.mode : "hide",
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

let settings = {
  names: [],
  mode: "hide",
  enabled: true,
  whitelist: [],
  pixelCell: 15,
  pinEnabled: false,
  pinHash: null,
  pinSalt: null,
  pinAlgo: null,
  pinIter: null,
};
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

    /* === NEW: overlay system for pixelate === */
    .cf-obscured { position: relative !important; }
    .cf-overlay {
      position: absolute !important;
      inset: 0 !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
    }
    /* Pixelate look via two perpendicular repeating gradients (mosaic) */
    .cf-overlay.pixelate {
      --cf-a: rgba(0,0,0,.92);
      --cf-b: #fff;

      /* fallback checkerboard (works everywhere) */
      background:
        linear-gradient(90deg, var(--cf-a) 50%, var(--cf-b) 0) 0 0 / var(--cf-cell) var(--cf-cell),
        linear-gradient(      var(--cf-a) 50%, var(--cf-b) 0) 0 0 / var(--cf-cell) var(--cf-cell);
      background-size: calc(2 * var(--cf-cell)) calc(2 * var(--cf-cell));
      background-position: 0 0, var(--cf-cell) var(--cf-cell);
      mix-blend-mode: multiply;
      opacity: 1 !important;
      backdrop-filter: saturate(.7) contrast(1.1); /* optional: makes text underneath less legible */
    }

    /* Prefer repeating-conic-gradient when supported (crisper squares) */
    @supports (background: repeating-conic-gradient(#000 0 25%, #111 0 50%)) {
      .cf-overlay.pixelate {
        background: repeating-conic-gradient(
          from 0deg,
          var(--cf-a) 0 25%,
          var(--cf-b) 0 50%
        );
        background-size: var(--cf-cell) var(--cf-cell);
      }
    }
  `;
  document.documentElement.appendChild(style);
}

function escCloser(e) {
  if (e.key === "Escape") closeOptionsModal();
}

// ---- PIN modal (content script only; no window.prompt) ----
let CF_PIN_OPEN = false;

function cfPinPrompt(reason = "change settings") {
  if (CF_PIN_OPEN) return Promise.resolve(null);
  CF_PIN_OPEN = true;

  // Root + Shadow to isolate from site CSS
  const host = document.createElement("div");
  host.id = "cf-pin-host";
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "auto";
  (document.documentElement || document.body).appendChild(host);

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,.35);
    }
    .dlg {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
      min-width: 320px; max-width: 90vw;
      font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, 'Helvetica Neue', Arial, sans-serif;
      background: #1f2330; color: #e9eef7; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.4);
      padding: 16px 16px 12px;
    }
    .hdr { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .hdr .title { font-weight: 600; }
    .msg { opacity: .9; margin-bottom: 10px; }
    .row { display: flex; gap: 8px; }
    input[type="password"]{
      flex: 1; padding: 10px 12px; border-radius: 8px; border: 1px solid #374151;
      background: #0f1421; color: #e9eef7; outline: none;
    }
    input[type="password"]:focus{ border-color:#10b981; box-shadow: 0 0 0 2px rgba(79,70,229,.35); }
    button{
      padding: 9px 14px; border-radius: 8px; border: 0; cursor: pointer; font-weight: 600;
    }
    .ok { background: #10b981; color: white; }
    .cancel { background: #374151; color: #e9eef7; }
  `;
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="backdrop" part="backdrop"></div>
    <div class="dlg" role="dialog" aria-modal="true" aria-label="ClarityFilter PIN">
      <div class="hdr">
        <div class="title">ClarityFilter</div>
      </div>
      <div class="msg">Enter PIN to <span id="reason-text"></span>:</div>
      <div class="row">
        <input id="cfPin" type="password" autocomplete="off" />
        <button class="ok" id="ok">OK</button>
        <button class="cancel" id="cancel">Cancel</button>
      </div>
    </div>
  `;
  shadow.append(style, wrap);

  const input = shadow.getElementById("cfPin");
  const ok = shadow.getElementById("ok");
  const cancel = shadow.getElementById("cancel");
  const reasonText = shadow.getElementById("reason-text");

  // Safely set the reason text to prevent XSS
  reasonText.textContent = reason;

  let resolve;
  const p = new Promise((res) => (resolve = res));

  function close(v = null) {
    host.remove();
    CF_PIN_OPEN = false;
    resolve(v);
  }
  ok.addEventListener("click", () => close(input.value || ""));
  cancel.addEventListener("click", () => close(null));
  shadow.addEventListener("keydown", (e) => {
    if (e.key === "Enter") ok.click();
    if (e.key === "Escape") cancel.click();
  });

  input.focus();
  return p;
}

// -------------------- Utils --------------------
function debounce(fn, wait = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function addOverlay(container, cls) {
  if (!container || !container.appendChild) return;
  // If already obscured, don't add again
  if (container.querySelector(":scope > .cf-overlay")) return;

  container.classList.add("cf-obscured");
  const cs = getComputedStyle(container);
  if (cs && cs.display === "contents") {
    // climb one level to a paintable box
    if (container.parentElement) container = container.parentElement;
  }
  const ov = document.createElement("div");
  ov.className = `cf-overlay ${cls}`;
  if (cls.includes("pixelate")) {
    const cell = Number.isFinite(settings.pixelCell) ? settings.pixelCell : 15;
    ov.style.setProperty("--cf-cell", `${cell}px`);
  }
  container.appendChild(ov);
}

function removeOverlays(root = document) {
  root.querySelectorAll(".cf-overlay").forEach((n) => n.remove());
  root
    .querySelectorAll(".cf-obscured")
    .forEach((n) => n.classList.remove("cf-obscured"));
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
    if (!ph) continue; // ignore bad entries
    if (h === ph || h.endsWith("." + ph)) return true;
  }
  return false;
}

// Unicode-aware regex; allow short case endings (e.g., "Vučiću")
function buildRegex(names) {
  // Security: Limit input size to prevent ReDoS attacks
  if (!Array.isArray(names) || names.length === 0) return null;
  if (names.length > 1000) return null; // Limit total count

  const cleaned = names
    .map((n) => String(n || "").trim())
    .filter(Boolean)
    .map((n) => n.normalize("NFC"))
    .filter((n) => n.length <= 50) // Limit individual name length
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); // Proper escaping

  if (!cleaned.length) return null;

  // Join all terms. No suffix allowance here.
  const core = cleaned.join("|");

  // Security: Limit total pattern length to prevent ReDoS
  if (core.length > 5000) return null;

  // Whole-word boundaries against Unicode letters/numbers/underscore.
  // Hyphen and other punctuation count as boundaries, so "AI-" matches.
  const pattern = `(?<![\\p{L}\\p{N}_])(?:${core})(?![\\p{L}\\p{N}_])`;

  try {
    return new RegExp(pattern, "iu"); // Unicode + case-insensitive
  } catch {
    // Fallback for environments without lookbehind.
    // This includes the boundary chars in the match, so replacement keeps them.
    try {
      return new RegExp(
        `(^|[^\\p{L}\\p{N}_])(?:${core})(?=[^\\p{L}\\p{N}_]|$)`,
        "iu"
      );
    } catch {
      // Fail safely if regex construction fails
      return null;
    }
  }
}

function elementMatchesText(text) {
  if (!nameRegex) return false;
  return nameRegex.test((text || "").normalize("NFC"));
}

function shouldTarget(el) {
  if (!el || !el.classList) return true;
  return (
    !el.classList.contains("cf-blur") &&
    !el.classList.contains("cf-hidden") &&
    !el.classList.contains("cf-obscured") // NEW
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

// --- PIN helpers ---
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(str)
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function pbkdf2Hex(pin, saltHex, iter = 150000) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const salt = Uint8Array.from(
    saltHex.match(/../g).map((h) => parseInt(h, 16))
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", iterations: iter, salt },
    key,
    256
  );
  return [...new Uint8Array(bits)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getSettings() {
  const all = await chrome.storage.sync.get(STORAGE_KEY);
  const s = all[STORAGE_KEY] || {};
  return {
    ...s,
    pinEnabled: !!s.pinEnabled,
    pinHash: typeof s.pinHash === "string" ? s.pinHash : null,
    pinSalt: typeof s.pinSalt === "string" ? s.pinSalt : null,
    pinAlgo: typeof s.pinAlgo === "string" ? s.pinAlgo : null,
    pinIter: Number.isFinite(s.pinIter) ? s.pinIter : null,
  };
}

async function requirePin(reason = "change settings") {
  const s = await getSettings();
  if (!s.pinEnabled || !s.pinHash || !s.pinSalt) return true; // no PIN set

  const input = await cfPinPrompt(reason);
  if (input == null) return false;

  try {
    // Use the same verification logic as other places
    if (s.pinAlgo === "PBKDF2") {
      // New PBKDF2 format
      const hash = await pbkdf2Hex(input, s.pinSalt, s.pinIter || 150000);
      return hash === s.pinHash;
    } else {
      // Legacy SHA-256 format
      const hash = await sha256Hex(`${s.pinSalt}:${input}`);
      return hash === s.pinHash;
    }
  } catch {
    return false;
  }
}

const IS_TOP = window === window.top;

// Rate limiting for toggle operations
let lastToggleTime = 0;
const TOGGLE_COOLDOWN = 2000; // 2 seconds between toggles

document.addEventListener("keydown", async (e) => {
  if (!e.isTrusted) return; // Block synthetic events from malicious pages
  if (!IS_TOP) return;
  if (e.repeat) return;
  const t = e.target;
  const tag = (t && t.tagName) || "";
  const typing = tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable;
  if (typing) return;
});

// Consolidated message listener for all content script messages
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {


  // Handle ping to check if content script is loaded
  if (msg?.type === "cf_ping") {
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === "cf_require_pin") {
    // Only handle PIN prompts in the main frame (top-level window)
    if (window !== window.top) {
  
      sendResponse({ ok: false });
      return true;
    }

    // Prevent multiple PIN prompts from being handled simultaneously
    if (window.CF_PIN_PROMPT_ACTIVE) {
   
      sendResponse({ ok: false });
      return true;
    }

    window.CF_PIN_PROMPT_ACTIVE = true;
    (async () => {
      try {
      
        const ok = await requirePin(msg.reason || "change settings");
     
        sendResponse({ ok });
      } finally {
        window.CF_PIN_PROMPT_ACTIVE = false;
      }
    })();
    return true; // keep port open
  }

  // Handle toggle filter command from background script
  if (msg?.type === "cf_toggle_filter") {
    (async () => {
      try {
        // Rate limiting check
        const now = Date.now();
        if (now - lastToggleTime < TOGGLE_COOLDOWN) {
          sendResponse({
            success: false,
            reason: "Please wait before toggling again",
          });
          return;
        }
        lastToggleTime = now;

        // Get current settings from storage
        const all = await chrome.storage.sync.get(STORAGE_KEY);
        const current = all[STORAGE_KEY] || {};

        // Verify PIN if enabled
        if (current.pinEnabled) {
          const ok = await requirePin(
            current.enabled ? "turn filtering OFF" : "turn filtering ON"
          );
          if (!ok) {
            sendResponse({ success: false, reason: "PIN verification failed" });
            return;
          }
        }

        // Toggle the enabled state
        const newEnabled = !current.enabled;
        await chrome.storage.sync.set({
          [STORAGE_KEY]: { ...current, enabled: newEnabled },
        });

        // Update local settings immediately
        settings.enabled = newEnabled;

        // Trigger rescan
        scan();

        sendResponse({ success: true, enabled: newEnabled });
      } catch (error) {
        console.error("[ClarityFilter] Toggle error:", error);
        sendResponse({ success: false, reason: "Toggle failed" });
      }
    })();
    return true; // keep port open
  }

  // Handle rescan messages
  if (msg?.type === "cf_rescan") {

    (async () => {
      // Prefer authoritative settings from background if present
      if (msg.next && typeof msg.next === "object") {
      
        settings = normalize(msg.next);
      } else {
       
        // Fallback: re-read from storage to avoid stale settings
        const all = await chrome.storage.sync.get(STORAGE_KEY);
        const s = all[STORAGE_KEY] || {};
        settings = normalize(s);
      }

  

      // Recompute regex and apply/clear deterministically
      nameRegex = buildRegex(settings.names);

      if (isWhitelisted(location.href, settings.whitelist)) {
        clearEffects();
        sendResponse({
          ok: true,
          enabled: settings.enabled,
          whitelisted: true,
        });
        return;
      }

      if (settings.enabled) {
        applyEffects();
        const count = scan();
   
        sendResponse({ ok: true, enabled: true, count });
      } else {
        clearEffects();
    
        sendResponse({ ok: true, enabled: false });
      }
    })();
    return true; // keep port open for async response
  }
});

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
  // Never treat a real article node as a generic wrapper.
  if (el?.tagName === "ARTICLE" || el?.getAttribute?.("role") === "article") {
    return false;
  }
  const dt = (el?.getAttribute?.("data-testid") || "").toLowerCase();
  if (
    /(grid|stack|cluster|wrapper|container|list|section|columns|row|rail|unit)/.test(
      dt
    )
  ) {
    return true;
  }
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
// A descendant counts as a “card item” only if it’s article-ish AND has media + text.
function isCardish(el) {
  if (!el || el === document) return false;
  const dt = (el.getAttribute?.("data-testid") || "").toLowerCase();
  const articley =
    el.tagName === "ARTICLE" ||
    el.getAttribute?.("role") === "article" ||
    dt.includes("card") ||
    looksLikeItem(el);
  return (
    articley &&
    hasMedia(el) &&
    hasCardText(el) &&
    // Avoid counting the container itself
    el !== this
  );
}

function hasManyCardDescendants(root) {
  // Scan a reasonable number of descendants to keep perf predictable
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let count = 0,
    n = 0;
  while (walker.nextNode()) {
    const el = walker.currentNode;
    n++;
    if (n > 2000) break; // bail on gigantic DOMs
    if (isCardish.call(root, el)) {
      count++;
      if (count >= 2) return true;
    }
  }
  return false;
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
// Find the smallest ancestor (within a few levels) that contains both media + text,
// and that doesn't look like a giant multi-card wrapper.
function findCardAncestor(el, maxHops = 6) {
  let cur = el;
  for (let i = 0; cur && i < maxHops; i++, cur = cur.parentElement) {
    if (!cur) break;
    // Skip "display: contents" containers – absolutely positioned overlay won’t render there
    const cs = getComputedStyle(cur);
    if (cs && cs.display === "contents") continue;
    if (
      hasMedia(cur) &&
      hasCardText(cur) &&
      !hasManyCardDescendants(cur) &&
      !looksLikeWrapper(cur) &&
      !isForbiddenContainer(cur)
    ) {
      return cur;
    }
  }
  return null;
}

const cardish = document.querySelectorAll(`
  article:has(img, picture, video):has(h1,h2,h3,p,[class*="title" i],[class*="headline" i]),
  [data-testid*="card" i]:not([data-testid*="grid" i]):not([data-testid*="stack" i]):has(img, picture, video):has(h1,h2,h3,p,[class*="title" i],[class*="headline" i]),
  li:has(img, picture, video):has(h1,h2,h3,p)
`);
cardish.forEach((c) => {
  if (!shouldTarget(c) || hasManyCardDescendants(c)) return;
  const tn = findFirstMatchingTextNode(c);
  if (tn) applyAction(c);
});

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
  // NEW: if sibling cluster (image + title) lives under grandparent, try one hop up
  const gp = parent.parentElement;
  if (gp) {
    const gpLooksMulti =
      hasManyCardDescendants(gp) || looksLikeWrapper(gp) || looksHuge(gp);
    if (
      hasMedia(gp) &&
      hasCardText(gp) &&
      !gpLooksMulti &&
      !isForbiddenContainer(gp)
    ) {
      return gp;
    }
  }
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

  // NEW: if the closest <article> contains both media and text (single-card),
  // prefer that. This matches your screenshot structure exactly.
  const nearestArticle = el.closest("article,[role='article']");
  if (
    nearestArticle &&
    hasMedia(nearestArticle) &&
    hasCardText(nearestArticle) &&
    !hasManyCardDescendants(nearestArticle) &&
    !isForbiddenContainer(nearestArticle)
  ) {
    return nearestArticle;
  }

  // NEW: Try the smallest ancestor that contains BOTH image/media and card text.
  const bothAncestor = findCardAncestor(el, 6);
  if (bothAncestor) {
    return bothAncestor;
  }

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
  removeOverlays(document); // NEW
}

function applyEffects() {
  // Ensure CSS styles are injected
  ensureStyle();
}

function clampToReasonable(container, anchorEl) {
  if (!container) return container;
  const r = container.getBoundingClientRect?.();
  if (!r) return container;
  const vw = Math.max(
    320,
    window.innerWidth || document.documentElement.clientWidth || 0
  );
  const vh = Math.max(
    320,
    window.innerHeight || document.documentElement.clientHeight || 0
  );

  const tooWide = r.width >= vw * 0.85;
  const tooTall = r.height >= vh * 0.7;
  const tooHeady = hasManyHeadlines(container);
  const isCluster = hasManyCardDescendants(container);
  const tooBig = (tooWide && tooTall) || tooHeady || isCluster;
  if (!tooBig) return container;

  // Prefer the smallest nearby card-ish thing that still covers the match.
  const small =
    anchorEl?.closest?.(
      'article,[role="article"],li,.card,.story,.tile,[data-testid*="card" i]'
    ) ||
    anchorEl?.parentElement ||
    container;
  return small;
}

// -------------------- Actions --------------------
function applyAction(el) {
  if (!shouldTarget(el)) return;

  let container = pickContainer(el) || el;
  container = clampToReasonable(container, el);

  if (container.querySelector(":scope > .cf-overlay")) return;

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
    case "pixelate":
      addOverlay(container, "pixelate");
      lastScanBlockedCount++;
      break;
    case "replace":
      replaceText(container);
      lastScanBlockedCount++;
      break;
  }
}

function replaceText(root) {
  if (!nameRegex || !root) return;

  // Security: Validate root element
  if (
    typeof root.nodeType !== "number" ||
    root.nodeType !== Node.ELEMENT_NODE
  ) {
    return;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const t = node.nodeValue;
      if (!t || typeof t !== "string" || t.trim().length === 0)
        return NodeFilter.FILTER_REJECT;

      // Security: Limit text length to prevent performance issues
      if (t.length > 10000) return NodeFilter.FILTER_REJECT;

      return nameRegex.test(t)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes = [];
  let current;
  let nodeCount = 0;
  const MAX_NODES = 1000; // Security: Limit number of nodes processed

  while ((current = walker.nextNode()) && nodeCount < MAX_NODES) {
    nodes.push(current);
    nodeCount++;
  }

  nodes.forEach((node) => {
    try {
      // Security: Validate node before replacement
      if (node && node.nodeValue && typeof node.nodeValue === "string") {
        node.nodeValue = node.nodeValue.replace(nameRegex, "████");
      }
    } catch (error) {
      // Fail safely if replacement fails
      console.warn("[ClarityFilter] Text replacement failed:", error);
    }
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

  // Pass 0 (fast path for modern browsers): pick card-like nodes that have media + text.
  // Do this *after* nameRegex exists.
  try {
    if (CSS.supports("selector(:has(*))")) {
      const cardish = document.querySelectorAll(`
        article:has(img, picture, video):has(h1,h2,h3,p,[class*="title" i],[class*="headline" i]),
        [class*="card" i]:not([class*="cards" i]):has(img, picture, video):has(h1,h2,h3,p,[class*="title" i],[class*="headline" i]),
        li:has(img, picture, video):has(h1,h2,h3,p)
      `);
      cardish.forEach((c) => {
        if (!shouldTarget(c) || hasManyCardDescendants(c)) return;
        const tn = findFirstMatchingTextNode(c);
        if (tn) applyAction(c);
      });
    }
  } catch {
    /* old engines without selector support */
  }

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
        pixelCell: Number.isFinite(saved.pixelCell) ? saved.pixelCell : 15,
        pinEnabled: !!saved.pinEnabled,
        pinHash: typeof saved.pinHash === "string" ? saved.pinHash : null,
        pinSalt: typeof saved.pinSalt === "string" ? saved.pinSalt : null,
        pinAlgo: typeof saved.pinAlgo === "string" ? saved.pinAlgo : null,
        pinIter: Number.isFinite(saved.pinIter) ? saved.pinIter : null,
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

  // Security: Validate and sanitize settings
  settings = {
    names: Array.isArray(newVal.names)
      ? newVal.names.filter((n) => typeof n === "string" && n.length <= 100)
      : [],
    mode:
      typeof newVal.mode === "string" &&
      ["hide", "blur", "pixelate", "replace"].includes(newVal.mode)
        ? newVal.mode
        : "hide",
    enabled: typeof newVal.enabled === "boolean" ? newVal.enabled : true,
    whitelist: Array.isArray(newVal.whitelist)
      ? newVal.whitelist.filter((w) => typeof w === "string" && w.length <= 200)
      : [],
    pixelCell:
      Number.isFinite(newVal.pixelCell) &&
      newVal.pixelCell >= 5 &&
      newVal.pixelCell <= 50
        ? newVal.pixelCell
        : 15,
    pinEnabled: !!newVal.pinEnabled,
    pinHash: typeof newVal.pinHash === "string" ? newVal.pinHash : null,
    pinSalt: typeof newVal.pinSalt === "string" ? newVal.pinSalt : null,
    pinAlgo: typeof newVal.pinAlgo === "string" ? newVal.pinAlgo : null,
    pinIter: Number.isFinite(newVal.pinIter) ? newVal.pinIter : null,
  };

  // Security: Limit total names count
  if (settings.names.length > 1000) {
    settings.names = settings.names.slice(0, 1000);
  }

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
  removeOverlays(document);
  scan();
});

loadSettingsAndInit();
// ------------------------------------------------
