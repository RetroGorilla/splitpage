import type { DocumentLocation } from "../location/document-location.ts";
import type { Preferences } from "../preferences/preferences.ts";
import type { DraftsMount } from "../recovery/drafts-ports.ts";
import { changeSet } from "../session/change-set.ts";
import type { SessionChange } from "../session/change-set.ts";
import type { DocumentView, Plan } from "../session/document-session.ts";
import type { Capability, CapabilityPort } from "../session/ports.ts";
import { colorsWithMine } from "../../core/document/person-colors.ts";
import { cleanAuthorName } from "../../core/document/people.ts";
import type { SaveState } from "./save-state.ts";

export interface SessionEffects {
  readonly dirty: (change: SessionChange) => void;
  readonly draft: (change: SessionChange) => void;
  readonly save: (change: SessionChange) => void;
  readonly edit: () => Capability;
  readonly attribute: (doc: DocumentView) => Plan | null;
}

export interface SaveChangeNotes {
  readonly noteChange: () => void;
  readonly scheduleAutoSave: () => void;
}

export interface SessionEffectPorts {
  readonly capability: Pick<CapabilityPort, "saveDestinations" | "autosave">;
  readonly saves: Pick<SaveState, "dueNow">;
  readonly changes: SaveChangeNotes;
  readonly drafts: Pick<DraftsMount, "noteChange">;
  readonly location: Pick<DocumentLocation, "home" | "amendHome">;
  readonly preferences: Pick<Preferences, "commentAuthor" | "myColor">;
}

const EDIT_ALLOWED: Capability = Object.freeze({ allowed: true });

export function createSessionEffects(ports: SessionEffectPorts): SessionEffects {
  const myColor = changeSet({ docFields: ["personColors"] });

  function myColorPlan(doc: DocumentView): Plan | null {
    if (!doc) return null;
    const next = colorsWithMine(doc.personColors, cleanAuthorName(ports.preferences.commentAuthor()).trim(), ports.preferences.myColor());
    if (!next) return null;
    return { changes: myColor, apply: function (live) { live.personColors = next; } };
  }

  return {
    dirty: function () {
      ports.changes.noteChange();
    },
    attribute: myColorPlan,
    draft: function () {
      ports.drafts.noteChange();
    },
    save: function (change) {
      if (!ports.capability.saveDestinations().allowed || !ports.capability.autosave().allowed) return;
      if (change.kind !== "recovery") ports.changes.scheduleAutoSave();
      if (ports.location.home().kind === "import") ports.location.amendHome(ports.location.home(), { dirty: true });
      if (change.changes.saveNow) ports.saves.dueNow();
    },
    edit: function () {
      return EDIT_ALLOWED;
    }
  };
}
