import type { FileMenuDropdownPorts, FileMenuDropdownMount } from "./ports.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import { IS_MAC, keyChipWords, keyChipsHtml } from "../common/key-chips.ts";
import { savedStatusText, savedWhenText } from "../../../shared/clock.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { NO_DESTINATION } from "../../application/transitions/ports.ts";
import { exposeTestHook } from "../common/test-hooks.ts";

let ports: FileMenuDropdownPorts | null = null;
let activeMount: object | null = null;
const listeners: (() => void)[] = [];

function listen<K extends keyof HTMLElementEventMap>(target: HTMLElement | Window, type: K, listener: (event: HTMLElementEventMap[K]) => void) {
  target.addEventListener(type, listener as EventListener);
  listeners.push(function () { target.removeEventListener(type, listener as EventListener); });
}

function el(id: string | null) { return document.getElementById(id); }

const ARIA_KEYS: Record<string, string | undefined> = { mod: IS_MAC ? "Meta" : "Control", shift: "Shift", alt: "Alt" };

function keysWorkHere(item: Element) {
  const only = item.getAttribute("data-keys-only");
  return !only || (only === "desktop" && (ports as FileMenuDropdownPorts).desktop());
}

function renderKeyChips(root?: ParentNode | null) {
  (root || document).querySelectorAll("[data-keys]").forEach(function (item) {
    let box = item.querySelector(".mi-keys");
    if (!keysWorkHere(item)) {
      if (box) box.remove();
      item.removeAttribute("aria-keyshortcuts");
      return;
    }
    const spec = item.getAttribute("data-keys");
    if (!box) {
      box = document.createElement("span");
      box.className = "mi-keys";
      box.setAttribute("aria-hidden", "true");
      item.insertBefore(box, item.querySelector(".mi-switch-track"));
    }
    box.innerHTML = keyChipsHtml(spec);
    item.setAttribute("aria-keyshortcuts", (spec as string).split("+").map(function (p) {
      return ARIA_KEYS[p.toLowerCase()] || (p.length === 1 ? p.toUpperCase() : p);
    }).join("+"));
  });
}

const FORMAT_NAMES: Record<string, string | undefined> = {
  md: "Markdown",
  splitpage: "Splitpage file",
  html: "Old Splitpage page",
  docx: "Word document",
  csv: "Spreadsheet",
  txt: "Plain text"
};

