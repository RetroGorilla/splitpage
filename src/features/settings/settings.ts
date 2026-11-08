import type { SettingsPorts } from "./ports.ts";
import { getSavedAuthorName } from "../../application/comment-author.ts";
import { SCRIPT_SCALE_MAX, SCRIPT_SCALE_MIN, WRITER_SIZE_MAX, WRITER_SIZE_MIN } from "../../application/preferences/preferences.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { cleanAuthorName } from "../../core/document/people.ts";
import { formatClock } from "../../../shared/clock.ts";
import { applyTagIcons, applyTheme } from "./appearance.ts";
import { exposeTestHook } from "../common/test-hooks.ts";
import { microphoneChoices } from "../../application/microphones.ts";
import type { MicrophoneList } from "../../application/microphones.ts";

let ports: SettingsPorts | null = null;
const listeners: (() => void)[] = [];

function listen(target: EventTarget, type: string, handler: EventListener) {
  target.addEventListener(type, handler);
  listeners.push(function () { target.removeEventListener(type, handler); });
}

const SETTINGS_ID = "settings-modal";
let settingsReturnFocus: Element | null = null;

function modal() { return document.getElementById(SETTINGS_ID); }

export function settingsOpen() {
  const m = modal();
  return !!(m && !m.hidden);
}

function currentWriterSize() {
  const n = (ports as SettingsPorts).editor.writerSize();
  if (n != null) return n;
  const el = document.getElementById("wr-size");
  const v = el ? parseInt((el as HTMLInputElement).value, 10) : NaN;
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
  const view = (ports as SettingsPorts).actions.view("import-app-data", "button");
  return !!view && view.visible;
}

const MIC_NOTE_DESKTOP = "In the desktop app, Follow My Voice listens on the Windows default microphone. Change it in Windows Settings › System › Sound.";
const MIC_NOTE_BROWSER = "This browser listens on your system's default microphone for Follow My Voice. Chrome and Edge can use a different one.";
const MIC_HINT_NAMED = "Used by Follow My Voice. The teleprompter has the same choice.";
const MIC_HINT_UNNAMED = "Microphone names appear once Follow My Voice has been allowed to use the microphone.";
let microphoneList: MicrophoneList = { options: [], named: false };

function microphoneHtml() {
  const given = ports as SettingsPorts;
  const support = given.microphones.support();
  if (support !== "yes") {
    return '<p class="settings-hint" id="settings-microphone-note">' + escapeHtml(support === "desktop" ? MIC_NOTE_DESKTOP : MIC_NOTE_BROWSER) + '</p>';
  }
  const saved = given.preferences.microphone();
  return '<div class="settings-field settings-inline">' +
      '<label class="settings-label" for="settings-microphone">Microphone for Follow My Voice</label>' +
      '<span class="settings-inline-control"><select id="settings-microphone">' +
        microphoneChoices(saved, microphoneList).map(function (choice) {
          return '<option value="' + escapeHtml(choice.value) + '"' + (choice.value === saved ? " selected" : "") + '>' + escapeHtml(choice.label) + '</option>';
        }).join("") +
      '</select></span>' +
    '</div>' +
    '<p class="settings-hint" id="settings-microphone-hint">' + escapeHtml(microphoneList.named ? MIC_HINT_NAMED : MIC_HINT_UNNAMED) + '</p>';
}

function loadMicrophones() {
  const owner = ports;
  if (!owner || owner.microphones.support() !== "yes") return;
  owner.microphones.list().then(function (list) {
    if (ports !== owner) return;
    if (JSON.stringify(list) === JSON.stringify(microphoneList) && !document.getElementById("settings-microphone-note")) return;
    microphoneList = list;
    if (settingsOpen()) renderSettings("microphone");
  });
}

