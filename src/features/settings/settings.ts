import type { SettingsPorts } from "./ports.ts";
import { getSavedAuthorName } from "../../application/comment-author.ts";
import { SCRIPT_SCALE_MAX, SCRIPT_SCALE_MIN, WRITER_SIZE_MAX, WRITER_SIZE_MIN } from "../../application/preferences/preferences.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { cleanAuthorName } from "../../core/document/people.ts";
import { formatClock } from "../../../shared/clock.js";
import { applyTagIcons, applyTheme } from "./appearance.ts";
import { exposeTestHook } from "../common/test-hooks.ts";

let ports: SettingsPorts | null = null;
let listeners: (() => void)[] = [];

function listen(target: EventTarget, type: string, handler: EventListener) {
  target.addEventListener(type, handler);
  listeners.push(function () { target.removeEventListener(type, handler); });
}

var SETTINGS_ID = "settings-modal";
let settingsReturnFocus: HTMLElement | null = null;

function modal() { return document.getElementById(SETTINGS_ID); }

export function settingsOpen() {
  var m = modal();
  return !!(m && !m.hidden);
}

function currentWriterSize() {
  var n = (ports as SettingsPorts).editor.writerSize();
  if (n != null) return n;
  var el = document.getElementById("wr-size");
  var v = el ? parseInt(el.value, 10) : NaN;
  return isFinite(v) ? v : 20;
}

function segHtml(name: string, label: string, options: [string, string][], value: string) {
  return '<div class="settings-field">' +
    '<div class="settings-label" id="settings-' + name + '-label">' + escapeHtml(label) + '</div>' +
    '<div class="export-seg settings-seg" role="radiogroup" aria-labelledby="settings-' + name + '-label">' +
    options.map(function (o) {
      return '<label><input type="radio" name="settings-' + name + '" value="' + escapeHtml(o[0]) + '"' +
        (o[0] === value ? " checked" : "") + '>' + escapeHtml(o[1]) + '</label>';
    }).join("") +
    '</div></div>';
}

function switchHtml(id: string, label: string, hint: string, on: boolean) {
  return '<label class="settings-switch" for="' + id + '">' +
    '<span class="settings-switch-text"><span class="settings-switch-label">' + escapeHtml(label) + '</span>' +
      (hint ? '<span class="settings-hint">' + escapeHtml(hint) + '</span>' : '') + '</span>' +
    '<input type="checkbox" role="switch" id="' + id + '"' + (on ? " checked" : "") + '>' +
    '<span class="settings-switch-track" aria-hidden="true"><span class="settings-switch-thumb"></span></span>' +
    '</label>';
}

function section(title: string, body: string) {
  return '<section class="settings-section" aria-label="' + escapeHtml(title) + '">' +
    '<h3 class="settings-section-title">' + escapeHtml(title) + '</h3>' + body + '</section>';
}

function clockExample(mode: string) {
  return formatClock(new Date(2026, 0, 1, 14, 52), mode) + " · " + formatClock(new Date(2026, 0, 1, 9, 5), mode);
}

function importAvailable() {
  var view = (ports as SettingsPorts).actions.view("import-app-data", "button");
  return !!view && view.visible;
}

