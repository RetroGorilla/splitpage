import { SAVED_JUST_NOW_MS, savedStatusText, savedWhenText } from "../../../shared/clock.ts";
import { saveButtonView, saveStatus } from "../../application/save/status.ts";
import { exposeTestHook } from "../common/test-hooks.ts";
import type { SaveStatusPorts, SaveStatusListeners, SaveStatusMount } from "./ports.ts";
import type { SaveStatusLine } from "../../application/save/status.ts";
import type { LocalFileHandle } from "../../application/files/local-file-access.ts";

type MutableSaveStatusLine = { -readonly [K in keyof SaveStatusLine]: SaveStatusLine[K] };

let ports: SaveStatusPorts | null = null;

function paintSaveButtons() {
  const view = saveButtonView({ busy: (ports as SaveStatusPorts).saves.busy(), dirty: (ports as SaveStatusPorts).saves.unsaved() });
  ["btn-save", "wr-save"].forEach(function (id) {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = view.label;
    (btn as HTMLButtonElement).disabled = view.disabled;
    btn.classList.toggle("is-dirty", view.dirty);
  });
}

function setSaveButtons() {
  paintSaveButtons();
  (ports as SaveStatusPorts).identity.sync();
  (ports as SaveStatusPorts).drafts.noteChange();
  updateSaveStatus();
}

function saveStatusListeners(): SaveStatusListeners {
  return {
    paint: function () {
      paintSaveButtons();
      updateSaveStatus();
    },
    save: function (change) {
      if (change === "change") {
        if (!(ports as SaveStatusPorts).saves.busy()) setSaveButtons();
      } else if (change === "clean") {
        savedAt = 0;
        setSaveButtons();
      } else if (change === "running") {
        setSaveButtons();
      } else {
        updateSaveStatus();
      }
    },
    location: function (change) {
      if (change !== "writtenOut") updateSaveStatus();
    },
    preference: function (change) {
      if ((ports as SaveStatusPorts).preferences.nameOf(change.key) === "clock") updateSaveStatus();
    }
  };
}

function savedTitle(where: SaveStatusLine["where"]) {
  const when = savedWhenText(savedAt, Date.now(), (ports as SaveStatusPorts).preferences.clock());
  if (when) return "Last saved " + (where ? "to " + where + " " : "") + "at " + when + ".";
  return where ? "Up to date with " + where + "." : "Everything is saved.";
}

function saveStatusView() {
  const target = (ports as SaveStatusPorts).autoSave.target();
  const place = (ports as SaveStatusPorts).place;
  const where = place.home().kind === "file" ? ((place.home().handle && (place.home().handle as Pick<LocalFileHandle, "name">).name) as string | null | undefined) || ""
    : place.home().kind === "import" ? (place.home().name as string | null | undefined) || ""
    : "";

  const autosave = (ports as SaveStatusPorts).autoSave.policy();
  const line = saveStatus({
    busy: (ports as SaveStatusPorts).saves.busy(),
    dirty: (ports as SaveStatusPorts).saves.unsaved(),
    halted: autosave.halted(),
    autoSaveOn: autosave.enabled(),
    target: target,
    where: where,
    homeKind: place.home().kind
  }).line;
  return line ? Object.assign({}, line) : null;
}

let savedAt = 0;
let lastViewText = "";
let justNowTimer: ReturnType<typeof setTimeout> | null = null;

function updateSaveStatus() {
  const view = saveStatusView();
  const text = view ? view.text : "";
  if (text === "Saved" && lastViewText === "Saving…") savedAt = Date.now();
  else if (text !== "Saved") savedAt = 0;
  lastViewText = text;
  if (text === "Saved") (view as MutableSaveStatusLine).title = savedTitle((view as MutableSaveStatusLine).where);
  ["save-status", "wr-save-status"].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !view;
    if (!view) { el.textContent = ""; el.removeAttribute("title"); return; }
    el.textContent = view.text;
    el.title = view.title;
    el.className = "save-status is-" + view.cls;
  });
  const btn = document.getElementById("btn-save");
  if (btn) {
    const shown = !view ? "Save" : text === "Saved" ? savedStatusText(savedAt, Date.now()) : view.text;
    btn.setAttribute("data-status", shown);
    btn.setAttribute("data-state", view ? view.cls : "none");
    btn.setAttribute("aria-label", view ? shown + ". Save now" : "Save");
    btn.title = view ? view.title + " Click to save now." : "Save this script";
  }
  if (savedAt && !justNowTimer) {
    const left = savedAt + SAVED_JUST_NOW_MS - Date.now();
    if (left > 0) {
      justNowTimer = setTimeout(function () {
        justNowTimer = null;
        if (savedAt) updateSaveStatus();
      }, left + 50);
    }
  }
}

let activeMount: SaveStatusMount | null = null;

export function mountSaveStatus(nextPorts: SaveStatusPorts) {
  ports = nextPorts;
  const mine = nextPorts;
  function onOwnerCleared(e: Event) {
    const n = ((e as CustomEvent<{ count?: number }>).detail && (e as CustomEvent<{ count?: number }>).detail.count) || 0;
    if (n) mine.notices.show("That person is no longer on the crew, so " + (n === 1 ? "1 item is" : n + " items are") + " now unassigned.", "warn");
  }
  const listening = typeof document !== "undefined" && !!document.addEventListener;
  if (listening) document.addEventListener("undo-owner-cleared", onOwnerCleared);
  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__saveStatusTest", function () { return { refresh: updateSaveStatus }; }, function (withdraw) { withdrawHook = withdraw; });
  let disposed = false;
  const mounted = {
    refresh: updateSaveStatus,
    listeners: saveStatusListeners,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      if (listening) document.removeEventListener("undo-owner-cleared", onOwnerCleared);
      if (withdrawHook) withdrawHook();
      if (activeMount !== mounted) return;
      activeMount = null;
      if (justNowTimer) clearTimeout(justNowTimer);
      justNowTimer = null;
      savedAt = 0;
      lastViewText = "";
      ports = null;
    }
  };
  activeMount = mounted;
  return mounted;
}
