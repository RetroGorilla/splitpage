import { S } from "./_state.js";
import { escapeHtml } from "./02-state.js";
import { promptForTarget } from "./03-sync.js";
import { reviewMode } from "./13-hosted.js";
import {
  IS_MAC,
  fileMenuOpen,
  keyChipWords,
  keyChipsHtml,
  keysWorkHere,
  menuItemReason,
  modalIsOpen,
  refreshFileMenu,
  openLongDemo,
  toggleFileMenu
} from "./18b-file-menu.js";
import { EXPORT_ACTION_NAMES, exportActionReason, runExportAction } from "./18c-export-dialog.js";
import { writerOpen } from "./19-writer.js";

/* ================= the command menu (issue #147) =================

   Ctrl/Cmd+K, or File ▸ Search commands… on a keyboard with no Ctrl: a
   search box over the script. Typing narrows every command the File menu
   has — each export format on its own line, the panels, Write and Present
   too — by its name or by a word someone might use for it ("teleprompter"
   finds Present), grouped the way the menu groups them, with their
   shortcuts. ↑/↓ move, Enter runs, Esc closes and puts the focus (and the
   caret) back where it was. With nothing typed it lists what was run last
   on this device first.

   NOTHING OF ITS OWN TO RUN. A File-menu command clicks that command's
   button in #file-menu; a format clicks its hidden export button; a panel,
   Write, Present and Save click the header's own button. So it runs
   exactly what the menu or the button runs, capture-phase listeners and
   all (20b, 20c, 20e), and whether a command is offered, enabled or has a
   reason is read off that same button — refreshFileMenu() first, so it is
   current. An unavailable command is listed greyed with the menu's own
   reason under it, and Enter on it does nothing. The one command with no
   button, "Set target length…" (#170), opens the clock's own popover
   (promptForTarget, 03-sync.js), which is what clicking the clock does.

   WHERE IT DOES NOT OPEN. Not over the teleprompter, the writer, a modal
   dialog or the tour: each of those owns the keyboard while it is up. And
   it never takes a keystroke something else already handled — a script
   cell's own shortcuts run first and mark the event. */

var RECENT_KEY = "splitpage-recent-commands";
var RECENT_MAX = 5;
/* "Tags" sits right under Recent (Adam, 2026-09-27: the tag reference
   wants to be near the top, not the last thing under Help). Being early
   in this order also wins it the ties when a query scores two groups the
   same. */
var GROUP_ORDER = ["Recent", "Tags", "File", "Share", "Export", "View", "This document", "Help"];

function el(id) { return document.getElementById(id); }

function menuButton(action) {
  return document.querySelector('#file-menu [data-file-action="' + action + '"]');
}

/* A command read off a File-menu button: its label (the menu's own, unless
   a clearer one out of the menu's context is given), its icon, its
   shortcut when it works in this build, and why it cannot run. */
function fromMenu(action, group, words, label) {
  return {
    id: action,
    group: group,
    words: words || "",
    read: function () {
      var btn = menuButton(action);
      if (!btn || btn.hidden) return null;
      /* Save to file is disabled whenever there is no foreign file to
         write back to — the menu does not offer it then, and neither does
         this. */
      if (action === "save-back" && btn.disabled) return null;
      var use = btn.querySelector(".mi-icon use");
      var lab = btn.querySelector(".mi-label");
      return {
        label: label || (lab ? lab.textContent : btn.textContent),
        icon: use ? use.getAttribute("href").slice(1) : "i-file",
        keys: btn.hasAttribute("data-keys") && keysWorkHere(btn) ? btn.getAttribute("data-keys") : "",
        why: btn.disabled ? (menuItemReason(btn) || btn.title || "Not available right now") : menuItemReason(btn),
        disabled: btn.disabled,
        state: btn.getAttribute("role") === "menuitemcheckbox"
          ? (btn.getAttribute("aria-checked") === "true" ? "On" : "Off") : ""
      };
    },
    run: function () {
      var btn = menuButton(action);
      if (btn && !btn.disabled) btn.click();
    }
  };
}

/* One export format, run through its own hidden button. */
function fromExport(action, words) {
  return {
    id: action,
    group: "Export",
    words: "export download " + words,
    read: function () {
      var why = exportActionReason(action);
      return { label: "Export as " + EXPORT_ACTION_NAMES[action], icon: "i-export", keys: "",
               why: why, disabled: !!why, state: "" };
    },
    run: function () { runExportAction(action); }
  };
}

