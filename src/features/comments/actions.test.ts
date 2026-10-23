import "../../test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry, registerAll } from "../../application/actions.ts";
import type { ScreenState } from "../../application/screen.ts";
import { commentsHelpActions, commentsOpenActions, commentsPanelActions } from "./actions.ts";

const clear: ScreenState = { loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false };

test("comments actions preserve ids, panel visibility, loading refusal and close behavior", () => {
  document.body.innerHTML = '<button id="btn-comments"></button><div id="comments-panel"></div>';
  let screen = clear;
  const closed: string[] = [];
  const registry = createActionRegistry();
  const stop = registerAll(registry, [
    ...commentsPanelActions(() => screen, { close: (id) => { closed.push(id); } }),
    ...commentsHelpActions(() => screen),
    ...commentsOpenActions()
  ]);
  try {
    assert.deepEqual(registry.list().map(({ id }) => id), ["panel-comments", "tagging-help", "comment-on-selection"]);
    assert.equal(registry.view("panel-comments")?.enabled, true);
    assert.equal(registry.invoke("panel-comments", "button").kind, "ran");
    assert.deepEqual(closed, ["comments-panel"]);
    screen = { ...clear, loading: true };
    assert.equal(registry.invoke("panel-comments", "button").kind, "unavailable");
    assert.deepEqual(closed, ["comments-panel"]);
    screen = { ...clear, dialog: true };
    assert.equal(registry.invoke("tagging-help", "menu").kind, "unavailable");
    const button = document.getElementById("btn-comments");
    assert.ok(button);
    button.hidden = true;
    assert.equal(registry.view("panel-comments")?.visible, false);
    assert.equal(registry.view("comment-on-selection")?.visible, false);
  } finally {
    stop();
  }
  assert.deepEqual(registry.list(), []);
});

test("comment selection rejects every missing or mistyped field before opening", () => {
  const definition = commentsOpenActions().find(({ id }) => id === "comment-on-selection");
  assert.ok(definition);
  assert.throws(() => definition.run("button", null), /needs what to open/);
  for (const key of ["id", "rowId", "field", "quotedText"]) {
    const base: Record<string, unknown> = { id: "c1", rowId: "r1", field: "audioText", quotedText: "Words" };
    const input: Record<string, unknown> = Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));
    assert.throws(() => definition.run("button", input), new RegExp("needs " + key + " as text"));
    assert.throws(() => definition.run("button", { ...base, [key]: 1 }), new RegExp("needs " + key + " as text"));
  }
});
