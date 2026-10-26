import { mountImportDialog } from "../../features/imports/imports.js";
import { importActions as definitions } from "../../features/imports/actions.ts";
import type { LegacyOpening } from "../../legacy/transition-bridge.ts";
import type { ImportDialogControls, ImportDialogPorts } from "../../features/imports/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { REVIEW_ONLY, noteSessionEdit } from "../../legacy/session-bridge.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { documentReader } from "./ports/document.ts";
import { edits } from "./ports/editing.ts";
import { notices } from "./ports/effects.ts";
import { importFormats } from "./ports/imports.ts";
import { ownership } from "./ports/saving.ts";
import { history } from "./ports/transitions.ts";
import { text } from "./ports/text.ts";
import { screen } from "./ports/screen.ts";

const imports = owned<ImportDialogControls>();

export function mountImportDialogFeature(deferred: Pick<ImportDialogPorts, "stampRow">): ImportDialogControls {
  return imports.replace(() => {
    const ports: ImportDialogPorts = {
      document: documentReader,
      edits,
      ownership,
      history,
      text,
      notices,
      formats: importFormats,
      desktop: { running: runningOnDesktop, openExternal: (url) => { const desktop = desktopPort(); if (desktop) return desktop.openExternal(url); } },
      reviewOnly: REVIEW_ONLY,
      noteEdit: noteSessionEdit,
      stampRow: deferred.stampRow
    };
    return mountImportDialog(ports);
  });
}

export function importControls(): ImportDialogControls | null { return imports.owner(); }

export function importDocumentSource() {
  return {
    id: "import",
    takes: (opening: { kind: string }) => opening.kind === "import",
    open: (opening: LegacyOpening) => imports.owner()?.importDocumentSource().open(opening)
  };
}

export function importActions() { return definitions(imports.owner, screen); }
