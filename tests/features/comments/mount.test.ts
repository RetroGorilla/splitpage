import test from "node:test";
import assert from "node:assert/strict";
import { mountComments } from "../../../src/features/comments/mount.ts";
import type { CommentsMount, CommentsPorts } from "../../../src/features/comments/mount.ts";
import { jsdomWindow } from "../editing/jsdom.mjs";

type Realm = Window & typeof globalThis;
const rootEvents = ["click", "mousedown", "input", "focusout", "paste", "keydown", "focusin", "beforeinput", "compositionstart", "compositionend", "dragstart", "dragend", "drop"];
const targets: Record<string, string[]> = {
  document: ["input", "compositionend"],
  "comment-modal": [...rootEvents, "click"],
  "comments-panel": [...rootEvents, "change"],
  "btn-comments": ["click"], "comments-panel-close": ["click"],
  "comments-sort": ["change"], "comment-close": ["click"],
  "comment-cancel": ["click"], "comment-post": ["click"], "comment-image-input": ["change"]
};

function harness() {
  const win = jsdomWindow() as unknown as Realm;
  const doc = win.document;
  doc.body.innerHTML = Object.keys(targets).filter((id) => id !== "document").map((id) => '<div id="' + id + '"></div>').join("");
  const el = (id: string): HTMLElement => doc.getElementById(id) as HTMLElement;
  el("comments-sort").outerHTML = '<select id="comments-sort"><option value="recent">Recent</option><option value="position">Position</option></select>';
  el("comment-image-input").outerHTML = '<input id="comment-image-input" type="file">';
  el("comment-modal").innerHTML = '<div id="comment-body-editable" class="cell-editable"></div><input id="comment-name">';
  el("comments-panel").innerHTML = '<div id="reply" class="cell-editable"></div><select id="comments-assignee-filter"><option value="Ada">Ada</option></select><select id="assignee" class="comment-assignee-select" data-id="c1"><option value="Ada">Ada</option></select>';
  const calls: string[] = [];
  const order: string[] = [];
  const state = { epoch: 1, composer: 1, marks: false };
  const pending: { resolve: (value: string) => void; reject: (reason: Error) => void }[] = [];
  const log = (name: string) => (): void => { calls.push(name); };
  const idLog = (name: string) => (id: string | null): void => { calls.push(name + ":" + id); };
  const ports: CommentsPorts = {
    rootClick: (event) => { calls.push("click"); if (!owner?.click(event)) owner?.jumpClick(event); },
    rootMouseDown: log("mousedown"), rootInput: log("input"), rootFocusOut: log("focusout"),
    rootPaste: log("paste"), rootKeydown: log("keydown"),
    authorFields: "#comment-name", limitAuthor: log("author"),
    isDraft: (box) => box.classList.contains("cell-editable"),
    draftUndo: log("undo"), draftRedo: log("redo"),
    typeMarks: () => state.marks, beforeInput: log("beforeinput"),
    focusDraft: log("focus"), composeDraft: (_box, composing) => { calls.push("composition:" + composing); },
    pasteDraft: (_box, html, text) => { calls.push("drop:" + html + ":" + text); },
    toggleResolve: idLog("resolve"), filter: idLog("filter"), toggleReply: idLog("reply"),
    postReply: idLog("reply-post"), deleteComment: (_button, id) => { calls.push("delete:" + id); },
    restoreConflict: idLog("restore"), menu: idLog("menu"), jump: idLog("jump"),
    openPanel: log("open-panel"), closePanel: log("close-panel"),
    assigneeFilter: (value) => { calls.push("filter-assignee:" + value); },
    assignee: (id, value) => { calls.push("assignee:" + id + ":" + value); },
    sortMode: () => { order.push("sort:init"); return "position"; },
    captureReplies: log("capture-replies"), sort: (value) => { calls.push("sort:" + value); },
    closeComposer: (cancelled) => { calls.push("close:" + cancelled); }, post: log("post"),
    captureComposer: () => {
      calls.push("capture-composer");
      const epoch = state.epoch;
      const composer = state.composer;
      const body = el("comment-body-editable");
      return () => epoch === state.epoch && composer === state.composer && el("comment-body-editable") === body ? body : null;
    },
    compressImage: (file, dim, quality) => {
      calls.push("compress:" + file.name + ":" + dim + ":" + quality);
      return new Promise<string>((resolve, reject) => { pending.push({ resolve, reject }); });
    },
    appendImage: (box, data) => { calls.push("append:" + box.id + ":" + data); box.innerHTML += '<img src="' + data + '">'; },
    imageError: log("error"), reset: log("reset")
  };
  const records = Object.entries(targets).map(([id, expected]) => {
    const target: EventTarget = id === "document" ? doc : el(id);
    const added: string[] = [];
    const held: { fn: EventListenerOrEventListenerObject | null; key: string }[] = [];
    const active: typeof held = [];
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const key = (type: string, opts?: boolean | EventListenerOptions): string => type + ((typeof opts === "boolean" ? opts : opts?.capture) ? "/C" : "");
    target.addEventListener = (type, fn, opts) => {
      const entry = { fn, key: key(type, opts) };
      added.push(entry.key); held.push(entry); active.push(entry); order.push(id + ":" + entry.key);
      if (id === "comments-sort") assert.equal((target as HTMLSelectElement).value, "position");
      add(type, fn, opts);
    };
    target.removeEventListener = (type, fn, opts) => {
      const index = active.findIndex((entry) => entry.fn === fn && entry.key === key(type, opts));
      assert.ok(index >= 0, id);
      active.splice(index, 1);
      remove(type, fn, opts);
    };
    return { id, target, expected, added, active, held };
  });
  let owner: CommentsMount | undefined;
  function mount(): CommentsMount {
    owner = mountComments({ window: win, ports });
    order.push("other:early");
    owner.mountRoots();
    order.push("resize:init");
    owner.mountControls();
    return owner;
  }
  function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}): Event {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
    return event;
  }
  return { win, doc, el, ports, state, pending, calls, order, records, mount, fire };
}

