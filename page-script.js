/**
 * Detour — Page Script (MAIN world, document_start)
 *
 * Patches fetch and XMLHttpRequest immediately before app scripts run, then
 * receives the redirect ruleset from loader.js via window.postMessage.
 *
 * postMessage is used rather than an inline <script> bridge because strict-CSP
 * pages (GitHub and many SaaS apps) block inline script execution.
 * postMessage is allowed regardless of CSP.
 */
(function () {
  "use strict";

  var MESSAGE_SOURCE = "detour";
  var RULES_READY_TYPE = "__DETOUR_RULES_READY__";
  var RECORD_REDIRECT_EVENT = "__DETOUR_REDIRECT_EXECUTION__";
  var RULES_READY_TIMEOUT_MS = 250;

  var currentRules = [];
  var rulesReady = false;
  var resolveRulesReady = null;
  var rulesReadyPromise = new Promise(function (resolve) {
    resolveRulesReady = resolve;
  });

  function markRulesReady() {
    if (rulesReady) return;
    rulesReady = true;
    if (typeof resolveRulesReady === "function") {
      resolveRulesReady();
      resolveRulesReady = null;
    }
  }

  // Loader (ISOLATED world) posts the ruleset via window.postMessage. Filter
  // strictly by source+type so unrelated page traffic doesn't poison our state.
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.source !== MESSAGE_SOURCE || data.type !== RULES_READY_TYPE) return;
    currentRules = Array.isArray(data.rules) ? data.rules : [];
    markRulesReady();
  });

  window.setTimeout(function () {
    if (rulesReady) return;
    console.warn("[Detour] Timed out waiting for redirect rules; continuing without them");
    markRulesReady();
  }, RULES_READY_TIMEOUT_MS);

  function escapeRegex(pattern) {
    return pattern.replace(/([.+?^${}()|[\]\\])/g, "\\$1");
  }

  function wildcardToRegex(pattern) {
    return new RegExp("^" + escapeRegex(pattern).replace(/\*/g, "(.*)") + "$");
  }

  function matchRule(url, rule) {
    var source = rule && typeof rule.source === "string" ? rule.source : "";
    if (!source) return null;

    switch (rule.operator) {
      case "contains":
        return url.indexOf(source) !== -1 ? [url] : null;
      case "equals":
        return url === source ? [url] : null;
      case "regex":
        try {
          return new RegExp(source).exec(url);
        } catch (error) {
          console.warn("[Detour] Invalid redirect regex:", source, error.message);
          return null;
        }
      case "wildcard":
      default:
        return url.match(wildcardToRegex(source));
    }
  }

  function normalizeMethod(raw, fallback) {
    if (typeof raw !== "string") return fallback || "GET";
    return raw.toUpperCase();
  }

  function methodMatches(ruleMethod, requestMethod) {
    if (!ruleMethod || ruleMethod === "ALL") return true;
    return ruleMethod === requestMethod;
  }

  function applyCaptures(destination, match) {
    return String(destination || "").replace(/\$(\d+)/g, function (_token, groupIndex) {
      var captured = match && match[Number(groupIndex)];
      return captured === undefined || captured === null ? "" : String(captured);
    });
  }

  function getRedirectDetails(url, method) {
    if (!currentRules.length) return null;
    var requestMethod = normalizeMethod(method, "GET");

    for (var i = 0; i < currentRules.length; i++) {
      var rule = currentRules[i];
      if (!methodMatches(normalizeMethod(rule.method, "ALL"), requestMethod)) continue;
      var match = matchRule(url, rule);
      if (!match) continue;

      return {
        ruleId: rule.id,
        redirectUrl: applyCaptures(rule.destination, match),
      };
    }

    return null;
  }

  function recordRedirectExecution(ruleId, url, redirectUrl) {
    if (!ruleId) return;
    window.dispatchEvent(new CustomEvent(RECORD_REDIRECT_EVENT, {
      detail: {
        ruleId: ruleId,
        url: url,
        redirectUrl: redirectUrl,
      },
    }));
  }

  function resolveFetchMethod(input, init) {
    if (init && typeof init.method === "string") return init.method.toUpperCase();
    if (input instanceof Request && typeof input.method === "string") return input.method.toUpperCase();
    return "GET";
  }

  function resolveFetchRedirect(context, input, init) {
    var url = input instanceof Request ? input.url : String(input);
    var method = resolveFetchMethod(input, init);
    var redirect = getRedirectDetails(url, method);
    if (redirect) {
      console.debug("[Detour] fetch %s %s → %s", method, url, redirect.redirectUrl);
      recordRedirectExecution(redirect.ruleId, url, redirect.redirectUrl);
      input = input instanceof Request ? new Request(redirect.redirectUrl, input) : redirect.redirectUrl;
    }
    return _fetch.call(context, input, init);
  }

  // ── Patch fetch immediately ───────────────────────────────────────
  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    var context = this;
    if (rulesReady) {
      return resolveFetchRedirect(context, input, init);
    }
    return rulesReadyPromise.then(function () {
      return resolveFetchRedirect(context, input, init);
    });
  };

  // ── Patch XHR immediately ─────────────────────────────────────────
  var _xhrOpen = XMLHttpRequest.prototype.open;
  var _xhrSend = XMLHttpRequest.prototype.send;
  var _xhrAbort = XMLHttpRequest.prototype.abort;
  var _xhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  var _xhrOverrideMimeType = XMLHttpRequest.prototype.overrideMimeType;

  function openPendingRequest(xhr) {
    if (!xhr.__detourOpenArgs__ || xhr.__detourOpened__ || xhr.__detourAborted__) {
      return undefined;
    }

    var args = xhr.__detourOpenArgs__.slice();
    var method = typeof args[0] === "string" ? args[0].toUpperCase() : "GET";
    var url = String(args[1]);
    var redirect = getRedirectDetails(url, method);

    if (redirect) {
      console.debug("[Detour] XHR %s %s \u2192 %s", method, url, redirect.redirectUrl);
      args[1] = redirect.redirectUrl;
    }

    var result = _xhrOpen.apply(xhr, args);
    xhr.__detourOpened__ = true;

    if (xhr.__detourMimeType !== null && xhr.__detourMimeType !== undefined) {
      _xhrOverrideMimeType.call(xhr, xhr.__detourMimeType);
    }

    var headers = xhr.__detourHeaders__ || [];
    for (var i = 0; i < headers.length; i++) {
      _xhrSetRequestHeader.call(xhr, headers[i][0], headers[i][1]);
    }
    xhr.__detourHeaders__ = [];

    if (redirect) {
      recordRedirectExecution(redirect.ruleId, url, redirect.redirectUrl);
    }

    return result;
  }

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__detourOpenArgs__ = Array.prototype.slice.call(arguments);
    this.__detourHeaders__ = [];
    this.__detourOpened__ = false;
    this.__detourAborted__ = false;
    this.__detourAsync__ = arguments.length < 3 ? true : arguments[2] !== false;
    this.__detourMimeType = null;

    if (rulesReady || !this.__detourAsync__) {
      return openPendingRequest(this);
    }

    return undefined;
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__detourOpenArgs__ && !this.__detourOpened__) {
      this.__detourHeaders__.push([name, value]);
      return undefined;
    }
    return _xhrSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.overrideMimeType = function (mimeType) {
    if (this.__detourOpenArgs__ && !this.__detourOpened__) {
      this.__detourMimeType = mimeType;
      return undefined;
    }
    return _xhrOverrideMimeType.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;

    if (xhr.__detourOpenArgs__ && !xhr.__detourOpened__) {
      if (rulesReady || !xhr.__detourAsync__) {
        openPendingRequest(xhr);
        if (xhr.__detourAborted__) return undefined;
        return _xhrSend.call(xhr, body);
      }

      rulesReadyPromise.then(function () {
        if (xhr.__detourAborted__) return;
        openPendingRequest(xhr);
        if (xhr.__detourAborted__) return;
        _xhrSend.call(xhr, body);
      });
      return undefined;
    }

    return _xhrSend.call(xhr, body);
  };

  XMLHttpRequest.prototype.abort = function () {
    if (this.__detourOpenArgs__ && !this.__detourOpened__) {
      this.__detourAborted__ = true;
      this.__detourHeaders__ = [];
      this.__detourMimeType = null;
      this.__detourOpenArgs__ = null;
      return undefined;
    }
    return _xhrAbort.apply(this, arguments);
  };

  console.debug("[Detour] fetch/XHR interceptor patched (rules checked lazily at call-time)");
})();
