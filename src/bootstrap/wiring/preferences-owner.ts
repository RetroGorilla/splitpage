import { createBrollAnchoring } from "../../application/broll-anchoring.ts";
import type { BrollAnchorDeclines } from "../../application/broll-anchoring.ts";
import { getSavedAuthorName } from "../../application/comment-author.ts";
import { createCommentSorting } from "../../application/comment-sort.ts";
import type { CommentSorting } from "../../application/comment-sort.ts";
import { createFindOptions } from "../../application/find-options.ts";
import type { FindOptions } from "../../application/find-options.ts";
import { createImportMode } from "../../application/import-mode.ts";
import type { ImportMode } from "../../application/import-mode.ts";
import { createBrollView } from "../../application/preferences/broll-view.ts";
import type { BrollView } from "../../application/preferences/broll-view.ts";
import { createPanelWidths } from "../../application/preferences/panel-widths.ts";
import type { PanelWidths } from "../../application/preferences/panel-widths.ts";
import { createPreferences } from "../../application/preferences/preferences.ts";
import type { PreferenceChange, PreferencePorts, Preferences } from "../../application/preferences/preferences.ts";
import { createViewFlags } from "../../application/preferences/view-flags.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import { createPrompterState } from "../../application/prompter-state.ts";
import type { PrompterState } from "../../application/prompter-state.ts";

export const PREF_EVENT = "splitpage:pref";

interface Started {
  readonly preferences: Preferences;
  readonly flags: ViewFlags;
  readonly panels: PanelWidths;
  readonly brollView: BrollView;
  readonly prompter: PrompterState;
  readonly find: FindOptions;
  readonly commentSort: CommentSorting;
  readonly importMode: ImportMode;
  readonly brollAnchoring: BrollAnchorDeclines;
}

const BROLL_VIEW_KEY = "splitpage-broll-view";

let started: Started | null = null;

const changeListeners: ((change: PreferenceChange) => void)[] = [];

export function onPreferenceChange(listener: (change: PreferenceChange) => void): () => void {
  changeListeners.push(listener);
  return function () {
    const at = changeListeners.indexOf(listener);
    if (at !== -1) changeListeners.splice(at, 1);
  };
}

let announcing = false;

function tellListeners(change: PreferenceChange): void {
  changeListeners.slice().forEach(function (listener) { listener(change); });
}

export function notePreferenceChange(change: PreferenceChange): void {
  if (started && !announcing) tellListeners(change);
}

function running(): Started {
  if (!started) throw new Error("The preferences are not started yet");
  return started;
}

export function browserPreferencePorts(): PreferencePorts {
  return {
    storage: function () {
      try { return window.localStorage; } catch (e) { return null; }
    },
    announce: function (change) {
      document.dispatchEvent(new CustomEvent(PREF_EVENT, { detail: { key: change.key, value: change.value } }));
    }
  };
}

export function startPreferences(ports: PreferencePorts = browserPreferencePorts()): () => void {
  if (started) throw new Error("The preferences are already started; stop them first");
  const preferences = createPreferences({
    storage: ports.storage,
    announce: function (change) {
      announcing = true;
      try {
        ports.announce(change);
      } finally {
        announcing = false;
        tellListeners(change);
      }
    }
  });
  const mine: Started = {
    preferences: preferences,
    flags: createViewFlags({ hideShot: preferences.hideShot }),
    panels: createPanelWidths({ storage: ports.storage }),
    brollView: createBrollView({
      read: () => localStorage.getItem(BROLL_VIEW_KEY),
      write: (value) => { localStorage.setItem(BROLL_VIEW_KEY, value); }
    }),
    prompter: createPrompterState(),
    find: createFindOptions(),
    commentSort: createCommentSorting(),
    importMode: createImportMode(),
    brollAnchoring: createBrollAnchoring()
  };
  started = mine;
  return function () {
    if (started === mine) started = null;
  };
}

export function preferencesStarted(): boolean {
  return started !== null;
}

export function preferences(): Preferences {
  return running().preferences;
}

export function getEditorName(): string {
  return getSavedAuthorName(preferences()) || "Anonymous";
}

export function viewFlags(): ViewFlags {
  return running().flags;
}

export function panelWidths(): PanelWidths {
  return running().panels;
}

export function brollView(): BrollView {
  return running().brollView;
}

export function prompterState(): PrompterState {
  return running().prompter;
}

export function findOptions(): FindOptions {
  return running().find;
}

export function commentSorting(): CommentSorting {
  return running().commentSort;
}

export function importMode(): ImportMode {
  return running().importMode;
}

export function brollAnchoring(): BrollAnchorDeclines {
  return running().brollAnchoring;
}
