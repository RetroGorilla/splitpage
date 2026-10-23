import { SCRIPT_SCALE_MAX, SCRIPT_SCALE_MIN, WRITER_SIZE_MAX, WRITER_SIZE_MIN } from "../../application/preferences/preferences.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { cleanAuthorName } from "../../core/document/people.ts";
import { formatClock } from "../../../shared/clock.js";
import { applyTagIcons, applyTheme } from "./appearance.ts";

var ports = null;
var listeners = [];

function listen(target, type, handler) {
  target.addEventListener(type, handler);
  listeners.push(function () { target.removeEventListener(type, handler); });
}

var SETTINGS_ID = "settings-modal";
var settingsReturnFocus = null;

function modal() { return document.getElementById(SETTINGS_ID); }

export function settingsOpen() {
  var m = modal();
  return !!(m && !m.hidden);
}

function currentWriterSize() {
  var n = ports.editor.writerSize();
  if (n != null) return n;
  var el = document.getElementById("wr-size");
  var v = el ? parseInt(el.value, 10) : NaN;
  return isFinite(v) ? v : 20;
}

function segHtml(name, label, options, value) {
  return '<div class="settings-field">' +
    '<div class="settings-label" id="settings-' + name + '-label">' + escapeHtml(label) + '</div>' +
    '<div class="export-seg settings-seg" role="radiogroup" aria-labelledby="settings-' + name + '-label">' +
    options.map(function (o) {
      return '<label><input type="radio" name="settings-' + name + '" value="' + escapeHtml(o[0]) + '"' +
        (o[0] === value ? " checked" : "") + '>' + escapeHtml(o[1]) + '</label>';
    }).join("") +
    '</div></div>';
}

function switchHtml(id, label, hint, on) {
  return '<label class="settings-switch" for="' + id + '">' +
    '<span class="settings-switch-text"><span class="settings-switch-label">' + escapeHtml(label) + '</span>' +
      (hint ? '<span class="settings-hint">' + escapeHtml(hint) + '</span>' : '') + '</span>' +
    '<input type="checkbox" role="switch" id="' + id + '"' + (on ? " checked" : "") + '>' +
    '<span class="settings-switch-track" aria-hidden="true"><span class="settings-switch-thumb"></span></span>' +
    '</label>';
}

function section(title, body) {
  return '<section class="settings-section" aria-label="' + escapeHtml(title) + '">' +
    '<h3 class="settings-section-title">' + escapeHtml(title) + '</h3>' + body + '</section>';
}

function clockExample(mode) {
  return formatClock(new Date(2026, 0, 1, 14, 52), mode) + " · " + formatClock(new Date(2026, 0, 1, 9, 5), mode);
}

function importAvailable() {
  var view = ports.actions.view("import-app-data", "button");
  return !!view && view.visible;
}

function collaborationHtml() {
  var v = ports.collaboration.view();
  var where = v.servedHere
    ? '<p class="settings-hint settings-hint-flat">This page comes from <strong>' + escapeHtml(v.label) +
        '</strong>, so Collaborate stores scripts there.</p>'
    : '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-collab-server">Server address</label>' +
        '<span class="settings-inline-control"><input type="text" id="settings-collab-server" class="settings-wide" autocomplete="off" ' +
          'spellcheck="false" autocapitalize="off" placeholder="' + escapeHtml(ports.collaboration.defaultServer) + '" value="' +
          escapeHtml(ports.collaboration.address()) + '">' +
          (v.isDefault ? '' : '<button type="button" class="btn-outline is-small" data-settings-action="collab-default">Use the default</button>') +
        '</span>' +
      '</div>' +
      '<p class="settings-hint">Where Collaborate stores the scripts you share. Everyone you invite works on the copy there.</p>';
  return where +
    '<div class="settings-field settings-inline">' +
      '<span class="settings-label" id="settings-collab-signin">' + (v.signedIn
        ? 'Signed in on this device'
        : 'Not signed in on this device') + '</span>' +
      '<span class="settings-inline-control"><button type="button" class="btn-outline is-small" data-settings-action="collab-signout"' +
        (v.signedIn ? '' : ' disabled') + '>Sign out</button></span>' +
    '</div>' +
    '<p class="settings-hint">' + (v.signedIn
      ? 'Collaborate uses your owner key without asking. Sign out to make this device ask for it again.'
      : 'Collaborate asks for your server’s owner key the first time, and remembers it here.') + '</p>';
}

