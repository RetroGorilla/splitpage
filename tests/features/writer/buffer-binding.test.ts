import { test } from "node:test";
import * as Y from "yjs";
import assert from "node:assert/strict";
import { bufferedWriter } from "./buffer-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { observeSharedTransactions, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { sharedCommand, registerSplits } from "../../application/session/shared-session-support.ts";
import type { Command } from "../../../src/application/session/document-session.ts";
import { beatPos, startBeat } from "../../../src/core/flow/flow.ts";
import { fromHtml } from "../../../src/bootstrap/richtext.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";

test("rule 27: missing base counts once, refuses native input and repaints; the very next input works", () => {
  const page = bufferedWriter("ab", false);
  try {
    page.ready();
    assert.equal(page.native(2, 2, "Z"), false);
    assert.deepEqual([page.missing, page.text(), page.beat().textContent], [["R1"], "ab", "ab"]);
    assert.equal(page.native(2, 2, "Z"), true);
    assert.equal(page.text(), "abZ");
    assert.deepEqual(page.missing, ["R1"]);
    assert.deepEqual(page.reports, []);
  } finally { page.close(); }
});

test("commit refreshes the painted base before the next keystroke", () => {
  const page = bufferedWriter();
  try {
    assert.equal(page.native(2, 2, "Z"), true);
    assert.deepEqual([page.surface.paintedBase("R1")?.text, page.surface.paintedBase("R1")?.revision], ["abZ", 2]);
    assert.equal(page.native(3, 3, "Y"), true);
    assert.deepEqual([page.text(), page.a.executed.map(command => command.base)], ["abZY", [1, 2]]);
    assert.deepEqual(page.reports, []);
  } finally { page.close(); }
});

test("identical native replacement refreshes identities even while the painted text is unchanged", () => {
  const page = bufferedWriter("aa");
  try {
    const before = page.surface.paintedBase("R1"); assert.ok(before);
    page.native(0, 1, "a");
    const after = page.surface.paintedBase("R1"); assert.ok(after);
    assert.equal(after.text, "aa"); assert.equal(after.revision, 2);
    assert.notEqual(after.identity(0), before.identity(0));
    assert.equal(after.identity(1), before.identity(1));
    page.native(0, 1, "Z");
    assert.equal(page.text(), "Za");
    assert.deepEqual(page.reports, []);
  } finally { page.close(); }
});

test("orphan repair keeps the dirty painted base until the native insertion commits", () => {
  const page = bufferedWriter();
  try {
    const before = page.surface.paintedBase("R1");
    page.start(2);
    const target = page.surface.domRange({ anchor: beatPos("R1", 2), head: beatPos("R1", 2) }); assert.ok(target);
    const input = new window.InputEvent("beforeinput", { inputType: "insertCompositionText", bubbles: true, cancelable: true, data: "Z" });
    Object.defineProperty(input, "getTargetRanges", { value: () => [target] });
    assert.equal(page.root.dispatchEvent(input), true);
    page.beat().after(document.createTextNode("Z"));
    page.root.dispatchEvent(new window.InputEvent("input", { inputType: "insertCompositionText", bubbles: true, data: "Z" }));
    page.surface.paint(); page.surface.repaint();
    assert.equal(page.beat().textContent, "abZ");
    assert.equal(page.surface.paintedBase("R1"), before);
    assert.equal(page.text(), "ab");
    page.end("Z");
    assert.equal(page.text(), "abZ");
    assert.deepEqual(page.reports, []);
  } finally { page.close(); }
});

test("inline markdown reaches its command port only after native typing commits and refreshes its base", () => {
  const commands: string[] = [];
  const page = bufferedWriter("**ab*", true, name => {
    commands.push(name);
    assert.equal(page.text(), "**ab**");
    assert.equal(page.surface.paintedBase("R1")?.text, "**ab**");
    assert.equal(collabState(page.h.a).ingress.holds.has("buffer"), false);
    page.surface.paint();
  });
  try {
    page.native(5, 5, "*");
    assert.deepEqual(commands, ["inline-markdown"]);
    assert.equal(page.text(), "**ab**");
    assert.equal(page.surface.paintedBase("R1")?.text, "**ab**");
    assert.deepEqual(page.reports, []);
  } finally { page.close(); }
});

test("empty beat native typing uses the painted zero gap", () => {
  const page = bufferedWriter("");
  try {
    assert.equal(page.native(0, 0, "Z"), true);
    assert.equal(page.text(), "Z");
    assert.deepEqual(page.reports, []);
  } finally { page.close(); }
});

