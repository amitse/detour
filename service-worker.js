/* Detour — Service Worker
 *
 * All rules live in chrome.storage.local — fully editable, importable, exportable.
 *
 * Architecture:
 *   - loader.js (ISOLATED, document_start)  → reads storage, sets redirect rule data
 *   - page-script.js (MAIN, document_start) → patches fetch/XHR, reads rules lazily
 *   - declarativeNetRequest                 → network-level redirects
 *   - webNavigation.onCommitted + chrome.scripting.executeScript → script injection
 *
 * Script injection bypasses CSP completely:
 *   1. Service worker fetches the external script text (no CSP in SW context)
 *   2. Injects it via chrome.scripting.executeScript({ world: "MAIN" })
 *   3. This is extension-privileged code injection — no <script src> tag needed
 *   4. Bypasses both HTTP CSP headers AND <meta> CSP tags
 *
 * Storage: { rules: [ { id, name, type, enabled, source, destination, scripts } ] }
 */

const DEFAULT_RULES = [
  {
    id: "redirect-example",
    name: "Example redirect",
    type: "redirect",
    enabled: false,
    source: { operator: "wildcard", value: "https://source.example/api/*" },
    destination: "https://target.example/mock/$1",
    scripts: [],
  },
  {
    id: "script-example",
    name: "Example script",
    type: "script",
    enabled: false,
    source: { operator: "contains", value: "app.example" },
    destination: "",
    scripts: [{ src: "https://cdn.example/assets/mock-script.js" }],
  },
];

// ── Storage ──────────────────────────────────────────────────────────

function normalizeScriptEntries(scripts) {
  if (!Array.isArray(scripts)) return [];

  const normalized = [];
  const seen = new Set();

  for (const entry of scripts) {
    if (!entry || typeof entry !== "object" || typeof entry.src !== "string") continue;

    const src = entry.src.trim();
    if (!src) continue;

    let attrs;
    if (entry.attrs && typeof entry.attrs === "object" && !Array.isArray(entry.attrs)) {
      attrs = {};
      for (const key of Object.keys(entry.attrs).sort()) {
        const value = entry.attrs[key];
        if (value === undefined || value === null) continue;
        attrs[String(key)] = String(value);
      }
      if (Object.keys(attrs).length === 0) attrs = undefined;
    }

    const signature = JSON.stringify([src, attrs || null]);
    if (seen.has(signature)) continue;
    seen.add(signature);

    normalized.push(attrs ? { src, attrs } : { src });
  }

  return normalized;
}

function normalizeRule(rule, fallbackIndex, usedIds) {
  const type = rule && rule.type === "script" ? "script" : "redirect";
  const source = rule && rule.source && typeof rule.source === "object"
    ? {
        operator: typeof rule.source.operator === "string" && rule.source.operator ? rule.source.operator : "wildcard",
        value: typeof rule.source.value === "string" ? rule.source.value.trim() : "",
      }
    : { operator: "wildcard", value: "" };

  const baseId = rule && typeof rule.id === "string" && rule.id.trim()
    ? rule.id.trim()
    : type + "-rule-" + (fallbackIndex + 1);
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = baseId + "-" + suffix++;
  }
  usedIds.add(id);

  return {
    id,
    name: rule && typeof rule.name === "string" ? rule.name.trim() : "",
    type,
    enabled: !!(rule && rule.enabled),
    source,
    destination: rule && typeof rule.destination === "string" ? rule.destination.trim() : "",
    scripts: normalizeScriptEntries(rule && rule.scripts),
  };
}

function sanitizeRules(rules) {
  const usedIds = new Set();
  return (Array.isArray(rules) ? rules : []).map((rule, index) => normalizeRule(rule, index, usedIds));
}

function ruleImportSignature(rule) {
  return JSON.stringify([
    rule.type,
    rule.source.operator,
    rule.source.value,
    rule.destination,
    rule.scripts,
  ]);
}

function dedupeImportedRules(rules) {
  const sanitized = sanitizeRules(rules);
  const deduped = [];
  const seen = new Set();

  for (const rule of sanitized) {
    const signature = ruleImportSignature(rule);
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(rule);
  }

  return deduped;
}

