import type { ActionDefinition } from "../../application/actions.ts";
import { findActions as definitions } from "../../features/find/actions.ts";
import { __init, mountFindEvents } from "../../features/find/find.js";
import type { FindControls, FindPorts } from "../../features/find/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { shotHiding } from "../../legacy/shot-hiding-bridge.ts";
import { sharedPorts } from "./shared-ports.ts";

const find = owned<FindControls>();
const events = owned<ReturnType<typeof mountFindEvents>>();

export function mountFindFeature(): FindControls {
  return find.replace(() => {
    const shared = sharedPorts();
    const ports: FindPorts = {
      document: shared.document,
      edits: shared.edits,
      text: shared.text,
      shotHiding,
      review: shared.review,
      undo: shared.undo,
      notices: shared.notices,
      flags: shared.flags
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
  const shared = sharedPorts();
  return definitions(find.owner, { screen: shared.screen, flags: shared.flags });
}
