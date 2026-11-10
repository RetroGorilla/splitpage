import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as Y from "yjs";
import { fromDocument, toDocument } from "../../src/proj/document.ts";
import { projectionReferences, serializeProjection } from "../../src/proj/reference.ts";
import { records } from "../../src/proj/value.ts";

const literalTagBytes = `{
  "schema": 2,
  "title": "Quoted tag attribute",
  "docId": "d88888888888888888888888888888888",
  "rev": 0,
  "wordsPerMinute": 150,
  "rows": [
    {
      "id": "quote-row",
      "visualText": "<span class=\\"tag-anchor\\" data-tag-cat=\\"prop\\" data-tag-name=\\"A > B\\" contenteditable=\\"false\\">label</span>",
      "audioText": "",
      "status": "todo",
      "updatedAt": "",
      "updatedBy": null,
      "visualImage": null
    }
  ],
  "comments": [],
  "people": [],
  "productionTags": [
    {
      "id": "t_gt",
      "cat": "prop",
      "name": "A > B",
      "owner": "",
      "notes": "",
      "status": "needed"
    }
  ],
  "brollShots": []
}`;

const literalWhoBytes = `{
  "schema": 2,
  "title": "Quoted who attribute",
  "docId": "d99999999999999999999999999999999",
  "rev": 0,
  "wordsPerMinute": 150,
  "rows": [
    {
      "id": "quote-row",
      "visualText": "<span class=\\"who-anchor\\" data-who=\\"Mira > Nia\\" contenteditable=\\"false\\">@Mira &gt; Nia</span>",
      "audioText": "",
      "status": "todo",
      "updatedAt": "",
      "updatedBy": null,
      "visualImage": null
    }
  ],
  "comments": [],
  "people": [],
  "productionTags": [],
  "brollShots": []
}`;

for (const candidate of ["A", "B"] as const) {
  test(`PROJ review: greater-than in quoted tag and who attributes ${candidate}`, () => {
    for (const [file, expected, bytes] of [
      ["quoted-tag.splitpage", '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="A > B" contenteditable="false">label</span>', literalTagBytes],
      ["quoted-who.splitpage", '<span class="who-anchor" data-who="Mira > Nia" contenteditable="false">@Mira &gt; Nia</span>', literalWhoBytes]
    ]) {
      const reference = projectionReferences().find(reference => reference.name === file);
      assert.ok(reference);
      assert.equal(reference.appSaved.bytes, Buffer.byteLength(bytes as string));
      assert.equal(reference.appSaved.sha256, createHash("sha256").update(bytes as string).digest("hex"));
      assert.equal(records(reference.document.rows)[0]?.visualText, expected);
      const replica = fromDocument(reference.document, candidate);
      const other = new Y.Doc();
      try {
        Y.applyUpdate(other, Y.encodeStateAsUpdate(replica.doc));
        assert.equal(records(toDocument(other, candidate).rows)[0]?.visualText, expected);
        assert.equal(serializeProjection(toDocument(other, candidate)), bytes);
      } finally { replica.destroy(); other.destroy(); }
    }
  });

  test(`PROJ review: no unknown key name can change record prototypes ${candidate}`, () => {
    const reference = projectionReferences().find(reference => reference.name === "special-keys.splitpage");
    assert.ok(reference);
    const replica = fromDocument(reference.document, candidate);
    const other = new Y.Doc();
    try {
      Y.applyUpdate(other, Y.encodeStateAsUpdate(replica.doc));
      const document = toDocument(other, candidate);
      const comment = records(document.comments)[0] as Record<string, unknown>;
      for (const [kind, value] of [
        ["document", document], ["row", records(document.rows)[0]], ["comment", comment], ["reply", records(comment.replies)[0]],
        ["person", records(document.people)[0]], ["tag", records(document.productionTags)[0]], ["shot", records(document.brollShots)[0]]
      ] as const) {
        assert.ok(value);
        assert.equal(Object.hasOwn(value, "__proto__"), true, kind);
        assert.deepEqual(value["__proto__"], { kept: kind });
        assert.deepEqual(value["constructor"], [kind]);
        assert.equal(value["prototype"], kind);
        assert.equal(Object.getPrototypeOf(value), Object.prototype);
      }
      assert.deepEqual(document, reference.document);
    } finally { replica.destroy(); other.destroy(); }
  });

  test(`PROJ review: sanitized quoted attributes retain less-than, ampersands, both quotes and entities ${candidate}`, () => {
    const reference = projectionReferences().find(reference => reference.name === "attribute-cases.splitpage");
    assert.ok(reference);
    const expected = [
      '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="A < B" contenteditable="false">less</span>',
      '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="A &amp; B" contenteditable="false">amp</span>',
      '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="A &quot;B&quot;" contenteditable="false">double</span>',
      `<span class="tag-anchor" data-tag-cat="prop" data-tag-name="A 'B'" contenteditable="false">single</span>`,
      '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="A &amp;gt; B" contenteditable="false">entity text</span>',
      '<span class="who-anchor" data-who="Mira > 🎬" contenteditable="false">@Mira &gt; 🎬</span>',
      `<span class="who-anchor" data-who="Mira &quot;Q&quot; 'S' &amp; Nia < C > D" contenteditable="false">@Mira "Q" 'S' &amp; Nia &lt; C &gt; D</span>`,
      `<a href="https://example.com/?q=<>&amp;quote=&quot;&amp;apostrophe='" target="_blank" rel="noopener">link</a>`,
      '<span class="who-anchor" data-who="Mira Nia" contenteditable="false">@Mira Nia</span>'
    ];
    assert.deepEqual(records(reference.document.rows).map(row => row.visualText), expected);
    const replica = fromDocument(reference.document, candidate);
    const other = new Y.Doc();
    try {
      Y.applyUpdate(other, Y.encodeStateAsUpdate(replica.doc));
      assert.deepEqual(records(toDocument(other, candidate).rows).map(row => row.visualText), expected);
    } finally { replica.destroy(); other.destroy(); }
  });
}