function bodyHtml() {
  const clock = (ports as SettingsPorts).preferences.clock();
  const scale = (ports as SettingsPorts).preferences.scriptScale();
  const wsize = currentWriterSize();
  const name = getSavedAuthorName((ports as SettingsPorts).preferences);
  return section("Appearance",
      segHtml("theme", "Theme", [["system", "System"], ["light", "Light"], ["dark", "Dark"]], (ports as SettingsPorts).preferences.theme()) +
      segHtml("clock", "Clock", [["system", "System"], ["12", "12-hour"], ["24", "24-hour"]], clock) +
      '<p class="settings-hint settings-clock-example" id="settings-clock-example">' + escapeHtml(clockExample(clock)) + '</p>' +
      switchHtml("settings-rundown-min", "Minimise the rundown strip", "Keep the strip of beats under the header small.", (ports as SettingsPorts).preferences.rundownMin()) +
      switchHtml("settings-tag-icons", "Show icons on tags",
        "Put a small icon for its category before each tag, as well as its colour.", (ports as SettingsPorts).preferences.tagIcons())) +
    section("Editor",
      switchHtml("settings-hide-shot", "Hide filmed beats", "Collapse beats marked Filmed into a thin strip.", (ports as SettingsPorts).preferences.hideShot()) +
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
      switchHtml("settings-prompter-scene", "One beat at a time", "Pause at the end of each beat.", (ports as SettingsPorts).preferences.prompterFlag("prompterSceneMode")) +
      microphoneHtml()) +
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
  let m = modal();
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

function typedFields(): Record<string, (key: string | null | undefined) => boolean> {
  return {
    "settings-name": function (key) { return key === "commentAuthor"; },
    "settings-default-wpm": function (key) { return key === "defaultWpm"; }
  };
}

function renderSettings(changedKey?: string | null) {
  const m = modal();
  if (!m) return;
  const bodyEl = m.querySelector("#settings-body");
  const typed: Record<string, string> = {};
  const fields = typedFields();
  Object.keys(fields).forEach(function (fid) {
    const el = document.getElementById(fid);
    if (el && !(fields[fid] as (key: string | null | undefined) => boolean)(changedKey)) typed[fid] = (el as HTMLInputElement).value;
  });
  const focusedId = document.activeElement && m.contains(document.activeElement) ? document.activeElement.id : "";
  const focusedRadio = document.activeElement && (document.activeElement as HTMLInputElement).type === "radio" && m.contains(document.activeElement)
    ? (document.activeElement as HTMLInputElement).name + "=" + (document.activeElement as HTMLInputElement).value : "";
  const scroll = (bodyEl as HTMLElement).scrollTop;
  (bodyEl as HTMLElement).innerHTML = bodyHtml();
  (bodyEl as HTMLElement).scrollTop = scroll;
  Object.keys(typed).forEach(function (fid) {
    const el = document.getElementById(fid);
    if (el) (el as HTMLInputElement).value = typed[fid] as string;
  });
  let again = null;
  if (focusedRadio) {
    const parts = focusedRadio.split("=");
    again = (bodyEl as HTMLElement).querySelector<HTMLElement>('input[name="' + parts[0] + '"][value="' + parts[1] + '"]');
  } else if (focusedId) {
    again = document.getElementById(focusedId);
  }
  if (again) { try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); } }
}

export function openSettings(opts?: unknown) {
  opts = opts && typeof opts === "object" && !(opts instanceof Event) ? opts : {};
  const m = ensureModal();
  if (!m.hidden) return;
  const active = document.activeElement;
  settingsReturnFocus = active && active !== document.body ? active : document.getElementById("btn-file");
  renderSettings();
  loadMicrophones();
  m.hidden = false;
  const wanted = (opts as { focus?: string }).focus ? document.getElementById((opts as { focus: string }).focus) : null;
  const first = wanted || m.querySelector<HTMLElement>('input[name="settings-theme"]:checked') || m.querySelector<HTMLElement>("input, button");
  if (first) first.focus();
  if (wanted) {
    try { wanted.scrollIntoView({ block: "center" }); } catch (e) { wanted.scrollIntoView(); }
    if (typeof (wanted as HTMLInputElement).select === "function") (wanted as HTMLInputElement).select();
  }
}

export function closeSettings() {
  const m = modal();
  if (!m || m.hidden) return;
  m.hidden = true;
  let back = settingsReturnFocus;
  settingsReturnFocus = null;
  if (back && back.closest && back.closest("#file-menu")) back = document.getElementById("btn-file");
  if (back && document.contains(back) && (back as HTMLElement).offsetParent !== null) {
    try { (back as HTMLElement).focus({ preventScroll: true }); } catch (e) { (back as HTMLElement).focus(); }
  }
}

