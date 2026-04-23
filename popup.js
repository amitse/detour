/* Detour — Popup / DevTools panel UI
 *
 * Shared by popup.html (toolbar popup) and panel.html (DevTools panel). Surface
 * detection: chrome.devtools is defined only inside DevTools pages, so we use
 * its presence to pick the tab-resolution strategy.
 */

// Points at the published rules schema. Exports include this so editors
// (VS Code, etc.) that understand `$schema` validate the file automatically.
// The schema itself ships with the extension at rules.schema.json.
var RULES_SCHEMA_URL = "https://raw.githubusercontent.com/amitse/detour/main/rules.schema.json";

var SURFACE = (typeof chrome !== "undefined" && chrome.devtools && chrome.devtools.inspectedWindow)
  ? "panel" : "popup";

var allRules = [];
var globalSettings = { enabled: true, presets: { cors: false, csp: false, xfo: false } };
var editingId = null;
// Preserved from the rule being edited so legacy regex rules don't get
// silently downgraded to wildcard when someone saves. New rules start as
// "wildcard" — the only operator the UI ever creates.
var editingOperator = "wildcard";
var editScripts = [];
var currentTabId = null;
var currentTabUrl = "";
var executions = {}; // { ruleId: { count, lastUrl, time } }
var isImporting = false;

function cloneAttrs(attrs) {
  var copy = {};
  var hasValue = false;
  for (var key in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
    copy[key] = attrs[key];
    hasValue = true;
  }
  return hasValue ? copy : null;
}

function cloneScriptEntry(entry) {
  if (!entry || typeof entry.src !== "string") return null;
  var script = { src: entry.src };
  if (entry.attrs && typeof entry.attrs === "object" && !Array.isArray(entry.attrs)) {
    var attrs = cloneAttrs(entry.attrs);
    if (attrs) script.attrs = attrs;
  }
  return script;
}

function formatScriptAttrs(attrs) {
  if (!attrs || typeof attrs !== "object") return "";
  var parts = [];
  for (var key in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
    var value = attrs[key];
    parts.push(value === "" || value === null || value === undefined
      ? key
      : key + "=" + value);
  }
  return parts.join(" \u00b7 ");
}

function setToggleAriaLabel(input, ruleName, enabled) {
  input.setAttribute("aria-label", (enabled ? "Disable " : "Enable ") + 'rule "' + ruleName + '"');
}

function getErrorMessage(error) {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return String(error);
}

function showError(prefix, error) {
  alert(prefix + ": " + getErrorMessage(error));
}

// ── Messaging ───────────────────────────────────────────────────────

