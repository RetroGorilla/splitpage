import { test } from "node:test";
import assert from "node:assert/strict";
import * as flow from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowRange } from "../../../src/core/flow/flow.ts";
import type { DocumentScene } from "../../../src/core/document/scenes.ts";
import { flowCommand } from "../../../src/application/commands/flow.ts";
import { syncCommentAnchors } from "../../../src/core/text/anchors.ts";
import { harness, runConfined } from "../../application/session-fakes.ts";
import { createFlowLoadRuntime, expectedHeadingWhitespaceOnReload } from "./load.ts";
import { observedFlowContent, referenceReplacement } from "./reference.ts";

const stamps = { clock: { nowIso: () => "2026-11-04T12:00:00Z" }, editor: { name: () => "Editor" } };
const image = (n: number) => ({ sha256: n.toString(16).padStart(64, "0"), width: 1, height: 1, mime: "image/png" });
const mark = { kind: "text", color: "#111111", size: 0.1, x: 0.2, y: 0.3, text: "Caption" };
function fixture(seed: number) {
  const annotation = { imageRef: image(100), marks: Array.from({ length: 500 }, () => ({ ...mark, text: "Caption".repeat(70).slice(0, 500) })) };
  const gallery = { imageRef: image(1), imageName: "N".repeat(200), imageAnnotation: annotation };
  const titles = ["A scene", "Title " + seed, "Two  words", "Caf\u00e9", "Room (night)"];
  return { schema: 2, title: "Reload", rows: [
    { id: "a", audioText: '<strong>Body</strong> <span class="cmt-anchor" data-cmt="quote">words</span>', visualText: "Visual", ...gallery,
      imageLinks: Array.from({ length: 20 }, (_, i) => ({ href: "https://example.com/" + i, ...(i === 0 ? { poster: true } : {}) })) },
    { id: "b", audioText: "Second", visualText: "Other", imageRef: image(1), imageLinks: [{ href: "https://example.com/20", poster: true }], ...(seed % 2 ? { paragraphStart: true } : {}) },
    { id: "c", audioText: "", visualText: seed % 2 ? "Only visual" : "" }
  ], sections: [{ id: "s", name: titles[seed % titles.length] as string, firstSceneId: "a" }, { id: "t", name: "Next scene", firstSceneId: "c" }],
  comments: [{ id: "thread", anchorId: "quote", rowId: "a", field: "audioText", body: "<strong>Keep</strong>", author: "Adam", resolved: false,
    replies: [{ id: "reply", body: "Reply", author: "Sam", createdAt: "2026-11-01T00:00:00Z" }] }] };
}

test("reference sequences: 60 varied headings retain six successive inserts, whitespace and returned selections", t => {
  const started = performance.now();
  const rt = createFlowLoadRuntime();
  for (let seed = 1; seed <= 60; seed++) {
    const input = fixture(seed);
    const h = harness(undefined, { entry: rt.load, reconcile: doc => syncCommentAnchors(doc, rt.cells) });
    h.session.adopt(input);
    const initial = h.session.held() as FlowDoc;
    const title = ((initial.sections ?? []) as DocumentScene[])[0] as DocumentScene;
    let selection = flow.caretAt(flow.headingPos(title.id, title.name.length));
    for (const text of [" ", "X", "  ", "tail", " ", "Z"]) {
      const before = h.session.held() as FlowDoc;
      const piece = [{ text, marks: {} }];
      const expected = referenceReplacement(before, selection, piece, rt.ports, true);
      const out = runConfined(h.session, flowCommand("sequence", current => {
        const result = flow.replaceRange(current, selection, piece, rt.ports);
        assert.ok(result && "rows" in result, "sequence seed=" + seed);
        selection = result.selection;
        return result;
      }, stamps));
      assert.equal(out.kind, "applied", "sequence seed=" + seed);
      assert.deepEqual(observedFlowContent(h.session.held() as FlowDoc, before, rt.ports), expected, "sequence seed=" + seed + " text=" + JSON.stringify(text));
      const live = h.session.held() as FlowDoc;
      const name = ((live.sections ?? []) as DocumentScene[])[0]?.name ?? "";
      assert.equal(selection.head.offset, name.length, "caret seed=" + seed);
      assert.deepEqual(rt.load(live), expectedHeadingWhitespaceOnReload(live), "sequence reload seed=" + seed);
    }
    h.session.dispose();
  }
  t.diagnostic("360 successive edits and reloads in " + (performance.now() - started).toFixed(0) + " ms; seeds 1..60");
});