async function getRules() {
  const { rules } = await chrome.storage.local.get("rules");
  return rules || DEFAULT_RULES;
}

// Serialize all rule mutations so concurrent messages (e.g. rapid toggles)
// can't read the same stale snapshot and overwrite each other, and so DNR
// resyncs never run from overlapping snapshots.
let rulesMutationChain = Promise.resolve();

function withRulesLock(fn) {
  const next = rulesMutationChain.then(fn, fn);
  rulesMutationChain = next.catch(() => {});
  return next;
}

async function setRules(rules) {
  const sanitized = sanitizeRules(rules);
  await chrome.storage.local.set({ rules: sanitized });
  await syncDnrRules(sanitized);
  return sanitized;
}

async function mutateRules(mutator) {
  return withRulesLock(async () => {
    const current = await getRules();
    const next = await mutator(current);
    return setRules(next);
  });
}

// ── URL matching ─────────────────────────────────────────────────────

function matchSource(source, url) {
  const val = source.value;
  switch (source.operator) {
    case "contains":
      return url.indexOf(val) !== -1;
    case "equals":
      return url === val;
    case "wildcard": {
      const re = new RegExp(
        "^" + val.replace(/([.+?^${}()|[\]\\])/g, "\\$1").replace(/\*/g, "(.*)") + "$"
      );
      return re.test(url);
    }
    case "regex":
      try { return new RegExp(val).test(url); }
      catch { return false; }
    default:
      return false;
  }
}

// ── DNR rule sync ────────────────────────────────────────────────────

function wildcardToRegex(pattern) {
  return "^" + pattern.replace(/([.+?^${}()|[\]\\])/g, "\\$1").replace(/\*/g, "(.*)") + "$";
}

function buildRedirectDnrRule(rule, id) {
  const regexFilter = wildcardToRegex(rule.source.value);
  const regexSubstitution = rule.destination.replace(/\$(\d+)/g, "\\$1");
  return {
    id,
    priority: 1,
    action: { type: "redirect", redirect: { regexSubstitution } },
    condition: {
      regexFilter,
      resourceTypes: [
        "main_frame", "sub_frame", "stylesheet", "script",
        "image", "font", "xmlhttprequest", "other",
      ],
    },
  };
}

async function syncDnrRules(rules) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = [];
  let nextId = 1;

  for (const rule of rules) {
    if (!rule.enabled || rule.type !== "redirect") continue;
    addRules.push(buildRedirectDnrRule(rule, nextId++));
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// ── Script injection (via webNavigation + executeScript) ─────────────
//
// Fetches external script text in the service worker (no CSP applies here),
// then injects the code via chrome.scripting.executeScript({ world: "MAIN" }).
// This bypasses ALL CSP (HTTP headers + <meta> tags) because the extension
// API injects the code directly — no <script src> tag is created.

// Cache fetched scripts to avoid re-downloading on every navigation
const scriptCache = new Map();
const SCRIPT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SCRIPT_CACHE_ENTRIES = 32;
const ACTION_BADGE_COLOR = "#2A7598";

// Track which rules fired on which tab for badge + popup display
// Shape: { tabId: { ruleId: { count, lastUrl, time } } }
const tabExecutions = new Map();

function pruneScriptCache(now) {
  for (const [url, entry] of scriptCache.entries()) {
    if (now - entry.time > SCRIPT_CACHE_TTL_MS) {
      scriptCache.delete(url);
    }
  }

  while (scriptCache.size > MAX_SCRIPT_CACHE_ENTRIES) {
    const oldestUrl = scriptCache.keys().next().value;
    if (!oldestUrl) break;
    scriptCache.delete(oldestUrl);
  }
}

function recordExecution(tabId, ruleId, url) {
  if (!tabExecutions.has(tabId)) tabExecutions.set(tabId, {});
  const tab = tabExecutions.get(tabId);
  tab[ruleId] = {
    count: (tab[ruleId]?.count || 0) + 1,
    lastUrl: url,
    time: Date.now(),
  };
  updateBadge(tabId);
}

function updateBadge(tabId) {
  const tab = tabExecutions.get(tabId);
  if (!tab) {
    chrome.action.setBadgeText({ text: "", tabId });
    return;
  }
  const count = Object.keys(tab).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "", tabId });
  chrome.action.setBadgeBackgroundColor({ color: ACTION_BADGE_COLOR, tabId });
}

