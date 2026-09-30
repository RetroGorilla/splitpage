import { escapeHtml } from "./02-state.js";
import { invokeFrom } from "./12-dirty-toast.js";
import {
  IS_MAC,
  fileMenuOpen,
  keyChipWords,
  keyChipsHtml,
  refreshFileMenu,
  toggleFileMenu
} from "./18b-file-menu.js";
import { EXPORT_ACTION_NAMES, exportActionReason, runExportAction } from "./18c-export-dialog.js";
import { appActions } from "../legacy/app-actions.ts";
import { askingFromLauncher, launcherShown } from "../legacy/screen.ts";

var RECENT_KEY = "splitpage-recent-commands";
var RECENT_MAX = 5;
var GROUP_ORDER = ["Recent", "Tags", "File", "Share", "Export", "View", "This document", "Help"];

function el(id) { return document.getElementById(id); }

var OWN_ACTION = "command-menu";

var EXPORT_COMMANDS = [
  ["export-pdf", "pdf print"],
  ["export-docx", "word docx document google docs"],
  ["export-md", "markdown md text stacked"],
  ["export-md-table", "markdown md table two columns side by side"],
  ["export-xlsx", "excel xlsx spreadsheet workbook sheets numbers table"],
  ["export-csv", "spreadsheet csv excel sheets table"],
  ["export-html", "splitshare share standalone page html web browser send any device app"],
  ["export-narration-docx", "narration voice over voiceover audio artist word docx"],
  ["export-narration-txt", "narration voice over voiceover audio artist text txt"],
  ["export-breakdown-xlsx", "breakdown excel xlsx spreadsheet workbook tags props locations cast list"],
  ["export-breakdown", "breakdown csv tags props locations cast list"],
  ["export-packing-gear", "packing list checklist gear equipment kit pdf"],
  ["export-packing-prop", "packing list checklist props prop pdf"],
  ["export-broll-pdf", "b-roll broll shot list shots second unit print pdf landscape"],
  ["export-broll-xlsx", "b-roll broll shot list shots excel xlsx spreadsheet workbook sheets"],
  ["export-broll-csv", "b-roll broll shot list shots spreadsheet csv excel sheets"]
];

var LIST_ORDER = [
  "save", "save-as", "save-back", "autosave", "new", "open", "server-open", "paste", "gdoc-import", "drive-open",
  "collaborate", "server-publish", "servers", "export"
].concat(EXPORT_COMMANDS.map(function (e) { return e[0]; })).concat([
  "panel-production", "panel-gear", "panel-broll", "panel-comments", "write", "present",
  "history", "find", "toggle-hide-shot", "toggle-rundown-min", "set-target",
  "prompter-open-in-browser", "prompter-open-in-chromium",
  "settings", "help", "tour", "long-demo", "setup", "about", "tagging-help", "export-app-data", "import-app-data"
]);

function exportEntry(action, words) {
  var why = exportActionReason(action);
  return {
    cmd: { id: action, group: "Export", words: "export download " + words, run: function () { runExportAction(action); } },
    view: { label: "Export as " + EXPORT_ACTION_NAMES[action], icon: "i-export", keys: "", why: why, disabled: !!why, state: "" }
  };
}

function actionEntry(view) {
  return {
    cmd: { id: view.id, group: view.group, words: view.words, run: function () { invokeFrom(view.id, "command-menu"); } },
    view: {
      label: view.label,
      icon: view.icon || "i-file",
      keys: view.keys.length ? view.keys[0] : "",
      why: view.enabled ? "" : view.reason,
      disabled: !view.enabled,
      state: view.checked === null ? "" : (view.checked ? "On" : "Off")
    }
  };
}

function listRank(id) {
  var at = LIST_ORDER.indexOf(id);
  return at === -1 ? LIST_ORDER.length : at;
}

function listedEntries() {
  var views = askingFromLauncher(function () { return appActions.list(); });
  var entries = views.filter(function (v) { return v.visible && v.id !== OWN_ACTION; }).map(actionEntry)
    .concat(EXPORT_COMMANDS.map(function (e) { return exportEntry(e[0], e[1]); }));
  return entries.map(function (entry, i) { return { entry: entry, at: i }; })
    .sort(function (a, b) { return (listRank(a.entry.cmd.id) - listRank(b.entry.cmd.id)) || (a.at - b.at); })
    .map(function (x) { return x.entry; });
}