/* A header button: a panel, Write, Present, Save. */
function fromButton(id, btnId, group, label, icon, words, keys, blockedWhy) {
  return {
    id: id,
    group: group,
    words: words,
    read: function () {
      var btn = el(btnId);
      if (!btn || btn.hidden) return null;
      var why = blockedWhy ? blockedWhy() : "";
      return { label: label, icon: icon, keys: keys || "", why: why, disabled: !!why || btn.disabled, state: "" };
    },
    run: function () {
      var btn = el(btnId);
      if (btn && !btn.disabled) btn.click();
    }
  };
}

var COMMANDS = null;

function commands() {
  if (COMMANDS) return COMMANDS;
  var viewing = function () {
    return reviewMode() ? "Viewing only — the writer changes the script" : "";
  };
  COMMANDS = [
    fromButton("save", "btn-save", "File", "Save", "i-save", "store keep write disk", "mod+s"),
    fromMenu("save-as", "File", "save as duplicate copy another file"),
    fromMenu("save-back", "File", "write back original docx csv txt"),
    fromMenu("autosave", "File", "automatic save saving"),
    fromMenu("new", "File", "blank empty create start fresh document"),
    fromMenu("open", "File", "load file document project md splitpage docx"),
    fromMenu("server-open", "File", "server hosted shared documents"),
    fromMenu("paste", "File", "import revised draft text", "Import: paste a script…"),
    fromMenu("gdoc-import", "File", "import google docs link url", "Import: Google Doc link…"),
    fromMenu("drive-open", "File", "import google drive cloud files", "Import: Google Drive…"),
    fromMenu("collaborate", "Share", "collaborate share invite link url people live together send edit comment publish"),
    fromMenu("server-publish", "Share", "publish upload server hosted"),
    fromMenu("servers", "Share", "server connect bookmark address pin join"),
    fromMenu("export", "Export", "download save as format dialog"),
    fromExport("export-pdf", "pdf print"),
    fromExport("export-docx", "word docx document google docs"),
    fromExport("export-md", "markdown md text stacked"),
    fromExport("export-md-table", "markdown md table two columns side by side"),
    /* the workbook first: "excel" finds it before the CSV, whose words
       still say excel for anyone who asks for that by habit */
    fromExport("export-xlsx", "excel xlsx spreadsheet workbook sheets numbers table"),
    fromExport("export-csv", "spreadsheet csv excel sheets table"),
    fromExport("export-html", "splitshare share standalone page html web browser send any device app"),
    fromExport("export-narration-docx", "narration voice over voiceover audio artist word docx"),
    fromExport("export-narration-txt", "narration voice over voiceover audio artist text txt"),
    fromExport("export-breakdown-xlsx", "breakdown excel xlsx spreadsheet workbook tags props locations cast list"),
    fromExport("export-breakdown", "breakdown csv tags props locations cast list"),
    fromExport("export-packing-gear", "packing list checklist gear equipment kit pdf"),
    fromExport("export-packing-prop", "packing list checklist props prop pdf"),
    fromExport("export-broll-pdf", "b-roll broll shot list shots second unit print pdf landscape"),
    fromExport("export-broll-xlsx", "b-roll broll shot list shots excel xlsx spreadsheet workbook sheets"),
    fromExport("export-broll-csv", "b-roll broll shot list shots spreadsheet csv excel sheets"),
    fromButton("panel-production", "btn-production", "View", "Production panel", "i-panel",
      "breakdown tags props locations cast show hide toggle"),
    fromButton("panel-gear", "btn-gear", "View", "Gear panel", "i-panel", "gear equipment kit camera show hide toggle"),
    fromButton("panel-broll", "btn-broll", "View", "B-roll panel", "i-panel", "broll b roll shots cutaways show hide toggle"),
    fromButton("panel-comments", "btn-comments", "View", "Comments panel", "i-panel", "comments notes review feedback show hide toggle"),
    fromButton("write", "btn-write", "View", "Write", "i-pen", "writer narration word processor audio column", "", viewing),
    fromButton("present", "btn-present", "View", "Present", "i-play", "teleprompter prompter autocue read play"),
    fromMenu("history", "This document", "versions restore snapshot backup older undo"),
    fromMenu("find", "This document", "search replace look for"),
    fromMenu("toggle-hide-shot", "This document", "collapse done finished filter shot scenes"),
    fromMenu("toggle-rundown-min", "This document", "rundown strip timeline minimize collapse thin bar more room"),
    /* #170: the clock's popover, the caret in its target field */
    {
      id: "set-target",
      group: "This document",
      words: "target length goal duration aim runtime running time clock back timing over under minutes",
      read: function () {
        var why = reviewMode() ? "Viewing only — the writer sets the target" : "";
        return { label: "Set target length…", icon: "i-clock", keys: "", why: why, disabled: !!why, state: "" };
      },
      run: function () { promptForTarget(); }
    },
    fromMenu("prompter-open-in-browser", "This document", "teleprompter browser follow my voice present"),
    fromMenu("prompter-open-in-chromium", "This document", "teleprompter chrome edge chromium speech recognition voice"),
    fromMenu("settings", "Help", "settings preferences options theme dark light mode clock 12 24 hour colour color name zoom", "Settings"),
    fromMenu("help", "Help", "guide manual docs user guide how", "Help"),
    fromMenu("tour", "Help", "tutorial walkthrough introduction", "Take the tour"),
    /* #215: no menu button of its own, like "Set target length…" */
    {
      id: "long-demo",
      group: "Help",
      words: "demo example sample long thirty 30 scenes test try every feature",
      read: function () {
        return { label: "Open the long demo (30 scenes)", icon: "i-file-plus", keys: "", why: "", disabled: false, state: "" };
      },
      run: function () { openLongDemo(); }
    },
    fromMenu("setup", "Help", "setup settings wizard install", "Set up Splitpage…"),
    fromMenu("about", "Help", "version about", "About Splitpage"),
    fromMenu("tagging-help", "Tags", "tags tagging reference shortcuts brackets help"),
    fromMenu("export-app-data", "Help", "backup move desktop app data history bookmarks"),
    fromMenu("import-app-data", "Help", "restore move desktop app data history bookmarks")
  ];
  return COMMANDS;
}

