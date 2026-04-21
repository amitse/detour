/**
 * Detour — Loader (ISOLATED world, document_start)
 *
 * Handles redirect rules only:
 *   - Reads rules from chrome.storage
 *   - Sets window.__REQUEST_RULES_REDIRECTS__ for page-script.js
 *
 * Script injection is handled by the service worker via
 * webNavigation.onCommitted + chrome.scripting.executeScript.
 */
(function () {
  chrome.storage.local.get("rules", function (data) {
    var rules = data.rules || [];
    var root = document.documentElement;
    if (!root) return;

    var redirectRules = [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.enabled && r.type === "redirect" && r.destination) {
        redirectRules.push({
          source: r.source.value,
          operator: r.source.operator || "wildcard",
          destination: r.destination,
        });
      }
    }

    if (redirectRules.length > 0) {
      var tag = document.createElement("script");
      tag.textContent =
        "window.__REQUEST_RULES_REDIRECTS__=" +
        JSON.stringify(redirectRules) + ";";
      root.appendChild(tag);
      tag.remove();
    }
  });
})();
