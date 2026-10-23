import { createOperations } from "../application/session/operation.ts";
import type { OperationContext, Operations } from "../application/session/operation.ts";
import { createDocumentSources } from "../application/transitions/sources.ts";
import type { DocumentSource, DocumentSources } from "../application/transitions/sources.ts";
import { createTransitions } from "../application/transitions/transitions.ts";
import type { Transitions } from "../application/transitions/transitions.ts";
import type { DestinationPort, DocumentDestination, HistoryPort, IdentityPort, LiveDocumentPort } from "../application/transitions/ports.ts";
import type { ValidatedDocument } from "../core/document/validated.ts";
import { migrateRows } from "../js/02-state.js";
import { currentConn, currentHome, documentLocation } from "./location-bridge.ts";
import { confirmedGeneration } from "./save-bridge.ts";
import { liveSession } from "./session-bridge.ts";

export interface LegacyTransitionPorts {
  readonly live: LiveDocumentPort;
  readonly destination: DestinationPort<DocumentDestination>;
  readonly identity: IdentityPort;
  readonly history: HistoryPort;
}

export interface LegacyOpening {
  readonly kind: string;
  readonly [field: string]: unknown;
}

export type LegacyDocumentSource = DocumentSource<LegacyOpening>;
export type LegacyDocumentSources = DocumentSources<LegacyOpening>;

interface Started {
  readonly transitions: Transitions<DocumentDestination>;
  readonly operations: Operations;
  readonly sources: LegacyDocumentSources;
  readonly history: HistoryPort;
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
  const transitions = createTransitions<DocumentDestination>({
    entry: migrateRows,
    live: ports.live,
    destination: ports.destination,
    identity: ports.identity,
    history: ports.history,
    ownership: operations
  });
  const mine: Started = Object.freeze({
    transitions: transitions,
    operations: operations,
    sources: createDocumentSources<LegacyOpening>(),
    history: ports.history
  });
  started = mine;
  return function () {
    if (started === mine) started = null;
  };
}

export function documentTransitions(): Transitions<DocumentDestination> {
  return running().transitions;
}

export function captureOperation(): OperationContext {
  return running().operations.capture();
}

export function stillOwns(ctx: OperationContext): boolean {
  return running().operations.stillOwns(ctx);
}

export function documentSources(): LegacyDocumentSources {
  return running().sources;
}

export function openDocument(opening: LegacyOpening): Promise<unknown> {
  const source = running().sources.taking(opening);
  if (!source) return Promise.resolve(false);
  return Promise.resolve(source.open(opening));
}

export function keepSnapshot(label: string, doc?: ValidatedDocument | null): unknown {
  return running().history.keep(label, doc);
}
