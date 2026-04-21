/* Detour — Popup */

var allRules = [];
var editingId = null;
var editScripts = [];
var currentTabId = null;
var currentTabUrl = "";
var executions = {}; // { ruleId: { count, lastUrl, time } }
var isImporting = false;

// ── Messaging ───────────────────────────────────────────────────────

function send(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

function setImportState(importing) {
  isImporting = importing;
  var button = document.getElementById("btn-import");
  if (!button) return;
  button.disabled = importing;
  button.textContent = importing ? "Importing..." : "Import";
}

// ── Views ───────────────────────────────────────────────────────────

var listView = document.getElementById("list-view");
var editView = document.getElementById("edit-view");

function showList() {
  listView.classList.remove("hidden");
  editView.classList.add("hidden");
  renderRules();
}

function showEdit(rule) {
  listView.classList.add("hidden");
  editView.classList.remove("hidden");

  editingId = rule ? rule.id : null;
  document.getElementById("edit-title").textContent = rule ? "Edit rule" : "New rule";
  document.getElementById("btn-delete").classList.toggle("hidden", !rule);

  document.getElementById("f-name").value = rule ? rule.name : "";
  document.getElementById("f-type").value = rule ? rule.type : "redirect";
  document.getElementById("f-operator").value = rule && rule.source ? rule.source.operator : "wildcard";
  document.getElementById("f-source").value = rule && rule.source ? rule.source.value : "";
  document.getElementById("f-destination").value = rule ? rule.destination || "" : "";
  editScripts = rule && rule.scripts ? rule.scripts.map(function (s) { return s.src; }) : [];

  updateTypeFields();
  renderScriptList();
  updateHints();
  document.getElementById("f-name").focus();
}

function updateTypeFields() {
  var type = document.getElementById("f-type").value;
  document.getElementById("redirect-fields").classList.toggle("hidden", type !== "redirect");
  document.getElementById("script-fields").classList.toggle("hidden", type !== "script");
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

function getDetail(rule) {
  if (rule.type === "redirect") {
    return (rule.source.value + " \u2192 " + (rule.destination || "")).replace(/https?:\/\//g, "");
  }
  if (rule.type === "script") {
    return (rule.scripts || []).map(function (s) { return s.src.split("/").pop(); }).join(", ");
  }
  return rule.source ? rule.source.value : "";
}

function renderRules() {
  var container = document.getElementById("rules");
  container.innerHTML = "";

  if (allRules.length === 0) {
    var empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML =
      '<div class="empty-title">No rules here yet.</div>' +
      '<div class="empty-copy">Create a redirect or script rule for the page in front of you.</div>';
    container.appendChild(empty);
    return;
  }

  for (var i = 0; i < allRules.length; i++) {
    (function (rule) {
      var row = document.createElement("div");
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
      name.textContent = rule.name || "Untitled rule";

      var detail = document.createElement("div");
      detail.className = "rule-detail";
      detail.textContent = getDetail(rule);
      detail.title = getDetail(rule);

      body.appendChild(name);
      body.appendChild(detail);

      // Execution count badge
      var execCount = document.createElement("span");
      execCount.className = "exec-count" + (executions[rule.id] ? " visible" : "");
      if (executions[rule.id]) {
        execCount.textContent = executions[rule.id].count;
        execCount.title = "Executed " + executions[rule.id].count + " time(s)";
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
      input.setAttribute("aria-label", (rule.enabled ? "Disable " : "Enable ") + 'rule "' + (rule.name || "untitled") + '"');
      input.addEventListener("change", function () {
        toggle.classList.remove("is-toggling");
        void toggle.offsetWidth;
        toggle.classList.add("is-toggling");
        setTimeout(function () { toggle.classList.remove("is-toggling"); }, 360);
        row.classList.toggle("is-disabled", !input.checked);
        send({ type: "toggleRule", ruleId: rule.id }).then(function (res) {
          if (res) allRules = res.rules;
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
}

// ── Script list (edit form) ─────────────────────────────────────────

function renderScriptList() {
  var list = document.getElementById("f-scripts");
  list.innerHTML = "";

  for (var i = 0; i < editScripts.length; i++) {
    (function (idx) {
      var li = document.createElement("li");
      li.className = "script-item";

      var span = document.createElement("span");
      span.textContent = editScripts[idx];
      span.style.flex = "1";

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-ghost";
      btn.textContent = "\u00d7";
      btn.setAttribute("aria-label", "Remove script " + editScripts[idx]);
      btn.addEventListener("click", function () {
        editScripts.splice(idx, 1);
        renderScriptList();
      });

      li.appendChild(span);
      li.appendChild(btn);
      list.appendChild(li);
    })(i);
  }
}

// ── Collect form data ───────────────────────────────────────────────

function collectRule() {
  var type = document.getElementById("f-type").value;
  var existing = editingId ? allRules.find(function (r) { return r.id === editingId; }) : null;

  return {
    id: editingId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    name: document.getElementById("f-name").value.trim(),
    type: type,
    enabled: existing ? existing.enabled : false,
    source: {
      operator: document.getElementById("f-operator").value,
      value: document.getElementById("f-source").value.trim(),
    },
    destination: type === "redirect" ? document.getElementById("f-destination").value.trim() : "",
    scripts: type === "script" ? editScripts.map(function (s) { return { src: s }; }) : [],
  };
}

// ── Import / Export ─────────────────────────────────────────────────

function exportRules() {
  var json = JSON.stringify(allRules, null, 2);
  var blob = new Blob([json], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "request-rules-export.json";
  a.click();
  URL.revokeObjectURL(url);
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
        var imported = JSON.parse(reader.result);
        if (!Array.isArray(imported)) throw new Error("Expected array");
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

// ── Event bindings ──────────────────────────────────────────────────

document.getElementById("btn-new").addEventListener("click", function () { showEdit(null); });
document.getElementById("btn-back").addEventListener("click", showList);
document.getElementById("btn-cancel").addEventListener("click", showList);
document.getElementById("btn-import").addEventListener("click", function () { closeMoreMenu(); importRules(); });
document.getElementById("btn-export").addEventListener("click", function () { closeMoreMenu(); exportRules(); });
document.getElementById("f-type").addEventListener("change", updateTypeFields);

// ── Overflow menu ───────────────────────────────────────────────────

var btnMore = document.getElementById("btn-more");
var moreMenu = document.getElementById("more-menu");

function setMoreMenuOpen(open) {
  moreMenu.classList.toggle("hidden", !open);
  btnMore.setAttribute("aria-expanded", open ? "true" : "false");
}
function closeMoreMenu() { setMoreMenuOpen(false); }

btnMore.addEventListener("click", function (e) {
  e.stopPropagation();
  setMoreMenuOpen(moreMenu.classList.contains("hidden"));
});
document.addEventListener("click", function (e) {
  if (moreMenu.classList.contains("hidden")) return;
  if (moreMenu.contains(e.target) || btnMore.contains(e.target)) return;
  closeMoreMenu();
});
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && !moreMenu.classList.contains("hidden")) closeMoreMenu();
});

// ── Hints ───────────────────────────────────────────────────────────

var HINTS = {
  wildcard: {
    source: 'Use <code>*</code> to match anything. Each <code>*</code> becomes <code>$1</code>, <code>$2</code>, and so on.',
    dest: 'Use <code>$1</code>, <code>$2</code> for the captured parts.',
    examples: [
      ['<code>https://example.com/api/*</code>', 'Matches any path under /api/'],
      ['<code>https://*.example.com/*</code>', '<code>$1</code> = subdomain, <code>$2</code> = path'],
      ['<code>https://source.example/api/*</code> \u2192 <code>https://target.example/mock/$1</code>', 'Redirects matching requests to a mock endpoint'],
    ],
  },
  contains: {
    source: 'Matches when this text appears anywhere in the URL.',
    dest: '',
    examples: [
      ['<code>example.com</code>', 'Matches any page on this domain'],
      ['<code>/chat</code>', 'Matches any URL containing /chat'],
    ],
  },
  equals: {
    source: 'Matches only when the full URL is exactly this value.',
    dest: '',
    examples: [
      ['<code>https://example.com/page</code>', 'Only this exact URL, no query params'],
    ],
  },
  regex: {
    source: 'Use a regular expression. Capturing groups <code>()</code> can be reused in the destination.',
    dest: 'Use <code>$1</code>, <code>$2</code> for captured groups.',
    examples: [
      ['<code>^https://example\\.com/old/(.*)</code> \u2192 <code>https://example.com/new/$1</code>', 'Regex redirect with capture group'],
      ['<code>app\\.example.*widget(.*)</code>', 'Escape dots with <code>\\.</code>'],
    ],
  },
};

function updateHints() {
  var op = document.getElementById("f-operator").value;
  var hint = HINTS[op] || {};
  var type = document.getElementById("f-type").value;

  document.getElementById("hint-source").innerHTML = hint.source || "";
  document.getElementById("hint-dest").innerHTML = type === "redirect" ? (hint.dest || "") : "";

  var exEl = document.getElementById("hint-source-examples");
  exEl.classList.remove("visible");
  exEl.innerHTML = "";
  if (hint.examples) {
    for (var i = 0; i < hint.examples.length; i++) {
      var div = document.createElement("div");
      div.className = "hint";
      div.innerHTML = hint.examples[i][0] + (hint.examples[i][1] ? " \u2014 " + hint.examples[i][1] : "");
      exEl.appendChild(div);
    }
  }
}

document.getElementById("hint-source-toggle").addEventListener("click", function () {
  var el = document.getElementById("hint-source-examples");
  var visible = el.classList.toggle("visible");
  this.textContent = visible ? "Hide examples" : "Examples";
  this.setAttribute("aria-expanded", visible ? "true" : "false");
});

document.getElementById("f-operator").addEventListener("change", updateHints);

document.getElementById("btn-add-script").addEventListener("click", function () {
  var inp = document.getElementById("f-script-url");
  var val = inp.value.trim();
  if (val) {
    editScripts.push(val);
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
  });
});

document.getElementById("btn-delete").addEventListener("click", function () {
  if (editingId && confirm("Delete this rule?")) {
    send({ type: "deleteRule", ruleId: editingId }).then(function (res) {
      if (res) { allRules = res.rules; showList(); }
    });
  }
});

// ── Init ────────────────────────────────────────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
  var tab = tabs && tabs[0];
  if (tab) {
    currentTabId = tab.id;
    currentTabUrl = tab.url || "";
    var urlEl = document.getElementById("page-url");
    var display = currentTabUrl.replace(/^https?:\/\//, "").replace(/\?.*$/, "");
    urlEl.textContent = display || "No page selected";
    urlEl.title = currentTabUrl;

    // Get execution data for this tab
    send({ type: "getExecutions", tabId: currentTabId }).then(function (res) {
      if (res) executions = res.executions || {};
      // Then load rules
      send({ type: "getState" }).then(function (res2) {
        if (res2) { allRules = res2.rules; renderRules(); }
      });
    });
  } else {
    send({ type: "getState" }).then(function (res) {
      if (res) { allRules = res.rules; renderRules(); }
    });
  }
});
