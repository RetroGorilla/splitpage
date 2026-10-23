import type { ActionDefinition } from "../../application/actions.ts";
import type { ScreenState } from "../../application/screen.ts";
import { EVERY_OVERLAY, OPENS_A_DIALOG, availableUnless, firstRefusal } from "../../application/screen.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import { openCommentComposer, openCommentsPanel, showTaggingHelp } from "./comments.js";

export function commentsPanelActions(screen: () => ScreenState, panels: Pick<SidePanels, "close">): ActionDefinition[] {
  return [{
    id: "panel-comments",
    label: "Comments panel",
    group: "View",
    icon: "i-panel",
    words: "comments notes review feedback show hide toggle",
    availability: () => {
      const button = document.getElementById("btn-comments");
      const availability = firstRefusal(availableUnless(["loading"], screen()), availableUnless(EVERY_OVERLAY, screen()));
      return button !== null && !button.hidden ? availability : { ...availability, visible: false };
    },
    run: () => {
      const panel = document.getElementById("comments-panel");
      if (panel !== null && !panel.hidden) panels.close("comments-panel");
      else openCommentsPanel();
    }
  }];
}

export function commentsHelpActions(screen: () => ScreenState): ActionDefinition[] {
  return [{
    id: "tagging-help",
    label: "Tagging reference",
    group: "Tags",
    icon: "i-tag",
    words: "tags tagging reference shortcuts brackets help",
    availability: () => availableUnless(OPENS_A_DIALOG, screen()),
    run: () => { showTaggingHelp(); }
  }];
}

export function commentsOpenActions(): ActionDefinition[] {
  return [{
    id: "comment-on-selection",
    label: "Comment on selection",
    group: "Open",
    availability: () => ({ enabled: true, visible: false }),
    run: (_source, input) => {
      if (typeof input !== "object" || input === null) throw new TypeError("comment-on-selection needs what to open");
      const fields = input as Readonly<Record<string, unknown>>;
      for (const key of ["id", "rowId", "field", "quotedText"]) {
        if (typeof fields[key] !== "string") throw new TypeError(`comment-on-selection needs ${key} as text`);
      }
      openCommentComposer(fields);
    }
  }];
}