function recentIds() {
  var list;
  try { list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch (e) { list = []; }
  return Array.isArray(list) ? list.filter(function (x) { return typeof x === "string"; }).slice(0, RECENT_MAX) : [];
}

function noteRecent(id) {
  var list = recentIds().filter(function (x) { return x !== id; });
  list.unshift(id);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch (e) { }
}

function scoreFor(view, cmd, terms) {
  var label = view.label.toLowerCase();
  var labelWords = label.split(/[^a-z0-9]+/).filter(Boolean);
  var otherWords = (cmd.words + " " + cmd.group).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  var total = 0;
  for (var i = 0; i < terms.length; i++) {
    var t = terms[i];
    var one = t.length > 3 && /s$/.test(t) ? t.slice(0, -1) : t;
    var s = 0;
    if (labelWords.some(function (w) { return w.indexOf(t) === 0 || w.indexOf(one) === 0; })) s = 3;
    else if (label.indexOf(t) !== -1) s = 2;
    else if (otherWords.some(function (w) { return w.indexOf(t) === 0; })) s = 1;
    if (!s) return 0;
    total += s;
  }
  if (label.indexOf(terms.join(" ")) === 0) total += 2;
  return total;
}

export function commandResults(query) {
  var q = String(query || "").trim().toLowerCase();
  var terms = q.split(/\s+/).filter(Boolean);
  var all = listedEntries().map(function (entry, i) { return { cmd: entry.cmd, view: entry.view, order: i }; });
  var groupOrder = GROUP_ORDER.slice();
  all.forEach(function (it) { if (groupOrder.indexOf(it.cmd.group) === -1) groupOrder.push(it.cmd.group); });
  var groups = {};
  var put = function (g, item) { (groups[g] = groups[g] || []).push(item); };
  if (!terms.length) {
    var recent = recentIds();
    var byId = {};
    all.forEach(function (it) { byId[it.cmd.id] = it; });
    recent.forEach(function (id) { if (byId[id]) put("Recent", byId[id]); });
    all.forEach(function (it) { if (recent.indexOf(it.cmd.id) === -1) put(it.cmd.group, it); });
  } else {
    all.forEach(function (it) {
      it.score = scoreFor(it.view, it.cmd, terms);
      if (it.score) put(it.cmd.group, it);
    });
    Object.keys(groups).forEach(function (g) {
      groups[g].sort(function (a, b) { return (b.score - a.score) || (a.order - b.order); });
    });
  }
  var out = groupOrder.filter(function (g) { return groups[g]; }).map(function (g) { return { group: g, items: groups[g] }; });
  if (terms.length) {
    var best = function (g) { return Math.max.apply(null, g.items.map(function (it) { return it.score; })); };
    out.sort(function (a, b) { return best(b) - best(a) || groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group); });
  }
  return out;
}

var shown = [];
var active = -1;
var returnFocus = null;

function labelHtml(label, terms) {
  var lower = label.toLowerCase();
  var marks = [];
  terms.forEach(function (t) {
    var at = -1;
    var re = /[a-z0-9]+/g, m;
    while ((m = re.exec(lower))) {
      if (m[0].indexOf(t) === 0) { at = m.index; break; }
    }
    if (at === -1 && t.length > 3 && /s$/.test(t)) {
      var one = t.slice(0, -1);
      re.lastIndex = 0;
      while ((m = re.exec(lower))) {
        if (m[0].indexOf(one) === 0) { at = m.index; t = one; break; }
      }
    }
    if (at === -1) at = lower.indexOf(t);
    if (at === -1) return;
    if (marks.some(function (r) { return at < r[1] && at + t.length > r[0]; })) return;
    marks.push([at, at + t.length]);
  });
  if (!marks.length) return escapeHtml(label);
  marks.sort(function (a, b) { return a[0] - b[0]; });
  var out = "", pos = 0;
  marks.forEach(function (r) {
    out += escapeHtml(label.slice(pos, r[0])) + "<mark>" + escapeHtml(label.slice(r[0], r[1])) + "</mark>";
    pos = r[1];
  });
  return out + escapeHtml(label.slice(pos));
}

function renderList() {
  var list = el("cmdk-list");
  var input = el("cmdk-input");
  var results = commandResults(input.value);
  var terms = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  shown = [];
  if (!results.length) {
    list.innerHTML = '<div class="cmdk-empty">No command matches “' + escapeHtml(input.value.trim()) + '”.</div>';
    setActive(-1);
    return;
  }
  var html = "";
  results.forEach(function (g, gi) {
    html += '<div role="group" aria-labelledby="cmdk-g-' + gi + '"><div class="cmdk-group" id="cmdk-g-' + gi + '">' + escapeHtml(g.group) + '</div>';
    g.items.forEach(function (it) {
      var n = shown.length;
      shown.push(it);
      var v = it.view;
      html += '<div class="cmdk-item" role="option" id="cmdk-opt-' + n + '" data-index="' + n + '" data-cmd="' + escapeHtml(it.cmd.id) + '"' +
        ' aria-selected="false"' + (v.disabled ? ' aria-disabled="true"' : '') + '>' +
        '<svg class="cmdk-icon" aria-hidden="true"><use href="#' + escapeHtml(v.icon) + '"/></svg>' +
        '<span class="cmdk-text"><span class="cmdk-label">' + labelHtml(v.label, terms) + '</span>' +
        (v.why ? '<span class="cmdk-why">' + escapeHtml(v.why) + '</span>' : '') + '</span>' +
        (v.state ? '<span class="cmdk-state">' + v.state + '</span>' : '') +
        (v.keys ? '<span class="cmdk-keys" aria-hidden="true">' + keyChipsHtml(v.keys) + '</span>' : '') +
      '</div>';
    });
    html += '</div>';
  });
  list.innerHTML = html;
  var first = shown.findIndex(function (it) { return !it.view.disabled; });
  setActive(first === -1 ? 0 : first);
}