/* ---- recently run (per device) ---- */

function recentIds() {
  var list;
  try { list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch (e) { list = []; }
  return Array.isArray(list) ? list.filter(function (x) { return typeof x === "string"; }).slice(0, RECENT_MAX) : [];
}

function noteRecent(id) {
  var list = recentIds().filter(function (x) { return x !== id; });
  list.unshift(id);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch (e) { /* storage full or blocked — still runs, just not remembered */ }
}

/* ---- matching ----

   Every word typed has to be found: at the start of a word of the label
   (best), anywhere in the label, or at the start of one of the command's
   other words. Ranked by how well, then the menu's own order. A plural
   counts as its singular at the start of a label word, so "tags" finds
   Tagging reference by its name and not only by a keyword — otherwise
   every tag command tied and the reference came last. */
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

/* What the list shows for `query`: [{group, items:[{cmd, view}]}]. */
export function commandResults(query) {
  var q = String(query || "").trim().toLowerCase();
  var terms = q.split(/\s+/).filter(Boolean);
  var all = [];
  commands().forEach(function (cmd, i) {
    var view = cmd.read();
    if (view) all.push({ cmd: cmd, view: view, order: i });
  });
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
  var out = GROUP_ORDER.filter(function (g) { return groups[g]; }).map(function (g) { return { group: g, items: groups[g] }; });
  /* With a query, the group holding the best match comes first, so Enter
     straight after typing runs what was most plainly asked for. */
  if (terms.length) {
    var best = function (g) { return Math.max.apply(null, g.items.map(function (it) { return it.score; })); };
    out.sort(function (a, b) { return best(b) - best(a) || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group); });
  }
  return out;
}

/* ---- the list ---- */

var shown = [];          /* the rows in list order: {cmd, view} */
var active = -1;
var returnFocus = null;  /* {el, range} to go back to */

/* A label with the letters typed marked, as B-Command draws them (#169):
   each term where scoreFor() found it — at the start of a word of the
   label, else anywhere in it. A term found only among the command's other
   words ("teleprompter" for Present) marks nothing. Only the markup
   changes; the label's text is the same. */
