import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";

test("reading the change delta at merge changes which kind-key bold survives undo", t => {
  const seed = new Y.Doc();
  seed.clientID = 900;
  seed.getMap("cells").set("script", new Y.Text("abcdefgh"));
  const initial = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  const show = (text: Y.Text): string => {
    const delta = text.toDelta() as { insert: string; attributes?: { b?: boolean } }[];
    return delta.map(({ insert, attributes }) => attributes?.b ? insert.toUpperCase() : insert).join("");
  };

  for (const readDelta of [false, true]) {
    let merging = false;
    const copy = (id: number) => {
      const doc = new Y.Doc();
      doc.clientID = id;
      Y.applyUpdate(doc, initial);
      const cells = doc.getMap<Y.Text>("cells");
      const text = cells.get("script");
      assert.ok(text);
      cells.observeDeep(events => {
        for (const event of events) {
          if (readDelta && merging && event instanceof Y.YTextEvent) void event.delta;
        }
      });
      return { doc, text };
    };
    const a = copy(1), b = copy(2), origin = {};
    const undo = new Y.UndoManager(a.text, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
    t.after(() => { undo.destroy(); a.doc.destroy(); b.doc.destroy(); });
    const send = (from: Y.Doc, to: Y.Doc): void => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
    const sync = (): void => { send(a.doc, b.doc); send(b.doc, a.doc); send(a.doc, b.doc); };

    a.doc.transact(() => a.text.format(2, 4, { b: true }), origin);
    b.text.format(4, 3, { b: true });
    merging = true;
    sync();
    merging = false;
    assert.deepEqual([show(a.text), show(b.text)], ["abCDEFgh", "abCDEFgh"]);

    undo.undo();
    sync();
    const expected = readDelta ? "abcdefgh" : "abcdEFGh";
    assert.deepEqual([show(a.text), show(b.text)], [expected, expected]);
  }
});
