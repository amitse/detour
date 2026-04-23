/* Detour — Service Worker
 *
 * All rules live in chrome.storage.local — fully editable, importable, exportable.
 *
 * Architecture:
 *   - loader.js (ISOLATED, document_start)  → reads storage, sets redirect rule data
 *   - page-script.js (MAIN, document_start) → patches fetch/XHR, reads rules lazily
 *   - declarativeNetRequest                 → network-level redirects + preset header strips
 *   - webNavigation.onCommitted + chrome.scripting.executeScript → script injection
 *
 * Script injection bypasses CSP completely:
 *   1. Service worker fetches the external script text (no CSP in SW context)
 *   2. Injects it via chrome.scripting.executeScript({ world: "MAIN" })
 *   3. This is extension-privileged code injection — no <script src> tag needed
 *   4. Bypasses both HTTP CSP headers AND <meta> CSP tags
 *
 * Storage:
 *   rules:    [ { id, name, type, enabled, source, destination, scripts } ]
 *   settings: { enabled, presets: { cors, csp, xfo } }
 */

const DEFAULT_RULES = [
  {
    id: "redirect-example",
    name: "Example redirect",
    type: "redirect",
    enabled: false,
    source: { operator: "wildcard", value: "https://source.example/api/*", method: "ALL" },
    destination: "https://target.example/mock/$1",
    scripts: [],
  },
  {
    id: "script-example",
    name: "Example script",
    type: "script",
    enabled: false,
    source: { operator: "wildcard", value: "*app.example*", method: "ALL" },
    destination: "",
    scripts: [{ src: "https://cdn.example/assets/mock-script.js" }],
  },
];

const DEFAULT_SETTINGS = {
  enabled: true,
  presets: { cors: false, csp: false, xfo: false },
};

// DNR IDs: 1..USER_RULE_ID_MAX for user rules, PRESET_ID_BASE+ for presets.
const USER_RULE_ID_MAX = 10000;
const PRESET_ID_BASE = 10001;
const PRESET_IDS = {
  cors: PRESET_ID_BASE,
  csp: PRESET_ID_BASE + 1,
  xfo: PRESET_ID_BASE + 2,
};

