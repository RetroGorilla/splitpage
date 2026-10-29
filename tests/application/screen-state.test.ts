import { test } from "node:test";
import assert from "node:assert/strict";
import { createScreenState } from "../../src/application/screen-state.ts";
import type { ScreenStatePorts } from "../../src/application/screen-state.ts";

interface Fake {
  doc: unknown;
  dialog: boolean;
  launcher: boolean;
  tour: boolean;
  prompter: boolean;
  writer: boolean;
  shotlist: boolean;
}

function fakePorts(fake: Fake): ScreenStatePorts {
  return {
    document: { current: () => fake.doc },
    flags: () => ({ tourOpen: () => fake.tour, writerOpen: () => fake.writer, brollPageOpen: () => fake.shotlist }),
    prompterOpen: () => fake.prompter,
    page: { dialogShown: () => fake.dialog, launcherShown: () => fake.launcher }
  };
}

function blank(): Fake {
  return { doc: {}, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false };
}

test("screen state reports nothing in front when a document is open and no overlay shows", () => {
  const owner = createScreenState(fakePorts(blank()));
  assert.deepEqual(owner.screenNow(), { loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false });
});

test("screen state reports loading while no document is held", () => {
  const fake = blank();
  fake.doc = null;
  assert.equal(createScreenState(fakePorts(fake)).screenNow().loading, true);
});

test("screen state reports each overlay from its own port", () => {
  for (const key of ["dialog", "launcher", "tour", "prompter", "writer", "shotlist"] as const) {
    const fake = blank();
    fake[key] = true;
    const state = createScreenState(fakePorts(fake)).screenNow();
    for (const other of ["dialog", "launcher", "tour", "prompter", "writer", "shotlist"] as const) {
      assert.equal(state[other], other === key, `${key} set, ${other} read`);
    }
  }
});

test("screen state reads every port in blocker order on each call", () => {
  const reads: string[] = [];
  const owner = createScreenState({
    document: { current: () => { reads.push("document"); return {}; } },
    flags: () => {
      reads.push("flags");
      return {
        tourOpen: () => { reads.push("tour"); return false; },
        writerOpen: () => { reads.push("writer"); return false; },
        brollPageOpen: () => { reads.push("shotlist"); return false; }
      };
    },
    prompterOpen: () => { reads.push("prompter"); return false; },
    page: {
      dialogShown: () => { reads.push("dialog"); return false; },
      launcherShown: () => { reads.push("launcher"); return false; }
    }
  });
  owner.screenNow();
  assert.deepEqual(reads, ["document", "dialog", "launcher", "flags", "tour", "prompter", "flags", "writer", "flags", "shotlist"]);
});

test("asking from the launcher hides the launcher only while the read runs", () => {
  const fake = blank();
  fake.launcher = true;
  const owner = createScreenState(fakePorts(fake));
  assert.equal(owner.screenNow().launcher, true);
  const inside = owner.askingFromLauncher(() => owner.screenNow().launcher);
  assert.equal(inside, false);
  assert.equal(owner.screenNow().launcher, true);
  assert.equal(owner.launcherShown(), true);
  assert.equal(owner.askingFromLauncher(() => owner.launcherShown()), true);
});

test("asking from the launcher restores the launcher after the read throws", () => {
  const fake = blank();
  fake.launcher = true;
  const owner = createScreenState(fakePorts(fake));
  assert.throws(() => owner.askingFromLauncher(() => { throw new Error("read failed"); }), /read failed/);
  assert.equal(owner.screenNow().launcher, true);
});

test("asking from the launcher returns the read's value", () => {
  const owner = createScreenState(fakePorts(blank()));
  assert.equal(owner.askingFromLauncher(() => 42), 42);
});

test("each owner keeps its own launcher asking state", () => {
  const fake = blank();
  fake.launcher = true;
  const one = createScreenState(fakePorts(fake));
  const two = createScreenState(fakePorts(fake));
  assert.equal(one.askingFromLauncher(() => two.screenNow().launcher), true);
});
