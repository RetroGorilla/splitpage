import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateRows } from "../../../../src/bootstrap/document-ports.ts";
import {
  removeNativeComment, resolveNativeComment
} from "../../../../src/adapters/collab/native/comment-commands.ts";
import { moveNativeBlocks } from "../../../../src/adapters/collab/native/move-commands.ts";
import { clearNativeField, setNativeField } from "../../../../src/adapters/collab/native/record-commands.ts";
import { joinNativeRow, removeNativeRows } from "../../../../src/adapters/collab/native/structure-commands.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { Delivery } from "./helpers.ts";
import {
  AUTHOR, COMMENT, IMAGE, REPLY, RESOLUTION, beatField, commentInput, createNativeComment, createNativeReply, expectedMint,
  freshRecordRead, recordCopies, recordRead, recordSnapshot, recordUndo, replyId, replyInput, setNativeCommentBody, unchangedRecord
} from "./record-harness.ts";
import { split } from "./structure-harness.ts";

const WRITTEN = { kind: "written" };
const orders: readonly Delivery[] = ["forward", "reverse", "twice", "shuffled", "state"];
const clients = [[4, 9], [9, 4], [4, 9, 7], [4, 7, 9], [9, 4, 7], [9, 7, 4], [7, 4, 9], [7, 9, 4]];

function races(run: (left: NativeScript, right: NativeScript, settle: (check: (script: NativeScript) => void) => void, third?: NativeScript) => void): void {
  for (const ids of clients) for (const delivery of orders) {
    const { scripts, net } = recordCopies(ids), [left, right, third] = scripts;
    assert.ok(left && right);
    const settle = (check: (script: NativeScript) => void): void => {
      const deliverers = delivery === "reverse" ? [...scripts].reverse() : scripts;
      for (const from of deliverers) for (const to of scripts) if (from !== to) net.deliver(from, to, delivery);
      for (const script of scripts) {
        check(script);
        assert.deepEqual(recordSnapshot(script), recordSnapshot(left));
        assert.deepEqual(recordRead(script), recordRead(left));
        assert.deepEqual(recordRead(script), freshRecordRead(script));
      }
    };
    try {
      for (const [index, script] of scripts.entries()) {
        assert.deepEqual(setNativeField(script, beatField("F", "writer-" + index), ids[index]), WRITTEN);
      }
      run(left, right, settle, third);
    } finally { for (const script of scripts) script.doc.destroy(); }
  }
}

test("concurrent field writes and whole bodies keep the highest client value on two and three author devices", () => {
  races((left, right, settle, third) => {
    const writes = ["ready", "shot", "todo"] as const;
    const writers = third ? [left, right, third] : [left, right];
    for (const [index, script] of writers.entries()) {
      if (index === 2) assert.deepEqual(setNativeField(script, beatField("B", "status"), "ready"), WRITTEN);
      assert.deepEqual(setNativeField(script, beatField("B", "status"), writes[index]), WRITTEN);
      assert.deepEqual(setNativeCommentBody(script, COMMENT, AUTHOR, "body " + index), WRITTEN);
      assert.deepEqual(setNativeCommentBody(script, REPLY, AUTHOR, "reply " + index), WRITTEN);
    }
    const winner = writers.findIndex(script => script.doc.clientID === Math.max(...writers.map(writer => writer.doc.clientID)));
    settle(script => {
      assert.equal(script.reader.row("B")?.fields.status, writes[winner]);
      const [comment] = script.reader.document().comments;
      assert.equal(comment?.body, "body " + winner);
      assert.equal(comment?.replies?.[0]?.body, "reply " + winner);
    });
  });
});

test("a field on a concurrently removed row stays stored and returns when the remover undoes", () => {
  races((left, right, settle) => {
    const undo = recordUndo(right);
    assert.deepEqual(setNativeField(left, beatField("B", "status"), "shot"), WRITTEN);
    assert.deepEqual(removeNativeRows(right, ["B"]), WRITTEN);
    settle(script => {
      assert.equal(script.reader.row("B"), null);
      assert.equal(script.roots.beats.get("B")?.get("status"), '"shot"');
      assert.ok(script.roots.visuals.has("B"));
      unchangedRecord(script, () => setNativeField(script, beatField("B", "status"), "ready"), "missing");
    });
    assert.ok(undo.undo());
    settle(script => {
      assert.equal(script.reader.row("B")?.fields.status, "shot");
      assert.equal(script.reader.row("B")?.audioText, "bravo");
    });
  });
});

