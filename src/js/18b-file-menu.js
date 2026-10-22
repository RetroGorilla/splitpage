import { S } from "./_state.js";
import { currentHome, reviewMode, serverStatus } from "../legacy/location-bridge.ts";
import { savedStatusText, savedWhenText } from "../../shared/clock.js";
import { escapeHtml, makeId, migrateRows } from "./02-state.js";
import { syncDocIdentity } from "./02b-doc-id.js";
import { pushSnapshot, updateIdentityChip } from "./03-sync.js";
import { renderAbsorbed } from "./05-render.js";
import { resetProductionPanelState } from "../legacy/production-editing-bridge.ts";
import { clearDirty, updateSaveStatus } from "./12-dirty-toast.js";
import { applyReviewMode, updateServerMenu } from "./13-hosted.js";
import { openProjectFile, updateFileChip } from "./18-local-files.js";
import {
  canOpenPrompterInBrowser,
  canOpenPrompterInChromium,
  makeDesktopHandle,
  notifyDesktopDocumentState
} from "./20f-desktop.js";
import { closeNewTabPage } from "./20j-newtab.js";
import { LONG_DEMO } from "./_starters.js";
import { NO_DESTINATION, documentTransitions } from "../legacy/transition-bridge.ts";
import { setMenuItemLabel, setMenuItemReason, showToast } from "../legacy/effects-bridge.ts";
import { saveBusy, unsavedChanges } from "../legacy/save-bridge.ts";
import { preferences } from "../legacy/preferences-bridge.ts";

function el(id) { return document.getElementById(id); }

export var IS_MAC = typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

var KEY_WORDS = {
  mod: IS_MAC ? "⌘" : "Ctrl",
  shift: IS_MAC ? "⇧" : "Shift",
  alt: IS_MAC ? "⌥" : "Alt"
};
var ARIA_KEYS = { mod: IS_MAC ? "Meta" : "Control", shift: "Shift", alt: "Alt" };

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
      item.insertBefore(box, item.querySelector(".mi-switch-track"));
    }
    box.innerHTML = keyChipsHtml(spec);
    item.setAttribute("aria-keyshortcuts", spec.split("+").map(function (p) {
      return ARIA_KEYS[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p);
    }).join("+"));
  });
}

export { setMenuItemLabel, setMenuItemReason };

export function menuItemReason(item) {
  var why = item && item.querySelector(".mi-why");
  return why && !why.hidden ? why.textContent : "";
}

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

function savedWord(at) {
  if (saveBusy()) return { text: "Saving…" };
  if (unsavedChanges()) return { text: "Unsaved changes", unsaved: true };
  var now = Date.now();
  var when = at ? savedWhenText(at, now, preferences().clock()) : "";
  return { text: savedStatusText(at, now), title: when ? "Last saved at " + when : "" };
}

