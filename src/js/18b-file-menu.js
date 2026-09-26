import { S } from "./_state.js";
import { home, setHome } from "./_home.js";
import { readDefaultWpm, savedStatusText, savedWhenText } from "./00p-prefs.js";
import { escapeHtml, makeId, migrateRows } from "./02-state.js";
import { syncDocIdentity } from "./02b-doc-id.js";
import { cloneState, pushSnapshot, setBaseState, updateIdentityChip } from "./03-sync.js";
import { render } from "./05-render.js";
import { resetProductionPanelState } from "./07-production-tags.js";
import { clearDirty, showToast, updateSaveStatus } from "./12-dirty-toast.js";
import { applyReviewMode, reviewMode, serverSessionExpired, updateServerMenu } from "./13-hosted.js";
import { openProjectFile, updateFileChip } from "./18-local-files.js";
import { writerOpen } from "./19-writer.js";
import {
  canOpenPrompterInBrowser,
  canOpenPrompterInChromium,
  makeDesktopHandle,
  notifyDesktopDocumentState
} from "./20f-desktop.js";
import { closeNewTabPage } from "./20j-newtab.js";
import { LONG_DEMO } from "./_starters.js";

/* ================= the File menu (issue #145) =================

   A dropdown under the File button: a card saying where this document is
   kept and whether it is all there yet, four plain headed groups — New &
   open, Share, Export, This document — and a footer of Help and settings.
   It replaced the left drawer #51 made, whose collapsible sections hid the
   things people were looking for behind a heading they had to guess.

   WHAT STAYS PUT. The element is still #file-menu and every item is still a
   <button data-file-action>, each exactly once: 21-events.js sends a click
   on one to handleFileMenuAction() (18-local-files.js); 20b, 20c and 20e
   each catch their own actions in the capture phase before that; and the
   desktop native menu clicks these same buttons (runDesktopMenuCommand,
   20f-desktop.js). This file adds the parts a dropdown needs and a drawer
   did not: where it sits, what it says about the file, why an item cannot
   work right now, which shortcuts are real, and the keyboard.

   THE DOM IS THE STATE. Whether an item is offered, enabled, or has a
   reason under it is written onto its button by whichever module knows
   (updateServerMenu in 13-hosted.js, updateHeaderFileChip in
   18-local-files.js, initDesktop in 20f-desktop.js, refreshFileMenu here),
   and read back from the button by everything else — the command menu
   (#147) included. Two copies of "is Publish available" would drift apart;
   one cannot. */

function el(id) { return document.getElementById(id); }

/* ---- shortcut chips ----

   An item names its shortcut in data-keys ("mod+shift+s", "F1"), and the
   chips are drawn from that for the platform it is running on. Only a
   shortcut that works in THIS build gets a chip: data-keys-only="desktop"
   marks one that only the desktop app's native menu provides (F1, Ctrl+
   Shift+P). Everything else works in both builds — the desktop app through
   its menu accelerators (desktop/main.js), the browser through the keydown
   handler at the bottom of this file. */
export var IS_MAC = typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

var KEY_WORDS = {
  mod: IS_MAC ? "⌘" : "Ctrl",
  shift: IS_MAC ? "⇧" : "Shift",
  alt: IS_MAC ? "⌥" : "Alt"
};
var ARIA_KEYS = { mod: IS_MAC ? "Meta" : "Control", shift: "Shift", alt: "Alt" };

/* "mod+shift+s" -> ["Ctrl", "Shift", "S"] (or the Mac symbols). */
export function keyChipWords(spec) {
  return String(spec || "").split("+").filter(Boolean).map(function (part) {
    var low = part.toLowerCase();
    return KEY_WORDS[low] || (part.length === 1 ? part.toUpperCase() : part);
  });
}

export function keyChipsHtml(spec) {
  return keyChipWords(spec).map(function (w) { return "<kbd>" + escapeHtml(w) + "</kbd>"; }).join("");
}

export function keysWorkHere(item) {
  var only = item.getAttribute("data-keys-only");
  return !only || (only === "desktop" && !!S.DESKTOP);
}

