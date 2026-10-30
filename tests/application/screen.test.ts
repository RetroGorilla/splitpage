import test from "node:test";
import assert from "node:assert/strict";
import { EVERY_OVERLAY, OPENS_A_DIALOG, availableUnless, everyOverlayBut, firstRefusal, inFront } from "../../src/application/screen.ts";
import type { Blocker, Overlay, ScreenState } from "../../src/application/screen.ts";

function screenWith(...open: Blocker[]): ScreenState {
  return {
    loading: open.includes("loading"),
    dialog: open.includes("dialog"),
    launcher: open.includes("launcher"),
    tour: open.includes("tour"),
    prompter: open.includes("prompter"),
    writer: open.includes("writer"),
    shotlist: open.includes("shotlist")
  };
}

const ALL: readonly Blocker[] = ["loading", "dialog", "launcher", "tour", "prompter", "writer", "shotlist"];

test("the overlay lists are fixed and frozen", () => {
  assert.deepEqual(EVERY_OVERLAY, ["dialog", "launcher", "tour", "prompter", "writer", "shotlist"]);
  assert.deepEqual(OPENS_A_DIALOG, ["dialog", "tour"]);
  assert.ok(Object.isFrozen(EVERY_OVERLAY));
  assert.ok(Object.isFrozen(OPENS_A_DIALOG));
});

test("everyOverlayBut leaves out only the named overlay and keeps the order", () => {
  for (const own of EVERY_OVERLAY) {
    const others = everyOverlayBut(own);
    assert.equal(others.length, EVERY_OVERLAY.length - 1);
    assert.ok(!others.includes(own));
    assert.deepEqual(others, EVERY_OVERLAY.filter((o: Overlay) => o !== own));
  }
});

test("everyOverlayBut returns a new list each time and does not change the shared one", () => {
  const first = everyOverlayBut("dialog");
  assert.notEqual(first, everyOverlayBut("dialog"));
  assert.equal(EVERY_OVERLAY.length, 6);
});

test("inFront is undefined when nothing the caller cares about is showing", () => {
  assert.equal(inFront(ALL, screenWith()), undefined);
  assert.equal(inFront([], screenWith(...ALL)), undefined);
  assert.equal(inFront(["tour"], screenWith("dialog", "writer")), undefined);
});

test("inFront picks the frontmost showing blocker, in the fixed front-to-back order", () => {
  assert.equal(inFront(ALL, screenWith(...ALL)), "loading");
  assert.equal(inFront(ALL, screenWith("shotlist", "writer", "prompter", "tour", "launcher", "dialog")), "dialog");
  assert.equal(inFront(ALL, screenWith("shotlist", "writer", "prompter", "tour", "launcher")), "launcher");
  assert.equal(inFront(ALL, screenWith("shotlist", "writer", "prompter", "tour")), "tour");
  assert.equal(inFront(ALL, screenWith("shotlist", "writer", "prompter")), "prompter");
  assert.equal(inFront(ALL, screenWith("shotlist", "writer")), "writer");
  assert.equal(inFront(ALL, screenWith("shotlist")), "shotlist");
});

test("inFront ignores a showing blocker that is not in the caller's list, even when it is further forward", () => {
  assert.equal(inFront(["writer", "shotlist"], screenWith("dialog", "shotlist")), "shotlist");
});

test("inFront does not depend on the order of the caller's list", () => {
  assert.equal(inFront(["shotlist", "dialog"], screenWith("dialog", "shotlist")), "dialog");
});

test("availableUnless is enabled with no reason when no listed blocker shows", () => {
  assert.deepEqual(availableUnless(["writer"], screenWith("dialog")), { enabled: true });
});

test("availableUnless refuses with the reason for the frontmost listed blocker", () => {
  const reasons: Record<Blocker, string> = {
    loading: "Still loading…",
    dialog: "Close the open dialog first",
    launcher: "Close the open dialog first",
    tour: "Finish or skip the tour first",
    prompter: "Close Present first",
    writer: "Close the writer first",
    shotlist: "Close the shot list first"
  };
  for (const blocker of ALL) {
    assert.deepEqual(availableUnless(ALL, screenWith(blocker)), { enabled: false, reason: reasons[blocker] });
  }
  assert.deepEqual(availableUnless(["writer", "shotlist"], screenWith("shotlist", "writer")), { enabled: false, reason: "Close the writer first" });
});

test("availableUnless carries the checked flag through, enabled or refused, and omits it when not given", () => {
  assert.deepEqual(availableUnless([], screenWith(), true), { enabled: true, checked: true });
  assert.deepEqual(availableUnless([], screenWith(), false), { enabled: true, checked: false });
  assert.deepEqual(availableUnless(["tour"], screenWith("tour"), false), { enabled: false, reason: "Finish or skip the tour first", checked: false });
  assert.equal("checked" in availableUnless([], screenWith()), false);
});

test("firstRefusal gives the screen's answer when it refuses and the action's own when the screen allows", () => {
  const refused = { enabled: false, reason: "Close Present first" };
  const own = { enabled: false, reason: "Nothing selected" };
  assert.equal(firstRefusal(refused, own), refused);
  assert.equal(firstRefusal({ enabled: true }, own), own);
  assert.deepEqual(firstRefusal({ enabled: true }, { enabled: true, checked: true }), { enabled: true, checked: true });
});
