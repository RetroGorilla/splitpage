import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { Stage1ExecutorHarness } from "../../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { createBufferedField } from "../../../src/application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../../src/application/editing/painted-beats.ts";
import { mountSceneControls } from "../../../src/features/rows/scene-controls.ts";
import { createSceneView } from "../../../src/application/editing/scene-view.ts";
import { deriveDocumentNumbering } from "../../../src/core/document/numbering.ts";
import { sceneGroups } from "../../../src/core/document/scenes.ts";
import type { DocumentView } from "../../../src/application/session/document-session.ts";
import { fakeNotices, fakeWriterBufferEffects } from "../fakes.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { edgeInput } from "../edge-input.ts";

export type RenamePage = ReturnType<typeof sharedRename>;

function headerNode(name: string): HTMLElement {
  const header = document.createElement("div");
  header.className = "section-header"; header.setAttribute("data-section-id", "H1");
  const heading = header.appendChild(document.createElement("span")); heading.setAttribute("role", "heading");
  const button = heading.appendChild(document.createElement("button")); button.className = "section-name"; button.textContent = name;
  const rename = header.appendChild(document.createElement("button")); rename.setAttribute("data-section-action", "rename");
  return header;
}

export function sharedRename(name = "Scene", options: { readonly author?: (serial: number) => string } = {}) {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }, { id: "R2", text: "next" }], { sections: [{ id: "H1", name, firstSceneId: "R1" }] });
  const a = sharedHarness(adapterReplica(h.a)), { effects, reports, recovered } = fakeWriterBufferEffects();
  let serial = 0, depth = 0, repaints = 0;
  const shared = sharedBufferPorts(h.a, a.session, { ...effects, readers: bufferReaders, stamps: bufferStamps("Alice"),
    author: () => { const next = ++serial; return { id: options.author?.(next) ?? "native:" + next, by: "Alice" }; } });
  const listeners: (() => void)[] = [], checks: (() => void)[] = [], commands: string[] = [];
  const current = () => a.session.read(doc => doc) as DocumentView | null;
  const shownName = () => { const doc = current(); return doc ? sceneGroups(doc)[0]?.scene.name ?? "" : ""; };
  document.body.innerHTML = '<div id="rows"></div><button id="away">away</button>';
  const rows = document.getElementById("rows"); assert.ok(rows);
  rows.append(headerNode(shownName()));
  for (const id of ["R1", "R2"]) { const row = rows.appendChild(document.createElement("div")); row.className = "row"; row.setAttribute("data-id", id); }
  function paint(): void {
    for (const check of checks.slice()) check();
    const old = rows?.querySelector('.section-header[data-section-id="H1"]'), next = shownName();
    if (old && old.querySelector(".section-name")?.textContent !== next) old.replaceWith(headerNode(next));
    for (const listener of listeners.slice()) listener();
  }
  const watch = <T>(list: T[], item: T) => { list.push(item); return () => { const at = list.indexOf(item); if (at >= 0) list.splice(at, 1); }; };
  const controls = mountSceneControls(window, {
    document: { current, numbering: () => deriveDocumentNumbering(current() ?? { rows: [] }) },
    edits: { allowed: () => true, run: command => { commands.push(command.name); return { kind: "noop" }; } },
    scenes: createSceneView(), focus: { focusedRow: () => {} }, drag: { dragging: () => null, end: () => {} },
    ids: { id: () => "created" }, notices: fakeNotices().notices, scroll: () => {}, stopScroll: () => {},
    sharedNames: {
      field: surface => createBufferedField(shared.bufferedText, surface),
      painted: createPaintedBeats(shared.paintedText),
      report: shared.bufferedText.report,
      shown: edit => { depth++; try { return edit(); } finally { depth--; } },
      repaintRows: () => { repaints++; paint(); },
      onPainted: listener => watch(listeners, listener),
      beforePaint: check => watch(checks, check)
    }
  });
  const input = () => { const found = document.querySelector<HTMLInputElement>(".section-rename input"); assert.ok(found); return found; };
  function open(): HTMLInputElement {
    document.querySelector<HTMLElement>('.section-header [data-section-action="rename"]')?.click();
    return input();
  }
  const edge = edgeInput(input);
  const stored = () => readSharedPaintedText(h.a, sharedBufferedTarget(h.a, "heading:H1"))?.text;
  return { h, a, controls, reports, recovered, commands, open, input, edge, stored, paint, rows,
    repaints: () => repaints, shownDepth: () => depth,
    close: () => { controls.dispose(); a.session.dispose(); h.destroy(); document.body.innerHTML = ""; } };
}