function renderKeyChips(root) {
  (root || document).querySelectorAll("[data-keys]").forEach(function (item) {
    var box = item.querySelector(".mi-keys");
    if (!keysWorkHere(item)) {
      if (box) box.remove();
      item.removeAttribute("aria-keyshortcuts");
      return;
    }
    var spec = item.getAttribute("data-keys");
    if (!box) {
      box = document.createElement("span");
      box.className = "mi-keys";
      box.setAttribute("aria-hidden", "true");
      /* before a switch's track, so the switch stays the last thing */
      item.insertBefore(box, item.querySelector(".mi-switch-track"));
    }
    box.innerHTML = keyChipsHtml(spec);
    item.setAttribute("aria-keyshortcuts", spec.split("+").map(function (p) {
      return ARIA_KEYS[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p);
    }).join("+"));
  });
}

/* ---- the second line: why an item cannot work ----

   An item that cannot do its job right now says so on the item, rather
   than failing (or toasting) on click. Whether it is also disabled is the
   caller's decision: Publish & copy a link with no server stays enabled,
   because pressing it opens Servers… to set one up; on a read-only server
   there is nothing to press for, so it is disabled as well. */
export function setMenuItemReason(item, reason) {
  var why = item && item.querySelector(".mi-why");
  if (!why) return;
  why.textContent = reason || "";
  why.hidden = !reason;
}

export function menuItemReason(item) {
  var why = item && item.querySelector(".mi-why");
  return why && !why.hidden ? why.textContent : "";
}

/* The label an updater may rewrite (Servers… names the server it is on).
   Written into .mi-label, never the button's own textContent, which would
   take the icon and the reason line with it. */
export function setMenuItemLabel(item, text) {
  var label = item && item.querySelector(".mi-label");
  if (label) label.textContent = text;
  else if (item) item.textContent = text;
}

/* ---- the file card ---- */

var FORMAT_NAMES = {
  md: "Markdown",
  splitpage: "Splitpage file",
  html: "Old Splitpage page",
  docx: "Word document",
  csv: "Spreadsheet",
  txt: "Plain text"
};

export function timeAgo(at, now) {
  if (!at) return "";
  var secs = Math.max(0, Math.round(((now || Date.now()) - at) / 1000));
  if (secs < 45) return "just now";
  var mins = Math.round(secs / 60);
  if (mins < 60) return mins + " min ago";
  var hours = Math.round(mins / 60);
  if (hours < 24) return hours + " h ago";
  var days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return days + " days ago";
  return new Date(at).toLocaleDateString();
}

/* The header's words (#208, savedStatusText in 00p-prefs.js), not an age:
   "Saved 43 min ago" here read as autosave having stalled, just as it did
   beside the Save button. `at` is the file's own timestamp — when it was
   last written, by this page or anyone — and goes in the tooltip. */
function savedWord(at) {
  if (S.saveButtonBusy) return { text: "Saving…" };
  if (S.dirty) return { text: "Unsaved changes", unsaved: true };
  var now = Date.now();
  var when = at ? savedWhenText(at, now) : "";
  return { text: savedStatusText(at, now), title: when ? "Last saved at " + when : "" };
}

/* What the card says: the file's name (or that there is none yet), and
   whether what is on screen is in it. Derived from `home` every time the
   menu opens rather than kept, like the header's file chip. */
export function fileCardView() {
  if (!S.state) return { name: "Loading…", bits: [] };
  if (home.kind === "server") {
    var srv = serverSessionExpired ? { text: "Signed out — reload to sign in", unsaved: true }
      : savedWord(null);
    return { name: S.state.title || "Untitled script", bits: [srv, { text: "On the server · v" + home.rev }] };
  }
  if (home.kind === "file") {
    return {
      name: home.name || (home.handle && home.handle.name) || "Untitled",
      bits: [savedWord(home.lastModified), { text: FORMAT_NAMES[home.format] || home.format }]
    };
  }
  if (home.kind === "import") {
    return {
      name: home.name,
      bits: [home.dirty ? { text: "Not written back yet", unsaved: true } : { text: "Up to date" },
             { text: FORMAT_NAMES[home.format] || home.format }]
    };
  }
  return { name: "Not saved yet", bits: [{ text: "Save to choose where it’s kept" }] };
}

function refreshFileCard() {
  var nameEl = el("fm-card-name");
  var metaEl = el("fm-card-meta");
  if (!nameEl || !metaEl) return;
  var view = fileCardView();
  nameEl.textContent = view.name;
  nameEl.title = view.name;
  metaEl.innerHTML = view.bits.map(function (b) {
    return '<span' + (b.unsaved ? ' class="is-unsaved"' : '') +
      (b.title ? ' title="' + escapeHtml(b.title) + '"' : '') + '>' + escapeHtml(b.text) + '</span>';
  }).join(" · ");
}

