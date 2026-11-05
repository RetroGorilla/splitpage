import { SAVED_JUST_NOW_MS, savedStatusText, savedWhenText } from "../../../shared/clock.ts";
import { flowSaveStatus, saveButtonView, saveStatus } from "../../application/save/status.ts";
import { writerFlowEnabled } from "../common/writer-flow-enabled.ts";
import { exposeTestHook } from "../common/test-hooks.ts";
import type { SaveStatusPorts, SaveStatusListeners, SaveStatusMount } from "./ports.ts";
import type { SaveStatusInput, SaveStatusLine } from "../../application/save/status.ts";
import type { LocalFileHandle } from "../../application/files/local-file-access.ts";

type MutableSaveStatusLine = { -readonly [K in keyof SaveStatusLine]: SaveStatusLine[K] };

let ports: SaveStatusPorts | null = null;

// why: these paint on every key, and a replaced text node makes the page's body:has() rules restyle the whole page
function setText(el: Element, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

function paintSaveButtons() {
  const view = saveButtonView({ busy: (ports as SaveStatusPorts).saves.busy(), dirty: (ports as SaveStatusPorts).saves.unsaved() });
  ["btn-save", "wr-save"].forEach(function (id) {
    const btn = document.getElementById(id);
    if (!btn) return;
    setText(btn, view.label);
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
        flowProblem = "";
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
      const name = (ports as SaveStatusPorts).preferences.nameOf(change.key);
      if (name === "clock" || (name === "autosave" && writerFlowEnabled(window))) updateSaveStatus();
    }
  };
}

function savedTitle(where: SaveStatusLine["where"]) {
  const when = savedWhenText(savedAt, Date.now(), (ports as SaveStatusPorts).preferences.clock());
  if (when) return "Last saved " + (where ? "to " + where + " " : "") + "at " + when + ".";
  return where ? "Up to date with " + where + "." : "Everything is saved.";
}

function saveStatusInput(): SaveStatusInput {
  const target = (ports as SaveStatusPorts).autoSave.target();
  const place = (ports as SaveStatusPorts).place;
  const where = place.home().kind === "file" ? ((place.home().handle && (place.home().handle as Pick<LocalFileHandle, "name">).name) as string | null | undefined) || ""
    : place.home().kind === "import" ? (place.home().name as string | null | undefined) || ""
    : "";

  const autosave = (ports as SaveStatusPorts).autoSave.policy();
  return {
    busy: (ports as SaveStatusPorts).saves.busy(),
    dirty: (ports as SaveStatusPorts).saves.unsaved(),
    halted: autosave.halted(),
    autoSaveOn: autosave.enabled(),
    target: target,
    where: where,
    homeKind: place.home().kind
  };
}

let savedAt = 0;
let lastViewText = "";
let flowProblem = "";
let justNowTimer: ReturnType<typeof setTimeout> | null = null;

function updateSaveStatus() {
  const input = saveStatusInput();
  const line = saveStatus(input).line;
  const view = line ? Object.assign({}, line) : null;
  const text = view ? view.text : "";
  if (text === "Saved" && lastViewText === "Saving…") savedAt = Date.now();
  else if (text !== "Saved") savedAt = 0;
  lastViewText = text;
  if (text === "Saved") (view as MutableSaveStatusLine).title = savedTitle((view as MutableSaveStatusLine).where);
  ["save-status", "wr-save-status"].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !view;
    if (!view) { setText(el, ""); el.removeAttribute("title"); return; }
    setText(el, view.text);
    el.title = view.title;
    el.className = "save-status is-" + view.cls;
  });
  const btn = document.getElementById("btn-save") as HTMLButtonElement | null;
  if (btn) {
    const shown = !view ? "Save" : text === "Saved" ? savedStatusText(savedAt, Date.now()) : view.text;
    btn.setAttribute("data-status", shown);
    btn.setAttribute("data-state", view ? view.cls : "none");
    btn.setAttribute("aria-label", view ? shown + ". Save now" : "Save");
    btn.title = view ? view.title + " Click to save now." : "Save this script";
    if (writerFlowEnabled(window)) {
      if (!input.busy && !input.dirty) flowProblem = "";
      if (input.halted) flowProblem = input.halted;
      const flow = flowSaveStatus({ ...input, halted: input.halted || flowProblem });
      const label = flow.text === "Saved" ? savedStatusText(savedAt, Date.now()) : flow.text;
      setText(btn, label);
      btn.setAttribute("data-status", label);
      btn.setAttribute("data-actionable", String(flow.actionable));
      btn.setAttribute("data-state", flow.problem ? "warn" : flow.actionable ? "pending" : input.busy ? "busy" : "ok");
      btn.disabled = !flow.actionable;
      btn.setAttribute("aria-label", label + (flow.actionable ? ". Save now" : ""));
      btn.title = (flow.problem ? flowProblem : view?.title || (input.target ? "Everything is saved." : "Save to choose where this script is kept."))
        + (flow.actionable ? " Click to save now." : "");
    }
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
      flowProblem = "";
      ports = null;
    }
  };
  activeMount = mounted;
  return mounted;
}
