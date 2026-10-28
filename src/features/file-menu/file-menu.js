import { IS_MAC, keyChipWords, keyChipsHtml } from "../common/key-chips.js";
import { savedStatusText, savedWhenText } from "../../../shared/clock.js";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { NO_DESTINATION } from "../../application/transitions/ports.ts";

var ports = null;
var activeMount = null;
var listeners = [];

function listen(target, type, listener) {
  target.addEventListener(type, listener);
  listeners.push(function () { target.removeEventListener(type, listener); });
}

function el(id) { return document.getElementById(id); }

var ARIA_KEYS = { mod: IS_MAC ? "Meta" : "Control", shift: "Shift", alt: "Alt" };

function keysWorkHere(item) {
  var only = item.getAttribute("data-keys-only");
  return !only || (only === "desktop" && ports.desktop());
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
  if (ports.saves.busy()) return { text: "Saving…" };
  if (ports.saves.unsaved()) return { text: "Unsaved changes", unsaved: true };
  var now = Date.now();
  var when = at ? savedWhenText(at, now, ports.preferences.clock()) : "";
  return { text: savedStatusText(at, now), title: when ? "Last saved at " + when : "" };
}

function fileCardView() {
  if (!ports.document.current()) return { name: "Loading…", bits: [] };
  if (ports.place.home().kind === "file") {
    return {
      name: ports.place.home().name || (ports.place.home().handle && ports.place.home().handle.name) || "Untitled",
      bits: [savedWord(ports.place.home().lastModified), { text: FORMAT_NAMES[ports.place.home().format] || ports.place.home().format }]
    };
  }
  if (ports.place.home().kind === "import") {
    return {
      name: ports.place.home().name,
      bits: [ports.place.home().dirty ? { text: "Not written back yet", unsaved: true } : { text: "Up to date" },
             { text: FORMAT_NAMES[ports.place.home().format] || ports.place.home().format }]
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
  return !!(ports.desktop() && ports.recents.available());
}

function refreshFileMenu() {
  var presentBrowser = el("menu-present-browser");
  if (presentBrowser) presentBrowser.hidden = !ports.canOpenPrompter.browser();
  var presentChromium = el("menu-present-chromium");
  if (presentChromium) presentChromium.hidden = !ports.canOpenPrompter.chromium();
  var recent = el("menu-recent");
  if (recent) recent.hidden = !recentsSupported();

  refreshFileCard();
  renderKeyChips(el("file-menu"));
  if (typeof refreshExtraMenuItems === "function") refreshExtraMenuItems();

  document.querySelectorAll("#file-menu .menu-group").forEach(function (g) {
    var any = Array.prototype.some.call(g.querySelectorAll(":scope > .mi"), function (b) { return !b.hidden; });
    g.hidden = !any;
  });
}

function refreshOpenFileMenu() {
  var menu = el("file-menu");
  if (menu && !menu.hidden) refreshFileMenu();
}

var extraRefreshers = [];
function onFileMenuRefresh(fn) {
  extraRefreshers.push(fn);
  return function () {
    var index = extraRefreshers.indexOf(fn);
    if (index !== -1) extraRefreshers.splice(index, 1);
  };
}
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

function toggleFileMenu(force, opts) {
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

function fileMenuOpen() {
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

function toggleSubmenu(name, force, focusFirst) {
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
  var mounted = activeMount;
  var entries;
  try { entries = await ports.recents.list(); } catch (e) { entries = []; }
  if (activeMount !== mounted) return;
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
  var mounted = activeMount;
  var entry;
  try {
    var r = await ports.recents.routeOpen({ kind: "file", fileId: fileId });
    if (activeMount !== mounted) return;
    if (!r || r.where !== "this-tab") return;
    entry = await ports.recents.read(fileId);
  } catch (e) {
    if (activeMount !== mounted) return;
    ports.notices.show("That file isn't there any more — it may have been moved or deleted.", "warn");
    return;
  }
  if (activeMount !== mounted) return;
  var handle = ports.recentHandle(entry);
  var file = await handle.getFile();
  if (activeMount !== mounted) return;
  await ports.opening.open({ kind: "file", file: file, handle: handle });
}

function startNewScript() {
  if (!ports.document.current()) { ports.notices.show("Still loading…", "warn"); return false; }
  var kept = replaceWithNewDocument(ports.prepareDocument({
    title: "Untitled Script",
    rows: [{ id: ports.ids.id("r"), visualText: "", imageRef: null, audioText: "" }],
    wordsPerMinute: ports.preferences.defaultWpm()
  }), "startNewScript: a new blank document", "Before starting a new script");
  var first = document.querySelector('#rows .row .audio-cell .cell-editable');
  if (first) first.focus();
  ports.notices.show(kept ? "New script — the one before is in Version history." : "New script.", "ok");
  return true;
}

function openLongDemo() {
  if (!ports.document.current()) { ports.notices.show("Still loading…", "warn"); return false; }
  var kept = replaceWithNewDocument(ports.prepareDocument(JSON.parse(JSON.stringify(ports.longDemo.state))),
    "openLongDemo: a new copy of the long demo", "Before opening the long demo");
  ports.notices.show("The long demo — " + ports.longDemo.state.rows.length + " scenes, not saved anywhere yet." +
    (kept ? " The script before is in Version history." : ""), "ok");
  return true;
}

function replaceWithNewDocument(next, reason, keepLabel) {
  var active = document.activeElement;
  if (active && active !== document.body && typeof active.blur === "function") active.blur();
  var kept = ports.document.current().rows.length ? ports.history.keep(keepLabel) : null;
  if (kept) ports.history.keep(keepLabel, Object.assign({}, ports.document.current(), { docId: next.docId }));
  ports.resetProductionPanel();
  ports.transitions.startNew({ from: { document: next }, reason: reason, destination: NO_DESTINATION });
  ports.saving.confirmSavedNow();
  if (typeof ports.syncIdentity === "function") ports.syncIdentity();
  ports.panels.close("newtab-page");
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

function wireMenu() {
  var menu = el("file-menu");
  var btn = el("btn-file");
  if (!menu || !btn) return;
  listen(menu, "keydown", onMenuKeydown);
  listen(btn, "keydown", function (e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    toggleFileMenu(true, { focusFirst: true });
    if (e.key === "ArrowUp") focusItemAt(-1);
  });
  var recent = el("menu-sub-recent");
  if (recent) {
    listen(recent, "click", function (e) {
      var item = e.target.closest("[data-recent-id]");
      if (!item) return;
      e.stopPropagation();
      toggleFileMenu(false);
      openRecentFile(item.getAttribute("data-recent-id"));
    });
  }
  listen(window, "resize", function () { if (fileMenuOpen()) positionMenu(); });
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

export function startFileMenu(given) {
  ports = given;
  var mounted = {};
  activeMount = mounted;
  wireMenu();
  var probe = window.__fileMenuTest;
  var disposed = false;
  function live(fn) {
    return function () { return disposed ? undefined : fn.apply(null, arguments); };
  }
  return {
    toggleFileMenu: live(toggleFileMenu),
    fileMenuOpen: function () { return !disposed && fileMenuOpen(); },
    toggleSubmenu: live(toggleSubmenu),
    refreshFileMenu: live(refreshFileMenu),
    refreshOpenFileMenu: live(refreshOpenFileMenu),
    onFileMenuRefresh: onFileMenuRefresh,
    startNewScript: function () { return disposed ? false : startNewScript(); },
    openLongDemo: function () { return disposed ? false : openLongDemo(); },
    dispose: function () {
      if (disposed) return;
      disposed = true;
      while (listeners.length) listeners.pop()();
      if (probe && window.__fileMenuTest === probe) delete window.__fileMenuTest;
      if (activeMount === mounted) {
        activeMount = null;
        ports = null;
      }
    }
  };
}
