import type * as Y from "yjs";
import { NativeScriptReader } from "./reader.ts";
import { declareNativeRoots } from "./roots.ts";
import type { NativeRoots } from "./roots.ts";

export interface NativeScript {
  readonly doc: Y.Doc;
  readonly roots: NativeRoots;
  readonly reader: NativeScriptReader;
  readonly origin: object;
}

export function openNativeScript(doc: Y.Doc): NativeScript {
  const roots = declareNativeRoots(doc);
  return Object.freeze({ doc, roots, reader: new NativeScriptReader(roots), origin: Object.freeze({ script: doc.guid }) });
}

export function closeNativeScript(script: NativeScript): void {
  script.reader.close();
}