test("a field follows its beat ID across a concurrent split, join or move", () => {
  for (const structure of ["split", "join", "move"]) races((left, right, settle) => {
    assert.deepEqual(setNativeField(left, beatField("B", "status"), "shot"), WRITTEN);
    let created: string | undefined;
    if (structure === "split") created = split(right, "B", 2);
    if (structure === "join") assert.deepEqual(joinNativeRow(right, "B", "A", " "), WRITTEN);
    if (structure === "move") assert.deepEqual(moveNativeBlocks(right, [{ kind: "beat", id: "B" }], { kind: "beat", id: "D" }), WRITTEN);
    settle(script => {
      assert.equal(script.roots.beats.get("B")?.get("status"), '"shot"');
      if (created) {
        assert.equal(script.reader.row("B")?.audioText, "br");
        assert.equal(script.reader.row(created)?.audioText, "avo");
        assert.equal(script.reader.row(created)?.fields.status, undefined);
      }
      if (structure === "join") {
        assert.equal(script.reader.row("B"), null);
        assert.deepEqual(script.reader.row("A")?.members, ["A", "B"]);
      }
      if (structure === "move") assert.deepEqual(script.reader.rows().map(row => row.id), ["A", "C", "B", "D", "E", "F"]);
      assert.equal(script.reader.row(structure === "join" ? "A" : "B")?.fields.status, "shot");
    });
  });
});

test("removing a comment hides a concurrent resolution and reply until removal is undone", () => {
  races((left, right, settle) => {
    const undo = recordUndo(right);
    assert.deepEqual(resolveNativeComment(left, COMMENT, RESOLUTION), WRITTEN);
    const reply = expectedMint(left, "rp");
    assert.deepEqual(createNativeReply(left, COMMENT.comment, replyInput("unseen")), { ...WRITTEN, created: reply });
    assert.deepEqual(removeNativeComment(right, COMMENT), WRITTEN);
    settle(script => {
      assert.deepEqual(script.reader.document().comments, []);
      assert.equal(script.roots.comments.get(COMMENT.comment)?.get("removed"), true);
      assert.ok(script.roots.replies.has(replyId(COMMENT.comment, reply)));
      unchangedRecord(script, () => removeNativeComment(script, { ...COMMENT, reply }), "missing");
    });
    assert.ok(undo.undo());
    settle(script => {
      const [comment] = script.reader.document().comments;
      assert.equal(comment?.resolved, true);
      assert.equal(comment.resolvedBy, RESOLUTION.by);
      assert.deepEqual(comment?.replies?.map(item => item.id), ["answer", reply]);
    });
  });
});

test("concurrent creations mint distinct comments and replies stay under the intended parent", () => {
  races((left, right, settle) => {
    const expected = [left, right].map((script, index) => {
      const id = expectedMint(script, "c"), body = "thread " + index;
      assert.deepEqual(createNativeComment(script, commentInput("same", body)), { ...WRITTEN, created: id });
      const reply = expectedMint(script, "rp"), answer = "answer " + index;
      assert.deepEqual(createNativeReply(script, id, replyInput("same", answer)), { ...WRITTEN, created: reply });
      return { id, body, reply, answer };
    });
    assert.notEqual(expected[0]?.id, expected[1]?.id);
    assert.notEqual(expected[0]?.reply, expected[1]?.reply);
    settle(script => {
      const comments = script.reader.document().comments;
      assert.equal(comments.length, 3);
      for (const { id, body, reply, answer } of expected) {
        const record = comments.find(comment => comment.id === id);
        assert.equal(record?.body, body);
        assert.deepEqual(record?.replies?.map(item => [item.id, item.body]), [[reply, answer]]);
      }
    });
  });
});

