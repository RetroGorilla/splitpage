import { createDocumentIdentityOwner } from "../../application/identity/document-identity.ts";
import type { DocumentIdentityOwner, DocumentIdentityPorts } from "../../application/identity/ports.ts";
import type { IdentityPort } from "../../application/transitions/ports.ts";
import { documentGuardOn, documentView, quietly } from "../../application/identity/document-guard.ts";
import { heldDocument } from "./session-owner.ts";
import { documentReader } from "./ports/document.ts";
import { startStandaloneHtml } from "../../adapters/page/standalone-html.ts";
import { migrateRows } from "../document-ports.ts";
import { documentIdentityPorts } from "./ports/document-identity.ts";
import { exposeTestHook } from "../../features/common/test-hooks.ts";

let started: DocumentIdentityOwner | null = null;
let stop: (() => void) | null = null;

export function documentIdentityOwner(): DocumentIdentityOwner {
  if (!started) throw new Error("The document identity is not started yet");
  return started;
}

export const documentIdentityPort: IdentityPort = Object.freeze({
  mint: () => documentIdentityOwner().documentIdentityPort.mint(),
  writtenOut: () => documentIdentityOwner().documentIdentityPort.writtenOut(),
  markWrittenOut: (value: boolean) => documentIdentityOwner().documentIdentityPort.markWrittenOut(value)
});

export function mountDocumentIdentityOwner(ports: DocumentIdentityPorts = documentIdentityPorts()): DocumentIdentityOwner {
  stopDocumentIdentityOwner();
  const mine: DocumentIdentityOwner = createDocumentIdentityOwner();
  const dispose = mine.startIdentity(ports);
  const stopHtml = startStandaloneHtml(migrateRows);
  let withdrawHook: (() => void) | null = null;
  exposeTestHook("__documentGuardTest", () => ({
    on: function () { return documentGuardOn(); },
    viewed: function () { const doc = heldDocument(); return doc !== null && documentView(doc) !== doc; },
    writes: function () {
      const view = documentReader.current();
      if (!view) throw new Error("There is no document to probe");
      return [
        function () { Reflect.set(view, "title", view.title); },
        function () { Reflect.set(view.rows, "length", view.rows.length); },
        function () { Reflect.deleteProperty(view, "documentGuardProbe"); },
        function () { Reflect.defineProperty(view, "title", { value: view.title }); }
      ].map(function (write) {
        try { quietly(write); return false; } catch (error) { return error instanceof TypeError; }
      });
    }
  }), (withdraw) => { withdrawHook = withdraw; });
  started = mine;
  stop = () => {
    started = null;
    dispose();
    stopHtml();
    withdrawHook?.();
  };
  return mine;
}

export function stopDocumentIdentityOwner(): void {
  const dispose = stop;
  stop = null;
  dispose?.();
}