// Clear executions when tab navigates
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) {
    tabExecutions.delete(details.tabId);
    updateBadge(details.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabExecutions.delete(tabId);
});

async function fetchScriptText(url) {
  const now = Date.now();
  const cached = scriptCache.get(url);
  if (cached && now - cached.time <= SCRIPT_CACHE_TTL_MS) {
    return cached.text;
  }
  if (cached) {
    scriptCache.delete(url);
  }
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    scriptCache.set(url, { text, time: now });
    pruneScriptCache(now);
    return text;
  } catch (e) {
    console.error("[Detour] Failed to fetch script:", url, e.message);
    return null;
  }
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (!details.url.startsWith("http")) return;

  const rules = await getRules();
  const url = details.url;
  const target = { tabId: details.tabId, frameIds: [details.frameId] };

  // Track redirect rules that match this page (they fire at network level via DNR)
  for (const rule of rules) {
    if (!rule.enabled || rule.type !== "redirect") continue;
    if (matchSource(rule.source, url)) {
      recordExecution(details.tabId, rule.id, url);
    }
  }

  for (const rule of rules) {
    if (!rule.enabled || rule.type !== "script" || !rule.scripts) continue;
    if (!matchSource(rule.source, url)) continue;

    for (const entry of rule.scripts) {
      const code = await fetchScriptText(entry.src);
      if (!code) continue;

      try {
        await chrome.scripting.executeScript({
          target,
          func: (scriptCode, attrs) => {
            // Create a script element with inline code (not src) to avoid CSP fetch checks
            const s = document.createElement("script");
            if (attrs && typeof attrs === "object") {
              Object.keys(attrs).forEach((k) => s.setAttribute(k, attrs[k]));
            }
            s.textContent = scriptCode;
            (document.head || document.documentElement).appendChild(s);
            s.remove(); // cleanup DOM, code has already executed
            console.debug("[Detour] Injected script inline:", Object.keys(attrs || {}).length ? JSON.stringify(attrs) : "(no attrs)");
          },
          args: [code, entry.attrs || null],
          world: "MAIN",
          injectImmediately: true,
        });
        recordExecution(details.tabId, rule.id, url);
      } catch (e) {
        console.debug("[Detour] executeScript failed:", e.message);
      }
    }
  }
});

// ── Lifecycle ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const { rules } = await chrome.storage.local.get("rules");
  if (!rules) {
    await setRules(DEFAULT_RULES);
  } else {
    await syncDnrRules(rules);
  }
});

// ── Messaging ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    let rules;

    switch (message.type) {
      case "getState":
        rules = await getRules();
        sendResponse({ rules });
        break;

      case "toggleRule":
        rules = await mutateRules((current) =>
          current.map((r) => {
            if (r.id !== message.ruleId) return r;
            // Use the explicit desired state when provided so concurrent
            // toggles can't cancel each other out by re-inverting stale state.
            const desired = typeof message.enabled === "boolean"
              ? message.enabled
              : !r.enabled;
            return { ...r, enabled: desired };
          })
        );
        sendResponse({ rules });
        break;

      case "saveRule": {
        rules = await mutateRules((current) => {
          const idx = current.findIndex((r) => r.id === message.rule.id);
          if (idx >= 0) {
            current[idx] = message.rule;
          } else {
            current.push(message.rule);
          }
          return current;
        });
        sendResponse({ rules });
        break;
      }

      case "deleteRule":
        rules = await mutateRules((current) =>
          current.filter((r) => r.id !== message.ruleId)
        );
        sendResponse({ rules });
        break;

      case "importRules": {
        let addedCount = 0;
        rules = await mutateRules((current) => {
          const incoming = Array.isArray(message.rules) ? message.rules : [];
          const merged = dedupeImportedRules(current.concat(incoming));
          addedCount = merged.length - current.length;
          return merged;
        });
        sendResponse({ rules, addedCount });
        break;
      }

      case "getExecutions": {
        const execs = tabExecutions.get(message.tabId) || {};
        sendResponse({ executions: execs });
        break;
      }

      default:
        sendResponse({ error: "unknown message type" });
    }
  })();
  return true;
});