test("reload stability: all 21 flow transformations retain complete documents through the real load path", async t => {
  const started = performance.now();
  const rt = createFlowLoadRuntime();
  const operations: Record<string, (doc: FlowDoc, range: FlowRange) => FlowOutcome> = {
    replaceRange: (doc, range) => flow.replaceRange(doc, range, [{ text: "Word", marks: { i: true } }], rt.ports),
    setMarkAcross: (doc, range) => flow.setMarkAcross(doc, range, "u", rt.ports),
    startParagraph: doc => flow.startParagraph(doc, flow.beatPos("a", 2), rt.ports),
    startBeat: doc => flow.startBeat(doc, flow.beatPos("a", 2), rt.ports),
    enterAt: doc => flow.enterAt(doc, flow.caretAt(flow.beatPos("a", 2)), rt.ports),
    joinWithPrevious: doc => flow.joinWithPrevious(doc, "b", rt.ports),
    backspaceAt: doc => flow.backspaceAt(doc, flow.beatPos("b", 0), rt.ports, { tick: "delete" }),
    deleteForwardAt: doc => flow.deleteForwardAt(doc, flow.beatPos("a", 10), rt.ports),
    renameHeading: doc => {
      const name = [" Scene", "Scene ", "  Scene  ", "   ", "\t", "\u00a0", "S", "Room"][Number(doc.rows[0]?.["renameCase"] ?? 0)] as string;
      return flow.renameHeading(doc, "s", name, name.length);
    },
    enterInHeading: doc => flow.enterInHeading(doc, flow.headingPos("s", 2), rt.ports),
    finalizeHeading: doc => flow.finalizeHeading(doc, "a", 9, null, rt.ports),
    lineBreakAt: (doc, range) => flow.lineBreakAt(doc, range, rt.ports),
    pasteText: (doc, range) => flow.pasteText(doc, range, ["First", "Second"], rt.ports),
    typeWithMarks: doc => flow.typeWithMarks(doc, flow.beatPos("a", 2), "Bold", { b: true }, rt.ports),
    selectionToOwnBeat: doc => flow.selectionToOwnBeat(doc, { anchor: flow.beatPos("a", 1), head: flow.beatPos("a", 3) }, rt.ports),
    replaceMatch: (doc, range) => flow.replaceMatch(doc, range, "Word", rt.ports),
    replaceAll: doc => flow.replaceAll(doc, "o", "oo", false, rt.ports),
    insertBeats: doc => flow.insertBeats(doc, flow.beatPos("a", 2), [{ id: "inserted", audioText: "New", visualText: "" },
      { id: "tail", audioText: "Tail", paragraphStart: [false, true, 0, 1, "true", null, {}, []][Number(doc.rows[0]?.["renameCase"] ?? 0)] }] as unknown as flow.FlowRow[], rt.ports),
    moveBeats: doc => flow.moveBeats(doc, ["a"], flow.beatPos("c", 0), rt.ports),
    sentenceParagraphs: doc => ({ rows: flow.sentenceParagraphs(doc, rt.ports), sections: doc.sections as DocumentScene[], removedComments: [], selection: flow.caretAt(flow.beatPos("a", 0)) }),
    inlineMarkdown: doc => {
      const result = flow.inlineMarkdown(rt.cells("**Text**"), 8);
      assert.ok(result);
      return flow.replaceRange(doc, flow.caretAt(flow.beatPos("a", 2)), result.cell, rt.ports);
    }
  };
  assert.equal(Object.keys(operations).length, 21);
  const readers = ["beatPos", "headingPos", "caretAt", "flowOf", "startsParagraph", "comparePos", "orderedRange", "isCollapsed", "withinOneBeat",
    "isPendingHeading", "logicalText", "findInFlow", "normalizedSections", "stepFrom"];
  assert.deepEqual(Object.keys(flow).filter(name => typeof flow[name as keyof typeof flow] === "function").sort(), Object.keys(operations).concat(readers, ["copyFlowRange", "pasteFlowRange"]).sort());
  const applied = new Set<string>();
  for (const [name, run] of Object.entries(operations)) {
    await t.test(name, () => {
      for (let seed = 1; seed <= 8; seed++) {
        const input = fixture(seed);
        Object.assign(input.rows[0] as object, { renameCase: seed - 1 });
        if (name === "finalizeHeading") input.rows[0] = { ...input.rows[0] as typeof input.rows[0], id: "a", audioText: "# Heading", visualText: "" };
        if (name === "sentenceParagraphs") {
          const first = input.rows[0], second = input.rows[1];
          assert.ok(first && second);
          first.audioText = "Body.";
          Reflect.deleteProperty(second, "paragraphStart");
        }
        const h = harness(undefined, { entry: rt.load, reconcile: doc => syncCommentAnchors(doc, rt.cells) });
        h.session.adopt(input);
        try {
          const range = { anchor: flow.beatPos("a", 2), head: flow.beatPos("b", 3) };
          let outcome: FlowOutcome = null;
          const out = runConfined(h.session, flowCommand(name, current => { outcome = run(current, range); return outcome; }, stamps));
          assert.ok(["applied", "noop", "rejected"].includes(out.kind), name + " seed=" + seed + " " + JSON.stringify(out));
          if (out.kind === "applied") applied.add(name);
          const live = h.session.held() as FlowDoc;
          assert.deepEqual(rt.load(live), expectedHeadingWhitespaceOnReload(live), name + " reload seed=" + seed + " notice=" + (outcome as FlowEdit | null)?.notice);
        } finally {
          h.session.dispose();
        }
      }
    });
  }
  assert.deepEqual([...applied].sort(), Object.keys(operations).sort());
  await t.test("copyFlowRange", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const h = harness(undefined, { entry: rt.load, reconcile: doc => syncCommentAnchors(doc, rt.cells) });
      h.session.adopt(fixture(seed));
      try {
        const doc = h.session.held() as FlowDoc;
        const before = JSON.stringify(doc);
        const range = { anchor: flow.headingPos("s", 0), head: flow.beatPos("b", 6) };
        const clip = flow.copyFlowRange(doc, range, rt.ports);
        const sections = clip.headers.map(header => ({ ...header.scene, firstSceneId: (clip.rows[header.index] as flow.FlowRow).id }));
        const copied = rt.load({ ...doc, rows: clip.rows, sections });
        assert.deepEqual(clip.wholeIds, ["a", "b"], "copy seed=" + seed);
        assert.deepEqual(rt.load(copied), expectedHeadingWhitespaceOnReload(copied), "copy reload seed=" + seed);
        assert.equal(JSON.stringify(doc), before, "copy leaves source unchanged seed=" + seed);
        assert.equal(h.session.generation(), 0, "copy records no edit seed=" + seed);
      } finally {
        h.session.dispose();
      }
    }
  });
  await t.test("pasteFlowRange", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const h = harness(undefined, { entry: rt.load, reconcile: doc => syncCommentAnchors(doc, rt.cells) });
      h.session.adopt(fixture(seed));
      try {
        const doc = h.session.held() as FlowDoc;
        const clip = flow.copyFlowRange(doc, { anchor: flow.headingPos("s", 0), head: flow.beatPos("b", 6) }, rt.ports);
        const prepared = { ...clip, rows: clip.rows.map(row => ({ ...row, id: "copied-" + row.id })) };
        const out = runConfined(h.session, flowCommand("pasteFlowRange", current => flow.pasteFlowRange(current,
          flow.caretAt(flow.beatPos("a", 2)), prepared, rt.ports), stamps));
        assert.equal(out.kind, "applied", "paste seed=" + seed);
        const live = h.session.held() as FlowDoc;
        assert.deepEqual(rt.load(live), expectedHeadingWhitespaceOnReload(live), "paste reload seed=" + seed);
        assert.deepEqual(live.rows.filter(row => row.id.startsWith("copied-")).map(row => row.id), ["copied-a", "copied-b"], "paste ids seed=" + seed);
      } finally {
        h.session.dispose();
      }
    }
  });
  t.diagnostic("168 operation reloads in " + (performance.now() - started).toFixed(0) + " ms; seeds 1..8");
});