test("comments: all 37 registrations retain order, bubble phase and multiplicity after dispose and remount", () => {
  const h = harness();
  let owner = h.mount();
  assert.deepEqual(h.order, [
    "document:input", "document:compositionend", "other:early",
    ...rootEvents.map((type) => "comment-modal:" + type),
    ...rootEvents.map((type) => "comments-panel:" + type),
    "btn-comments:click", "comments-panel-close:click", "resize:init", "comments-panel:change", "sort:init", "comments-sort:change",
    "comment-close:click", "comment-cancel:click", "comment-post:click", "comment-modal:click", "comment-image-input:change"
  ]);
  assert.equal(h.records.reduce((total, r) => total + r.active.length, 0), 37);
  owner.mountRoots(); owner.mountControls();
  for (const r of h.records) assert.deepEqual(r.added, r.expected, r.id);
  owner.dispose(); owner.dispose();
  assert.equal(h.calls.filter((call) => call === "reset").length, 1);
  for (const r of h.records) assert.equal(r.active.length, 0, r.id);
  owner = h.mount();
  for (const r of h.records) {
    assert.deepEqual(r.added, [...r.expected, ...r.expected], r.id);
    assert.equal(r.active.length, r.expected.length, r.id);
  }
  h.calls.length = 0;
  for (const id of ["comment-modal", "comments-panel"]) {
    for (const type of rootEvents.slice(0, 6)) h.fire(h.el(id), type);
  }
  assert.deepEqual(h.calls, ["click", "close:true", "mousedown", "input", "focusout", "paste", "keydown", "click", "mousedown", "input", "focusout", "paste", "keydown"]);
  owner.dispose();
  h.calls.length = 0;
  for (const r of h.records) for (const type of new Set(r.expected)) h.fire(r.target, type);
  assert.deepEqual(h.calls, []);
  for (const r of h.records) assert.equal(r.active.length, 0, r.id);
  h.win.close();
});

test("comments: author limits wait for composition and controls retain capture-before-sort and backdrop order", () => {
  const h = harness();
  const owner = h.mount();
  h.fire(h.el("comment-name"), "input", { isComposing: true });
  assert.deepEqual(h.calls, ["input"]);
  h.calls.length = 0;
  h.fire(h.el("comment-name"), "input");
  h.fire(h.el("comment-name"), "compositionend");
  assert.deepEqual(h.calls, ["input", "author", "author"]);
  h.calls.length = 0;
  for (const id of ["btn-comments", "comments-panel-close", "comment-close", "comment-cancel", "comment-post"]) h.fire(h.el(id), "click");
  h.fire(h.el("comments-assignee-filter"), "change");
  h.fire(h.el("assignee"), "change");
  h.fire(h.el("comments-sort"), "change");
  assert.deepEqual(h.calls, ["open-panel", "close-panel", "close:true", "close:true", "post", "filter-assignee:Ada", "assignee:c1:Ada", "capture-replies", "sort:position"]);
  owner.dispose(); h.win.close();
});