function bodyHtml() {
  var clock = (ports as SettingsPorts).preferences.clock();
  var scale = (ports as SettingsPorts).preferences.scriptScale();
  var wsize = currentWriterSize();
  var name = getSavedAuthorName((ports as SettingsPorts).preferences);
  return section("Appearance",
      segHtml("theme", "Theme", [["system", "System"], ["light", "Light"], ["dark", "Dark"]], (ports as SettingsPorts).preferences.theme()) +
      segHtml("clock", "Clock", [["system", "System"], ["12", "12-hour"], ["24", "24-hour"]], clock) +
      '<p class="settings-hint settings-clock-example" id="settings-clock-example">' + escapeHtml(clockExample(clock)) + '</p>' +
      switchHtml("settings-rundown-min", "Minimise the rundown strip", "Keep the strip of scenes under the header small.", (ports as SettingsPorts).preferences.rundownMin()) +
      switchHtml("settings-tag-icons", "Show icons on tags",
        "Put a small icon for its category before each tag, as well as its colour.", (ports as SettingsPorts).preferences.tagIcons())) +
    section("Editor",
      switchHtml("settings-hide-shot", "Hide shot scenes", "Collapse scenes marked Shot into a thin strip.", (ports as SettingsPorts).preferences.hideShot()) +
      switchHtml("settings-autosave", "Autosave", "Write each change to the file you saved to, a moment after you stop typing.", (ports as SettingsPorts).preferences.autosave()) +
      switchHtml("settings-video-thumbs", "Fetch video thumbnails",
        "When you paste a YouTube or Vimeo link, ask the site for its picture once and keep it with the script.", (ports as SettingsPorts).preferences.videoThumbs()) +
      '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-default-wpm">Reading speed for new scripts</label>' +
        '<span class="settings-inline-control"><input type="number" id="settings-default-wpm" min="60" max="400" step="5" value="' +
          (ports as SettingsPorts).preferences.defaultWpm() + '"><span class="settings-unit">words a minute</span></span>' +
      '</div>' +
      '<p class="settings-hint">Each script keeps its own speed — click its length on the rundown to change it.</p>' +
      '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-writer-size">Writer text size</label>' +
        '<span class="settings-inline-control"><input type="range" id="settings-writer-size" min="' + WRITER_SIZE_MIN +
          '" max="' + WRITER_SIZE_MAX + '" step="1" value="' + wsize + '"><output class="settings-value" id="settings-writer-size-out" for="settings-writer-size">' +
          wsize + ' px</output></span>' +
      '</div>' +
      '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-script-scale">Script zoom</label>' +
        '<span class="settings-inline-control"><input type="range" id="settings-script-scale" min="' + Math.round(SCRIPT_SCALE_MIN * 100) +
          '" max="' + Math.round(SCRIPT_SCALE_MAX * 100) + '" step="10" value="' + Math.round(scale * 100) + '">' +
          '<output class="settings-value" id="settings-script-scale-out" for="settings-script-scale">' + Math.round(scale * 100) + ' %</output>' +
          '<button type="button" class="btn-outline is-small" data-settings-action="scale-reset"' + (scale === 1 ? " disabled" : "") + '>Reset to 100 %</button></span>' +
      '</div>') +
    section("Present",
      switchHtml("settings-prompter-mirror", "Mirror", "Flip the teleprompter left to right, for a beam-splitter glass.", (ports as SettingsPorts).preferences.prompterFlag("prompterMirror")) +
      switchHtml("settings-prompter-flip", "Flip", "Turn it upside down, for a monitor mounted that way.", (ports as SettingsPorts).preferences.prompterFlag("prompterFlip")) +
      switchHtml("settings-prompter-scene", "One scene at a time", "Pause at the end of each scene.", (ports as SettingsPorts).preferences.prompterFlag("prompterSceneMode"))) +
    section("You",
      '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-name">Your name</label>' +
        '<span class="settings-inline-control"><input type="text" id="settings-name" autocomplete="name" placeholder="Your name" value="' +
          escapeHtml(name) + '"></span>' +
      '</div>' +
      '<p class="settings-hint">Signs your edits and comments.</p>' +
      (ports as SettingsPorts).identity.swatchesHtml(name, "settings-person-color", "settings-label")) +
    section("Help & tips",
      '<div class="settings-actions">' +
        '<button type="button" class="btn-outline" data-settings-action="tagging-help">Show the tagging reference</button>' +
        '<button type="button" class="btn-outline" data-settings-action="tour">Take the tour again</button>' +
        '<button type="button" class="btn-outline" id="settings-desktop-notice" data-settings-action="desktop-notice">Show the desktop-app notice again</button>' +
      '</div>') +
    section("Data",
      '<div class="settings-actions">' +
        '<button type="button" class="btn-outline" data-settings-action="export-app-data">Export app data…</button>' +
        (importAvailable() ? '<button type="button" class="btn-outline" data-settings-action="import-app-data">Import app data…</button>' : '') +
      '</div>' +
      '<p class="settings-hint">App data is your version history and these settings — take it to another computer or the desktop app.</p>');
}

function ensureModal() {
  var m = modal();
  if (m) return m;
  m = document.createElement("div");
  m.className = "modal-backdrop";
  m.id = SETTINGS_ID;
  m.hidden = true;
  m.innerHTML =
    '<div class="modal-panel settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">' +
      '<div class="modal-header">' +
        '<h2 id="settings-title">Settings</h2>' +
        '<button type="button" class="modal-close" data-settings-action="close" aria-label="Close"><svg aria-hidden="true" focusable="false"><use href="#i-close"/></svg></button>' +
      '</div>' +
      '<p class="modal-hint">How Splitpage works for you, on this device. Nothing here changes the script.</p>' +
      '<div class="settings-body" id="settings-body"></div>' +
    '</div>';
  document.body.appendChild(m);
  wireModal(m);
  return m;
}

