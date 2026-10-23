import type { ActionDefinition, ActionRegistry } from "../../application/actions.ts";
import { registerAll } from "../../application/actions.ts";
import { EVERY_OVERLAY, OPENS_A_DIALOG, availableUnless, firstRefusal } from "../../application/screen.ts";
import type { ScreenState } from "../../application/screen.ts";

export type CommentActionSlot = "panel" | "tagging-help" | "selection";

export interface CommentActionPorts {
  readonly screen: () => ScreenState;
  readonly openPanel: () => void;
  readonly closePanel: () => void;
  readonly showTaggingHelp: () => void;
  readonly openComposer: (context: Readonly<Record<string, unknown>>) => void;
}

export function registerCommentAction(registry: ActionRegistry, slot: CommentActionSlot, ports: CommentActionPorts): () => void {
  let definition: ActionDefinition;
  if (slot === "panel") {
    definition = {
      id: "panel-comments",
      label: "Comments panel",
      group: "View",
      icon: "i-panel",
      words: "comments notes review feedback show hide toggle",
      availability: () => {
        const button = document.getElementById("btn-comments");
        const state = firstRefusal(availableUnless(["loading"], ports.screen()), availableUnless(EVERY_OVERLAY, ports.screen()));
        return button !== null && !button.hidden ? state : { ...state, visible: false };
      },
      run: () => {
        const panel = document.getElementById("comments-panel");
        if (panel !== null && !panel.hidden) ports.closePanel();
        else ports.openPanel();
      }
    };
  } else if (slot === "tagging-help") {
    definition = {
      id: "tagging-help",
      label: "Tagging reference",
      group: "Tags",
      icon: "i-tag",
      words: "tags tagging reference shortcuts brackets help",
      availability: () => availableUnless(OPENS_A_DIALOG, ports.screen()),
      run: () => { ports.showTaggingHelp(); }
    };
  } else {
    definition = {
      id: "comment-on-selection",
      label: "Comment on selection",
      group: "Open",
      availability: () => ({ enabled: true, visible: false }),
      run: (_source, input) => {
        if (typeof input !== "object" || input === null) throw new TypeError("comment-on-selection needs what to open");
        const record = input as Readonly<Record<string, unknown>>;
        for (const key of ["id", "rowId", "field", "quotedText"]) {
          if (typeof record[key] !== "string") throw new TypeError("comment-on-selection needs " + key + " as text");
        }
        ports.openComposer(record);
      }
    };
  }
  return registerAll(registry, [definition]);
}
