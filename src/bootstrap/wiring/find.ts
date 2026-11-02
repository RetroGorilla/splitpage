import type { ActionDefinition } from "../../application/actions.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { edits as portEdits, undoControl as portUndo } from "./ports/editing.ts";
import { text as portText } from "./ports/text.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { findOptions, flags as portFlags } from "./ports/preferences.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { findActions as definitions } from "../../features/find/actions.ts";
import { startFind, mountFindEvents } from "../../features/find/find.ts";
import type { FindControls, FindPorts } from "../../features/find/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { shotHiding } from "./ports/shot-hiding.ts";
import { bulkTagRows } from "./production-index.ts";
import { prompterControls } from "./prompter.ts";
import { prompterState } from "./ports/preferences.ts";

const find = owned<FindControls>();
const events = owned<ReturnType<typeof mountFindEvents>>();

export function mountFindFeature(): FindControls {
  return find.replace(() => {
    const ports: FindPorts = {
      document: portDocument,
      edits: portEdits,
      text: portText,
      shotHiding: () => shotHiding,
      undo: portUndo,
      notices: portNotices,
      flags: portFlags,
      options: findOptions,
      bulkTag: bulkTagRows,
      present: {
        isOpen: prompterState.isOpen,
        setSearching: (value) => prompterControls()?.setSearching(value),
        jump: (range) => prompterControls()?.jumpToFind(range),
        onViewChange: (listener) => prompterControls()?.onViewChange(listener) ?? (() => {})
      }
    };
    const mounted: FindControls = startFind(ports);
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
  return events.replace(() => mountFindEvents(findOptions));
}

export const stopFindEventsFeature = events.stop;

export function findActions(): ActionDefinition[] {
  return definitions(find.owner, { screen: portScreen, flags: portFlags });
}