function labelHtml(label, terms) {
  var lower = label.toLowerCase();
  var marks = [];
  terms.forEach(function (t) {
    var at = -1;
    var re = /[a-z0-9]+/g, m;
    while ((m = re.exec(lower))) {
      if (m[0].indexOf(t) === 0) { at = m.index; break; }
    }
    /* a plural matched as its singular (scoreFor) marks the singular */
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
  /* the first one that can run, so Enter does something useful */
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

/* ---- opening, closing, running ---- */

export function commandMenuOpen() {
  var m = el("cmdk");
  return !!m && !m.hidden;
}

/* Why it would not open right now, or "" — the places that own the
   keyboard while they are up. */
function blockedNow() {
  if (!S.state) return "loading";
  if (S.prompterOpen) return "prompter";
  if (writerOpen) return "writer";
  if (modalIsOpen()) return "modal";
  var tour = el("tour-overlay");
  if (tour && !tour.hidden) return "tour";
  return "";
}

export function openCommandMenu() {
  if (commandMenuOpen() || blockedNow()) return false;
  if (fileMenuOpen()) toggleFileMenu(false);
  /* Where to go back to: the element, and — for a script cell — where the
     caret was in it, since focusing a contenteditable again would put it
     at the start. */
  var ae = document.activeElement;
  var range = null;
  var sel = window.getSelection && window.getSelection();
  if (ae && ae.isContentEditable && sel && sel.rangeCount && ae.contains(sel.anchorNode)) range = sel.getRangeAt(0).cloneRange();
  returnFocus = ae && ae !== document.body ? { el: ae, range: range } : null;
  /* whether each command is offered right now is read off the menu */
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
    } catch (e) { /* the cell was redrawn meanwhile — focus alone will do */ }
  }
}

function runAt(i) {
  var it = shown[i];
  if (!it || it.view.disabled) return false;
  /* focus goes back first, so whatever the command opens takes it from
     there, as it would from a click */
  closeCommandMenu();
  noteRecent(it.cmd.id);
  it.cmd.run();
  return true;
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
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
  /* mousedown would take the focus out of the box before the click lands */
  list.addEventListener("mousedown", function (e) { e.preventDefault(); });
  list.addEventListener("click", function (e) {
    var row = e.target.closest(".cmdk-item");
    if (row) runAt(+row.getAttribute("data-index"));
  });
  modal.addEventListener("mousedown", function (e) { if (e.target === modal) { e.preventDefault(); closeCommandMenu(); } });
  /* the phone's close button (page.html); mousedown kept off it so the
     focus stays in the box until the click has landed */
  var closeBtn = el("cmdk-close");
  if (closeBtn) {
    closeBtn.addEventListener("mousedown", function (e) { e.preventDefault(); });
    closeBtn.addEventListener("click", function () { closeCommandMenu(); });
  }
  /* Focus leaving for somewhere else (another shortcut, a click through)
     takes the box with it — it is a question asked of this moment, not
     something to come back to. */
  modal.addEventListener("focusout", function (e) {
    if (commandMenuOpen() && !(e.relatedTarget && modal.contains(e.relatedTarget))) closeCommandMenu(false);
  });

  /* The header's "Search or run a command" button (#175): the same menu,
     for whoever has not met Ctrl K yet. Its tooltip names the shortcut in
     the words the chips use; where it is only a magnifier that tooltip is
     all the hint there is. Opened from it, Esc hands the focus back to it
     (returnFocus above). */
  var trigger = el("btn-command");
  if (trigger) {
    trigger.title = "Search or run a command (" + keyChipWords("mod+k").join(IS_MAC ? "" : "+") + ")";
    trigger.addEventListener("click", function () { openCommandMenu(); });
  }

  /* Ctrl/Cmd+K, in both builds: nothing in desktop/main.js registers it
     (its Search Commands… item shows the accelerator without registering
     it, like Find), and nothing in the page used it before. Pressed again
     while the box is up, it closes it. */
  window.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (String(e.key || "").toLowerCase() !== "k") return;
    if (commandMenuOpen()) { e.preventDefault(); closeCommandMenu(); return; }
    if (blockedNow()) return;
    e.preventDefault();
    openCommandMenu();
  });

  /* ---- test hook ----
     The ranked list for a query without typing it, for a suite to read.
     Nothing in the app reads this. */
  window.__commandTest = {
    results: function (q) {
      return commandResults(q).map(function (g) {
        return { group: g.group, items: g.items.map(function (it) { return { id: it.cmd.id, label: it.view.label, disabled: !!it.view.disabled, why: it.view.why }; }) };
      });
    },
    recent: recentIds
  };
}
