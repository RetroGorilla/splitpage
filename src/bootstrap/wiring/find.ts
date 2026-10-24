import type { ActionDefinition } from "../../application/actions.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { edits as portEdits, undoControl as portUndo } from "./ports/editing.ts";
import { text as portText } from "./ports/text.ts";
import { review as portReview } from "./ports/location.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { flags as portFlags } from "./ports/preferences.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { findActions as definitions } from "../../features/find/actions.ts";
import { __init, mountFindEvents } from "../../features/find/find.js";
import type { FindControls, FindPorts } from "../../features/find/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { shotHiding } from "../../legacy/shot-hiding-bridge.ts";

const find = owned<FindControls>();
const events = owned<ReturnType<typeof mountFindEvents>>();

export function mountFindFeature(): FindControls {
  return find.replace(() => {
    const ports: FindPorts = {
      document: portDocument,
      edits: portEdits,
      text: portText,
      shotHiding,
      review: portReview,
      undo: portUndo,
      notices: portNotices,
      flags: portFlags
    };
    const mounted: FindControls = __init(ports);
    let disposed = false;
    return {
      ...mounted,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        events.stop();
        mounted.dispose();
      }
    };
  });
}

export const stopFindFeature = find.stop;

export function mountFindEventsFeature(): ReturnType<typeof mountFindEvents> {
  return events.replace(mountFindEvents);
}

export const stopFindEventsFeature = events.stop;

export function findActions(): ActionDefinition[] {
  return definitions(find.owner, { screen: portScreen, flags: portFlags });
}
