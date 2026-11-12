import { mountImportDialog } from "../../features/imports/imports.ts";
import { importActions as definitions } from "../../features/imports/actions.ts";
import type { LegacyOpening } from "./transition-owners.ts";
import type { ImportDialogControls, ImportDialogPorts } from "../../features/imports/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { importDesktop } from "./ports/desktop.ts";
import { documentReader, legacyEdit } from "./ports/document.ts";
import { edits } from "./ports/editing.ts";
import { notices } from "./ports/effects.ts";
import { importFormats } from "./ports/imports.ts";
import { importMode } from "./ports/preferences.ts";
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
      desktop: importDesktop,
      noteEdit: legacyEdit.noteEdit,
      stampRow: deferred.stampRow,
      mode: importMode
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
