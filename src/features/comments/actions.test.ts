import "../../test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createActionRegistry } from "../../application/actions.ts";
import { registerCommentAction } from "./actions.ts";
import type { CommentActionPorts } from "./actions.ts";

function fixture() {
  document.body.innerHTML = '<button id="btn-comments"></button><div id="comments-panel" hidden></div>';
  const registry = createActionRegistry();
  const calls: unknown[] = [];
  const screen = { loading: false, dialog: false, launcher: false, tour: false, prompter: false, writer: false, shotlist: false };
  const ports: CommentActionPorts = {
    screen: () => screen,
    openPanel: () => { calls.push("open"); },
    closePanel: () => { calls.push("close"); },
    showTaggingHelp: () => { calls.push("reference"); },
    openComposer: (context) => { calls.push(context); }
  };
  return { registry, ports, calls, screen };
}

test("the comments panel retains its toggle, visibility and loading refusals", () => {
  const { registry, ports, calls, screen } = fixture();
  const stop = registerCommentAction(registry, "panel", ports);
  try {
    assert.equal(registry.invoke("panel-comments", "button").kind, "ran");
    const panel = document.getElementById("comments-panel");
    assert.ok(panel);
    panel.hidden = false;
    registry.invoke("panel-comments", "menu");
    assert.deepEqual(calls, ["open", "close"]);
    screen.loading = true;
    assert.equal(registry.invoke("panel-comments", "menu").kind, "unavailable");
    screen.loading = false;
    screen.writer = true;
    assert.equal(registry.view("panel-comments")?.reason, "Close the writer first");
    const button = document.getElementById("btn-comments");
    assert.ok(button);
    button.hidden = true;
    assert.equal(registry.view("panel-comments")?.visible, false);
  } finally {
    stop();
  }
  assert.equal(registry.has("panel-comments"), false);
});

test("the tagging reference retains its dialog policy and registration disposer", () => {
  const { registry, ports, calls, screen } = fixture();
  const stop = registerCommentAction(registry, "tagging-help", ports);
  try {
    screen.prompter = true;
    registry.invoke("tagging-help", "menu");
    assert.deepEqual(calls, ["reference"]);
    screen.dialog = true;
    assert.equal(registry.invoke("tagging-help", "menu").kind, "unavailable");
    assert.deepEqual(calls, ["reference"]);
  } finally {
    stop();
  }
  assert.equal(registry.has("tagging-help"), false);
});

test("selection comments validate their context and remain callable from their view", () => {
  const { registry, ports, calls, screen } = fixture();
  const stop = registerCommentAction(registry, "selection", ports);
  const context = { id: "c1", rowId: "r1", field: "audioText", quotedText: "Words" };
  try {
    screen.dialog = true;
    assert.equal(registry.view("comment-on-selection")?.visible, false);
    assert.equal(registry.invoke("comment-on-selection", "button", null).kind, "failed");
    assert.equal(registry.invoke("comment-on-selection", "button", { ...context, rowId: 1 }).kind, "failed");
    assert.equal(registry.invoke("comment-on-selection", "button", context).kind, "ran");
    assert.deepEqual(calls, [context]);
  } finally {
    stop();
  }
  assert.equal(registry.has("comment-on-selection"), false);
});