const ALLOWED_METHODS = ["ALL", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const DNR_METHOD_LOOKUP = {
  GET: "get", POST: "post", PUT: "put", PATCH: "patch",
  DELETE: "delete", HEAD: "head", OPTIONS: "options",
};

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

function normalizeMethod(method) {
  if (typeof method !== "string") return "ALL";
  const upper = method.trim().toUpperCase();
  return ALLOWED_METHODS.includes(upper) ? upper : "ALL";
}

// Collapse the legacy {contains, equals} operators into wildcard. The UI now
// only speaks wildcard (with `*` as the single placeholder) and regex is kept
// alive only so imported JSON files from older versions or JSON editors keep
// working. Everything unknown normalizes to wildcard.
//   contains:"foo"  →  wildcard:"*foo*"
//   equals:"foo"    →  wildcard:"foo"   (no `*` in a wildcard = exact match)
//   regex:...       →  preserved as-is
function normalizeSource(rawSource) {
  if (!rawSource || typeof rawSource !== "object") {
    return { operator: "wildcard", value: "", method: "ALL" };
  }
  const value = typeof rawSource.value === "string" ? rawSource.value.trim() : "";
  const op = typeof rawSource.operator === "string" ? rawSource.operator : "";
  const method = normalizeMethod(rawSource.method);

  if (op === "contains") {
    return { operator: "wildcard", value: value ? "*" + value + "*" : "", method };
  }
  if (op === "equals") {
    return { operator: "wildcard", value, method };
  }
  if (op === "regex") {
    return { operator: "regex", value, method };
  }
  return { operator: "wildcard", value, method };
}

function normalizeRule(rule, fallbackIndex, usedIds) {
  const type = rule && rule.type === "script" ? "script" : "redirect";
  const source = normalizeSource(rule && rule.source);

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

function sanitizeSettings(raw) {
  const base = { enabled: true, presets: { cors: false, csp: false, xfo: false } };
  if (!raw || typeof raw !== "object") return base;
  if (typeof raw.enabled === "boolean") base.enabled = raw.enabled;
  if (raw.presets && typeof raw.presets === "object") {
    for (const key of Object.keys(base.presets)) {
      if (typeof raw.presets[key] === "boolean") base.presets[key] = raw.presets[key];
    }
  }
  return base;
}

function ruleImportSignature(rule) {
  return JSON.stringify([
    rule.type,
    rule.source.operator,
    rule.source.value,
    rule.source.method,
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

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return sanitizeSettings(settings);
}

// Serialize all rule/setting mutations so concurrent messages (e.g. rapid toggles)
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
  const settings = await getSettings();
  await chrome.storage.local.set({ rules: sanitized });
  await syncDnrRules(sanitized, settings);
  return sanitized;
}

async function setSettings(settings) {
  const sanitized = sanitizeSettings(settings);
  const rules = await getRules();
  await chrome.storage.local.set({ settings: sanitized });
  await syncDnrRules(rules, sanitized);
  return sanitized;
}

async function mutateRules(mutator) {
  return withRulesLock(async () => {
    const current = await getRules();
    const next = await mutator(current);
    return setRules(next);
  });
}

async function mutateSettings(mutator) {
  return withRulesLock(async () => {
    const current = await getSettings();
    const next = await mutator(current);
    return setSettings(next);
  });
}

// ── URL matching ─────────────────────────────────────────────────────

function matchSource(source, url) {
  if (!source || typeof source.value !== "string" || !source.value) return false;
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

function escapeRegexLiteral(value) {
  return value.replace(/([.+?^${}()|[\]\\])/g, "\\$1");
}

function wildcardToRegex(pattern) {
  return "^" + escapeRegexLiteral(pattern).replace(/\*/g, "(.*)") + "$";
}

function buildSourceRegexFilter(source) {
  if (!source || typeof source.value !== "string" || !source.value) return null;

  switch (source.operator) {
    case "contains":
      return "^.*" + escapeRegexLiteral(source.value) + ".*$";
    case "equals":
      return "^" + escapeRegexLiteral(source.value) + "$";
    case "regex":
      return source.value;
    case "wildcard":
    default:
      return wildcardToRegex(source.value);
  }
}

async function buildRedirectDnrRule(rule, id) {
  const regexFilter = buildSourceRegexFilter(rule.source);
  if (!regexFilter) {
    console.error("[Detour] Skipping redirect rule with empty source:", rule.id);
    return null;
  }

  const support = await chrome.declarativeNetRequest.isRegexSupported({ regex: regexFilter });
  if (!support.isSupported) {
    console.error("[Detour] Skipping unsupported redirect regex:", rule.id, support.reason || "unsupported");
    return null;
  }

  const regexSubstitution = rule.destination.replace(/\$(\d+)/g, "\\$1");
  const condition = {
    regexFilter,
    resourceTypes: [
      "main_frame", "sub_frame", "stylesheet", "script",
      "image", "font", "xmlhttprequest", "other",
    ],
  };

  const method = normalizeMethod(rule.source && rule.source.method);
  if (method !== "ALL" && DNR_METHOD_LOOKUP[method]) {
    condition.requestMethods = [DNR_METHOD_LOOKUP[method]];
  }

  return {
    id,
    priority: 1,
    action: { type: "redirect", redirect: { regexSubstitution } },
    condition,
  };
}

function buildPresetRules(presets) {
  const rules = [];

  if (presets.cors) {
    rules.push({
      id: PRESET_IDS.cors,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { operation: "set", header: "access-control-allow-origin", value: "*" },
          { operation: "set", header: "access-control-allow-methods", value: "*" },
          { operation: "set", header: "access-control-allow-headers", value: "*" },
          { operation: "set", header: "access-control-expose-headers", value: "*" },
          // access-control-allow-credentials cannot coexist with "*" origin,
          // so we remove it to keep the "*" path valid. Credentialed CORS
          // requests still fail — document this caveat in the UI.
          { operation: "remove", header: "access-control-allow-credentials" },
        ],
      },
      condition: {
        urlFilter: "|http*",
        resourceTypes: ["xmlhttprequest", "sub_frame", "main_frame", "script", "stylesheet", "font", "other"],
      },
    });
  }

  if (presets.csp) {
    rules.push({
      id: PRESET_IDS.csp,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { operation: "remove", header: "content-security-policy" },
          { operation: "remove", header: "content-security-policy-report-only" },
          { operation: "remove", header: "x-webkit-csp" },
          { operation: "remove", header: "x-content-security-policy" },
        ],
      },
      condition: {
        urlFilter: "|http*",
        resourceTypes: ["main_frame", "sub_frame"],
      },
    });
  }

  if (presets.xfo) {
    rules.push({
      id: PRESET_IDS.xfo,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { operation: "remove", header: "x-frame-options" },
          { operation: "remove", header: "frame-options" },
        ],
      },
      condition: {
        urlFilter: "|http*",
        resourceTypes: ["main_frame", "sub_frame"],
      },
    });
  }

  return rules;
}

