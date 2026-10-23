import { test } from "node:test";
import assert from "node:assert/strict";
import { NEVER_CONFIRMED, createSaveCoordinator } from "../../src/application/save/coordinator.ts";
import type { DestinationKey, SaveCoordinator, SaveJob, WriterResult } from "../../src/application/save/coordinator.ts";
import type { OperationContext } from "../../src/application/session/operation.ts";

interface Request {
  readonly kind: "save" | "auto" | "saveAs";
  readonly tag?: string;
}

interface Pending {
  readonly job: SaveJob<Request>;
  readonly answer: (result: WriterResult) => void;
  readonly fail: (error: unknown) => void;
}

interface World {
  epoch: number;
  destination: { readonly name: string };
  readonly pending: Pending[];
  readonly obsolete: { request: Request; here: boolean }[];
  readonly running: boolean[];
  calls: number;
  readonly coordinator: SaveCoordinator<Request, string>;
}

function place(name: string): { readonly name: string } {
  return Object.freeze({ name: name });
}

function world(): World {
  const w = {
    epoch: 1,
    destination: place("file-a"),
    pending: [] as Pending[],
    obsolete: [] as { request: Request; here: boolean }[],
    running: [] as boolean[],
    calls: 0
  } as World;
  function capture(): OperationContext {
    w.calls++;
    return Object.freeze({
      epoch: w.epoch, docId: "d1", destination: w.destination, destinationGeneration: 0, generation: 0, connection: null, revision: null
    });
  }
  const coordinator = createSaveCoordinator<Request, string>({
    ownership: {
      capture: capture,
      stillOwns: function (ctx) { w.calls++; return ctx.epoch === w.epoch && ctx.destination === w.destination; }
    },
    destination: {
      current: function () { w.calls++; return w.destination; },
      keyOf: function (identity): DestinationKey {
        w.calls++;
        return { owner: "places", name: (identity as { name: string }).name };
      }
    },
    writer: {
      write: function (job) {
        return new Promise<WriterResult>(function (resolve, reject) {
          w.pending.push({ job: job, answer: resolve, fail: reject });
        });
      }
    },
    report: {
      obsolete: function (request, here) { w.calls++; w.obsolete.push({ request: request, here: here }); }
    },
    join: function (pending, next) {
      if (pending.kind === "saveAs" || next.kind === "saveAs") return null;
      if (pending.kind === "auto" && next.kind === "auto") return pending;
      return { kind: "save" };
    }
  });
  coordinator.onChange(function (change) {
    if (change !== "running") return;
    w.calls++;
    w.running.push(coordinator.running());
  });
  (w as { coordinator: SaveCoordinator<Request, string> }).coordinator = coordinator;
  return w;
}

function nth(w: World, index: number): Pending {
  const found = w.pending[index];
  if (!found) throw new Error("no writer number " + index + " was started");
  return found;
}

