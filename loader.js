/**
 * Detour — Loader (ISOLATED world, document_start)
 *
 * Handles redirect rules only:
 *   - Reads rules + global settings from chrome.storage
 *   - Hands them to page-script.js via window.postMessage
 *
 * We use postMessage rather than an inline <script> tag because strict-CSP
 * pages (GitHub and many SaaS apps) block inline script execution.
 * postMessage is the standard CSP-safe transport between ISOLATED-world
 * content scripts and MAIN-world scripts in the same frame.
 *
 * Script injection is handled by the service worker via
 * webNavigation.onCommitted + chrome.scripting.executeScript.
 */
(function () {
  var MESSAGE_SOURCE = "detour";
  var RULES_READY_TYPE = "__DETOUR_RULES_READY__";
  var RECORD_REDIRECT_EVENT = "__DETOUR_REDIRECT_EXECUTION__";
  var DEFAULT_RULES = [
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
      source: { operator: "contains", value: "app.example", method: "ALL" },
      destination: "",
      scripts: [{ src: "https://cdn.example/assets/mock-script.js" }],
    },
  ];

  function sendRulesToPage(redirectRules) {
    // Target "*" is fine: the payload is non-sensitive (redirect patterns
    // the user configured) and page-script filters by source + type.
    window.postMessage({
      source: MESSAGE_SOURCE,
      type: RULES_READY_TYPE,
      rules: redirectRules,
    }, "*");
  }

  window.addEventListener(RECORD_REDIRECT_EVENT, function (event) {
    var detail = event && event.detail;
    if (!detail || !detail.ruleId) return;

    chrome.runtime.sendMessage({
      type: "recordExecutionFromPage",
      ruleId: detail.ruleId,
      url: typeof detail.url === "string" ? detail.url : "",
    }, function () {
      if (chrome.runtime.lastError) {
        console.debug("[Detour] Failed to record in-page redirect:", chrome.runtime.lastError.message);
      }
    });
  });

  function computeRedirectRules(rules, settings) {
    var masterEnabled = settings && settings.enabled !== false;
    if (!masterEnabled) return [];

    var redirectRules = [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.enabled && r.type === "redirect" && r.source && r.source.value && r.destination) {
        redirectRules.push({
          id: r.id,
          source: r.source.value,
          operator: r.source.operator || "wildcard",
          method: r.source.method || "ALL",
          destination: r.destination,
        });
      }
    }
    return redirectRules;
  }

  function loadAndSend() {
    chrome.storage.local.get(["rules", "settings"], function (data) {
      var rules = Array.isArray(data.rules) ? data.rules : DEFAULT_RULES;
      var settings = data.settings && typeof data.settings === "object" ? data.settings : {};
      sendRulesToPage(computeRedirectRules(rules, settings));
    });
  }

  // Re-push rules when storage changes so master-toggle and per-rule toggles
  // take effect on in-page fetch/XHR without a page reload (DNR network
  // redirects already react instantly; this closes the gap for the patch).
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (!changes.rules && !changes.settings) return;
    loadAndSend();
  });

  loadAndSend();
})();