function typedFields() {
  return {
    "settings-name": function (key) { return key === "commentAuthor"; },
    "settings-default-wpm": function (key) { return key === "defaultWpm"; }
  };
}

function renderSettings(changedKey?: string | null) {
  var m = modal();
  if (!m) return;
  var bodyEl = m.querySelector("#settings-body");
  var typed = {};
  var fields = typedFields();
  Object.keys(fields).forEach(function (fid) {
    var el = document.getElementById(fid);
    if (el && !fields[fid](changedKey)) typed[fid] = el.value;
  });
  var focusedId = document.activeElement && m.contains(document.activeElement) ? document.activeElement.id : "";
  var focusedRadio = document.activeElement && document.activeElement.type === "radio" && m.contains(document.activeElement)
    ? document.activeElement.name + "=" + document.activeElement.value : "";
  var scroll = bodyEl.scrollTop;
  bodyEl.innerHTML = bodyHtml();
  bodyEl.scrollTop = scroll;
  Object.keys(typed).forEach(function (fid) {
    var el = document.getElementById(fid);
    if (el) el.value = typed[fid];
  });
  var again = null;
  if (focusedRadio) {
    var parts = focusedRadio.split("=");
    again = bodyEl.querySelector('input[name="' + parts[0] + '"][value="' + parts[1] + '"]');
  } else if (focusedId) {
    again = document.getElementById(focusedId);
  }
  if (again) { try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); } }
}

export function openSettings(opts?: { focus?: string } | Event) {
  opts = opts && typeof opts === "object" && !(opts instanceof Event) ? opts : {};
  var m = ensureModal();
  if (!m.hidden) return;
  var active = document.activeElement;
  settingsReturnFocus = active && active !== document.body ? active : document.getElementById("btn-file");
  renderSettings();
  m.hidden = false;
  var wanted = opts.focus ? document.getElementById(opts.focus) : null;
  var first = wanted || m.querySelector('input[name="settings-theme"]:checked') || m.querySelector("input, button");
  if (first) first.focus();
  if (wanted) {
    try { wanted.scrollIntoView({ block: "center" }); } catch (e) { wanted.scrollIntoView(); }
    if (typeof wanted.select === "function") wanted.select();
  }
}

export function closeSettings() {
  var m = modal();
  if (!m || m.hidden) return;
  m.hidden = true;
  var back = settingsReturnFocus;
  settingsReturnFocus = null;
  if (back && back.closest && back.closest("#file-menu")) back = document.getElementById("btn-file");
  if (back && document.contains(back) && back.offsetParent !== null) {
    try { back.focus({ preventScroll: true }); } catch (e) { back.focus(); }
  }
}

function applyChange(target: HTMLInputElement) {
  var id = target.id, name = target.name;
  if (name === "settings-theme") { (ports as SettingsPorts).preferences.setTheme(target.value); return; }
  if (name === "settings-clock") { (ports as SettingsPorts).preferences.setClock(target.value); return; }
  if (name === "settings-person-color") { (ports as SettingsPorts).preferences.setMyColor(target.value); return; }
  if (id === "settings-rundown-min") { (ports as SettingsPorts).preferences.setRundownMin(target.checked); return; }
  if (id === "settings-tag-icons") { (ports as SettingsPorts).preferences.setTagIcons(target.checked); return; }
  if (id === "settings-video-thumbs") { (ports as SettingsPorts).preferences.setVideoThumbs(target.checked); return; }
  if (id === "settings-hide-shot") { (ports as SettingsPorts).editor.hideShot(target.checked); return; }
  if (id === "settings-autosave") { (ports as SettingsPorts).editor.autoSave(target.checked); return; }
  if (id === "settings-prompter-mirror") { (ports as SettingsPorts).prompter.mirror(target.checked); return; }
  if (id === "settings-prompter-flip") { (ports as SettingsPorts).prompter.flip(target.checked); return; }
  if (id === "settings-prompter-scene") { (ports as SettingsPorts).prompter.sceneMode(target.checked); return; }
  if (id === "settings-default-wpm") {
    var n = Math.round(Number(target.value));
    if (isFinite(n) && n >= 60 && n <= 400) (ports as SettingsPorts).preferences.setDefaultWpm(n);
    else target.value = (ports as SettingsPorts).preferences.defaultWpm();
    return;
  }
  if (id === "settings-writer-size") { (ports as SettingsPorts).editor.setWriterSize(Number(target.value), true); return; }
  if (id === "settings-script-scale") {
    var s = Math.round(Number(target.value)) / 100;
    if (isFinite(s) && s >= SCRIPT_SCALE_MIN && s <= SCRIPT_SCALE_MAX) (ports as SettingsPorts).preferences.setScriptScale(s);
    return;
  }
  if (id === "settings-name") {
    var v = cleanAuthorName(target.value);
    if (!v || v === getSavedAuthorName((ports as SettingsPorts).preferences)) { target.value = getSavedAuthorName((ports as SettingsPorts).preferences); return; }
    (ports as SettingsPorts).preferences.setCommentAuthor(v);
  }
}

