/**
 * Detour — Page Script (MAIN world, document_start)
 *
 * Patches fetch and XMLHttpRequest immediately before app scripts run.
 * Rules are read lazily at call-time from window.__REQUEST_RULES_REDIRECTS__.
 */
(function () {
  "use strict";

  function wildcardToRegex(pattern) {
    var escaped = pattern.replace(/([.+?^=!:${}()|[\]/\\])/g, "\\$1");
    return new RegExp("^" + escaped.replace(/\*/g, "(.*)") + "$");
  }

  function getRedirectUrl(url) {
    // Read rules at call-time — they may not exist yet at patch-time
    var rules = window.__REQUEST_RULES_REDIRECTS__;
    if (!rules || !rules.length) return null;

    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var match = url.match(wildcardToRegex(rule.source));
      if (match) {
        var dest = rule.destination;
        for (var j = 1; j < match.length; j++) {
          dest = dest.replace("$" + j, match[j] || "");
        }
        return dest;
      }
    }
    return null;
  }

  // ── Patch fetch immediately ───────────────────────────────────────
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    var url = input instanceof Request ? input.url : String(input);
    var redirect = getRedirectUrl(url);
    if (redirect) {
      console.debug("[Detour] fetch %s \u2192 %s", url, redirect);
      input = input instanceof Request ? new Request(redirect, input) : redirect;
    }
    return _fetch.call(this, input, init);
  };

  // ── Patch XHR immediately ─────────────────────────────────────────
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var redirect = getRedirectUrl(String(url));
    if (redirect) {
      console.debug("[Detour] XHR %s \u2192 %s", url, redirect);
      arguments[1] = redirect;
    }
    return _xhrOpen.apply(this, arguments);
  };

  console.debug("[Detour] fetch/XHR interceptor patched (rules checked lazily at call-time)");
})();