function setActive(i) {
  var input = el("cmdk-input");
  var prev = document.querySelector("#cmdk-list .cmdk-item.is-active");
  if (prev) { prev.classList.remove("is-active"); prev.setAttribute("aria-selected", "false"); }
  active = i;
  var row = i >= 0 ? el("cmdk-opt-" + i) : null;
  if (!row) { input.removeAttribute("aria-activedescendant"); active = -1; return; }
  row.classList.add("is-active");
  row.setAttribute("aria-selected", "true");
  input.setAttribute("aria-activedescendant", row.id);
  row.scrollIntoView({ block: "nearest" });
}

function move(delta) {
  if (!shown.length) return;
  var n = shown.length;
  setActive(((active === -1 ? (delta > 0 ? -1 : 0) : active) + delta + n) % n);
}

export function commandMenuOpen() {
  return launcherShown();
}

export function openCommandMenu() {
  if (commandMenuOpen()) return false;
  if (fileMenuOpen()) toggleFileMenu(false);
  var ae = document.activeElement;
  var range = null;
  var sel = window.getSelection && window.getSelection();
  if (ae && ae.isContentEditable && sel && sel.rangeCount && ae.contains(sel.anchorNode)) range = sel.getRangeAt(0).cloneRange();
  returnFocus = ae && ae !== document.body ? { el: ae, range: range } : null;
  refreshFileMenu();
  var modal = el("cmdk");
  var input = el("cmdk-input");
  input.value = "";
  modal.hidden = false;
  renderList();
  input.focus();
  return true;
}

export function closeCommandMenu(restore) {
  var modal = el("cmdk");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  el("cmdk-list").innerHTML = "";
  shown = [];
  active = -1;
  var back = returnFocus;
  returnFocus = null;
  if (restore === false || !back || !document.contains(back.el)) return;
  back.el.focus({ preventScroll: true });
  if (back.range) {
    try {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(back.range);
    } catch (e) { }
  }
}

function runAt(i) {
  var it = shown[i];
  if (!it || it.view.disabled) return false;
  closeCommandMenu();
  noteRecent(it.cmd.id);
  it.cmd.run();
  return true;
}

export function __init() {
  var modal = el("cmdk");
  var input = el("cmdk-input");
  var list = el("cmdk-list");
  if (!modal || !input || !list) return;
  input.addEventListener("input", renderList);
  input.addEventListener("keydown", function (e) {
    if (e.isComposing) return;
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); runAt(active); }
    else if (e.key === "Tab") { e.preventDefault(); move(e.shiftKey ? -1 : 1); }
  });
  modal.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCommandMenu(); }
  });
  list.addEventListener("mousemove", function (e) {
    var row = e.target.closest(".cmdk-item");
    if (row && +row.getAttribute("data-index") !== active) setActive(+row.getAttribute("data-index"));
  });
  list.addEventListener("mousedown", function (e) { e.preventDefault(); });
  list.addEventListener("click", function (e) {
    var row = e.target.closest(".cmdk-item");
    if (row) runAt(+row.getAttribute("data-index"));
  });
  modal.addEventListener("mousedown", function (e) { if (e.target === modal) { e.preventDefault(); closeCommandMenu(); } });
  var closeBtn = el("cmdk-close");
  if (closeBtn) {
    closeBtn.addEventListener("mousedown", function (e) { e.preventDefault(); });
    closeBtn.addEventListener("click", function () { closeCommandMenu(); });
  }
  modal.addEventListener("focusout", function (e) {
    if (commandMenuOpen() && !(e.relatedTarget && modal.contains(e.relatedTarget))) closeCommandMenu(false);
  });

  var trigger = el("btn-command");
  if (trigger) {
    trigger.title = "Search or run a command (" + keyChipWords("mod+k").join(IS_MAC ? "" : "+") + ")";
    trigger.addEventListener("click", function () { appActions.invoke("command-menu", "button"); });
  }

  window.__commandTest = {
    results: function (q) {
      return commandResults(q).map(function (g) {
        return { group: g.group, items: g.items.map(function (it) { return { id: it.cmd.id, label: it.view.label, disabled: !!it.view.disabled, why: it.view.why }; }) };
      });
    },
    recent: recentIds
  };
}