function send(msg) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(msg, function (response) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response && response.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

function setImportState(importing) {
  isImporting = importing;
  var button = document.getElementById("btn-import");
  if (!button) return;
  button.disabled = importing;
  button.textContent = importing ? "Importing…" : "Import rules";
}

// ── Tab resolution ──────────────────────────────────────────────────

function getCurrentTab() {
  return new Promise(function (resolve) {
    if (SURFACE === "panel") {
      var tabId = chrome.devtools.inspectedWindow.tabId;
      chrome.tabs.get(tabId, function (tab) {
        if (chrome.runtime.lastError || !tab) resolve(null);
        else resolve(tab);
      });
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

// ── Views ───────────────────────────────────────────────────────────

var listView = document.getElementById("list-view");
var editView = document.getElementById("edit-view");

function showList() {
  listView.classList.remove("hidden");
  editView.classList.add("hidden");
  renderRules();
}

function showEdit(rule, defaultType) {
  listView.classList.add("hidden");
  editView.classList.remove("hidden");

  editingId = rule ? rule.id : null;
  document.getElementById("edit-title").textContent = rule
    ? "Edit rule"
    : (defaultType === "script" ? "New script" : "New redirect");
  document.getElementById("btn-delete").classList.toggle("hidden", !rule);

  document.getElementById("f-name").value = rule ? rule.name : "";
  document.getElementById("f-type").value = rule ? rule.type : (defaultType || "redirect");
  // Operator is no longer user-selectable — new rules are always wildcard,
  // and existing rules preserve whatever operator they were loaded with
  // (only legacy regex rules still carry a non-wildcard operator after
  // normalizeSource in the service worker runs).
  editingOperator = rule && rule.source && rule.source.operator ? rule.source.operator : "wildcard";
  document.getElementById("f-source").value = rule && rule.source ? rule.source.value : "";
  document.getElementById("f-method").value = rule && rule.source && rule.source.method
    ? rule.source.method : "ALL";
  document.getElementById("f-destination").value = rule ? rule.destination || "" : "";
  editScripts = [];
  if (rule && rule.scripts) {
    for (var i = 0; i < rule.scripts.length; i++) {
      var cloned = cloneScriptEntry(rule.scripts[i]);
      if (cloned) editScripts.push(cloned);
    }
  }

  updateTypeFields();
  renderScriptList();
  updateHints();
  document.getElementById("f-name").focus();
}

function updateTypeFields() {
  var type = document.getElementById("f-type").value;
  document.getElementById("redirect-fields").classList.toggle("hidden", type !== "redirect");
  document.getElementById("script-fields").classList.toggle("hidden", type !== "script");
  // Script rules fire on webNavigation.onCommitted (always GET on main frame);
  // method filter is meaningless, so hide it for script type.
  var methodField = document.getElementById("method-field");
  if (methodField) methodField.classList.toggle("hidden", type !== "redirect");
}

// ── Render rule list ────────────────────────────────────────────────

var TYPE_ICONS = {
  redirect:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M2.75 11.75h5V5.75h3.75" />' +
      '<path d="m9.25 3.5 2.75 2.25-2.75 2.25" />' +
    '</svg>',
  script:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="m5.5 5 -3 3 3 3" />' +
      '<path d="m10.5 5 3 3 -3 3" />' +
    '</svg>',
};

function getMethod(rule) {
  return rule.source && rule.source.method ? rule.source.method : "ALL";
}

function stripProto(s) {
  return String(s || "").replace(/https?:\/\//g, "");
}

function getDetailText(rule) {
  // Plain-text version used for the `title` attribute (so the tooltip shows
  // the full, untruncated content when the visible text ellipsizes).
  var method = getMethod(rule);
  var prefix = method !== "ALL" ? method + " " : "";
  if (rule.type === "redirect") {
    return prefix + stripProto(rule.source.value) + " \u2192 " + stripProto(rule.destination || "");
  }
  if (rule.type === "script") {
    return prefix + (rule.scripts || []).map(function (s) { return s.src.split("/").pop(); }).join(", ");
  }
  return rule.source ? rule.source.value : "";
}

// Render the detail row into pre-built spans so CSS can truncate the source
// (left-hand, usually longer) while preserving the destination (right-hand,
// the load-bearing answer to "where does this go?").
function fillDetail(container, rule) {
  container.textContent = "";
  var method = getMethod(rule);

  if (method !== "ALL") {
    var m = document.createElement("span");
    m.className = "rule-method";
    m.textContent = method;
    container.appendChild(m);
  }

  if (rule.type === "redirect") {
    var src = document.createElement("span");
    src.className = "rule-src";
    src.textContent = stripProto(rule.source.value);
    var arrow = document.createElement("span");
    arrow.className = "rule-arrow";
    arrow.textContent = "\u2192";
    var dst = document.createElement("span");
    dst.className = "rule-dst";
    dst.textContent = stripProto(rule.destination || "");
    container.appendChild(src);
    container.appendChild(arrow);
    container.appendChild(dst);
  } else if (rule.type === "script") {
    var scripts = (rule.scripts || []).map(function (s) { return s.src.split("/").pop(); }).join(", ");
    var single = document.createElement("span");
    single.className = "rule-src";
    single.textContent = scripts;
    container.appendChild(single);
  }
}

function renderRules() {
  var redirectContainer = document.getElementById("rules-redirect");
  var scriptContainer = document.getElementById("rules-script");
  if (redirectContainer) redirectContainer.innerHTML = "";
  if (scriptContainer) scriptContainer.innerHTML = "";

  var redirectCount = 0;
  var scriptCount = 0;

  for (var i = 0; i < allRules.length; i++) {
    (function (rule) {
      var container = rule.type === "script" ? scriptContainer : redirectContainer;
      if (!container) return;
      if (rule.type === "script") scriptCount++;
      else redirectCount++;
      var row = document.createElement("li");
      row.className = "rule-row";
      row.setAttribute("data-type", rule.type || "");
      if (!rule.enabled) {
        row.classList.add("is-disabled");
      }

      var openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "rule-open";
    openButton.setAttribute("aria-label", 'Edit rule "' + (rule.name || "untitled") + '"');
      openButton.addEventListener("click", function () { showEdit(rule); });

      var icon = document.createElement("span");
      icon.className = "rule-icon";
      icon.innerHTML = TYPE_ICONS[rule.type] || "";
      icon.setAttribute("aria-hidden", "true");

      // Execution indicator dot
      var execDot = document.createElement("span");
      execDot.className = "exec-dot" + (executions[rule.id] ? " fired" : "");
      execDot.setAttribute("aria-hidden", "true");

      var body = document.createElement("div");
      body.className = "rule-body";

      var name = document.createElement("div");
      name.className = "rule-name";
      var displayName = rule.name || "Untitled rule";
      name.textContent = displayName;
      name.title = displayName;

      var detail = document.createElement("div");
      detail.className = "rule-detail";
      fillDetail(detail, rule);
      detail.title = getDetailText(rule);

      body.appendChild(name);
      body.appendChild(detail);

      // Execution count badge
      var execCount = document.createElement("span");
      execCount.className = "exec-count" + (executions[rule.id] ? " visible" : "");
      if (executions[rule.id]) {
        var n = executions[rule.id].count;
        execCount.textContent = n;
        execCount.title = n === 1 ? "Executed 1 time" : "Executed " + n + " times";
        execCount.setAttribute("aria-label", execCount.title);
      }

      openButton.appendChild(execDot);
      openButton.appendChild(icon);
      openButton.appendChild(body);
      openButton.appendChild(execCount);

      var toggle = document.createElement("label");
      toggle.className = "toggle";
      toggle.addEventListener("click", function (e) { e.stopPropagation(); });

      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!rule.enabled;
      var ruleName = rule.name || "untitled";
      setToggleAriaLabel(input, ruleName, !!rule.enabled);
      input.addEventListener("change", function () {
        var desired = input.checked;
        row.classList.toggle("is-disabled", !desired);
        setToggleAriaLabel(input, ruleName, desired);
        // Send the desired state explicitly so concurrent toggles can't race
        // and cancel each other out by re-inverting stale storage state.
        send({ type: "toggleRule", ruleId: rule.id, enabled: desired }).then(function (res) {
          if (res) {
            allRules = res.rules;
            // Reconcile UI in case the server-side state diverged from the
            // optimistic update (e.g. another popup or a concurrent change).
            var updated = allRules.find(function (r) { return r.id === rule.id; });
            if (updated) {
              input.checked = !!updated.enabled;
              row.classList.toggle("is-disabled", !updated.enabled);
              setToggleAriaLabel(input, ruleName, !!updated.enabled);
              if (updated.enabled !== desired) {
                renderRules();
              }
            }
          }
        }).catch(function (error) {
          input.checked = !desired;
          row.classList.toggle("is-disabled", desired);
          setToggleAriaLabel(input, ruleName, !desired);
          showError("Could not update the rule", error);
        });
      });

      var track = document.createElement("span");
      track.className = "track";
      var knob = document.createElement("span");
      knob.className = "knob";

      toggle.appendChild(input);
      toggle.appendChild(track);
      toggle.appendChild(knob);

      row.appendChild(openButton);
      row.appendChild(toggle);
      container.appendChild(row);
    })(allRules[i]);
  }

  // Section counts — unified grammar with the Header Overrides indicator:
  // "· N" prefix. Shown only when non-zero to keep zero-state quiet.
  var countRedirect = document.getElementById("count-redirect");
  var countScript = document.getElementById("count-script");
  var redirectEnabled = allRules.filter(function (r) { return r.type === "redirect" && r.enabled; }).length;
  var scriptEnabled = allRules.filter(function (r) { return r.type === "script" && r.enabled; }).length;

  var emptyRedirect = document.getElementById("empty-redirect");
  var emptyScript = document.getElementById("empty-script");
  if (emptyRedirect) emptyRedirect.classList.toggle("hidden", redirectCount > 0);
  if (emptyScript) emptyScript.classList.toggle("hidden", scriptCount > 0);
  if (countRedirect) countRedirect.textContent = redirectCount > 0 ? "\u00b7 " + redirectEnabled + "/" + redirectCount : "";
  if (countScript) countScript.textContent = scriptCount > 0 ? "\u00b7 " + scriptEnabled + "/" + scriptCount : "";
}

// ── Script list (edit form) ─────────────────────────────────────────

function renderScriptList() {
  var list = document.getElementById("f-scripts");
  list.innerHTML = "";

  for (var i = 0; i < editScripts.length; i++) {
    (function (idx) {
      var li = document.createElement("li");
      li.className = "script-item";
      var script = editScripts[idx];

      var text = document.createElement("div");
      text.className = "script-text";

      var srcLine = document.createElement("div");
      srcLine.className = "script-src";
      srcLine.textContent = script.src;
      text.appendChild(srcLine);

      var attrsText = formatScriptAttrs(script.attrs);
      if (attrsText) {
        var attrsLine = document.createElement("div");
        attrsLine.className = "script-attrs";
        attrsLine.textContent = attrsText;
        attrsLine.title = "Attributes applied to the injected <script> element";
        text.appendChild(attrsLine);
      }

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-ghost";
      btn.textContent = "\u00d7";
      btn.setAttribute("aria-label", "Remove script " + script.src);
      btn.addEventListener("click", function () {
        editScripts.splice(idx, 1);
        renderScriptList();
      });

      li.appendChild(text);
      li.appendChild(btn);
      list.appendChild(li);
    })(i);
  }
}

// ── Collect form data ───────────────────────────────────────────────

function newRuleId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for contexts that don't expose randomUUID. The base36-random
  // tail gives ~62 bits of entropy.
  return Date.now().toString(36) + "-" +
    Math.random().toString(36).slice(2, 12) +
    Math.random().toString(36).slice(2, 12);
}

function collectRule() {
  var type = document.getElementById("f-type").value;
  var existing = editingId ? allRules.find(function (r) { return r.id === editingId; }) : null;

  return {
    id: editingId || newRuleId(),
    name: document.getElementById("f-name").value.trim(),
    type: type,
    enabled: existing ? existing.enabled : true,
    source: {
      operator: editingOperator,
      value: document.getElementById("f-source").value.trim(),
      method: document.getElementById("f-method").value || "ALL",
    },
    destination: type === "redirect" ? document.getElementById("f-destination").value.trim() : "",
    scripts: type === "script" ? editScripts.map(function (entry) { return cloneScriptEntry(entry); }).filter(Boolean) : [],
  };
}

// ── Import / Export ─────────────────────────────────────────────────

function exportRules() {
  var payload = { $schema: RULES_SCHEMA_URL, rules: allRules };
  var json = JSON.stringify(payload, null, 2);
  var blob = new Blob([json], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "request-rules-export.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 100);
}

function importRules() {
  if (isImporting) return;
  var input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.addEventListener("change", function () {
    if (!input.files.length) return;
    setImportState(true);
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        // Accept both shapes: the current wrapped form `{ $schema?, rules: [...] }`
        // and the original bare-array form. Older exports and hand-written lists
        // should keep working.
        var imported;
        if (Array.isArray(parsed)) {
          imported = parsed;
        } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.rules)) {
          imported = parsed.rules;
        } else {
          throw new Error("Expected an array of rules or an object with a \"rules\" array");
        }
        send({ type: "importRules", rules: imported }).then(function (res) {
          if (res) {
            allRules = res.rules;
            showList();
            var added = typeof res.addedCount === "number" ? res.addedCount : imported.length;
            var skipped = imported.length - added;
            if (skipped > 0) {
              alert("Imported " + added + " rule" + (added === 1 ? "" : "s") + ". Skipped " + skipped + " duplicate" + (skipped === 1 ? "" : "s") + ".");
            }
          }
          setImportState(false);
        }).catch(function (error) {
          setImportState(false);
          showError("Could not import rules", error);
        });
      } catch (e) {
        setImportState(false);
        alert("Invalid rules file: " + e.message);
      }
    };
    reader.onerror = function () {
      setImportState(false);
      alert("Could not read the selected file.");
    };
    reader.readAsText(input.files[0]);
  });
  input.click();
}

// ── Master toggle + presets ─────────────────────────────────────────

function applyGlobalSettingsToUI() {
  var masterInput = document.getElementById("master-toggle");
  if (masterInput) masterInput.checked = !!globalSettings.enabled;

  var banner = document.getElementById("master-banner");
  if (banner) banner.classList.toggle("hidden", !!globalSettings.enabled);

  var masterWrap = document.getElementById("master-toggle-wrap");
  if (masterWrap) {
    masterWrap.setAttribute(
      "title",
      globalSettings.enabled ? "Pause all rules" : "Resume all rules"
    );
  }

  var presets = globalSettings.presets || {};
  var activeCount = 0;
  ["cors", "csp", "xfo"].forEach(function (key) {
    var check = document.getElementById("preset-" + key);
    if (check) check.checked = !!presets[key];
    if (presets[key]) activeCount++;
  });

  var countEl = document.getElementById("presets-active-count");
  if (countEl) countEl.textContent = activeCount > 0 ? "\u00b7 " + activeCount + "/3" : "";
}

// Auto-expand the disclosure once on popup open if any preset is already on.
// Don't fight the user: after this initial set, their manual open/close wins.
function syncPresetDisclosureOnce() {
  var wrap = document.getElementById("presets-wrap");
  if (!wrap) return;
  var presets = globalSettings.presets || {};
  if (presets.cors || presets.csp || presets.xfo) {
    wrap.setAttribute("open", "");
  }
}

function bindMasterToggle() {
  var input = document.getElementById("master-toggle");
  if (!input) return;

  input.addEventListener("change", function () {
    var desired = input.checked;
    send({ type: "setMasterEnabled", enabled: desired }).then(function (res) {
      if (res && res.settings) {
        globalSettings = res.settings;
      } else {
        globalSettings.enabled = desired;
      }
      applyGlobalSettingsToUI();
    }).catch(function (error) {
      input.checked = !desired;
      showError("Could not update the master toggle", error);
    });
  });

  var resumeBtn = document.getElementById("btn-master-resume");
  if (resumeBtn) {
    resumeBtn.addEventListener("click", function () {
      if (globalSettings.enabled) return;
      input.checked = true;
      input.dispatchEvent(new Event("change"));
    });
  }
}

function bindPresetToggle(key) {
  var input = document.getElementById("preset-" + key);
  if (!input) return;

  input.addEventListener("change", function () {
    var desired = input.checked;
    // Optimistic local state; applyGlobalSettingsToUI reconciles after the
    // service worker responds.
    globalSettings.presets = Object.assign({}, globalSettings.presets);
    globalSettings.presets[key] = desired;

    send({ type: "setPreset", key: key, enabled: desired }).then(function (res) {
      if (res && res.settings) {
        globalSettings = res.settings;
        applyGlobalSettingsToUI();
      }
    }).catch(function (error) {
      input.checked = !desired;
      globalSettings.presets[key] = !desired;
      showError("Could not update preset", error);
    });
  });
}

// ── Event bindings ──────────────────────────────────────────────────

document.getElementById("btn-add-redirect").addEventListener("click", function () { showEdit(null, "redirect"); });
document.getElementById("btn-new-script").addEventListener("click", function () { showEdit(null, "script"); });
document.getElementById("btn-back").addEventListener("click", showList);
document.getElementById("btn-cancel").addEventListener("click", showList);
document.getElementById("btn-import").addEventListener("click", importRules);
document.getElementById("btn-export").addEventListener("click", exportRules);
document.getElementById("f-type").addEventListener("change", function () {
  updateTypeFields();
  // Hint copy + examples depend on the type (script rules hide dest hint
  // and redirect-flavored examples). Re-run so switching type mid-edit
  // doesn't leave stale capture-group references on screen.
  updateHints();
});

bindMasterToggle();
bindPresetToggle("cors");
bindPresetToggle("csp");
bindPresetToggle("xfo");

// ── Hints ───────────────────────────────────────────────────────────

// Wildcard is the one operator the UI offers. Every new rule is wildcard;
// legacy regex rules still work at the backend layer but the popup never
// writes `regex` for newly-edited rules. Hints show `*` syntax only.
var WILDCARD_HINT = {
  source: 'Use <code>*</code> as a placeholder for any text. Leave it out to match the URL exactly.',
  dest: 'Each <code>*</code> in the pattern becomes <code>$1</code>, <code>$2</code>, and so on.',
  matchExamples: [
    ['<code>https://example.com/page</code>', 'Matches that URL exactly'],
    ['<code>*example.com*</code>', 'Matches any URL containing example.com'],
    ['<code>https://example.com/api/*</code>', 'Matches any path under /api/'],
    ['<code>https://*.example.com/*</code>', 'Matches any subdomain and path'],
  ],
  redirectExamples: [
    ['<code>https://source.example/api/*</code> \u2192 <code>https://target.example/mock/$1</code>', 'Redirect to a mock endpoint, preserving the path'],
  ],
};

function updateHints() {
  var type = document.getElementById("f-type").value;

  document.getElementById("hint-source").innerHTML = WILDCARD_HINT.source;
  document.getElementById("hint-dest").innerHTML = type === "redirect" ? WILDCARD_HINT.dest : "";

  var exEl = document.getElementById("hint-source-examples");
  exEl.classList.remove("visible");
  exEl.innerHTML = "";
  // Script rules see only match examples. Redirect rules also get the
  // substitution example that demos how `*` turns into `$1` in the dest.
  var examples = WILDCARD_HINT.matchExamples.slice();
  if (type === "redirect") {
    examples = examples.concat(WILDCARD_HINT.redirectExamples);
  }
  for (var i = 0; i < examples.length; i++) {
    var div = document.createElement("div");
    div.className = "hint";
    div.innerHTML = examples[i][0] + (examples[i][1] ? " \u2014 " + examples[i][1] : "");
    exEl.appendChild(div);
  }

  var toggle = document.getElementById("hint-source-toggle");
  toggle.textContent = "Examples";
  toggle.setAttribute("aria-expanded", "false");
}

document.getElementById("hint-source-toggle").addEventListener("click", function () {
  var el = document.getElementById("hint-source-examples");
  var visible = el.classList.toggle("visible");
  this.textContent = visible ? "Hide examples" : "Examples";
  this.setAttribute("aria-expanded", visible ? "true" : "false");
});

document.getElementById("btn-add-script-url").addEventListener("click", function () {
  var inp = document.getElementById("f-script-url");
  var val = inp.value.trim();
  if (val) {
    editScripts.push({ src: val });
    inp.value = "";
    renderScriptList();
  }
});

document.getElementById("btn-save").addEventListener("click", function () {
  var rule = collectRule();
  if (!rule.name) { alert("Name is required"); return; }
  if (!rule.source.value) { alert("Source URL pattern is required"); return; }
  if (rule.type === "redirect" && !rule.destination) { alert("Destination URL is required"); return; }
  if (rule.type === "script" && !rule.scripts.length) { alert("At least one script URL is required"); return; }

  send({ type: "saveRule", rule: rule }).then(function (res) {
    if (res) { allRules = res.rules; showList(); }
  }).catch(function (error) {
    showError("Could not save the rule", error);
  });
});

document.getElementById("btn-delete").addEventListener("click", function () {
  if (editingId && confirm("Delete this rule?")) {
    send({ type: "deleteRule", ruleId: editingId }).then(function (res) {
      if (res) { allRules = res.rules; showList(); }
    }).catch(function (error) {
      showError("Could not delete the rule", error);
    });
  }
});

// ── Init ────────────────────────────────────────────────────────────

getCurrentTab().then(function (tab) {
  var urlEl = document.getElementById("page-url");

  if (tab) {
    currentTabId = tab.id;
    currentTabUrl = tab.url || "";
    var display = currentTabUrl.replace(/^https?:\/\//, "").replace(/\?.*$/, "");
    if (display) {
      urlEl.textContent = display;
      urlEl.title = currentTabUrl;
      urlEl.removeAttribute("data-empty");
    } else {
      urlEl.textContent = "No page selected";
      urlEl.setAttribute("data-empty", "true");
    }
  } else {
    urlEl.textContent = "No page selected";
    urlEl.setAttribute("data-empty", "true");
  }

  // Executions + rules are independent — fetch both in parallel to halve
  // open time. getExecutions only needs a tabId; if we don't have one, skip.
  var requests = [send({ type: "getState" })];
  if (currentTabId) requests.push(send({ type: "getExecutions", tabId: currentTabId }));

  Promise.all(requests).then(function (results) {
    var stateRes = results[0];
    var execRes = results[1];
    if (stateRes) {
      allRules = stateRes.rules || [];
      if (stateRes.settings) globalSettings = stateRes.settings;
    }
    if (execRes) executions = execRes.executions || {};
    applyGlobalSettingsToUI();
    syncPresetDisclosureOnce();
    renderRules();
  }).catch(function (error) {
    showError("Could not load rule state", error);
  });
});