function bodyHtml() {
  var clock = ports.preferences.clock();
  var scale = ports.preferences.scriptScale();
  var wsize = currentWriterSize();
  var name = ports.identity.name();
  return section("Appearance",
      segHtml("theme", "Theme", [["system", "System"], ["light", "Light"], ["dark", "Dark"]], ports.preferences.theme()) +
      segHtml("clock", "Clock", [["system", "System"], ["12", "12-hour"], ["24", "24-hour"]], clock) +
      '<p class="settings-hint settings-clock-example" id="settings-clock-example">' + escapeHtml(clockExample(clock)) + '</p>' +
      switchHtml("settings-rundown-min", "Minimise the rundown strip", "Keep the strip of scenes under the header small.", ports.preferences.rundownMin()) +
      switchHtml("settings-tag-icons", "Show icons on tags",
        "Put a small icon for its category before each tag, as well as its colour.", ports.preferences.tagIcons())) +
    section("Editor",
      switchHtml("settings-hide-shot", "Hide shot scenes", "Collapse scenes marked Shot into a thin strip.", ports.preferences.hideShot()) +
      switchHtml("settings-autosave", "Autosave", "Write each change to the file you saved to, a moment after you stop typing.", ports.preferences.autosave()) +
      switchHtml("settings-video-thumbs", "Fetch video thumbnails",
        "When you paste a YouTube or Vimeo link, ask the site for its picture once and keep it with the script.", ports.preferences.videoThumbs()) +
      '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-default-wpm">Reading speed for new scripts</label>' +
        '<span class="settings-inline-control"><input type="number" id="settings-default-wpm" min="60" max="400" step="5" value="' +
          ports.preferences.defaultWpm() + '"><span class="settings-unit">words a minute</span></span>' +
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
      switchHtml("settings-prompter-mirror", "Mirror", "Flip the teleprompter left to right, for a beam-splitter glass.", ports.preferences.prompterFlag("prompterMirror")) +
      switchHtml("settings-prompter-flip", "Flip", "Turn it upside down, for a monitor mounted that way.", ports.preferences.prompterFlag("prompterFlip")) +
      switchHtml("settings-prompter-scene", "One scene at a time", "Pause at the end of each scene.", ports.preferences.prompterFlag("prompterSceneMode"))) +
    section("You",
      '<div class="settings-field settings-inline">' +
        '<label class="settings-label" for="settings-name">Your name</label>' +
        '<span class="settings-inline-control"><input type="text" id="settings-name" autocomplete="name" placeholder="Your name" value="' +
          escapeHtml(name) + '"></span>' +
      '</div>' +
      '<p class="settings-hint">Signs your edits and comments.</p>' +
      ports.identity.swatchesHtml(name, "settings-person-color", "settings-label")) +
    section("Collaboration", collaborationHtml()) +
    section("Help & tips",
      '<div class="settings-actions">' +
        '<button type="button" class="btn-outline" data-settings-action="tagging-help">Show the tagging reference</button>' +
        '<button type="button" class="btn-outline" data-settings-action="tour">Take the tour again</button>' +
        '<button type="button" class="btn-outline" data-settings-action="desktop-notice">Show the desktop-app notice again</button>' +
      '</div>') +
    section("Data",
      '<div class="settings-actions">' +
        '<button type="button" class="btn-outline" data-settings-action="export-app-data">Export app data…</button>' +
        (importAvailable() ? '<button type="button" class="btn-outline" data-settings-action="import-app-data">Import app data…</button>' : '') +
        '<button type="button" class="btn-outline" data-settings-action="servers">Servers…</button>' +
        '<button type="button" class="btn-outline" data-settings-action="drive">Google Drive…</button>' +
      '</div>' +
      '<p class="settings-hint">App data is your version history, server bookmarks and these settings — take it to another computer or the desktop app.</p>');
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
    "settings-default-wpm": function (key) { return key === "defaultWpm"; },
    "settings-collab-server": function (key) { return key === "collabServer"; }
  };
}

