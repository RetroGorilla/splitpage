import { owned } from "../../features/routing/owned.ts";
import { startRowsRender } from "../../features/rows/render.ts";
import type { RowsRenderPorts } from "../../features/rows/render-ports.ts";
import { documentReader } from "./ports/document.ts";
import { edits, renderEditing, renderDraft, renderUndo } from "./ports/editing.ts";
import { text, video } from "./ports/text.ts";
import { notices } from "./ports/effects.ts";
import { pictures } from "./ports/pictures.ts";
import { renderPreferences, tagView } from "./ports/preferences.ts";
import { actions } from "./ports/actions.ts";
import { personColors } from "./ports/person-colors.ts";
import { renderDeletes, renderProduction, tagPanelState } from "./ports/production.ts";
import { ids } from "./ports/identity.ts";
import { shotHiding } from "./shot-hiding.ts";

const render = owned<ReturnType<typeof startRowsRender>>();

export function mountRowsRenderFeature() {
  return render.replace(() => {
    const ports: RowsRenderPorts = {
      document: documentReader, edits, text, video, editing: renderEditing, draft: renderDraft,
      undo: renderUndo, hiding: shotHiding, pictures, personColors,
      preferences: renderPreferences, view: tagView, notices, actions,
      deletes: renderDeletes, tagPanel: tagPanelState, ids, production: renderProduction
    };
    return startRowsRender(ports);
  });
}

export const stopRowsRenderFeature = render.stop;
export const currentRowsRender = render.owner;