/* ---- what is offered right now ---- */

function recentsSupported() {
  return !!(S.DESKTOP && typeof S.DESKTOP.listRecents === "function");
}

/* Everything about the menu that can have changed since it last opened —
   decided each time it opens rather than once at boot, the same way the
   teleprompter's voice button decides when it opens: a browser suite swaps
   a fake desktop bridge in after boot, and an older bridge without a call
   has nothing to offer. The command menu (#147) calls this too, before it
   reads the items. */
export function refreshFileMenu() {
  var presentBrowser = el("menu-present-browser");
  if (presentBrowser) presentBrowser.hidden = !canOpenPrompterInBrowser();
  var presentChromium = el("menu-present-chromium");
  if (presentChromium) presentChromium.hidden = !canOpenPrompterInChromium();
  var recent = el("menu-recent");
  if (recent) recent.hidden = !recentsSupported();
  if (typeof updateServerMenu === "function") updateServerMenu();

  /* Paste a script… replaces the rows of the document on screen, which a
     review session may not change (#30). Open and New script start a
     document of this tab's own, which it may. */
  var paste = document.querySelector('#file-menu [data-file-action="paste"]');
  if (paste) {
    var viewing = reviewMode();
    paste.disabled = viewing;
    setMenuItemReason(paste, viewing ? "Viewing only — you can comment, but not change the script" : "");
  }

  refreshFileCard();
  renderKeyChips(el("file-menu"));
  if (typeof refreshExtraMenuItems === "function") refreshExtraMenuItems();

  /* A group whose every item is hidden goes too, heading and all — the
     "nothing to show" rule the items themselves follow. */
  document.querySelectorAll("#file-menu .menu-group").forEach(function (g) {
    var any = Array.prototype.some.call(g.querySelectorAll(":scope > .mi"), function (b) { return !b.hidden; });
    g.hidden = !any;
  });
}

/* Other features add items of their own (the Export dialog's "Export again
   as …", #146) and register how to refresh them here. */
var extraRefreshers = [];
export function onFileMenuRefresh(fn) { extraRefreshers.push(fn); }
function refreshExtraMenuItems() {
  extraRefreshers.forEach(function (fn) { try { fn(); } catch (e) { /* one item's refresh never takes the menu down */ } });
}

/* ---- opening and closing ---- */

function isPhoneSheet() {
  return typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches;
}

/* Under the button, as tall as the window below it allows (the list
   scrolls inside itself past that), and pulled left if the window is too
   narrow for it to hang off the button's left edge. The phone sheet is
   all CSS. */
function positionMenu() {
  var menu = el("file-menu");
  var btn = el("btn-file");
  menu.style.maxHeight = "";
  menu.style.left = "";
  if (isPhoneSheet()) return;
  var b = btn.getBoundingClientRect();
  menu.style.maxHeight = Math.max(240, window.innerHeight - b.bottom - 18) + "px";
  var wrap = btn.parentElement.getBoundingClientRect();
  var width = menu.offsetWidth || 372;
  var over = wrap.left + width - (window.innerWidth - 12);
  if (over > 0) menu.style.left = -Math.min(over, Math.max(0, wrap.left - 12)) + "px";
}

/* opts.focusFirst: opened from the keyboard, so the first item takes the
   focus (the menu button pattern). Otherwise the menu itself does, which
   shows no ring but puts the arrow keys to work at once.
   opts.returnFocus: closing by Esc, which always hands the focus back to
   the File button. Closing any other way hands it back only when it was
   inside the menu, since leaving it on a hidden element strands the
   keyboard on nothing. */
export function toggleFileMenu(force, opts) {
  opts = opts || {};
  var menu = el("file-menu");
  var btn = el("btn-file");
  var backdrop = el("file-menu-backdrop");
  if (!menu || !btn) return;
  var open = force === undefined ? menu.hidden : !!force;
  if (open === !menu.hidden) {
    if (!open && opts.returnFocus) btn.focus();
    return;
  }
  /* Asked before the menu is hidden: reading activeElement after that can
     already find the browser has moved the focus off the hidden element
     and onto the body. */
  var inside = menu.contains(document.activeElement);
  menu.hidden = !open;
  if (backdrop) backdrop.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    closeSubmenus();
    refreshFileMenu();
    positionMenu();
    var body = menu.querySelector(".menu-body");
    if (body) body.scrollTop = 0;
    if (opts.focusFirst) focusItemAt(0);
    else menu.focus({ preventScroll: true });
  } else {
    closeSubmenus();
    if (inside || opts.returnFocus) btn.focus();
  }
}

