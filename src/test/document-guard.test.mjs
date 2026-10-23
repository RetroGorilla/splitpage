import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";

globalThis.location = new URL("https://splitpage.test/index.html?document-guard=1");

const { migrateRows } = await import("../js/02-state.js");
const { DocumentWriteError, documentGuardAsked, documentGuardOn, isDocumentView, quietly, rawOf } = await import("../legacy/document-guard.ts");
const { currentDocument, heldDocument, liveDocumentPort, liveSession, runDocumentEdit, sessionStamps } = await import("../legacy/session-bridge.ts");
const { changeSet } = await import("../application/session/change-set.ts");
const { sceneLengthCommand } = await import("../application/commands/scene-length.ts");
const { flushEdits, undo, undoSizes } = await import("../legacy/undo-bridge.ts");
const { loadTestDocument } = await import("./_document.mjs");

function shown() {
  return currentDocument();
}

function script(title) {
  return migrateRows({
    schema: 2, title: title, docId: "d" + "4".repeat(32), comments: [],
    people: [{ id: "p1", name: "Ada" }],
    rows: [
      { id: "r1", status: "todo", visualText: "Wide", audioText: "One." },
      { id: "r2", status: "todo", visualText: "Close", audioText: "Two." }
    ]
  });
}

function viewsIn(value) {
  const found = [];
  const seen = new Set();
  (function walk(v, path) {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (isDocumentView(v)) found.push(path);
    for (const [k, x] of Object.entries(rawOf(v))) walk(x, path + "." + k);
  })(value, "document");
  return found;
}

function refused(write) {
  try {
    quietly(write);
  } catch (error) {
    return error instanceof DocumentWriteError && error instanceof TypeError;
  }
  return false;
}

test("the guard is read once from the page's query: document-guard=1 and nothing else turns it on", () => {
  assert.equal(documentGuardOn, true);
  assert.equal(documentGuardAsked("?document-guard=1"), true);
  assert.equal(documentGuardAsked("?freeze-caches=1&document-guard=1"), true);
  assert.equal(documentGuardAsked(""), false);
  assert.equal(documentGuardAsked("?document-guard=0"), false);
  assert.equal(documentGuardAsked("?document-guard"), false);
  assert.equal(documentGuardAsked("?document-guard=true"), false);
});

test("shown() is a read-only view of the session's document, one view per object at every depth", () => {
  loadTestDocument(script("Viewed"));
  const raw = heldDocument();
  assert.notEqual(shown(), raw);
  assert.equal(isDocumentView(shown()), true);
  assert.equal(rawOf(shown()), raw);
  assert.equal(shown(), shown(), "the same view each time");
  assert.equal(shown().rows, shown().rows);
  assert.equal(shown().rows[0], shown().rows[0]);
  assert.equal(rawOf(shown().rows[1]), raw.rows[1]);
  assert.equal(shown().rows.indexOf(shown().rows[1]), 1, "identity comparisons among views behave as among raw objects");
  assert.equal(JSON.stringify(shown()), JSON.stringify(raw));
  assert.deepEqual(shown().rows.map((row) => row.id), ["r1", "r2"]);
  assert.equal(shown().rows.filter((row) => row.status === "todo").length, 2);
  assert.equal(isDocumentView(liveDocumentPort.current()), true, "the live-document port hands outside readers a view");
  assert.equal(rawOf(liveDocumentPort.current()), raw);
  assert.equal(isDocumentView(currentDocument()), true, "outside readers get a view");
  assert.equal(rawOf(currentDocument()), raw);
  assert.equal(currentDocument(), currentDocument());
});

test("every kind of write through the view is refused, and the document is unchanged", () => {
  loadTestDocument(script("Refused"));
  const before = JSON.stringify(heldDocument());
  const view = shown();
  const writes = {
    assign: () => { view.title = "Changed"; },
    nested: () => { view.rows[0].audioText = "Changed."; },
    remove: () => { delete view.rows[0].visualText; },
    push: () => { view.rows.push({ id: "r3" }); },
    splice: () => { view.rows.splice(0, 1); },
    sort: () => { view.rows.sort(); },
    length: () => { view.rows.length = 0; },
    define: () => { Object.defineProperty(view, "title", { value: "Changed" }); },
    freeze: () => { Object.freeze(view.people); },
    prototype: () => { Object.setPrototypeOf(view.people[0], null); }
  };
  for (const [name, write] of Object.entries(writes)) assert.equal(refused(write), true, name);
  assert.equal(JSON.stringify(heldDocument()), before);
});

test("a command changes the session's own object, and values read through views reach the document raw", () => {
  loadTestDocument(script("Commanded"));
  const raw = heldDocument();
  const ada = shown().people[0];
  assert.equal(isDocumentView(ada), true);
  const edited = runDocumentEdit({
    name: "copy a person through the view",
    needs: "edit",
    plan: () => ({
      changes: changeSet({ docFields: ["people"] }),
      apply: (doc) => { doc.people.push(ada, { id: "p2", name: "Bo", crew: [ada] }); }
    })
  });
  assert.equal(edited, true);
  assert.equal(heldDocument(), raw);
  assert.deepEqual(viewsIn(heldDocument()), [], "no view reaches the session");
  assert.equal(raw.people[1], raw.people[0], "the view was replaced by the object it shows");
  assert.equal(raw.people[2].crew[0], raw.people[0]);
  assert.equal(runDocumentEdit(sceneLengthCommand("r1", 30, sessionStamps)), true);
  assert.equal(shown().rows[0].lengthSeconds, 30);
  assert.deepEqual(viewsIn(heldDocument()), []);
});

test("a view handed to the session is unwrapped: a replacement and a server update hold raw objects", () => {
  loadTestDocument(script("Before"));
  const next = script("Next");
  next.people.push(shown().people[0]);
  liveDocumentPort.assign(next);
  assert.equal(heldDocument(), next);
  assert.deepEqual(viewsIn(heldDocument()), []);
  const theirs = script("Theirs");
  theirs.rows.push(shown().rows[1]);
  liveSession().absorbServer(theirs);
  assert.equal(heldDocument(), theirs);
  assert.deepEqual(viewsIn(heldDocument()), []);
});

test("undo and redo of a command run through the session under the guard", () => {
  loadTestDocument(script("Undone"));
  flushEdits();
  assert.equal(runDocumentEdit(sceneLengthCommand("r2", 45, sessionStamps)), true);
  flushEdits();
  assert.equal(undoSizes().undo, 1);
  assert.equal(undo().ok, true);
  assert.equal(shown().rows[1].lengthSeconds, undefined);
  assert.deepEqual(viewsIn(heldDocument()), []);
});