export function fileCardView() {
  if (!S.state) return { name: "Loading…", bits: [] };
  if (currentHome().kind === "server") {
    var srv = serverStatus().sessionExpired() ? { text: "Signed out — reload to sign in", unsaved: true }
      : serverStatus().linkTurnedOff() ? { text: "Link turned off — not saving", unsaved: true }
      : savedWord(null);
    return { name: S.state.title || "Untitled Script", bits: [srv, { text: "On the server · v" + currentHome().rev }] };
  }
  if (currentHome().kind === "file") {
    return {
      name: currentHome().name || (currentHome().handle && currentHome().handle.name) || "Untitled",
      bits: [savedWord(currentHome().lastModified), { text: FORMAT_NAMES[currentHome().format] || currentHome().format }]
    };
  }
  if (currentHome().kind === "import") {
    return {
      name: currentHome().name,
      bits: [currentHome().dirty ? { text: "Not written back yet", unsaved: true } : { text: "Up to date" },
             { text: FORMAT_NAMES[currentHome().format] || currentHome().format }]
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

function recentsSupported() {
  return !!(S.DESKTOP && typeof S.DESKTOP.listRecents === "function");
}

export function pasteItemState() {
  var viewing = reviewMode();
  return { hidden: false, disabled: viewing, reason: viewing ? "Viewing only — you can comment, but not change the script" : "" };
}

export function refreshFileMenu() {
  var presentBrowser = el("menu-present-browser");
  if (presentBrowser) presentBrowser.hidden = !canOpenPrompterInBrowser();
  var presentChromium = el("menu-present-chromium");
  if (presentChromium) presentChromium.hidden = !canOpenPrompterInChromium();
  var recent = el("menu-recent");
  if (recent) recent.hidden = !recentsSupported();
  if (typeof updateServerMenu === "function") updateServerMenu();

  var paste = document.querySelector('#file-menu [data-file-action="paste"]');
  if (paste) {
    var pasteState = pasteItemState();
    paste.disabled = pasteState.disabled;
    setMenuItemReason(paste, pasteState.reason);
  }

  refreshFileCard();
  renderKeyChips(el("file-menu"));
  if (typeof refreshExtraMenuItems === "function") refreshExtraMenuItems();

  document.querySelectorAll("#file-menu .menu-group").forEach(function (g) {
    var any = Array.prototype.some.call(g.querySelectorAll(":scope > .mi"), function (b) { return !b.hidden; });
    g.hidden = !any;
  });
}

var extraRefreshers = [];
export function onFileMenuRefresh(fn) { extraRefreshers.push(fn); }
function refreshExtraMenuItems() {
  extraRefreshers.forEach(function (fn) { try { fn(); } catch (e) { } });
}

function isPhoneSheet() {
  return typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches;
}

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

export function startNewScript() {
  if (!S.state) { showToast("Still loading…", "warn"); return false; }
  var kept = replaceWithNewDocument(migrateRows({
    title: "Untitled Script",
    rows: [{ id: makeId("r"), visualText: "", imageRef: null, audioText: "" }],
    wordsPerMinute: preferences().defaultWpm()
  }), "startNewScript: a new blank document", "Before starting a new script");
  var first = document.querySelector('#rows .row .audio-cell .cell-editable');
  if (first) first.focus();
  showToast(kept ? "New script — the one before is in Version history." : "New script.", "ok");
  return true;
}

export function openLongDemo() {
  if (!S.state) { showToast("Still loading…", "warn"); return false; }
  var kept = replaceWithNewDocument(migrateRows(JSON.parse(JSON.stringify(LONG_DEMO.state))),
    "openLongDemo: a new copy of the long demo", "Before opening the long demo");
  showToast("The long demo — " + LONG_DEMO.state.rows.length + " scenes, not saved anywhere yet." +
    (kept ? " The script before is in Version history." : ""), "ok");
  return true;
}

function replaceWithNewDocument(next, reason, keepLabel) {
  var active = document.activeElement;
  if (active && active !== document.body && typeof active.blur === "function") active.blur();
  var kept = S.state.rows.length ? pushSnapshot(keepLabel) : null;
  if (kept) pushSnapshot(keepLabel, Object.assign({}, S.state, { docId: next.docId }));
  documentTransitions().startNew({ from: { document: next }, reason: reason, destination: NO_DESTINATION });
  resetProductionPanelState();
  clearDirty();
  renderAbsorbed();
  applyReviewMode();
  updateIdentityChip();
  updateFileChip();
  updateSaveStatus();
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  if (S.DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
  if (typeof closeNewTabPage === "function") closeNewTabPage();
  return kept;
}

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

export function __init() {
  var menu = el("file-menu");
  var btn = el("btn-file");
  if (!menu || !btn) return;
  menu.addEventListener("keydown", onMenuKeydown);
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
  window.addEventListener("resize", function () { if (fileMenuOpen()) positionMenu(); });
  renderKeyChips(menu);
  var search = el("btn-command");
  if (search && search.parentElement) renderKeyChips(search.parentElement);

  window.__fileMenuTest = {
    cardView: fileCardView,
    timeAgo: timeAgo,
    keyChipWords: keyChipWords,
    navigable: function () { return navigableItems().map(function (b) { return b.getAttribute("data-file-action") || b.getAttribute("data-submenu") || b.getAttribute("data-recent-id") || ""; }); }
  };
}