test("concurrent writes to different extra fields of one beat both survive a core reload", () => {
  races((left, right, settle) => {
    assert.deepEqual(setNativeField(left, beatField("A", "lens"), "wide"), WRITTEN);
    assert.deepEqual(setNativeField(right, beatField("A", "note"), { scene: 2 }), WRITTEN);
    settle(script => {
      const document = script.reader.document();
      for (const row of [document.rows[0], migrateRows(structuredClone(document)).rows[0]]) {
        assert.equal(row?.lens, "wide");
        assert.deepEqual(row?.note, { scene: 2 });
      }
    });
  });
});

test("concurrent writes to one extra field keep one value and the winner's undo leaves it empty", () => {
  races((left, right, settle) => {
    const winner = left.doc.clientID > right.doc.clientID ? left : right;
    const undo = recordUndo(winner), target = beatField("A", "lens");
    assert.deepEqual(setNativeField(left, target, "wide"), WRITTEN);
    assert.deepEqual(setNativeField(right, target, "tight"), WRITTEN);
    settle(script => assert.equal(script.reader.row("A")?.fields.lens, winner === left ? "wide" : "tight"));
    assert.ok(undo.undo());
    settle(script => assert.equal(Object.hasOwn(script.reader.row("A")?.fields ?? {}, "lens"), false));
  });
});

test("an unseen clear of the primary image leaves a concurrent image name for the core to drop on reload", () => {
  races((left, right, settle) => {
    const image = beatField("A", "imageRef"), name = beatField("A", "imageName");
    assert.deepEqual(setNativeField(left, image, IMAGE), WRITTEN);
    settle(script => assert.deepEqual(script.reader.row("A")?.fields.imageRef, IMAGE));
    assert.deepEqual(clearNativeField(left, image), WRITTEN);
    unchangedRecord(left, () => setNativeField(left, name, "Frame"), "value");
    assert.deepEqual(setNativeField(right, name, "Frame"), WRITTEN);
    unchangedRecord(right, () => clearNativeField(right, image), "value");
    settle(script => {
      const document = script.reader.document(), row = document.rows[0];
      assert.ok(row);
      assert.equal(Object.hasOwn(row, "imageRef"), false);
      assert.equal(row.imageName, "Frame");
      const reloaded = migrateRows(structuredClone(document)).rows[0];
      assert.ok(reloaded);
      assert.equal(reloaded.imageRef, null);
      assert.equal(Object.hasOwn(reloaded, "imageName"), false);
    });
  });
});

test("concurrent picture additions to one beat keep one whole picture list in both client orders", () => {
  races((left, right, settle) => {
    const leftImage = { ...IMAGE, sha256: "b".repeat(64) }, rightImage = { ...IMAGE, sha256: "c".repeat(64) };
    assert.deepEqual(setNativeField(left, beatField("A", "imageRef"), IMAGE), WRITTEN);
    settle(script => assert.deepEqual(script.reader.row("A")?.fields.imageRef, IMAGE));
    for (const [script, image] of [[left, leftImage], [right, rightImage]] as const) {
      assert.deepEqual(setNativeField(script, beatField("A", "moreImages"), [{ imageRef: image }]), WRITTEN);
    }
    const winner = left.doc.clientID > right.doc.clientID ? leftImage : rightImage;
    settle(script => {
      assert.deepEqual(script.reader.row("A")?.fields.imageRef, IMAGE);
      assert.deepEqual(script.reader.row("A")?.fields.moreImages, [{ imageRef: winner }]);
    });
  });
});

test("a body edit and a resolution on different copies keep both values", () => {
  races((left, right, settle) => {
    for (const target of [COMMENT, REPLY]) {
      assert.deepEqual(setNativeCommentBody(left, target, AUTHOR, "edited"), WRITTEN);
      assert.deepEqual(resolveNativeComment(right, target, RESOLUTION), WRITTEN);
    }
    settle(script => {
      const [comment] = script.reader.document().comments;
      for (const record of [comment, comment?.replies?.[0]]) {
        assert.equal(record?.body, "edited");
        assert.equal(record?.resolved, true);
        assert.equal(record?.resolvedBy, RESOLUTION.by);
        assert.equal(record?.resolvedAt, RESOLUTION.at);
      }
    });
  });
});