export function fileMenuOpen() {
  var menu = el("file-menu");
  return !!menu && !menu.hidden;
}

/* ---- submenus (Open recent, Import, Export until #146) ----

   They open in place, under their item, rather than as flyouts: a flyout
   is clipped by the list's own scroll, and has nowhere to go on a phone. */
function closeSubmenus(except) {
  document.querySelectorAll("#file-menu .mi-parent").forEach(function (p) {
    if (p === except) return;
    p.setAttribute("aria-expanded", "false");
    var sub = el(p.getAttribute("aria-controls"));
    if (sub) sub.hidden = true;
  });
}

export function toggleSubmenu(name, force, focusFirst) {
  var parent = document.querySelector('#file-menu .mi-parent[data-submenu="' + name + '"]');
  var sub = parent && el(parent.getAttribute("aria-controls"));
  if (!sub) return;
  var open = force === undefined ? sub.hidden : !!force;
  closeSubmenus(parent);
  parent.setAttribute("aria-expanded", open ? "true" : "false");
  sub.hidden = !open;
  if (open && name === "recent") refreshRecents(focusFirst);
  else if (open && focusFirst) {
    var first = navigableItems().filter(function (b) { return sub.contains(b); })[0];
    if (first) first.focus();
  }
}

/* ---- Open recent (desktop) ----

   The same list the New Tab page shows (DESKTOP-RECENTS): an opaque
   fileId, the file's basename, the title it last reported, and when —
   never a path (invariant #34). Asked for each time the submenu opens,
   since main is the only authority on it. */
function formatRecentWhen(at) {
  var ago = timeAgo(at);
  return ago === "just now" ? "today" : ago;
}

async function refreshRecents(focusFirst) {
  var sub = el("menu-sub-recent");
  if (!sub || !recentsSupported()) return;
  var entries;
  try { entries = await S.DESKTOP.listRecents(); } catch (e) { entries = []; }
  if (!Array.isArray(entries)) entries = [];
  if (!entries.length) {
    sub.innerHTML = '<div class="menu-sub-empty">Nothing yet — what you open shows up here.</div>';
  } else {
    sub.innerHTML = entries.slice(0, 10).map(function (r) {
      var title = r.title || r.name;
      var when = formatRecentWhen(r.at);
      return '<button type="button" role="menuitem" class="mi" data-recent-id="' + escapeHtml(r.fileId) + '" title="' + escapeHtml(r.name) + '">' +
        '<svg class="mi-icon" aria-hidden="true"><use href="#i-file"/></svg>' +
        '<span class="mi-text"><span class="mi-label">' + escapeHtml(title) + '</span>' +
        '<span class="mi-why">' + escapeHtml(r.name) + (when ? " · " + escapeHtml(when) : "") + '</span></span></button>';
    }).join("");
  }
  if (focusFirst) {
    var first = sub.querySelector(".mi");
    if (first) first.focus();
  }
}

/* The same open the New Tab page's recent cards make (20j-newtab.js): main
   already holds the path behind this fileId and still decides which tab it
   lands in. A file moved or deleted since says so. */
async function openRecentFile(fileId) {
  if (!fileId || !recentsSupported()) return;
  var entry;
  try {
    var r = await S.DESKTOP.routeOpen({ kind: "file", fileId: fileId });
    if (!r || r.where !== "this-tab") return;
    entry = await S.DESKTOP.readFile(fileId);
  } catch (e) {
    showToast("That file isn't there any more — it may have been moved or deleted.", "warn");
    return;
  }
  var handle = makeDesktopHandle(entry);
  await openProjectFile(await handle.getFile(), handle);
}

/* ---- New script ----

   An empty script in THIS tab, the way File ▸ Open puts a foreign file in
   it (#7): the document on screen goes into Version history first, then a
   genuinely empty one takes its place — one blank scene, no tags, no
   comments, no b-roll, a fresh identity — built the way the New Tab page
   builds its blank (blankDocumentState, 20j-newtab.js) and with no home,
   so nothing it does can write into the file or server the old one came
   from. Not dirty: nobody has typed into it yet. On the desktop, main
   reads the report that follows (fileId and serverKey both null) as "this
   tab holds no document any more" and forgets the old file for it. */