test("a DOM difference outside the native target is refused and held without a whole-field fallback", () => {
  const page = bufferedWriter("abcd");
  try {
    page.native(1, 3, "Z", () => {
      const text = page.beat().firstChild; assert.ok(text instanceof window.Text);
      text.replaceData(0, 1, "x");
    });
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-native-evidence" }]);
    assert.deepEqual([page.text(), page.beat().textContent], ["abcd", "Zd"]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], ["buffer"]);
    page.surface.repaint();
    assert.equal(page.beat().textContent, "Zd");
    assert.equal(page.a.executed.length, 0);
  } finally { page.close(); }
});

test("paint during a dirty composition keeps the typed DOM and its original identities until commit", () => {
  const page = bufferedWriter();
  try {
    const base = page.surface.paintedBase("R1"), reads = page.reads();
    page.start(2);
    page.native(2, 2, "Z", undefined, "insertCompositionText");
    page.surface.repaint(); page.surface.paint(); page.surface.refreshBeat("R1");
    assert.equal(page.surface.paintedBase("R1"), base);
    assert.equal(page.beat().textContent, "abZ");
    assert.equal(page.reads(), reads);
    assert.equal(page.text(), "ab");
    page.native(3, 3, "Y", undefined, "insertCompositionText");
    page.end("ZY");
    assert.equal(page.text(), "abZY");
    assert.equal(page.surface.paintedBase("R1")?.text, "abZY");
    assert.equal(page.a.executed.length, 1);
    assert.deepEqual(page.reports, []);
  } finally { page.close(); }
});

test("native ingress interval holds a remote prefix; caret follows the inserted local text after drain", () => {
  const page = bufferedWriter();
  try {
    page.native(2, 2, "Z", () => {
      page.h.execute("B", [page.h.insertion("B", "R1", page.h.point("B", "R1", 0), "X")], ["b1"]);
      page.h.queue.deliverFrom("B", "D1");
      assert.equal(page.text(), "ab");
      assert.equal(page.beat().textContent, "ab");
    });
    assert.equal(page.text(), "XabZ");
    assert.equal(page.surface.selection()?.head.offset, 4);
    assert.deepEqual(page.reports, []);
  } finally { page.close(); }
});

test("composition cancellation discards only local native intent and releases remote arrivals", () => {
  const page = bufferedWriter();
  try {
    page.start(2);
    page.native(2, 2, "Z", undefined, "insertCompositionText");
    page.h.execute("B", [page.h.insertion("B", "R1", page.h.point("B", "R1", 0), "X")], ["b1"]);
    page.h.queue.flush("dup");
    page.end("");
    assert.equal(page.text(), "Xab");
    assert.equal(page.beat().textContent, "Xab");
    assert.equal(page.a.executed.length, 0);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
  } finally { page.close(); }
});

test("composition cancellation without a remote edit repaints the unchanged model over native DOM", () => {
  const page = bufferedWriter();
  try {
    page.start(2); page.native(2, 2, "Z", undefined, "insertCompositionText");
    page.end("");
    assert.deepEqual([page.text(), page.beat().textContent], ["ab", "ab"]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    assert.equal(page.a.executed.length, 0);
    page.native(2, 2, "Q");
    assert.equal(page.text(), "abQ");
  } finally { page.close(); }
});

test("a throwing subscriber during cancel is reported after held text drains and the model is repainted", () => {
  const page = bufferedWriter(), failure = new Error("subscriber");
  let stop = () => {};
  try {
    page.start(2); page.native(2, 2, "Z", undefined, "insertCompositionText");
    page.h.execute("B", [page.h.insertion("B", "R1", page.h.point("B", "R1", 0), "X")], ["b1"]);
    page.h.queue.flush("dup");
    stop = observeSharedTransactions(page.h.a, () => { throw failure; });
    page.end(""); stop();
    assert.deepEqual([page.text(), page.beat().textContent], ["Xab", "Xab"]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    assert.deepEqual(page.reports.map(report => report.kind), ["failed"]);
    const report = page.reports[0]; assert.ok(report?.kind === "failed" && report.error instanceof AggregateError);
    assert.deepEqual(report.error.errors, [failure, failure]);
  } finally { stop(); page.close(); }
});

test("composition commit inside delivery retains native text and the gate until an explicit finish", () => {
  const page = bufferedWriter();
  try {
    page.start(2); page.native(2, 2, "Z", undefined, "insertCompositionText");
    const stop = observeSharedTransactions(page.h.a, () => { page.end("Z"); });
    transactSharedDocument(page.h.a, "local-command", () => {}); stop();
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "buffer-delivery" }]);
    assert.equal(page.a.executed.length, 0);
    assert.equal(page.beat().textContent, "abZ");
    page.surface.finish();
    assert.equal(page.text(), "abZ");
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
  } finally { page.close(); }
});