function timeAgo(at?: number | null, now?: number) {
  if (!at) return "";
  const secs = Math.max(0, Math.round(((now || Date.now()) - at) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + " min ago";
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + " h ago";
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return days + " days ago";
  return new Date(at).toLocaleDateString();
}

function savedWord(at?: number | null) {
  if ((ports as FileMenuDropdownPorts).saves.busy()) return { text: "Saving…" };
  if ((ports as FileMenuDropdownPorts).saves.unsaved()) return { text: "Unsaved changes", unsaved: true };
  const now = Date.now();
  const when = at ? savedWhenText(at, now, (ports as FileMenuDropdownPorts).preferences.clock()) : "";
  return { text: savedStatusText(at, now), title: when ? "Last saved at " + when : "" };
}

function fileCardView(): { name: string | null | undefined; bits: { text: string | null | undefined; unsaved?: boolean; title?: string }[] } {
  if (!(ports as FileMenuDropdownPorts).document.current()) return { name: "Loading…", bits: [] };
  if ((ports as FileMenuDropdownPorts).place.home().kind === "file") {
    return {
      name: (ports as FileMenuDropdownPorts).place.home().name || ((ports as FileMenuDropdownPorts).place.home().handle && ((ports as FileMenuDropdownPorts).place.home().handle as NonNullable<ReturnType<FileMenuDropdownPorts["place"]["home"]>["handle"]>).name) || "Untitled",
      bits: [savedWord((ports as FileMenuDropdownPorts).place.home().lastModified), { text: FORMAT_NAMES[(ports as FileMenuDropdownPorts).place.home().format as string] || (ports as FileMenuDropdownPorts).place.home().format }]
    };
  }
  if ((ports as FileMenuDropdownPorts).place.home().kind === "import") {
    return {
      name: (ports as FileMenuDropdownPorts).place.home().name,
      bits: [(ports as FileMenuDropdownPorts).place.home().dirty ? { text: "Not written back yet", unsaved: true } : { text: "Up to date" },
             { text: FORMAT_NAMES[(ports as FileMenuDropdownPorts).place.home().format as string] || (ports as FileMenuDropdownPorts).place.home().format }]
    };
  }
  return { name: "Not saved yet", bits: [{ text: "Save to choose where it’s kept" }] };
}

function refreshFileCard() {
  const nameEl = el("fm-card-name");
  const metaEl = el("fm-card-meta");
  if (!nameEl || !metaEl) return;
  const view = fileCardView();
  nameEl.textContent = view.name as string;
  nameEl.title = view.name as string;
  metaEl.innerHTML = view.bits.map(function (b) {
    return '<span' + (b.unsaved ? ' class="is-unsaved"' : '') +
      (b.title ? ' title="' + escapeHtml(b.title) + '"' : '') + '>' + escapeHtml(b.text) + '</span>';
  }).join(" · ");
}

function recentsSupported() {
  return !!((ports as FileMenuDropdownPorts).desktop() && (ports as FileMenuDropdownPorts).recents.available());
}

function refreshFileMenu() {
  const presentBrowser = el("menu-present-browser");
  if (presentBrowser) presentBrowser.hidden = !(ports as FileMenuDropdownPorts).canOpenPrompter.browser();
  const presentChromium = el("menu-present-chromium");
  if (presentChromium) presentChromium.hidden = !(ports as FileMenuDropdownPorts).canOpenPrompter.chromium();
  const recent = el("menu-recent");
  if (recent) recent.hidden = !recentsSupported();

  refreshFileCard();
  renderKeyChips(el("file-menu"));
  if (typeof refreshExtraMenuItems === "function") refreshExtraMenuItems();

  document.querySelectorAll<HTMLElement>("#file-menu .menu-group").forEach(function (g) {
    const any = Array.prototype.some.call(g.querySelectorAll(":scope > .mi"), function (b: HTMLElement) { return !b.hidden; });
    g.hidden = !any;
  });
}

function refreshOpenFileMenu() {
  const menu = el("file-menu");
  if (menu && !menu.hidden) refreshFileMenu();
}

const extraRefreshers: (() => void)[] = [];
function onFileMenuRefresh(fn: () => void) {
  extraRefreshers.push(fn);
  return function () {
    const index = extraRefreshers.indexOf(fn);
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
  const menu = el("file-menu");
  const btn = el("btn-file");
  (menu as HTMLElement).style.maxHeight = "";
  (menu as HTMLElement).style.left = "";
  if (isPhoneSheet()) return;
  const b = (btn as HTMLElement).getBoundingClientRect();
  (menu as HTMLElement).style.maxHeight = Math.max(240, window.innerHeight - b.bottom - 18) + "px";
  const wrap = ((btn as HTMLElement).parentElement as HTMLElement).getBoundingClientRect();
  const width = (menu as HTMLElement).offsetWidth || 372;
  const over = wrap.left + width - (window.innerWidth - 12);
  if (over > 0) (menu as HTMLElement).style.left = -Math.min(over, Math.max(0, wrap.left - 12)) + "px";
}

function toggleFileMenu(force?: boolean, opts?: Parameters<FileMenuDropdownMount["toggleFileMenu"]>[1]) {
  opts = opts || {};
  const menu = el("file-menu");
  const btn = el("btn-file");
  const backdrop = el("file-menu-backdrop");
  if (!menu || !btn) return;
  const open = force === undefined ? menu.hidden : !!force;
  if (open === !menu.hidden) {
    if (!open && opts.returnFocus) btn.focus();
    return;
  }
  const inside = menu.contains(document.activeElement);
  menu.hidden = !open;
  if (backdrop) backdrop.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    closeSubmenus();
    refreshFileMenu();
    positionMenu();
    const body = menu.querySelector(".menu-body");
    if (body) body.scrollTop = 0;
    if (opts.focusFirst) focusItemAt(0);
    else menu.focus({ preventScroll: true });
  } else {
    closeSubmenus();
    if (inside || opts.returnFocus) btn.focus();
  }
}

function fileMenuOpen() {
  const menu = el("file-menu");
  return !!menu && !menu.hidden;
}

function closeSubmenus(except?: Element | null) {
  document.querySelectorAll("#file-menu .mi-parent").forEach(function (p) {
    if (p === except) return;
    p.setAttribute("aria-expanded", "false");
    const sub = el(p.getAttribute("aria-controls"));
    if (sub) sub.hidden = true;
  });
}

function toggleSubmenu(name: string | null, force?: boolean, focusFirst?: boolean) {
  const parent = document.querySelector('#file-menu .mi-parent[data-submenu="' + name + '"]');
  const sub = parent && el(parent.getAttribute("aria-controls"));
  if (!sub) return;
  const open = force === undefined ? sub.hidden : !!force;
  closeSubmenus(parent);
  (parent as Element).setAttribute("aria-expanded", open ? "true" : "false");
  sub.hidden = !open;
  if (open && name === "recent") refreshRecents(focusFirst);
  else if (open && focusFirst) {
    const first = navigableItems().filter(function (b) { return sub.contains(b); })[0];
    if (first) first.focus();
  }
}

function formatRecentWhen(at: number) {
  const ago = timeAgo(at);
  return ago === "just now" ? "today" : ago;
}

async function refreshRecents(focusFirst?: boolean) {
  const sub = el("menu-sub-recent");
  if (!sub || !recentsSupported()) return;
  const mounted = activeMount;
  let entries: Awaited<ReturnType<FileMenuDropdownPorts["recents"]["list"]>>;
  try { entries = await (ports as FileMenuDropdownPorts).recents.list(); } catch (e) { entries = []; }
  if (activeMount !== mounted) return;
  if (!Array.isArray(entries)) entries = [];
  if (!entries.length) {
    sub.innerHTML = '<div class="menu-sub-empty">Nothing yet — what you open shows up here.</div>';
  } else {
    sub.innerHTML = entries.slice(0, 10).map(function (r) {
      const title = r.title || r.name;
      const when = formatRecentWhen(r.at);
      return '<button type="button" role="menuitem" class="mi" data-recent-id="' + escapeHtml(r.fileId) + '" title="' + escapeHtml(r.name) + '">' +
        '<svg class="mi-icon" aria-hidden="true"><use href="#i-file"/></svg>' +
        '<span class="mi-text"><span class="mi-label">' + escapeHtml(title) + '</span>' +
        '<span class="mi-why">' + escapeHtml(r.name) + (when ? " · " + escapeHtml(when) : "") + '</span></span></button>';
    }).join("");
  }
  if (focusFirst) {
    const first = sub.querySelector<HTMLElement>(".mi");
    if (first) first.focus();
  }
}

async function openRecentFile(fileId: string | null) {
  if (!fileId || !recentsSupported()) return;
  const mounted = activeMount;
  let handle;
  let file;
  try {
    const r = await (ports as FileMenuDropdownPorts).recents.routeOpen({ kind: "file", fileId: fileId });
    if (activeMount !== mounted) return;
    if (!r || r.where !== "this-tab") return;
    const entry = await (ports as FileMenuDropdownPorts).recents.read(fileId);
    if (activeMount !== mounted) return;
    handle = (ports as FileMenuDropdownPorts).recentHandle(entry);
    file = await handle.getFile();
  } catch (e) {
    if (activeMount !== mounted) return;
    (ports as FileMenuDropdownPorts).notices.show("That file isn't there any more — it may have been moved or deleted.", "warn");
    return;
  }
  if (activeMount !== mounted) return;
  await (ports as FileMenuDropdownPorts).opening.open({ kind: "file", file: file, handle: handle });
}

function startNewScript() {
  if (!(ports as FileMenuDropdownPorts).document.current()) { (ports as FileMenuDropdownPorts).notices.show("Still loading…", "warn"); return false; }
  const kept = replaceWithNewDocument((ports as FileMenuDropdownPorts).prepareDocument({
    title: "Untitled Script",
    rows: [{ id: (ports as FileMenuDropdownPorts).ids.id("r"), visualText: "", imageRef: null, audioText: "" }],
    wordsPerMinute: (ports as FileMenuDropdownPorts).preferences.defaultWpm()
  }), "startNewScript: a new blank document", "Before starting a new script");
  const first = document.querySelector<HTMLElement>('#rows .row .audio-cell .cell-editable');
  if (first) first.focus();
  (ports as FileMenuDropdownPorts).notices.show(kept ? "New script — the one before is in Version history." : "New script.", "ok");
  return true;
}

function openLongDemo() {
  if (!(ports as FileMenuDropdownPorts).document.current()) { (ports as FileMenuDropdownPorts).notices.show("Still loading…", "warn"); return false; }
  const kept = replaceWithNewDocument((ports as FileMenuDropdownPorts).prepareDocument(JSON.parse(JSON.stringify((ports as FileMenuDropdownPorts).longDemo.state))),
    "openLongDemo: a new copy of the long demo", "Before opening the long demo");
  (ports as FileMenuDropdownPorts).notices.show("The long demo — " + (ports as FileMenuDropdownPorts).longDemo.state.rows.length + " beats, not saved anywhere yet." +
    (kept ? " The script before is in Version history." : ""), "ok");
  return true;
}

function replaceWithNewDocument(next: ValidatedDocument, reason: string, keepLabel: string) {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body && typeof active.blur === "function") active.blur();
  const kept = ((ports as FileMenuDropdownPorts).document.current() as DocumentView).rows.length ? (ports as FileMenuDropdownPorts).history.keep(keepLabel) : null;
  if (kept) (ports as FileMenuDropdownPorts).history.keep(keepLabel, Object.assign({}, (ports as FileMenuDropdownPorts).document.current(), { docId: next.docId }));
  (ports as FileMenuDropdownPorts).resetProductionPanel();
  (ports as FileMenuDropdownPorts).transitions.startNew({ from: { document: next }, reason: reason, destination: NO_DESTINATION });
  (ports as FileMenuDropdownPorts).saving.confirmSavedNow();
  if (typeof (ports as FileMenuDropdownPorts).syncIdentity === "function") (ports as FileMenuDropdownPorts).syncIdentity();
  (ports as FileMenuDropdownPorts).panels.close("newtab-page");
  return kept;
}

function navigableItems(): HTMLButtonElement[] {
  return Array.prototype.filter.call(document.querySelectorAll("#file-menu .mi"), function (b: HTMLButtonElement) {
    return !b.disabled && b.getClientRects().length > 0;
  }) as HTMLButtonElement[];
}

function focusItemAt(i: number) {
  const items = navigableItems();
  if (!items.length) return;
  const n = ((i % items.length) + items.length) % items.length;
  (items[n] as HTMLButtonElement).focus();
}

function onMenuKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  const menu = el("file-menu");
  const items = navigableItems();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const cur = at === -1 ? null : items[at];
  const key = e.key;
  if (key === "ArrowDown") { e.preventDefault(); focusItemAt(at === -1 ? 0 : at + 1); }
  else if (key === "ArrowUp") { e.preventDefault(); focusItemAt(at === -1 ? items.length - 1 : at - 1); }
  else if (key === "Home") { e.preventDefault(); focusItemAt(0); }
  else if (key === "End") { e.preventDefault(); focusItemAt(items.length - 1); }
  else if ((key === "ArrowRight" || key === "Enter" || key === " ") && cur && cur.classList.contains("mi-parent")) {
    e.preventDefault();
    const name = cur.getAttribute("data-submenu");
    if (key !== "ArrowRight" && cur.getAttribute("aria-expanded") === "true") toggleSubmenu(name, false);
    else toggleSubmenu(name, true, true);
  } else if (key === "ArrowLeft" && cur) {
    const sub = cur.closest(".menu-sub");
    const parent = sub ? (menu as HTMLElement).querySelector<HTMLElement>('.mi-parent[aria-controls="' + sub.id + '"]')
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

function wireMenu(holdTestHook: Parameters<typeof exposeTestHook>[2]) {
  const menu = el("file-menu");
  const btn = el("btn-file");
  if (!menu || !btn) return;
  listen(menu, "keydown", onMenuKeydown);
  listen(btn, "keydown", function (e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    toggleFileMenu(true, { focusFirst: true });
    if (e.key === "ArrowUp") focusItemAt(-1);
  });
  const recent = el("menu-sub-recent");
  if (recent) {
    listen(recent, "click", function (e) {
      const item = (e.target as Element).closest("[data-recent-id]");
      if (!item) return;
      e.stopPropagation();
      toggleFileMenu(false);
      openRecentFile(item.getAttribute("data-recent-id"));
    });
  }
  listen(window, "resize", function () { if (fileMenuOpen()) positionMenu(); });
  renderKeyChips(menu);
  const search = el("btn-command");
  if (search && search.parentElement) renderKeyChips(search.parentElement);

  exposeTestHook("__fileMenuTest", function () {
    return {
      cardView: fileCardView,
      timeAgo: timeAgo,
      keyChipWords: keyChipWords,
      navigable: function () { return navigableItems().map(function (b) { return b.getAttribute("data-file-action") || b.getAttribute("data-submenu") || b.getAttribute("data-recent-id") || ""; }); }
    };
  }, holdTestHook);
}

export function startFileMenu(given: FileMenuDropdownPorts): FileMenuDropdownMount {
  ports = given;
  const mounted = {};
  activeMount = mounted;
  let withdrawHook: (() => void) | null = null;
  wireMenu(function (withdraw) { withdrawHook = withdraw; });
  let disposed = false;
  function live<A extends unknown[], R>(fn: (...args: A) => R) {
    return function (...args: A) { return disposed ? undefined : fn(...args); };
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
      while (listeners.length) (listeners.pop() as () => void)();
      if (withdrawHook) withdrawHook();
      if (activeMount === mounted) {
        activeMount = null;
        ports = null;
      }
    }
  };
}
