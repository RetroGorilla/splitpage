import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEW_SAFE_ACTIONS, createReviewClickGate } from "../../../src/features/review/click-gate.ts";

function page(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = [
    '<div class="mini-toolbar"><button data-cmd="bold"><b>B</b></button><button data-cmd="comment">C</button></div>',
    '<button data-action="delete-row"><span class="icon"></span></button>',
    '<button data-action="jump-row">Jump</button>',
    '<button data-action="">Blank</button>',
    '<p class="plain">text</p>'
  ].join("");
  document.body.append(root);
  return root;
}

function at(root: HTMLElement, selector: string): Element {
  const el = root.querySelector(selector);
  assert.ok(el, selector);
  return el;
}

test("in review mode the gate refuses editing actions and toolbar commands, and lets the review-safe ones and plain clicks through", () => {
  const root = page();
  let refused = 0;
  const gate = createReviewClickGate({ reviewMode: () => true, refuse: () => { refused++; } });
  try {
    assert.equal(gate(at(root, '[data-cmd="bold"] b')), true, "a toolbar command other than comment");
    assert.equal(gate(at(root, '[data-cmd="comment"]')), false, "the toolbar's comment command");
    assert.equal(gate(at(root, '[data-action="delete-row"] .icon')), true, "an editing action, from a descendant");
    assert.equal(gate(at(root, '[data-action="jump-row"]')), false, "a review-safe action");
    assert.equal(gate(at(root, '[data-action=""]')), true, "an action with no name is not on the allowlist");
    assert.equal(gate(at(root, ".plain")), false, "a click on no action");
    assert.equal(refused, 3, "each refusal is reported once");
  } finally {
    root.remove();
  }
});

test("outside review mode the gate refuses nothing", () => {
  const root = page();
  let refused = 0;
  const gate = createReviewClickGate({ reviewMode: () => false, refuse: () => { refused++; } });
  try {
    assert.equal(gate(at(root, '[data-cmd="bold"]')), false);
    assert.equal(gate(at(root, '[data-action="delete-row"]')), false);
    assert.equal(refused, 0);
  } finally {
    root.remove();
  }
});

test("the review-safe allowlist is the baseline's sixteen actions", () => {
  assert.deepEqual([...REVIEW_SAFE_ACTIONS].sort(), [
    "bulk-clear", "export-breakdown", "export-packing-gear", "gallery-open", "gallery-open-videos",
    "jump-row", "jump-tag", "link-cancel", "link-confirm", "reply-cancel", "reply-post",
    "tag-expand", "toggle-reply", "video-cancel", "video-confirm", "writer-jump"
  ]);
});