for (const kind of ["status", "scalar", "structural"] as const) {
  test(`command admission: dirty typing commits before the ${kind} command plans and enters`, () => {
    const page = bufferedWriter();
    try {
      registerSplits(page.h.a);
      page.start(2); page.native(2, 2, "Z", undefined, "insertCompositionText");
      assert.equal(page.text(), "ab");
      const command: Command = kind === "structural" ? { name: "split", needs: "edit", plan: (doc, capabilities) => {
        const result = startBeat(doc, beatPos("R1", 2), { cells: html => fromHtml(html ?? ""), newId: () => "tail", hasVisual: () => false,
          operations: { id: "split", by: "Alice" } });
        assert.ok(result && "ops" in result && result.ops);
        return sharedCommand("split", result.ops).plan(doc, capabilities);
      } }
        : sharedCommand(kind, [page.h.command("A", kind === "status"
          ? { kind: "status", target: { scope: "beat", record: "R1" }, value: "ready", parents: [] }
          : { kind: "scalar", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 7 })]);
      let plans = 0;
      const outcome = page.a.session.run({ ...command, plan: (doc, capabilities) => {
        plans++;
        assert.equal(doc.rows[0]?.audioText, "abZ");
        assert.equal(collabState(page.h.a).ingress.holds.has("buffer"), false);
        return command.plan(doc, capabilities);
      } });
      assert.equal(outcome.kind, "applied", JSON.stringify(outcome));
      assert.equal(plans, 1);
      assert.deepEqual(page.a.executed.map(command => command.base), [1, 2]);
      assert.deepEqual(page.a.executed[0]?.operations.map(operation => operation.kind), ["text-insert"]);
      assert.deepEqual(page.a.executed[1]?.operations.map(operation => operation.kind), [kind === "structural" ? "split" : kind]);
      page.end("Z"); page.h.queue.flush("dup"); page.h.join();
      const projections = [page.h.a, page.h.b, page.h.c].map(projectSharedDocumentWithRecovery);
      assert.deepEqual(projections[1], projections[0]); assert.deepEqual(projections[2], projections[0]);
      assert.deepEqual(projections[0]?.document.rows.map(row => row.audioText), kind === "structural" ? ["ab", "Z", "next"] : ["abZ", "next"]);
      assert.deepEqual(page.reports, []);
    } finally { page.close(); }
  });
}

test("rule 29 dependent slice: residual stale base shows refusal and retains native text and hold, including disposal", () => {
  const page = bufferedWriter("abcd");
  try {
    page.start(1, 3); page.native(1, 3, "Z", undefined, "insertCompositionText");
    const other = collabState(page.h.a).roots.beats.get("R2"); assert.ok(other instanceof Y.Map);
    transactSharedDocument(page.h.a, "local-command", () => { other.set("lengthSeconds", 7); });
    page.end("Z");
    assert.deepEqual(page.reports, [{ kind: "rejected", reason: "stale-base" }]);
    assert.deepEqual([page.text(), page.beat().textContent], ["abcd", "aZd"]);
    assert.deepEqual([...collabState(page.h.a).ingress.holds], ["buffer"]);
    page.surface.repaint(); page.surface.dispose();
    assert.equal(page.beat().textContent, "aZd");
    assert.deepEqual([...collabState(page.h.a).ingress.holds], ["buffer"]);
    assert.deepEqual(page.reports[1], { kind: "rejected", reason: "stale-base" });
    assert.deepEqual(projectSharedDocumentWithRecovery(page.h.a).recovery, []);
    assert.deepEqual(page.a.session.run({ name: "must-wait", needs: "edit", plan: () => {
      assert.fail("A pending native edit must stop another command before planning");
    } }), { kind: "rejected", reason: "buffer-pending" });
    assert.equal(page.beat().textContent, "aZd");
    page.end("");
    assert.deepEqual([...collabState(page.h.a).ingress.holds], []);
    assert.equal(page.beat().textContent, "abcd");
  } finally { page.close(); }
});