function applyInput(target: HTMLInputElement) {
  if (target.id === "settings-writer-size") {
    var out = document.getElementById("settings-writer-size-out");
    if (out) out.textContent = target.value + " px";
  } else if (target.id === "settings-script-scale") {
    var o = document.getElementById("settings-script-scale-out");
    if (o) o.textContent = target.value + " %";
  }
}

function runAction(action: string | null) {
  if (action === "close") { closeSettings(); return; }
  if (action === "scale-reset") { (ports as SettingsPorts).preferences.setScriptScale(1); return; }
  if (action === "tagging-help") {
    closeSettings();
    (ports as SettingsPorts).actions.invoke("tagging-help", "button");
    (ports as SettingsPorts).preferences.announceTaggingHelp();
    return;
  }
  if (action === "tour") {
    closeSettings();
    (ports as SettingsPorts).preferences.resetTour();
    (ports as SettingsPorts).actions.invoke("tour", "button");
    return;
  }
  if (action === "desktop-notice") {
    (ports as SettingsPorts).preferences.resetDesktopNotice();
    if (typeof (ports as SettingsPorts).desktop.renderNotice === "function") (ports as SettingsPorts).desktop.renderNotice();
    (ports as SettingsPorts).notices.show((ports as SettingsPorts).desktop.running() ? "The desktop-app notice only shows in the browser." : "The desktop-app notice will show again.", "ok");
    return;
  }
  if (action === "export-app-data") { closeSettings(); (ports as SettingsPorts).actions.invoke("export-app-data", "button"); return; }
  if (action === "import-app-data") { closeSettings(); (ports as SettingsPorts).actions.invoke("import-app-data", "button"); }
}

function wireModal(m: HTMLElement) {
  listen(m, "change", function (e) { if (e.target && e.target.closest(".settings-body")) applyChange(e.target); });
  listen(m, "input", function (e) { if (e.target) applyInput(e.target); });
  listen(m, "keydown", function (e) {
    if (e.key === "Enter" && e.target && (e.target.id === "settings-name" || e.target.id === "settings-default-wpm")) {
      e.preventDefault();
      applyChange(e.target);
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSettings(); return; }
    if (e.key !== "Tab") return;
    var focusables = Array.prototype.filter.call(
      m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (el) { return !el.disabled && el.offsetParent !== null && !(el.type === "radio" && !el.checked); }
    );
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  listen(m, "click", function (e) {
    if (e.target === m) { closeSettings(); return; }
    var btn = e.target.closest("[data-settings-action]");
    if (btn && !btn.disabled) runAction(btn.getAttribute("data-settings-action"));
  });
}

function onPrefChanged(key: Parameters<SettingsPorts["elsewhere"]>[0] extends (name: infer N) => void ? N : never) {
  var name = key;
  if (name === "theme") applyTheme(window, (ports as SettingsPorts).preferences.theme());
  if (name === "tagIcons") applyTagIcons(window, (ports as SettingsPorts).preferences.tagIcons());
  if (settingsOpen()) renderSettings(key);
}

export function startSettings(given: SettingsPorts) {
  ports = given;
  var unhear = (ports as SettingsPorts).elsewhere(onPrefChanged);
  var unsubscribe = (ports as SettingsPorts).changes.onChange(function (change) {
    onPrefChanged(change.name);
  }, { elsewhere: false });
  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__settingsTest", function () {
    return {
      open: openSettings,
      close: closeSettings,
      isOpen: settingsOpen
    };
  }, function (withdraw) { withdrawHook = withdraw; });
  return {
    openSettings: openSettings,
    dispose: function () {
      unsubscribe();
      unhear();
      closeSettings();
      while (listeners.length) listeners.pop()();
      var m = modal();
      if (m) m.remove();
      if (withdrawHook) withdrawHook();
      settingsReturnFocus = null;
      ports = null;
    }
  };
}