async function turns(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const SAVED: WriterResult = { kind: "saved" };

function settled<T>(promise: Promise<T>): Promise<T | "still pending"> {
  return Promise.race([promise, new Promise<"still pending">((resolve) => { setTimeout(() => { resolve("still pending"); }, 200); })]);
}

test("a lone save hands its writer the captured context, is saved, and confirms the generation it captured", async () => {
  const w = world();
  w.coordinator.noteChange();
  w.coordinator.noteChange();
  const done = w.coordinator.request({ kind: "save" });
  assert.equal(w.pending.length, 1, "the writer starts at once when nothing else runs");
  const first = nth(w, 0);
  assert.equal(first.job.generation, 2);
  assert.equal(first.job.operation().destination, w.destination);
  assert.equal(w.coordinator.running(), true);
  first.answer(SAVED);
  assert.deepEqual(await done, { kind: "saved", acknowledged: true });
  assert.equal(w.coordinator.confirmed().generation, 2);
  assert.equal(w.coordinator.dirty(), false);
  assert.deepEqual(w.running, [true, false]);
});

test("F5/S7: a save asked for while another runs on the same destination waits its turn, and completions apply in order", async () => {
  const w = world();
  w.coordinator.noteChange();
  const order: string[] = [];
  const first = w.coordinator.request({ kind: "save", tag: "button" }).then(function (o) { order.push("first:" + o.kind); });
  w.coordinator.noteChange();
  const second = w.coordinator.request({ kind: "saveAs", tag: "retry" }).then(function (o) { order.push("second:" + o.kind); });
  await turns();
  assert.equal(w.pending.length, 1, "no second writer opens while the first is writing");
  assert.equal(w.coordinator.waiting(), 1);
  nth(w, 0).answer(SAVED);
  await turns();
  assert.equal(w.pending.length, 2, "the second starts once the first is done");
  assert.equal(nth(w, 1).job.generation, 2, "and captures the generation of its own turn");
  nth(w, 1).answer(SAVED);
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:saved", "second:saved"]);
  assert.deepEqual(w.running, [true, false], "the controls read busy from the first start to the last finish");
});

test("F5-stale: a confirmed generation never moves back, and an edit during a save keeps the destination dirty", async () => {
  const w = world();
  w.coordinator.noteChange();
  const done = w.coordinator.request({ kind: "save" });
  w.coordinator.noteChange();
  nth(w, 0).answer(SAVED);
  await done;
  assert.equal(w.coordinator.confirmed().generation, 1);
  assert.equal(w.coordinator.dirty(), true, "the edit made during the write is still unsaved");
  w.coordinator.confirmClean();
  assert.equal(w.coordinator.confirmed().generation, 2);
  const late = w.coordinator.request({ kind: "save" });
  w.coordinator.noteChange();
  w.coordinator.confirmClean();
  nth(w, 1).answer(SAVED);
  await late;
  assert.equal(w.coordinator.confirmed().generation, 3, "a completion for generation 2 does not lower the confirmed 3");
});

test("requests that wait join: automatic saves fold into one, a manual save absorbs them, a Save As never joins", async () => {
  const w = world();
  void w.coordinator.request({ kind: "save" });
  const autoA = w.coordinator.request({ kind: "auto" });
  const autoB = w.coordinator.request({ kind: "auto" });
  assert.equal(autoA, autoB, "two waiting autosaves are one save");
  const manual = w.coordinator.request({ kind: "save" });
  assert.equal(manual, autoA, "a manual save joins the waiting autosave");
  const copy = w.coordinator.request({ kind: "saveAs" });
  assert.notEqual(copy, manual, "a Save As waits on its own");
  assert.equal(w.coordinator.waiting(), 2);
  nth(w, 0).answer(SAVED);
  await turns();
  assert.equal(nth(w, 1).job.request.kind, "save", "the joined request is the manual save");
});

test("obsolete: a write that lands after the document was reopened is reported, not acknowledged", async () => {
  const w = world();
  w.coordinator.noteChange();
  const done = w.coordinator.request({ kind: "save" });
  w.epoch++;
  nth(w, 0).answer(SAVED);
  assert.deepEqual(await done, { kind: "obsolete", here: true });
  assert.deepEqual(w.obsolete.map(function (o) { return o.here; }), [true], "it landed where the open document saves");
  assert.equal(w.coordinator.confirmed().generation, NEVER_CONFIRMED, "nothing was acknowledged");
});

test("obsolete elsewhere: a write for a document that was replaced by one saving to another place is not reported as here", async () => {
  const w = world();
  const done = w.coordinator.request({ kind: "save" });
  w.epoch++;
  w.destination = place("file-b");
  nth(w, 0).answer(SAVED);
  assert.deepEqual(await done, { kind: "obsolete", here: false });
  assert.equal(w.coordinator.confirmed(place("file-a")).generation, NEVER_CONFIRMED);
});

test("cancelled and failed: neither acknowledges; a cancellation is its own outcome, and a writer that throws fails", async () => {
  const w = world();
  w.coordinator.noteChange();
  const cancelled = w.coordinator.request({ kind: "saveAs" });
  nth(w, 0).answer({ kind: "cancelled" });
  assert.deepEqual(await cancelled, { kind: "cancelled" });
  const failed = w.coordinator.request({ kind: "save" });
  const boom = new Error("disk full");
  nth(w, 1).fail(boom);
  assert.deepEqual(await failed, { kind: "failed", error: boom });
  const refused = w.coordinator.request({ kind: "save" });
  nth(w, 2).answer({ kind: "refused", reason: "changed on disk" });
  assert.deepEqual(await refused, { kind: "refused", reason: "changed on disk" });
  assert.equal(w.coordinator.dirty(), true);
  assert.deepEqual(w.obsolete, []);
});

test("a refusal keeps the file conflict its writer named, so a view can show it", async () => {
  const w = world();
  w.coordinator.noteChange();
  const conflict = { fileName: "a.md", current: { lastModified: 9 }, kind: "import" as const };
  const refused = w.coordinator.request({ kind: "save" });
  nth(w, 0).answer({ kind: "refused", reason: "changed on disk", conflict });
  assert.deepEqual(await refused, { kind: "refused", reason: "changed on disk", conflict });
  assert.equal(w.coordinator.dirty(), true);
});

test("C1: a copy that lands is saved but acknowledges nothing for the destination", async () => {
  const w = world();
  w.coordinator.noteChange();
  const done = w.coordinator.request({ kind: "saveAs" });
  nth(w, 0).answer({ kind: "copied" });
  assert.deepEqual(await done, { kind: "saved", acknowledged: false });
  assert.equal(w.coordinator.confirmed().generation, NEVER_CONFIRMED);
});

test("a save that moves the document to the place it picked owns that place, and acknowledges it there", async () => {
  const w = world();
  w.coordinator.noteChange();
  const done = w.coordinator.request({ kind: "saveAs" });
  w.destination = place("picked");
  nth(w, 0).job.moved();
  assert.equal(nth(w, 0).job.operation().destination, w.destination);
  nth(w, 0).answer(SAVED);
  assert.deepEqual(await done, { kind: "saved", acknowledged: true });
  assert.equal(w.coordinator.confirmed(place("picked")).generation, 1);
  assert.equal(w.coordinator.confirmed(place("file-a")).generation, NEVER_CONFIRMED, "the place it left is not acknowledged");
});

test("one queue per destination: saves for different places do not wait on each other", async () => {
  const w = world();
  void w.coordinator.request({ kind: "save" });
  w.destination = place("file-b");
  void w.coordinator.request({ kind: "save" });
  assert.equal(w.pending.length, 2);
  nth(w, 0).answer(SAVED);
  await turns();
  assert.equal(w.coordinator.running(), true, "the other place is still writing");
  nth(w, 1).answer(SAVED);
  await turns();
  assert.equal(w.coordinator.running(), false);
});

test("each destination keeps its own confirmed generation and baseline", () => {
  const w = world();
  w.coordinator.noteChange();
  w.coordinator.confirmBaseline("base-a");
  w.coordinator.confirmClean();
  w.destination = place("file-b");
  assert.equal(w.coordinator.dirty(), true, "a place that never confirmed anything is behind");
  assert.equal(w.coordinator.confirmed().baseline, null);
  w.coordinator.confirmBaseline("base-b");
  assert.equal(w.coordinator.confirmed(place("file-a")).baseline, "base-a");
  assert.equal(w.coordinator.confirmed().baseline, "base-b");
  assert.equal(w.coordinator.dirty(place("file-a")), false);
});

test("a writer that answers nothing it can be judged by is a failure", async () => {
  const w = world();
  const done = w.coordinator.request({ kind: "save" });
  nth(w, 0).answer(undefined as unknown as WriterResult);
  const outcome = await done;
  assert.equal(outcome.kind, "failed");
});

test("a job whose document moved on owns nothing but stays alive while its coordinator runs", async () => {
  const w = world();
  const done = w.coordinator.request({ kind: "save" });
  const job = nth(w, 0).job;
  w.epoch = 2;
  assert.equal(job.owns(), false, "a new epoch ends the job's ownership");
  assert.equal(job.alive(), true, "the coordinator that started the job is still running");
  nth(w, 0).answer(SAVED);
  assert.deepEqual(await done, { kind: "obsolete", here: true });
  w.coordinator.stop();
  assert.equal(job.alive(), false, "a stop ends the job's lifetime");
});

test("stop: queued saves settle cancelled, a running write settles from its own answer, and nothing after the stop reaches a port", async () => {
  const w = world();
  const active = w.coordinator.request({ kind: "save" });
  const queued = w.coordinator.request({ kind: "saveAs" });
  const other = w.destination;
  w.destination = place("file-b");
  const elsewhere = w.coordinator.request({ kind: "save" });
  assert.equal(w.pending.length, 2, "one writer per destination is running");
  assert.equal(w.coordinator.waiting(), 1);
  w.destination = other;
  const job = nth(w, 0).job;
  assert.equal(job.alive(), true, "a running coordinator's job is alive");
  w.coordinator.stop();
  w.calls = 0;
  assert.deepEqual(await settled(queued), { kind: "cancelled" });
  assert.equal(w.coordinator.waiting(), 0);
  assert.equal(job.owns(), false, "a stopped coordinator owns nothing");
  assert.equal(job.alive(), false, "a stopped coordinator's job is not alive");
  job.moved();
  assert.deepEqual(await settled(w.coordinator.request({ kind: "save" })), { kind: "refused", reason: "The save coordinator is stopped" });
  nth(w, 0).answer(SAVED);
  nth(w, 1).answer({ kind: "failed", error: "disk" });
  assert.deepEqual(await settled(active), { kind: "obsolete", here: false }, "a write that lands after the stop is no longer this coordinator's to confirm");
  assert.deepEqual(await settled(elsewhere), { kind: "failed", error: "disk" });
  await turns();
  assert.equal(w.calls, 0, "no port was called after the stop");
  assert.equal(w.pending.length, 2, "the queued save never wrote");
  assert.deepEqual(w.obsolete, []);
  assert.deepEqual(w.running, [true], "a stop does not report the controls idle through a released port");
  w.coordinator.stop();
});

test("stop: a writer that rejects after the stop settles failed, and a stop with nothing running changes nothing a later stop would", async () => {
  const w = world();
  const active = w.coordinator.request({ kind: "save" });
  w.coordinator.stop();
  w.calls = 0;
  const error = new Error("gone");
  nth(w, 0).fail(error);
  assert.deepEqual(await settled(active), { kind: "failed", error: error });
  assert.equal(w.calls, 0);
  const idle = world();
  idle.coordinator.stop();
  idle.coordinator.stop();
  assert.equal(idle.calls, 0, "stopping an idle coordinator calls no port");
});

test("unsaved: a change noted since the last confirmClean is unsaved, wherever the document saves to", () => {
  const w = world();
  const c = w.coordinator;
  assert.equal(c.unsaved(), false, "nothing has changed yet");
  c.noteChange();
  assert.equal(c.unsaved(), true, "an edit is unsaved");
  c.confirmClean();
  assert.equal(c.unsaved(), false, "confirming clean saves it");
  c.noteChange();
  w.destination = place("file-b");
  assert.equal(c.unsaved(), true, "moving the document does not confirm the edit");
  c.confirmClean();
  assert.equal(c.unsaved(), false);
  w.destination = place("file-a");
  assert.equal(c.dirty(), true, "the first place never confirmed either edit");
  assert.equal(c.unsaved(), false, "but the document has no change since it was last confirmed clean");
});

test("unsaved: an acknowledged save does not confirm the document clean; only confirmClean does", async () => {
  const w = world();
  const c = w.coordinator;
  c.noteChange();
  const saving = c.request({ kind: "save" });
  nth(w, 0).answer({ kind: "saved" });
  assert.deepEqual(await saving, { kind: "saved", acknowledged: true });
  assert.equal(c.dirty(), false, "the destination is acknowledged");
  assert.equal(c.unsaved(), true, "the writer has not confirmed the document clean");
  c.confirmClean();
  assert.equal(c.unsaved(), false);
});