export function startNewScript() {
  if (!S.state) { showToast("Still loading…", "warn"); return false; }
  var kept = replaceWithNewDocument(migrateRows({
    title: "Untitled Script",
    rows: [{ id: makeId("r"), visualText: "", imageRef: null, audioText: "" }],
    /* Settings' starting reading speed (#181) */
    wordsPerMinute: readDefaultWpm()
  }), "startNewScript: a new blank document", "Before starting a new script");
  var first = document.querySelector('#rows .row .audio-cell .cell-editable');
  if (first) first.focus();
  showToast(kept ? "New script — the one before is in Version history." : "New script.", "ok");
  return true;
}

/* The long demo (#215, _starters.js), from the command menu: a new
   untitled copy of it in this tab, exactly as New script puts a blank one
   there — the document on screen into Version history first, no home, so
   autosave writes it nowhere until it is saved, and not dirty. */
export function openLongDemo() {
  if (!S.state) { showToast("Still loading…", "warn"); return false; }
  var kept = replaceWithNewDocument(migrateRows(JSON.parse(JSON.stringify(LONG_DEMO.state))),
    "openLongDemo: a new copy of the long demo", "Before opening the long demo");
  showToast("The long demo — " + LONG_DEMO.state.rows.length + " scenes, not saved anywhere yet." +
    (kept ? " The script before is in Version history." : ""), "ok");
  return true;
}

/* What New script and the long demo share: `next` becomes the document,
   with the one before it kept in Version history (labelled `keepLabel`)
   when it had anything in it. Answers whether it kept one. */
