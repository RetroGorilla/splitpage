import { createOperations } from "../application/session/operation.ts";
import type { OperationContext, Operations } from "../application/session/operation.ts";
import { createTransitions } from "../application/transitions/transitions.ts";
import type { Transitions } from "../application/transitions/transitions.ts";
import type { DestinationPort, IdentityPort, LiveDocumentPort } from "../application/transitions/ports.ts";
import { migrateRows } from "../js/02-state.js";
import { currentConn, currentHome, documentLocation } from "./location-bridge.ts";
import { confirmedGeneration } from "./save-bridge.ts";
import { liveSession } from "./session-bridge.ts";

export interface LegacyDestination {
  readonly kind: string;
  readonly fields?: Readonly<Record<string, unknown>> | undefined;
}

export interface LegacyTransitionPorts {
  readonly live: LiveDocumentPort;
  readonly destination: DestinationPort<LegacyDestination>;
  readonly identity: IdentityPort;
}

export const NO_DESTINATION: LegacyDestination = Object.freeze({ kind: "none" });

interface Started {
  readonly transitions: Transitions<LegacyDestination>;
  readonly operations: Operations;
}

let started: Started | null = null;

function running(): Started {
  if (!started) throw new Error("The document transitions are not started yet");
  return started;
}

export function startTransitions(ports: LegacyTransitionPorts): () => void {
  if (started) throw new Error("The document transitions are already started; stop them first");
  const operations = createOperations({
    session: {
      epoch: function () { return liveSession().epoch(); },
      generation: function () { return liveSession().generation(); }
    },
    document: {
      id: function () {
        const doc = ports.live.current();
        return doc ? doc.docId : null;
      }
    },
    destination: {
      identity: function (): unknown { return currentHome(); },
      generation: confirmedGeneration,
      revision: function () {
        const rev: unknown = documentLocation().serverHomeRev();
        return typeof rev === "number" ? rev : null;
      }
    },
    connection: {
      current: function (): unknown {
        const instance: unknown = currentConn();
        return instance;
      }
    }
  });
  const transitions = createTransitions<LegacyDestination>({
    entry: migrateRows,
    live: ports.live,
    destination: ports.destination,
    identity: ports.identity,
    ownership: operations
  });
  const mine: Started = Object.freeze({ transitions: transitions, operations: operations });
  started = mine;
  return function () {
    if (started === mine) started = null;
  };
}

export function documentTransitions(): Transitions<LegacyDestination> {
  return running().transitions;
}

export function captureOperation(): OperationContext {
  return running().operations.capture();
}

export function stillOwns(ctx: OperationContext): boolean {
  return running().operations.stillOwns(ctx);
}
