import "../../../src/test/_dom.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Stage1ExecutorHarness } from "../../adapters/collab/stage1-executor-support.ts";
import { adapterReplica, sharedHarness } from "../../application/session/shared-session-support.ts";
import { sharedBufferPorts } from "../../../src/bootstrap/wiring/ports/shared-buffer.ts";
import { sharedSceneCreation } from "../../../src/bootstrap/wiring/ports/shared-scenes.ts";
import { createBufferedField } from "../../../src/application/editing/buffered-field.ts";
import { createPaintedBeats } from "../../../src/application/editing/painted-beats.ts";
import { mountSceneControls } from "../../../src/features/rows/scene-controls.ts";
import { createSceneView } from "../../../src/application/editing/scene-view.ts";
import { deriveDocumentNumbering } from "../../../src/core/document/numbering.ts";
import { sceneGroups } from "../../../src/core/document/scenes.ts";
import { registerSharedHeadingHandlers } from "../../../src/adapters/collab/heading-executor.ts";
import { registerSharedRemovalHandlers } from "../../../src/adapters/collab/removal-executor.ts";
import { fakeNotices, fakeWriterBufferEffects } from "../fakes.ts";
import { bufferReaders, bufferStamps } from "../../collab/buffer-readers.ts";
import { edgeInput } from "../edge-input.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import type { DeliveryOrder } from "../../collab/delivery.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  readonly JSDOM: new (html: string, options: { readonly url: string }) => { readonly window: Window };
};

export function sceneCreationPages() {
  const h = new Stage1ExecutorHarness([{ id: "R1", text: "ab" }, { id: "R2", text: "next" }]);
  for (const handle of [h.a, h.b]) { registerSharedHeadingHandlers(handle); registerSharedRemovalHandlers(handle); }
  function page(handle: SharedDocumentHandle, by: string) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://splitpage.test/" });
    const win = dom.window;
    const doc = win.document;
    doc.body.innerHTML = '<div id="rows"></div><button id="away">away</button>';
    const rows = doc.getElementById("rows"); assert.ok(rows);
    const a = sharedHarness(adapterReplica(handle)), { effects, reports, recovered, missing } = fakeWriterBufferEffects();
    const standalone: string[] = [];
    let serial = 0;
    const author = () => ({ id: ++serial === 1 ? "head" : "native_" + serial, by });
    const shared = sharedBufferPorts(handle, a.session, { ...effects, author, readers: bufferReaders, stamps: bufferStamps(by) });
    const listeners: (() => void)[] = [], checks: (() => void)[] = [];
    const watch = (list: (() => void)[], fn: () => void) => { list.push(fn); return () => { list.splice(list.indexOf(fn), 1); }; };
    const current = () => a.session.read(doc => doc);
    function paint(): void {
      for (const check of checks.slice()) check();
      const state = current(); assert.ok(state);
      rows?.replaceChildren();
      const groups = sceneGroups(state);
      for (const row of state.rows) {
        const scene = groups.find(group => group.scene.firstSceneId === row.id)?.scene;
        if (scene || state.rows[0]?.id === row.id) {
          const header = doc.createElement("div"); header.className = "section-header"; header.setAttribute("data-section-id", scene?.id ?? "");
          const title = header.appendChild(doc.createElement("span")); title.setAttribute("role", "heading");
          const name = title.appendChild(doc.createElement("button")); name.className = "section-name"; name.textContent = scene?.name ?? "Scene A";
          const button = header.appendChild(doc.createElement("button")); button.setAttribute("data-section-action", scene ? "rename" : "name-automatic");
          rows?.append(header);
        }
        const beat = doc.createElement("div"); beat.className = "row"; beat.setAttribute("data-id", row.id);
        beat.appendChild(doc.createElement("button")).className = "row-more";
        const add = beat.appendChild(doc.createElement("button")); add.setAttribute("data-action", "add-section"); add.setAttribute("data-id", row.id);
        rows?.append(beat);
      }
      for (const listener of listeners.slice()) listener();
    }
    paint();
    const controls = mountSceneControls(win, {
      document: { current, numbering: () => deriveDocumentNumbering(current() ?? { rows: [] }) },
      edits: { allowed: () => true, run: command => { standalone.push(command.name); return { kind: "noop" }; } },
      scenes: createSceneView(), focus: { focusedRow: () => {} }, drag: { dragging: () => null, end: () => {} },
      ids: { id: () => { standalone.push("id"); return "created"; } }, notices: fakeNotices().notices, scroll: () => {}, stopScroll: () => {},
      sharedScenes: sharedSceneCreation(handle, a.session, author),
      sharedNames: {
        field: surface => createBufferedField(shared.bufferedText, surface), painted: createPaintedBeats(shared.paintedText), report: effects.report,
        shown: edit => edit(), repaint: paint, onPainted: fn => watch(listeners, fn), beforePaint: fn => watch(checks, fn)
      }
    });
    const input = () => { const el = doc.querySelector<HTMLInputElement>(".section-rename input"); assert.ok(el); return el; };
    const edge = edgeInput(input);
    const open = (kind: "automatic" | "add", beat = "R1") => {
      doc.querySelector<HTMLElement>(kind === "automatic" ? '[data-section-action="name-automatic"]' : '[data-action="add-section"][data-id="' + beat + '"]')?.click();
      return input();
    };
    return { a, doc, input, edge, open, paint, reports, recovered, missing, controls, standalone,
      close: () => { controls.dispose(); a.session.dispose(); dom.window.close(); } };
  }
  const a = page(h.a, "Alice"), b = page(h.b, "Bob");
  return { h, a, b,
    copies: (order: DeliveryOrder, expected: unknown) => {
      h.queue.flush(order); h.join();
      for (const handle of [h.a, h.b, h.c]) assert.deepEqual(projectSharedDocumentWithRecovery(handle), expected);
    },
    close: () => { a.close(); b.close(); h.destroy(); }
  };
}

export function createdDocument(sections: unknown[] = [], rows = [
  { id: "R1", status: "todo", visualText: "", audioText: "ab", imageRef: null, updatedAt: "", updatedBy: null },
  { id: "R2", status: "todo", visualText: "", audioText: "next", imageRef: null, updatedAt: "", updatedBy: null }
]) {
  return { schema: 2, title: "", docId: "d00000000000000000000000000000000", rows, comments: [], people: [], productionTags: [], brollShots: [],
    wordsPerMinute: 150, rev: 0, ...sections.length ? { sections } : {} };
}