function replaceWithNewDocument(next, reason, keepLabel) {
  /* Let go of the field being typed in first, as a click on a menu would:
     its last words then land in the document going into history, and the
     render cannot keep the focused cell (05-render.js keeps it by row id,
     which a starter's "r1" can share with the script it replaces) with
     the old script's words in it. The command menu hands the focus back
     to the cell before it runs anything, so this is not hypothetical. */
  var active = document.activeElement;
  if (active && active !== document.body && typeof active.blur === "function") active.blur();
  var kept = S.state.rows.length ? pushSnapshot(keepLabel) : null;
  /* That snapshot is filed under the old script's id, where its file finds
     it when it is opened again; but the Version history panel lists the
     document on screen, and a script never saved has no file to go back
     to. So the new document's history gets the same snapshot too, and
     restoring it there brings the old script back (a restore keeps the
     identity it lands in, 03-sync.js). */
  if (kept) pushSnapshot(keepLabel, Object.assign({}, S.state, { docId: next.docId }));
  S.state = next;
  setBaseState(cloneState(S.state), reason);
  setHome("none");
  S.docIdWrittenOut = false;
  resetProductionPanelState();
  clearDirty();
  render();
  applyReviewMode();
  updateIdentityChip();
  updateFileChip();
  updateSaveStatus();
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  if (S.DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  if (typeof closeNewTabPage === "function") closeNewTabPage();
  return kept;
}

/* ---- the keyboard ----

   ↑/↓ move through every item that is showing and enabled (a submenu's
   items once it is open), wrapping; Home/End go to either end; → or Enter
   opens a submenu and ← closes it again; Esc closes the menu and gives the
   focus back to the File button; Tab leaves it. */
function navigableItems() {
  return Array.prototype.filter.call(document.querySelectorAll("#file-menu .mi"), function (b) {
    return !b.disabled && b.getClientRects().length > 0;
  });
}

function focusItemAt(i) {
  var items = navigableItems();
  if (!items.length) return;
  var n = ((i % items.length) + items.length) % items.length;
  items[n].focus();
}

function onMenuKeydown(e) {
  if (e.defaultPrevented) return;
  var menu = el("file-menu");
  var items = navigableItems();
  var at = items.indexOf(document.activeElement);
  var cur = at === -1 ? null : items[at];
  var key = e.key;
  if (key === "ArrowDown") { e.preventDefault(); focusItemAt(at === -1 ? 0 : at + 1); }
  else if (key === "ArrowUp") { e.preventDefault(); focusItemAt(at === -1 ? items.length - 1 : at - 1); }
  else if (key === "Home") { e.preventDefault(); focusItemAt(0); }
  else if (key === "End") { e.preventDefault(); focusItemAt(items.length - 1); }
  else if ((key === "ArrowRight" || key === "Enter" || key === " ") && cur && cur.classList.contains("mi-parent")) {
    e.preventDefault();
    var name = cur.getAttribute("data-submenu");
    if (key !== "ArrowRight" && cur.getAttribute("aria-expanded") === "true") toggleSubmenu(name, false);
    else toggleSubmenu(name, true, true);
  } else if (key === "ArrowLeft" && cur) {
    var sub = cur.closest(".menu-sub");
    var parent = sub ? menu.querySelector('.mi-parent[aria-controls="' + sub.id + '"]')
      : (cur.classList.contains("mi-parent") ? cur : null);
    if (parent) {
      e.preventDefault();
      toggleSubmenu(parent.getAttribute("data-submenu"), false);
      parent.focus();
    }
  } else if (key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    toggleFileMenu(false, { returnFocus: true });
  } else if (key === "Tab") {
    toggleFileMenu(false);
  }
}

/* ---- Save, Save a copy, Open from the keyboard in the browser ----

   The desktop app already has these as real menu accelerators
   (desktop/main.js: CmdOrCtrl+S, +Shift+S, +O), which Electron consumes
   before the page ever sees the keystroke — so this listener stands down
   whenever there is a desktop bridge, and nothing fires twice. In the
   browser nothing else answers them: Ctrl+S would offer to save the web
   page, and Ctrl+O would open some other file in place of the app. Each
   runs exactly what the button does (the header's Save, the File menu's
   item), never a copy of it. */
function runMenuItem(action) {
  var item = document.querySelector('#file-menu [data-file-action="' + action + '"]');
  if (item && !item.disabled) item.click();
  return !!item && !item.disabled;
}

export function modalIsOpen() {
  return !!document.querySelector(".modal-backdrop:not([hidden]), .cmdk-backdrop:not([hidden])");
}

function onShortcutKeydown(e) {
  if (e.defaultPrevented || e.isComposing) return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (S.DESKTOP) return;
  var k = String(e.key || "").toLowerCase();
  if (k === "s") {
    /* Taken even while a dialog is up — "save this web page" is never what
       Ctrl+S means here — but only acted on when nothing is in front. */
    e.preventDefault();
    if (modalIsOpen() || !S.state) return;
    if (e.shiftKey) runMenuItem("save-as");
    else {
      var save = el("btn-save");
      if (save && !save.disabled) save.click();
    }
  } else if (k === "o" && !e.shiftKey) {
    e.preventDefault();
    if (modalIsOpen() || S.prompterOpen || writerOpen || !S.state) return;
    toggleFileMenu(false);
    runMenuItem("open");
  }
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  var menu = el("file-menu");
  var btn = el("btn-file");
  if (!menu || !btn) return;
  menu.addEventListener("keydown", onMenuKeydown);
  /* ↓ on the button opens the menu on its first item, as Enter and Space
     do (21-events.js's click handler sees a keyboard click as detail 0). */
  btn.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    toggleFileMenu(true, { focusFirst: true });
    if (e.key === "ArrowUp") focusItemAt(-1);
  });
  var recent = el("menu-sub-recent");
  if (recent) {
    recent.addEventListener("click", function (e) {
      var item = e.target.closest("[data-recent-id]");
      if (!item) return;
      e.stopPropagation();
      toggleFileMenu(false);
      openRecentFile(item.getAttribute("data-recent-id"));
    });
  }
  /* the list may be scrolled when the window is resized under it */
  window.addEventListener("resize", function () { if (fileMenuOpen()) positionMenu(); });
  window.addEventListener("keydown", onShortcutKeydown);
  renderKeyChips(menu);
  /* the header's Search button (#175) wears the same Ctrl K chip */
  var search = el("btn-command");
  if (search && search.parentElement) renderKeyChips(search.parentElement);

  /* ---- test hook ----
     What a headless suite cannot reach by clicking: the view the card is
     drawn from, and the time words under a frozen clock. Nothing in the
     app reads this. */
  window.__fileMenuTest = {
    cardView: fileCardView,
    timeAgo: timeAgo,
    keyChipWords: keyChipWords,
    navigable: function () { return navigableItems().map(function (b) { return b.getAttribute("data-file-action") || b.getAttribute("data-submenu") || b.getAttribute("data-recent-id") || ""; }); }
  };
}