test("comments: B08-B16 controls return early and B18 excludes drafts, links and expanded selections", () => {
  const h = harness();
  const owner = h.mount();
  const actions = ["toggle-resolve", "toggle-reply", "reply-cancel", "reply-post", "delete-comment", "restore-conflict", "comment-menu"];
  const expected = ["resolve:c1", "reply:c1", "reply:c1", "reply-post:c1", "delete:c1", "restore:c1", "menu:c1"];
  actions.forEach((action, i) => {
    h.el("comments-panel").insertAdjacentHTML("beforeend", '<div id="action-card" class="comment-card is-jumpable" data-id="c2"><button id="action" data-id="c1" data-action="' + action + '"><span id="inner"></span></button></div>');
    h.calls.length = 0;
    h.fire(h.el("inner"), "click");
    assert.deepEqual(h.calls, ["click", expected[i]]);
    h.el("action-card").remove();
  });
  h.el("comments-panel").insertAdjacentHTML("beforeend", '<div id="comments-filter-seg"><button id="filter" data-filter="all"></button></div><div id="card" class="comment-card is-jumpable" data-id="c1"><span id="plain">Words</span><a id="link">Link</a><div class="reply-composer"><span id="draft"></span></div><div class="comment-menu"><span id="shield"></span></div></div>');
  h.calls.length = 0;
  h.fire(h.el("filter"), "click");
  assert.deepEqual(h.calls, ["click", "filter:all"]);
  for (const id of ["link", "draft"]) {
    h.calls.length = 0;
    h.fire(h.el(id), "click");
    assert.deepEqual(h.calls, ["click"]);
  }
  const click = (id: string): MouseEvent => {
    const event = new h.win.MouseEvent("click");
    Object.defineProperty(event, "target", { value: h.el(id) });
    return event;
  };
  assert.equal(owner.click(click("shield")), true);
  assert.equal(owner.click(click("plain")), false);
  h.calls.length = 0;
  assert.equal(owner.jumpClick(click("plain")), true);
  assert.deepEqual(h.calls, ["jump:c1"]);
  const range = h.doc.createRange(); range.selectNodeContents(h.el("plain"));
  h.win.getSelection()?.addRange(range);
  assert.equal(owner.jumpClick(click("plain")), false);
  owner.dispose();
  assert.equal(owner.click(click("filter")), false);
  assert.equal(owner.jumpClick(click("plain")), false);
  h.win.close();
});

test("comments: both roots preserve draft history, marks, composition and drag source reset", () => {
  const h = harness();
  let owner = h.mount();
  const transfer = { getData: (type: string) => type === "text/html" ? "<b>Drop</b>" : "Drop" };
  for (const id of ["comment-body-editable", "reply"]) {
    h.calls.length = 0;
    const box = h.el(id);
    h.fire(box, "focusin");
    h.fire(box, "compositionstart"); h.fire(box, "compositionend");
    assert.equal(h.fire(box, "beforeinput", { inputType: "historyUndo" }).defaultPrevented, true);
    assert.equal(h.fire(box, "beforeinput", { inputType: "historyRedo" }).defaultPrevented, true);
    h.state.marks = true;
    assert.equal(h.fire(box, "beforeinput", { inputType: "insertText", data: "x" }).defaultPrevented, true);
    h.state.marks = false;
    h.fire(box, "beforeinput", { inputType: "insertText", data: "x" });
    assert.deepEqual(h.calls, ["focus", "composition:true", "composition:false", "undo", "redo", "beforeinput"]);
    h.fire(box, "dragstart");
    assert.equal(h.fire(box, "drop", { dataTransfer: transfer }).defaultPrevented, false);
    h.fire(box, "dragend");
    assert.equal(h.fire(box, "drop", { dataTransfer: transfer }).defaultPrevented, true);
    assert.equal(h.calls.at(-1), "drop:<b>Drop</b>:Drop");
  }
  h.fire(h.el("reply"), "dragstart");
  owner.dispose(); owner = h.mount();
  assert.equal(h.fire(h.el("reply"), "drop", { dataTransfer: transfer }).defaultPrevented, true);
  owner.dispose(); h.win.close();
});