async function syncDnrRules(rules, settings) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = [];

  if (settings.enabled) {
    let nextId = 1;
    for (const rule of rules) {
      if (!rule.enabled || rule.type !== "redirect" || !rule.destination) continue;
      if (nextId > USER_RULE_ID_MAX) {
        console.error("[Detour] Too many user rules, dropping remainder:", rule.id);
        break;
      }
      const dnrRule = await buildRedirectDnrRule(rule, nextId);
      if (!dnrRule) continue;
      addRules.push(dnrRule);
      nextId += 1;
    }
  }

  // Presets are independent of the master toggle: the master gates user rules,
  // preset switches stand on their own.
  addRules.push(...buildPresetRules(settings.presets));

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
const SCRIPT_FETCH_TIMEOUT_MS = 10_000;
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
const ACTION_BADGE_COLOR = "#2A7598";
const TAB_EXECUTIONS_STORAGE_KEY = "tabExecutions";

function isHttpUrl(urlStr) {
  if (typeof urlStr !== "string") return false;
  return urlStr.startsWith("http://") || urlStr.startsWith("https://");
}

// Track which rules fired on which tab for badge + popup display
// Shape: { tabId: { ruleId: { count, lastUrl, time } } }
const tabExecutions = new Map();
let tabExecutionsReady = hydrateTabExecutions();

function serializeTabExecutions() {
  const stored = {};
  for (const [tabId, executions] of tabExecutions.entries()) {
    stored[String(tabId)] = executions;
  }
  return stored;
}

async function persistTabExecutions() {
  try {
    await chrome.storage.session.set({
      [TAB_EXECUTIONS_STORAGE_KEY]: serializeTabExecutions(),
    });
  } catch (error) {
    console.error("[Detour] Failed to persist tab executions:", error.message);
  }
}

async function hydrateTabExecutions() {
  try {
    const data = await chrome.storage.session.get(TAB_EXECUTIONS_STORAGE_KEY);
    const stored = data[TAB_EXECUTIONS_STORAGE_KEY];

    if (stored && typeof stored === "object") {
      for (const [tabId, executions] of Object.entries(stored)) {
        const parsedTabId = Number(tabId);
        if (!Number.isInteger(parsedTabId) || !executions || typeof executions !== "object") continue;
        tabExecutions.set(parsedTabId, executions);
      }
    }

    for (const tabId of Array.from(tabExecutions.keys())) {
      try {
        await chrome.tabs.get(tabId);
        updateBadge(tabId);
      } catch {
        tabExecutions.delete(tabId);
      }
    }

    await persistTabExecutions();
  } catch (error) {
    console.error("[Detour] Failed to hydrate tab executions:", error.message);
  }
}

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
  void persistTabExecutions();
}

function clearTabExecutions(tabId) {
  tabExecutions.delete(tabId);
  updateBadge(tabId);
  void persistTabExecutions();
}

function swallowNoTab(error) {
  // The badge APIs return promises that reject if the tab no longer exists
  // (common when a navigation or onRemoved event races with teardown).
  // Any such rejection is harmless — the badge is gone with the tab.
  const message = error && error.message ? error.message : String(error);
  if (!/No tab with id/i.test(message)) {
    console.debug("[Detour] updateBadge failed:", message);
  }
}

function updateBadge(tabId) {
  const tab = tabExecutions.get(tabId);
  const count = tab ? Object.keys(tab).length : 0;
  const text = count > 0 ? String(count) : "";

  const textResult = chrome.action.setBadgeText({ text, tabId });
  if (textResult && typeof textResult.catch === "function") textResult.catch(swallowNoTab);

  if (count > 0) {
    const colorResult = chrome.action.setBadgeBackgroundColor({ color: ACTION_BADGE_COLOR, tabId });
    if (colorResult && typeof colorResult.catch === "function") colorResult.catch(swallowNoTab);
  }
}

async function handleBeforeNavigate(details) {
  await tabExecutionsReady;

  if (details.frameId === 0) {
    clearTabExecutions(details.tabId);
  }

  if (!isHttpUrl(details.url)) return;

  const settings = await getSettings();
  if (!settings.enabled) return;

  const rules = await getRules();
  for (const rule of rules) {
    if (!rule.enabled || rule.type !== "redirect") continue;
    // Main-frame navigations are always GET, so only GET/ALL rules apply.
    const method = normalizeMethod(rule.source && rule.source.method);
    if (method !== "ALL" && method !== "GET") continue;
    if (matchSource(rule.source, details.url)) {
      recordExecution(details.tabId, rule.id, details.url);
    }
  }
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  void handleBeforeNavigate(details);
});