function renderSettings(changedKey) {
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

export function openSettings(opts) {
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

function applyChange(target) {
  var id = target.id, name = target.name;
  if (name === "settings-theme") { ports.preferences.setTheme(target.value); return; }
  if (name === "settings-clock") { ports.preferences.setClock(target.value); return; }
  if (name === "settings-person-color") { ports.preferences.setMyColor(target.value); return; }
  if (id === "settings-rundown-min") { ports.preferences.setRundownMin(target.checked); return; }
  if (id === "settings-tag-icons") { ports.preferences.setTagIcons(target.checked); return; }
  if (id === "settings-video-thumbs") { ports.preferences.setVideoThumbs(target.checked); return; }
  if (id === "settings-hide-shot") { ports.editor.hideShot(target.checked); return; }
  if (id === "settings-autosave") { ports.editor.autoSave(target.checked); return; }
  if (id === "settings-prompter-mirror") { ports.prompter.mirror(target.checked); return; }
  if (id === "settings-prompter-flip") { ports.prompter.flip(target.checked); return; }
  if (id === "settings-prompter-scene") { ports.prompter.sceneMode(target.checked); return; }
  if (id === "settings-default-wpm") {
    var n = Math.round(Number(target.value));
    if (isFinite(n) && n >= 60 && n <= 400) ports.preferences.setDefaultWpm(n);
    else target.value = ports.preferences.defaultWpm();
    return;
  }
  if (id === "settings-writer-size") { ports.editor.setWriterSize(Number(target.value), true); return; }
  if (id === "settings-script-scale") {
    var s = Math.round(Number(target.value)) / 100;
    if (isFinite(s) && s >= SCRIPT_SCALE_MIN && s <= SCRIPT_SCALE_MAX) ports.preferences.setScriptScale(s);
    return;
  }
  if (id === "settings-name") {
    var v = cleanAuthorName(target.value);
    if (!v || v === ports.identity.name()) { target.value = ports.identity.name(); return; }
    ports.preferences.setCommentAuthor(v);
  }
  if (id === "settings-collab-server") {
    var raw = (target.value || "").trim();
    var url = raw ? ports.collaboration.normalize(raw) : ports.collaboration.defaultServer;
    if (!url) {
      ports.notices.show("That isn't a web address — something like https://script.example.com/", "warn");
      target.value = ports.collaboration.address();
      return;
    }
    if (url === ports.collaboration.address()) { target.value = url; return; }
    ports.preferences.setCollabServer(url === ports.collaboration.defaultServer ? null : url);
  }
}

function applyInput(target) {
  if (target.id === "settings-writer-size") {
    var out = document.getElementById("settings-writer-size-out");
    if (out) out.textContent = target.value + " px";
  } else if (target.id === "settings-script-scale") {
    var o = document.getElementById("settings-script-scale-out");
    if (o) o.textContent = target.value + " %";
  }
}

function runAction(action) {
  if (action === "close") { closeSettings(); return; }
  if (action === "scale-reset") { ports.preferences.setScriptScale(1); return; }
  if (action === "tagging-help") {
    closeSettings();
    ports.actions.invoke("tagging-help", "button");
    ports.preferences.announceTaggingHelp();
    return;
  }
  if (action === "tour") {
    closeSettings();
    ports.preferences.resetTour();
    ports.actions.invoke("tour", "button");
    return;
  }
  if (action === "desktop-notice") {
    ports.preferences.resetDesktopNotice();
    if (typeof ports.desktop.renderNotice === "function") ports.desktop.renderNotice();
    ports.notices.show(ports.desktop.running() ? "The desktop-app notice only shows in the browser." : "The desktop-app notice will show again.", "ok");
    return;
  }
  if (action === "collab-default") { ports.preferences.setCollabServer(null); return; }
  if (action === "collab-signout") {
    ports.collaboration.signOut();
    renderSettings();
    return;
  }
  if (action === "servers") { closeSettings(); ports.actions.invoke("servers", "button"); return; }
  if (action === "drive") { closeSettings(); ports.actions.invoke("drive-open", "button"); return; }
  if (action === "export-app-data") { closeSettings(); ports.actions.invoke("export-app-data", "button"); return; }
  if (action === "import-app-data") { closeSettings(); ports.actions.invoke("import-app-data", "button"); }
}

function wireModal(m) {
  listen(m, "change", function (e) { if (e.target && e.target.closest(".settings-body")) applyChange(e.target); });
  listen(m, "input", function (e) { if (e.target) applyInput(e.target); });
  listen(m, "keydown", function (e) {
    if (e.key === "Enter" && e.target && (e.target.id === "settings-name" || e.target.id === "settings-default-wpm" ||
        e.target.id === "settings-collab-server")) {
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

function onPrefChanged(key) {
  var name = key;
  if (name === "theme") applyTheme(window, ports.preferences.theme());
  if (name === "tagIcons") applyTagIcons(window, ports.preferences.tagIcons());
  if (settingsOpen()) renderSettings(key);
}

export function __init(given) {
  ports = given;
  var unsubscribe = ports.changes.onChange(function (change) {
    onPrefChanged(change.name);
  });
  var test = {
    open: openSettings,
    close: closeSettings,
    isOpen: settingsOpen
  };
  window.__settingsTest = test;
  return {
    openSettings: openSettings,
    dispose: function () {
      unsubscribe();
      closeSettings();
      while (listeners.length) listeners.pop()();
      var m = modal();
      if (m) m.remove();
      if (window.__settingsTest === test) delete window.__settingsTest;
      settingsReturnFocus = null;
      ports = null;
    }
  };
}