function applyChange(target: HTMLInputElement) {
  const id = target.id, name = target.name;
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
  if (id === "settings-prompter-scene") { (ports as SettingsPorts).prompter.beatMode(target.checked); return; }
  if (id === "settings-microphone") { (ports as SettingsPorts).preferences.setMicrophone(target.value); return; }
  if (id === "settings-default-wpm") {
    const n = Math.round(Number(target.value));
    if (isFinite(n) && n >= 60 && n <= 400) (ports as SettingsPorts).preferences.setDefaultWpm(n);
    else target.value = (ports as SettingsPorts).preferences.defaultWpm() as unknown as string;
    return;
  }
  if (id === "settings-writer-size") { (ports as SettingsPorts).editor.setWriterSize(Number(target.value), true); return; }
  if (id === "settings-script-scale") {
    const s = Math.round(Number(target.value)) / 100;
    if (isFinite(s) && s >= SCRIPT_SCALE_MIN && s <= SCRIPT_SCALE_MAX) (ports as SettingsPorts).preferences.setScriptScale(s);
    return;
  }
  if (id === "settings-name") {
    const v = cleanAuthorName(target.value);
    if (!v || v === getSavedAuthorName((ports as SettingsPorts).preferences)) { target.value = getSavedAuthorName((ports as SettingsPorts).preferences); return; }
    (ports as SettingsPorts).preferences.setCommentAuthor(v);
  }
}

function applyInput(target: HTMLInputElement) {
  if (target.id === "settings-writer-size") {
    const out = document.getElementById("settings-writer-size-out");
    if (out) out.textContent = target.value + " px";
  } else if (target.id === "settings-script-scale") {
    const o = document.getElementById("settings-script-scale-out");
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
  listen(m, "change", function (e) { if (e.target && (e.target as Element).closest(".settings-body")) applyChange(e.target as HTMLInputElement); });
  listen(m, "input", function (e) { if (e.target) applyInput(e.target as HTMLInputElement); });
  listen(m, "keydown", function (e) {
    if ((e as KeyboardEvent).key === "Enter" && e.target && ((e.target as HTMLElement).id === "settings-name" || (e.target as HTMLElement).id === "settings-default-wpm")) {
      e.preventDefault();
      applyChange(e.target as HTMLInputElement);
      return;
    }
    if ((e as KeyboardEvent).key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSettings(); return; }
    if ((e as KeyboardEvent).key !== "Tab") return;
    const focusables = Array.prototype.filter.call(
      m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      function (el) { return !el.disabled && el.offsetParent !== null && !(el.type === "radio" && !el.checked); }
    );
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if ((e as KeyboardEvent).shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!(e as KeyboardEvent).shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  listen(m, "click", function (e) {
    if (e.target === m) { closeSettings(); return; }
    const btn = (e.target as Element).closest("[data-settings-action]");
    if (btn && !(btn as HTMLButtonElement).disabled) runAction(btn.getAttribute("data-settings-action"));
  });
}

function onPrefChanged(key: Parameters<SettingsPorts["elsewhere"]>[0] extends (name: infer N) => void ? N : never) {
  const name = key;
  if (name === "theme") applyTheme(window, (ports as SettingsPorts).preferences.theme());
  if (name === "tagIcons") applyTagIcons(window, (ports as SettingsPorts).preferences.tagIcons());
  if (settingsOpen()) renderSettings(key);
}

export function startSettings(given: SettingsPorts) {
  ports = given;
  const unhear = (ports as SettingsPorts).elsewhere(onPrefChanged);
  const unsubscribe = (ports as SettingsPorts).changes.onChange(function (change) {
    onPrefChanged(change.name);
  }, { elsewhere: false });
  const unwatchDevices = (ports as SettingsPorts).microphones.onChange(loadMicrophones);
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
      unwatchDevices();
      closeSettings();
      while (listeners.length) (listeners.pop() as () => void)();
      const m = modal();
      if (m) m.remove();
      if (withdrawHook) withdrawHook();
      settingsReturnFocus = null;
      microphoneList = { options: [], named: false };
      ports = null;
    }
  };
}
