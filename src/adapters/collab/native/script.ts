import type * as Y from "yjs";
import { NativeScriptReader } from "./reader.ts";
import { declareNativeRoots } from "./roots.ts";
import type { NativeRoots } from "./roots.ts";

export interface NativeScript {
  readonly doc: Y.Doc;
  readonly roots: NativeRoots;
  readonly reader: NativeScriptReader;
  readonly origin: object;
  readonly busy: () => boolean;
  readonly closed: () => boolean;
  readonly close: () => void;
}

export function openNativeScript(doc: Y.Doc): NativeScript {
  const roots = declareNativeRoots(doc), reader = new NativeScriptReader(roots);
  let open = false, closed = false;
  const begin = (): void => { open = true; }, end = (): void => { open = false; };
  doc.on("beforeAllTransactions", begin);
  doc.on("afterAllTransactions", end);
  const close = (): void => {
    if (closed) return;
    closed = true;
    doc.off("beforeAllTransactions", begin);
    doc.off("afterAllTransactions", end);
    reader.close();
  };
  return Object.freeze({ doc, roots, reader, origin: Object.freeze({ script: doc.guid }), busy: () => open, closed: () => closed, close });
}

export function closeNativeScript(script: NativeScript): void {
  script.close();
}
