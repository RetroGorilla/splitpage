import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { createBufferedField } from "../../../src/application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../../src/application/editing/painted-beats.ts";
import { TITLE_FIELD_KEY } from "../../../src/application/editing/buffered-field-key.ts";
import { mountTitleRoutes } from "../../../src/features/title/routes.ts";
import type { DocumentView } from "../../../src/application/session/document-session.ts";
import { fakeWriterBufferEffects } from "../fakes.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { edgeInput } from "../edge-input.ts";

export type TitlePage = ReturnType<typeof sharedTitle>;

export function sharedTitle(title = "Draft", fields: Record<string, unknown> = { titleOrigin: "user" }) {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }], { ...fields, title });
  const a = sharedHarness(adapterReplica(h.a)), { effects, reports, recovered } = fakeWriterBufferEffects();
  let serial = 0, depth = 0, repaints = 0, pageTitles = 0;
  const shared = sharedBufferPorts(h.a, a.session, { ...effects, readers: bufferReaders, stamps: bufferStamps("Alice"),
    author: () => ({ id: "native:" + ++serial, by: "Alice" }) });
  const listeners: (() => void)[] = [], checks: (() => void)[] = [], commands: string[] = [];
  const current = () => { const doc = a.session.read(view => view) as DocumentView | null; return doc ? doc.title || "" : null; };
  document.body.innerHTML = '<input id="doc-title"><div id="writer"><input id="writer-title"></div><button id="away">away</button>';
  const byId = (id: string): HTMLInputElement => { const found = document.getElementById(id); assert.ok(found instanceof window.HTMLInputElement); return found; };
  const main = byId("doc-title"), writer = byId("writer-title");
  function paint(): void {
    for (const check of checks.slice()) check();
    if (document.activeElement !== main) main.value = current() ?? "";
    for (const listener of listeners.slice()) listener();
  }
  const watch = <T>(list: T[], item: T) => { list.push(item); return () => { const at = list.indexOf(item); if (at >= 0) list.splice(at, 1); }; };
  const routes = mountTitleRoutes({
    main, writer,
    ports: { run: command => { commands.push(command.name); return { kind: "noop" }; }, current, pageTitle: () => { pageTitles++; } },
    shared: {
      field: surface => createBufferedField(shared.bufferedText, surface),
      painted: createPaintedBeats(shared.paintedText),
      report: shared.bufferedText.report,
      shown: edit => { depth++; try { return edit(); } finally { depth--; } },
      repaint: () => { repaints++; paint(); },
      onPainted: listener => watch(listeners, listener),
      beforePaint: check => watch(checks, check)
    }
  });
  const stored = () => readSharedPaintedText(h.a, sharedBufferedTarget(h.a, TITLE_FIELD_KEY))?.text;
  return { h, a, main, writer, routes, reports, recovered, commands, stored, paint,
    edge: edgeInput(() => main), writerEdge: edgeInput(() => writer),
    target: () => sharedBufferedTarget(h.a, TITLE_FIELD_KEY),
    repaints: () => repaints, pageTitles: () => pageTitles, shownDepth: () => depth,
    close: () => { routes.dispose(); a.session.dispose(); h.destroy(); document.body.innerHTML = ""; } };
}
