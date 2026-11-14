import type { DocumentView } from "../../application/session/document-session.ts";
import type { LocalFileOpening } from "../../application/transitions/local-files-ports.ts";
import { createOperations } from "../../application/session/operation.ts";
import type { OperationContext, Operations } from "../../application/session/operation.ts";
import { createDocumentSources } from "../../application/transitions/sources.ts";
import type { DocumentSource, DocumentSources } from "../../application/transitions/sources.ts";
import { createTransitions } from "../../application/transitions/transitions.ts";
import type { Transitions } from "../../application/transitions/transitions.ts";
import type { DestinationPort, DocumentDestination, DocumentOpeningActivity, HistoryPort, IdentityPort, LiveDocumentPort } from "../../application/transitions/ports.ts";
import { migrateRows } from "../document-ports.ts";
import { currentHome } from "./location-owner.ts";
import { confirmedGeneration } from "./save-owners.ts";
import { holdSessionCommands, liveSession, onDocumentReplaced, sharedSession } from "./session-owner.ts";
import { documentEntry } from "./ports/document-entry.ts";
import { entryCapabilities } from "./ports/capabilities.ts";

export interface LegacyTransitionPorts {
  readonly live: LiveDocumentPort;
  readonly destination: DestinationPort<DocumentDestination>;
  readonly identity: IdentityPort;
  readonly history: HistoryPort;
}

export interface LegacyOpening {
  readonly file?: LocalFileOpening["file"];
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
  readonly openings: Set<{ readonly epoch: number }>;
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
      generation: confirmedGeneration
    }
  });
  const original = createTransitions<DocumentDestination>({
    entry: migrateRows,
    live: ports.live,
    destination: ports.destination,
    identity: ports.identity,
    history: ports.history
  });
  function entered<T>(run: () => T, leaveFirst: boolean): T {
    const shared = leaveFirst && sharedSession();
    const permission = leaveFirst ? null : entryCapabilities.documentEntry();
    const refusal = leaveFirst ? documentEntry.before() : permission && !permission.allowed ? { refused: permission.reason } : null;
    if (refusal) throw new Error(refusal.refused);
    if (!shared) return run();
    const release = holdSessionCommands("document-entry");
    try { return run(); } finally { release(); }
  }
  const transitions: Transitions<DocumentDestination> = {
    open: arrival => entered(() => original.open(arrival), true),
    startNew: arrival => entered(() => original.startNew(arrival), true),
    recover: recovery => entered(() => original.recover(recovery), false),
    restore: restoration => entered(() => original.restore(restoration), false),
    copyId: original.copyId
  };
  const mine: Started = Object.freeze({
    transitions: transitions,
    operations: operations,
    sources: createDocumentSources<LegacyOpening>(),
    history: ports.history,
    openings: new Set<{ readonly epoch: number }>()
  });
  started = mine;
  const releaseEpoch = onDocumentReplaced(() => {
    const epoch = liveSession().epoch();
    for (const context of mine.openings) if (context.epoch !== epoch) mine.openings.delete(context);
  });
  return function () {
    releaseEpoch();
    mine.openings.clear();
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
  if (documentEntry.before()) return Promise.resolve(false);
  return documentOpenings.track(() => Promise.resolve(source.open(opening)));
}

export const documentOpenings: DocumentOpeningActivity = {
  openingPending: () => started !== null && started.openings.size > 0,
  track: work => {
    const mine = running(), context = { epoch: liveSession().epoch() };
    mine.openings.add(context);
    const close = () => { mine.openings.delete(context); };
    try {
      const result = work();
      const pending = result !== null && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function";
      if (pending) void Promise.resolve(result).then(close, close);
      else close();
      return result;
    } catch (error) { close(); throw error; }
  }
};

export function keepSnapshot(label: string, doc?: DocumentView | null): unknown {
  return running().history.keep(label, doc);
}