for (const scenario of ["dispose and reopen", "same-ID document replacement", "stale completion after remount", "composer reopened", "body replaced", "normal completion"]) {
  test("comments: image completion, " + scenario, async () => {
    const h = harness();
    const owner = h.mount();
    const input = h.el("comment-image-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new h.win.File(["image"], "picture.png", { type: "image/png" })] });
    h.fire(input, "change");
    assert.equal(input.value, "");
    assert.deepEqual(h.calls, ["capture-composer", "compress:picture.png:700:0.72"]);
    let replacement: CommentsMount | undefined;
    if (scenario === "dispose and reopen") { owner.dispose(); h.state.epoch++; h.state.composer++; }
    if (scenario === "same-ID document replacement") h.state.epoch++;
    if (scenario === "stale completion after remount") { owner.dispose(); replacement = h.mount(); }
    if (scenario === "composer reopened") h.state.composer++;
    if (scenario === "body replaced") h.el("comment-body-editable").replaceWith(h.el("comment-body-editable").cloneNode(true));
    h.calls.length = 0;
    const job = h.pending[0]; assert.ok(job);
    job.resolve("data:image/png;base64,AAAA");
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(h.calls, scenario === "normal completion" ? ["append:comment-body-editable:data:image/png;base64,AAAA"] : []);
    owner.dispose(); replacement?.dispose(); h.win.close();
  });
}

test("comments: stale image rejection is silent, live rejection reports once, and retained handlers are inert", async () => {
  const h = harness();
  let owner = h.mount();
  const input = h.el("comment-image-input");
  Object.defineProperty(input, "files", { value: [new h.win.File(["bad"], "bad.png")] });
  h.fire(input, "change");
  const first = h.pending[0]; assert.ok(first);
  owner.dispose(); owner = h.mount();
  h.calls.length = 0;
  first.reject(new Error("stale"));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(h.calls, []);
  h.fire(input, "change");
  const second = h.pending[1]; assert.ok(second);
  h.calls.length = 0;
  second.reject(new Error("live"));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(h.calls, ["error"]);
  owner.dispose(); h.calls.length = 0;
  for (const record of h.records) for (const entry of record.held) {
    const event = new h.win.Event(entry.key);
    Object.defineProperty(event, "target", { value: record.target });
    (entry.fn as EventListener)(event);
  }
  assert.deepEqual(h.calls, []);
  h.win.close();
});

test("comments: disposal removes every listener newest first and silences retained callbacks", () => {
  const h = harness();
  const added: { target: EventTarget; type: string; fn: EventListenerOrEventListenerObject | null; options: boolean | AddEventListenerOptions | undefined }[] = [];
  const removed: typeof added = [];
  for (const target of h.records.map((record) => record.target)) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void => {
      added.push({ target, type, fn, options });
      add(type, fn, options);
    };
    target.removeEventListener = (type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void => {
      removed.push({ target, type, fn, options });
      remove(type, fn, options);
    };
  }
  const owner = h.mount();
  try {
    assert.equal(added.length, 37);
    owner.dispose();
    owner.dispose();
    assert.equal(removed.length, 37);
    assert.deepEqual(removed, [...added].reverse());
    h.calls.length = 0;
    for (const entry of added) {
      assert.equal(typeof entry.fn, "function");
      (entry.fn as EventListener)(new h.win.Event(entry.type));
    }
    assert.deepEqual(h.calls, []);
  } finally { owner.dispose(); h.win.close(); }
});

test("comments: connected targets with a stale id are ignored while document listeners stay live", () => {
  const h = harness();
  const owner = h.mount();
  const target = h.el("comment-post");
  const replacement = target.cloneNode(true);
  target.removeAttribute("id");
  h.doc.body.append(replacement);
  try {
    h.fire(target, "click");
    assert.deepEqual(h.calls, []);
    const author = h.el("comment-name");
    h.doc.body.append(author);
    h.fire(author, "input");
    assert.deepEqual(h.calls, ["author"]);
  } finally { owner.dispose(); h.win.close(); }
});
