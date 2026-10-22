import type { ValidatedDocument } from "../../core/document/validated.ts";
import { documentIdStamp } from "../commands/save-stamps.ts";
import type { OperationContext } from "../session/operation.ts";
import type { TransitionPorts } from "./ports.ts";

export type Incoming =
  | { readonly document: ValidatedDocument }
  | { readonly raw: unknown };

export interface Arrival<D> {
  readonly from: Incoming;
  readonly reason: string;
  readonly destination?: D | undefined;
}

export interface Opening<D> extends Arrival<D> {
  readonly writtenOut?: boolean | undefined;
}

export interface Restoration {
  readonly from: Incoming;
}

export interface Recovery<D> extends Arrival<D> {
  readonly detached: boolean;
  readonly baseline: ValidatedDocument | null;
  readonly writtenOut?: boolean | undefined;
}

export interface Publication<D> {
  readonly destination: D;
  readonly docId: string;
  readonly baseline: ValidatedDocument;
  readonly reason: string;
}

export interface Arrived {
  readonly document: ValidatedDocument;
  readonly forkedFrom: string | null;
}

export type Published =
  | { readonly kind: "published"; readonly forkedFrom: string | null }
  | { readonly kind: "obsolete" };

export interface Transitions<D> {
  readonly open: (opening: Opening<D>) => Arrived;
  readonly startNew: (arrival: Arrival<D>) => Arrived;
  readonly restore: (restoration: Restoration) => Arrived;
  readonly recover: (recovery: Recovery<D>) => Arrived;
  readonly publish: (ctx: OperationContext, publication: Publication<D>) => Published;
  readonly copyId: () => string;
}

export function createTransitions<D>(ports: TransitionPorts<D>): Transitions<D> {
  function enter(from: Incoming): ValidatedDocument {
    return "document" in from ? from.document : ports.entry(from.raw);
  }

  function arrive(doc: ValidatedDocument, forkedFrom: string | null): Arrived {
    ports.live.assign(doc);
    return Object.freeze({ document: doc, forkedFrom: forkedFrom });
  }

  function settle<T>(arrival: Arrival<D>, baseline: ValidatedDocument | null, writtenOut: boolean | undefined, arrived: T): T {
    if (arrival.destination !== undefined) ports.destination.set(arrival.destination);
    ports.destination.confirm(baseline, arrival.reason);
    if (writtenOut !== undefined) ports.identity.markWrittenOut(writtenOut);
    return arrived;
  }

  function open(opening: Opening<D>): Arrived {
    const doc = enter(opening.from);
    return settle(opening, doc, opening.writtenOut, arrive(doc, null));
  }

  function startNew(arrival: Arrival<D>): Arrived {
    const doc = enter(arrival.from);
    return settle(arrival, doc, false, arrive(doc, null));
  }

  function restore(restoration: Restoration): Arrived {
    const doc = enter(restoration.from);
    const live = ports.live.current();
    if (live) doc.docId = live.docId;
    return arrive(doc, null);
  }

  function recover(recovery: Recovery<D>): Arrived {
    const doc = enter(recovery.from);
    const forkedFrom = recovery.detached ? doc.docId : null;
    if (recovery.detached) doc.docId = ports.identity.mint();
    const writtenOut = recovery.detached ? false : recovery.writtenOut;
    return settle(recovery, recovery.baseline, writtenOut, arrive(doc, forkedFrom));
  }

  function publish(ctx: OperationContext, publication: Publication<D>): Published {
    const live = ports.live.current();
    if (!live || !ports.ownership.stillOwns(ctx)) return Object.freeze({ kind: "obsolete" });
    const was = live.docId;
    ports.destination.set(publication.destination);
    ports.destination.confirm(publication.baseline, publication.reason);
    ports.live.stamp(documentIdStamp(was, publication.docId));
    ports.identity.markWrittenOut(true);
    return Object.freeze({ kind: "published", forkedFrom: was === publication.docId ? null : was });
  }

  function copyId(): string {
    const live = ports.live.current();
    if (!live || ports.identity.writtenOut()) return ports.identity.mint();
    return live.docId;
  }

  return Object.freeze({
    open: open,
    startNew: startNew,
    restore: restore,
    recover: recover,
    publish: publish,
    copyId: copyId
  });
}