// SPAs that rewrite history via pushState/replaceState never fire
// onBeforeNavigate, so badge counts would otherwise stick across client-side
// route changes. Clear on main-frame history updates to match hard-nav behavior.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  void tabExecutionsReady.then(() => clearTabExecutions(details.tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // The tab is already gone, so skip updateBadge — touching a dead tabId
  // rejects with "No tab with id". Just drop the bookkeeping.
  tabExecutions.delete(tabId);
  void persistTabExecutions();
});

async function fetchScriptText(url) {
  const now = Date.now();
  const cached = scriptCache.get(url);
  if (cached && now - cached.time <= SCRIPT_CACHE_TTL_MS) {
    // Refresh LRU position so hot entries aren't evicted before cold ones.
    scriptCache.delete(url);
    scriptCache.set(url, cached);
    return cached.text;
  }
  if (cached) {
    scriptCache.delete(url);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SCRIPT_FETCH_TIMEOUT_MS);
  try {
    // credentials: "omit" — SW fetches run with user cookies by default;
    // this extension fetches arbitrary user-supplied URLs, so we avoid
    // leaking auth to them.
    const resp = await fetch(url, { signal: controller.signal, credentials: "omit" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const declared = Number(resp.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_SCRIPT_BYTES) {
      throw new Error(`script too large: ${declared} bytes`);
    }

    const text = await resp.text();
    if (text.length > MAX_SCRIPT_BYTES) {
      throw new Error(`script too large: ${text.length} bytes`);
    }

    scriptCache.set(url, { text, time: now });
    pruneScriptCache(now);
    return text;
  } catch (e) {
    const reason = e.name === "AbortError" ? `timeout after ${SCRIPT_FETCH_TIMEOUT_MS}ms` : e.message;
    console.error("[Detour] Failed to fetch script:", url, reason);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (!isHttpUrl(details.url)) return;

  await tabExecutionsReady;
  const settings = await getSettings();
  if (!settings.enabled) return;

  const rules = await getRules();
  const url = details.url;
  const target = { tabId: details.tabId, frameIds: [details.frameId] };

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
  const stored = await chrome.storage.local.get(["rules", "settings"]);
  const rules = stored.rules ? sanitizeRules(stored.rules) : DEFAULT_RULES;
  const settings = sanitizeSettings(stored.settings);

  await chrome.storage.local.set({ rules, settings });
  await syncDnrRules(rules, settings);
});

// ── Messaging ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    let rules;
    let settings;

    switch (message.type) {
      case "getState":
        rules = await getRules();
        settings = await getSettings();
        sendResponse({ rules, settings });
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

      case "setMasterEnabled": {
        const desired = !!message.enabled;
        settings = await mutateSettings((current) => ({ ...current, enabled: desired }));
        sendResponse({ settings });
        break;
      }

      case "setPreset": {
        const key = message.key;
        if (key !== "cors" && key !== "csp" && key !== "xfo") {
          sendResponse({ error: "unknown preset" });
          break;
        }
        const desired = !!message.enabled;
        settings = await mutateSettings((current) => ({
          ...current,
          presets: { ...current.presets, [key]: desired },
        }));
        sendResponse({ settings });
        break;
      }

      case "recordExecutionFromPage":
        if (!sender.tab || typeof message.ruleId !== "string" || !message.ruleId) {
          sendResponse({ error: "invalid execution payload" });
          break;
        }
        await tabExecutionsReady;
        rules = await getRules();
        const executionUrl = typeof message.url === "string" ? message.url : sender.tab.url || "";
        const matchedRule = rules.find((rule) =>
          rule.id === message.ruleId &&
          rule.enabled &&
          rule.type === "redirect" &&
          matchSource(rule.source, executionUrl)
        );
        if (!matchedRule) {
          sendResponse({ error: "invalid execution payload" });
          break;
        }
        recordExecution(sender.tab.id, message.ruleId, executionUrl);
        sendResponse({ ok: true });
        break;

      case "getExecutions": {
        await tabExecutionsReady;
        const execs = tabExecutions.get(message.tabId) || {};
        sendResponse({ executions: execs });
        break;
      }

      default:
        sendResponse({ error: "unknown message type" });
    }
  })().catch((error) => {
    console.error("[Detour] Message handler failed:", error.message);
    sendResponse({ error: error.message || String(error) });
  });
  return true;
});
