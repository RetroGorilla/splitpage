import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION } from "../js/00-prelude.js";
import { STATE_FIELDS, migrateRows } from "../js/02-state.js";
import { mergeStates } from "../js/03-sync.js";
import { saveAuthorName } from "../js/10-comments.js";
import {
  FIXED_ISO, assertGolden, freezeClockAndRandom, goldenNames, goldenText, jsonCopy, maskTokens, readGolden, updatingGoldens
} from "./golden-helpers.mjs";

freezeClockAndRandom(0x6d657267);

const EDITOR = "Merge Editor";
const DOC = "d" + "1".repeat(32);
const DOC_MINE = "d" + "2".repeat(32);
const DOC_THEIRS = "d" + "3".repeat(32);

const at = (day, hour) => "2026-02-" + String(day).padStart(2, "0") + "T" + String(hour || 9).padStart(2, "0") + ":00:00.000Z";
const tag = (cat, name, text) =>
  `<span class="tag-anchor" data-tag-cat="${cat}" data-tag-name="${name}" contenteditable="false">${text === undefined ? name : text}</span>`;
const key = (id, text) => `<span class="broll-key" data-broll-id="${id}" contenteditable="false">${text || "B-roll:"}</span>`;
const cue = (inner) => `<span class="audio-cue">${inner}</span>`;
const anchor = (id, inner) => `<span class="cmt-anchor" data-cmt="${id}">${inner}</span>`;
const dir = (text) => `<span class="stage-dir">${text}</span>`;
const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
const pic = (ch, w, h) => ({ sha256: ch.repeat(64), width: w || 640, height: h || 360, mime: "image/png" });
const video = (slug, poster) => (poster ? { href: "https://video.example/" + slug, poster: true } : { href: "https://video.example/" + slug });
const pen = () => ({ kind: "pen", color: "#e5383b", width: 0.01, points: [0.1, 0.1, 0.25, 0.3] });

function row(id, audioText, visualText, extra) {
  return Object.assign({
    id, status: "todo", visualText: visualText || "", audioText: audioText || "",
    imageRef: null, updatedAt: at(1), updatedBy: "Base Writer"
  }, extra || {});
}

function doc(over) {
  return Object.assign({
    schema: SCHEMA_VERSION, title: "Lighthouse", docId: DOC,
    rows: [row("r1", "Hello there.")], comments: [], people: [], productionTags: [], brollShots: [],
    wordsPerMinute: 150, rev: 4, lastEditedBy: "Base Writer", lastEditedAt: at(1)
  }, over || {});
}

const four = () => doc({ rows: [row("r1", "One."), row("r2", "Two."), row("r3", "Three."), row("r4", "Four.")] });

const find = (s, id) => s.rows.find((r) => r.id === id);
function stamp(r, who) {
  r.updatedAt = who === "mine" ? at(5, 10) : at(6, 11);
  r.updatedBy = who === "mine" ? "Mine Writer" : "Their Writer";
}
function edit(s, id, fields, who) {
  const r = find(s, id);
  Object.assign(r, fields);
  stamp(r, who);
}
const mineEdit = (s, id, fields) => edit(s, id, fields, "mine");
const theirEdit = (s, id, fields) => edit(s, id, fields, "theirs");
function moveRow(s, id, to) {
  const i = s.rows.findIndex((r) => r.id === id);
  const [r] = s.rows.splice(i, 1);
  s.rows.splice(to, 0, r);
}
function dropRow(s, id) { s.rows = s.rows.filter((r) => r.id !== id); }
function insertRow(s, afterId, r) {
  const i = afterId === null ? 0 : s.rows.findIndex((x) => x.id === afterId) + 1;
  s.rows.splice(i, 0, r);
}
const newRow = (id, audio, who, extra) => {
  const r = row(id, audio, "", extra);
  stamp(r, who);
  return r;
};

function cm(id, extra) {
  return Object.assign({
    id, rowId: "r1", field: "audioText", anchorId: id, quotedText: id, author: "Sam", body: "Look at " + id,
    resolved: false, resolvedBy: null, resolvedAt: null, assignee: "", kind: "anchor",
    createdAt: at(2), updatedAt: at(2), replies: []
  }, extra || {});
}
const reply = (id, when, author) => ({ id, body: "Reply " + id, author: author || "Sam", createdAt: when });
const findComment = (s, id) => s.comments.find((c) => c.id === id);
const dropComment = (s, id) => { s.comments = s.comments.filter((c) => c.id !== id); };

const commentRows = () => [
  row("r1", anchor("c1", "one") + " " + anchor("c2", "two") + " " + anchor("c3", "three") + " " + anchor("c4", "four")),
  row("r2", "Second row.")
];

const tagEntry = (id, cat, name, extra) => Object.assign({ id, cat, name, owner: "", notes: "", status: "needed" }, extra || {});
const shot = (id, name, extra) => Object.assign({
  id, name, desc: "", status: "unshot", reshoot: false, notes: "", owner: "", audioRef: "", location: "",
  props: [], origin: "script"
}, extra || {});

const CASES = [
  { name: "title-mine-only", spec: doc({ title: "Base title" }), mine: (s) => { s.title = "Mine title"; } },
  { name: "title-theirs-only", spec: doc({ title: "Base title" }), theirs: (s) => { s.title = "Their title"; } },
  {
    name: "title-both-changed", spec: doc({ title: "Base title" }),
    mine: (s) => { s.title = "Fish & Chips <3"; }, theirs: (s) => { s.title = "Their title"; }
  },
  {
    name: "title-both-same", spec: doc({ title: "Base title" }),
    mine: (s) => { s.title = "Agreed title"; }, theirs: (s) => { s.title = "Agreed title"; }
  },
  {
    name: "title-no-base", noBase: true, spec: doc({ title: "Base title" }),
    mine: (s) => { s.title = "Mine title"; }, theirs: (s) => { s.title = "Their title"; }
  },
  {
    name: "title-mine-cleared", spec: doc({ title: "Base title" }),
    mine: (s) => { s.title = ""; }, theirs: (s) => { s.title = "Their title"; }
  },

  { name: "doc-id-mine-changed", spec: doc(), mine: (s) => { s.docId = DOC_MINE; } },
  { name: "doc-id-theirs-changed", spec: doc(), theirs: (s) => { s.docId = DOC_THEIRS; } },
  {
    name: "doc-id-both-changed", spec: doc(),
    mine: (s) => { s.docId = DOC_MINE; }, theirs: (s) => { s.docId = DOC_THEIRS; }
  },
  {
    name: "doc-id-theirs-unreadable", spec: doc(), mine: (s) => { s.docId = DOC_MINE; },
    after: (d) => { d.theirs.docId = "not a document id"; }
  },
  {
    name: "doc-id-neither-readable", spec: doc(),
    after: (d) => { d.mine.docId = "mine?"; d.theirs.docId = ""; }
  },
  {
    name: "doc-id-no-base", noBase: true, spec: doc(),
    mine: (s) => { s.docId = DOC_MINE; }, theirs: (s) => { s.docId = DOC_THEIRS; }
  },

  { name: "words-per-minute-mine-only", spec: doc(), mine: (s) => { s.wordsPerMinute = 180; } },
  { name: "words-per-minute-theirs-only", spec: doc(), theirs: (s) => { s.wordsPerMinute = 200; } },
  {
    name: "words-per-minute-both-changed", spec: doc(),
    mine: (s) => { s.wordsPerMinute = 180; }, theirs: (s) => { s.wordsPerMinute = 200; }
  },
  {
    name: "words-per-minute-no-base", noBase: true, spec: doc(),
    mine: (s) => { s.wordsPerMinute = 180; }
  },
  {
    name: "revision-and-last-edited", spec: doc(),
    mine: (s) => { s.rev = 9; s.lastEditedBy = "Mine Writer"; s.lastEditedAt = at(5); },
    theirs: (s) => { s.rev = 6; s.lastEditedBy = "Their Writer"; s.lastEditedAt = at(6); }
  },
  {
    name: "last-edited-only-mine-knows", spec: doc(),
    mine: (s) => { s.rev = 2; s.lastEditedBy = "Mine Writer"; s.lastEditedAt = at(5); },
    after: (d) => { d.theirs.rev = undefined; d.theirs.lastEditedBy = null; d.theirs.lastEditedAt = ""; }
  },
  {
    name: "schema-from-other-versions", spec: doc(),
    after: (d) => { d.mine.schema = 1; d.theirs.schema = 3; }
  },

  {
    name: "person-colors-each-side", spec: doc({ personColors: { Sam: "#80BDFB", Ada: "#F9B64F" } }),
    mine: (s) => { s.personColors = { Sam: "#CBA1FA", Ada: "#F9B64F", Cy: "#64D1D7" }; },
    theirs: (s) => { s.personColors = { Sam: "#80BDFB", Bo: "#73D4AC" }; }
  },
  {
    name: "person-colors-both-changed-one-name", spec: doc({ personColors: { Sam: "#80BDFB" } }),
    mine: (s) => { s.personColors = { sam: "#F89DC9" }; },
    theirs: (s) => { s.personColors = { Sam: "#C8DE63" }; }
  },
  {
    name: "person-colors-theirs-only", spec: doc({ personColors: { Sam: "#80BDFB" } }),
    theirs: (s) => { s.personColors = { Sam: "#73D4AC" }; }
  },
  {
    name: "person-colors-removed-both-sides", spec: doc({ personColors: { Sam: "#80BDFB" } }),
    mine: (s) => { delete s.personColors; }, theirs: (s) => { delete s.personColors; }
  },

  { name: "target-length-mine-only", spec: doc({ targetSeconds: 300 }), mine: (s) => { s.targetSeconds = 420; } },
  { name: "target-length-theirs-cleared", spec: doc({ targetSeconds: 300 }), theirs: (s) => { delete s.targetSeconds; } },
  {
    name: "target-length-both-changed", spec: doc({ targetSeconds: 300 }),
    mine: (s) => { s.targetSeconds = 420; }, theirs: (s) => { s.targetSeconds = 360; }
  },
  { name: "target-length-no-base", noBase: true, spec: doc(), mine: (s) => { s.targetSeconds = 240; } },

  {
    name: "rows-insert-both-sides", spec: four(),
    mine: (s) => {
      insertRow(s, null, newRow("rM0", "Mine first.", "mine"));
      insertRow(s, "r2", newRow("rM2", "Mine after two.", "mine"));
    },
    theirs: (s) => {
      insertRow(s, "r1", newRow("rT1", "Theirs after one.", "theirs"));
      s.rows.push(newRow("rT9", "Theirs last.", "theirs"));
    }
  },
  { name: "rows-delete-both-sides", spec: four(), mine: (s) => dropRow(s, "r2"), theirs: (s) => dropRow(s, "r4") },
  { name: "rows-delete-same-row", spec: four(), mine: (s) => dropRow(s, "r3"), theirs: (s) => dropRow(s, "r3") },
  { name: "rows-move-mine", spec: four(), mine: (s) => moveRow(s, "r4", 0) },
  { name: "rows-move-theirs", spec: four(), theirs: (s) => moveRow(s, "r1", 3) },
  {
    name: "rows-move-and-edit-both", spec: four(),
    mine: (s) => { moveRow(s, "r4", 0); mineEdit(s, "r4", { audioText: "Four, mine." }); },
    theirs: (s) => { moveRow(s, "r3", 1); theirEdit(s, "r2", { visualText: "Two, their visual." }); }
  },
  {
    name: "rows-mine-deleted-theirs-edited", spec: four(),
    mine: (s) => { dropRow(s, "r2"); dropRow(s, "r3"); },
    theirs: (s) => theirEdit(s, "r2", { audioText: "Two, theirs." })
  },
  {
    name: "rows-theirs-deleted-mine-edited", spec: four(),
    mine: (s) => {
      mineEdit(s, "r3", { audioText: "Three, mine." });
      insertRow(s, "r3", newRow("rM", "Mine after three.", "mine"));
    },
    theirs: (s) => { dropRow(s, "r3"); dropRow(s, "r4"); }
  },
  {
    name: "rows-no-base", noBase: true, spec: four(),
    mine: (s) => { dropRow(s, "r4"); insertRow(s, "r1", newRow("rM", "Mine new.", "mine")); },
    theirs: (s) => { dropRow(s, "r2"); theirEdit(s, "r3", { audioText: "Three, theirs." }); }
  },
  {
    name: "rows-status-and-length",
    spec: doc({
      rows: [
        row("r1", "One."), row("r2", "Two.", "", { status: "ready", lengthSeconds: 12 }),
        row("r3", "Three.", "", { status: "shot", lengthSeconds: 30 }), row("r4", "Four."),
        row("r5", "Five.", "", { lengthSeconds: 8 })
      ]
    }),
    mine: (s) => {
      find(s, "r1").status = "shot";
      mineEdit(s, "r2", { lengthSeconds: 20 });
      delete find(s, "r3").lengthSeconds;
      find(s, "r4").status = "ready";
      mineEdit(s, "r5", { lengthSeconds: 10 });
    },
    theirs: (s) => {
      find(s, "r1").status = "ready";
      theirEdit(s, "r4", { lengthSeconds: 45 });
      theirEdit(s, "r5", { lengthSeconds: 15 });
    }
  },
  {
    name: "rows-picture",
    spec: doc({
      rows: [
        row("r1", "One.", "", { imageRef: pic("a") }), row("r2", "Two.", "", { imageRef: pic("b") }),
        row("r3", "Three.", "", { imageRef: pic("c") }), row("r4", "Four.", "", { imageRef: pic("d"), imageName: "four.png" })
      ]
    }),
    mine: (s) => {
      mineEdit(s, "r1", {
        imageRef: pic("e", 800, 600), imageName: "mine.png",
        imageAnnotation: { imageRef: pic("f", 800, 600), marks: [pen()] }
      });
      mineEdit(s, "r3", { imageRef: pic("1") });
      mineEdit(s, "r4", { imageRef: null });
    },
    theirs: (s) => {
      theirEdit(s, "r2", { imageRef: pic("2") });
      theirEdit(s, "r3", { imageRef: pic("3") });
      theirEdit(s, "r4", { imageRef: pic("4") });
    }
  },
  {
    name: "rows-gallery-links",
    spec: doc({
      rows: [
        row("r1", "One.", "", { imageRef: pic("a"), imageLinks: [video("one"), video("two")] }),
        row("r2", "Two.", "", { imageRef: pic("b") }),
        row("r3", "Three.", "", { imageLinks: [video("three", true)] })
      ]
    }),
    mine: (s) => {
      mineEdit(s, "r1", { imageLinks: [video("two"), video("mine")] });
      mineEdit(s, "r2", { imageLinks: [video("mine-two")] });
    },
    theirs: (s) => {
      theirEdit(s, "r1", { imageLinks: [video("one"), video("two"), video("theirs")] });
      theirEdit(s, "r3", { imageLinks: [video("three", true), video("extra")] });
    }
  },
  {
    name: "rows-gallery-more-images",
    spec: doc({
      rows: [row("r1", "One.", "", {
        imageRef: pic("a"),
        moreImages: [
          { imageRef: pic("b"), name: "b.png" },
          { imageRef: pic("c"), links: [video("c-one")] },
          { links: [video("clip", true)] }
        ]
      })]
    }),
    mine: (s) => {
      const r = find(s, "r1");
      r.moreImages = [
        { imageRef: pic("c"), links: [video("c-one"), video("c-mine")] },
        { links: [video("clip", true)] },
        { imageRef: pic("d"), name: "d.png" }
      ];
      stamp(r, "mine");
    },
    theirs: (s) => {
      const r = find(s, "r1");
      r.moreImages = [
        { imageRef: pic("b"), name: "b.png" },
        { imageRef: pic("c"), links: [video("c-one"), video("c-theirs")] },
        { links: [video("clip", true), video("clip-extra")] },
        { imageRef: pic("e") }
      ];
      stamp(r, "theirs");
    }
  },

  {
    name: "text-one-side-each",
    spec: doc({
      rows: [
        row("r1", "Alpha beta gamma.", "Wide shot."), row("r2", "Delta epsilon.", "Close up."),
        row("r3", "Zeta eta.", "Insert.")
      ]
    }),
    mine: (s) => { mineEdit(s, "r1", { audioText: "Alpha BETA gamma." }); mineEdit(s, "r3", { visualText: "Insert, slow." }); },
    theirs: (s) => { theirEdit(s, "r2", { visualText: "Close up, handheld." }); theirEdit(s, "r3", { audioText: "Zeta eta theta." }); }
  },
  {
    name: "text-both-sides-merged",
    spec: doc({
      rows: [
        row("r1", "the cat sat on the mat"), row("r2", "a quick brown fox"), row("r3", "one two three"),
        row("r4", "", "Line one<br>Line two<br>Line three")
      ]
    }),
    mine: (s) => {
      mineEdit(s, "r1", { audioText: "the dog sat on the mat" });
      mineEdit(s, "r2", { audioText: "a <strong>quick</strong> brown fox" });
      mineEdit(s, "r3", { audioText: "one <strong>two</strong> three" });
      mineEdit(s, "r4", { visualText: "Line one, mine<br>Line two<br>Line three" });
    },
    theirs: (s) => {
      theirEdit(s, "r1", { audioText: "the cat sat on the rug" });
      theirEdit(s, "r2", { audioText: "a quick brown dog" });
      theirEdit(s, "r3", { audioText: "one <em>two</em> three" });
      theirEdit(s, "r4", { visualText: "Line one<br>Line two<br>Line three, theirs" });
    }
  },
  {
    name: "text-both-sides-conflict",
    spec: doc({ rows: [row("r1", "the cat sat on the mat"), row("r2", "Steady.", "Wide on the harbour")] }),
    mine: (s) => {
      mineEdit(s, "r1", { audioText: "the dog sat on the mat, <strong>twice</strong>" });
      mineEdit(s, "r2", { visualText: "Tight on the harbour" });
    },
    theirs: (s) => {
      theirEdit(s, "r1", { audioText: "the cow sat on the mat" });
      theirEdit(s, "r2", { visualText: "Drone on the harbour" });
    }
  },
  {
    name: "text-link-conflict-with-other-edits",
    spec: doc({ rows: [row("r1", "see the docs for more"), row("r2", "second scene")] }),
    mine: (s) => {
      mineEdit(s, "r1", { audioText: "look at the " + link("https://mine.example/", "docs") + " for more" });
      mineEdit(s, "r2", { audioText: "second scene, mine" });
    },
    theirs: (s) => theirEdit(s, "r1", { audioText: "see the " + link("https://theirs.example/", "docs") + " for less" })
  },
  {
    name: "text-unicode-and-atoms",
    spec: doc({
      rows: [
        row("r1", "Café 🎬 opens at 𝟗 — naïve crew. 東京 and עברית.",
          key("bsA") + " gulls over the pier<br>" + tag("prop", "Kettle", "kettle") + " on the hob 🔥"),
        row("r2", "Hi.<br>" + cue("SFX: door slam") + "<br>" + anchor("c1", "Then") + " we go " + dir("beat") + " home."),
        row("r3", "Score: 𝄞 one"),
        row("r4", "Put the red mug on the tabel", "a b c​d")
      ],
      comments: [cm("c1", { rowId: "r2", quotedText: "Then" })]
    }),
    mine: (s) => {
      mineEdit(s, "r1", {
        audioText: "Café 🎬 starts at 𝟗 — naïve crew. 東京 and עברית.",
        visualText: key("bsA") + " terns over the pier<br>" + tag("prop", "Kettle", "kettle") + " on the hob 🔥"
      });
      mineEdit(s, "r2", { audioText: "Hi.<br>" + cue("SFX: door slam") + "<br>" + anchor("c1", "Then") + " we go " + dir("beat") + " inside." });
      mineEdit(s, "r3", { audioText: "Score: 𝄞 two" });
      mineEdit(s, "r4", {
        audioText: "Put the " + tag("prop", "red mug") + " on the tabel",
        visualText: "a b c​d e"
      });
    },
    theirs: (s) => {
      theirEdit(s, "r1", {
        audioText: "Café 🎬 opens at 𝟗 — brave crew. 東京 and עברית.",
        visualText: key("bsA") + " gulls over the pier<br>" + tag("prop", "Kettle", "kettle") + " on the stove 🔥"
      });
      theirEdit(s, "r2", { audioText: "Hi.<br>" + cue("SFX: door slams") + "<br>" + anchor("c1", "Then") + " we go " + dir("beat") + " home." });
      theirEdit(s, "r3", { audioText: "Score: 𝄞 three" });
      theirEdit(s, "r4", { audioText: "Put the red mug on the table", visualText: "A b c​d" });
    }
  },
  {
    name: "text-tag-renamed-and-cell-edited",
    spec: doc({ rows: [row("r1", "Pour the " + tag("prop", "Mug", "mug") + " out now")] }),
    mine: (s) => {
      s.productionTags = [tagEntry("t_mugcup", "prop", "Cup")];
      mineEdit(s, "r1", { audioText: "Pour the " + tag("prop", "Cup", "mug") + " out now" });
    },
    theirs: (s) => theirEdit(s, "r1", { audioText: "Pour the " + tag("prop", "Mug", "mug") + " out slowly" }),
    after: (d) => { d.base.productionTags[0].id = "t_mugcup"; d.theirs.productionTags[0].id = "t_mugcup"; }
  },
  {
    name: "text-different-tags-on-one-word",
    spec: doc({ rows: [row("r1", "pour the mug out now")] }),
    mine: (s) => mineEdit(s, "r1", { audioText: "pour the " + tag("prop", "Mug", "mug") + " out now" }),
    theirs: (s) => theirEdit(s, "r1", { audioText: "pour the " + tag("prop", "Cup", "mug") + " out now" })
  },
  {
    name: "text-no-base", noBase: true,
    spec: doc({ rows: [row("r1", "one two"), row("r2", "same"), row("r3", "gone")] }),
    mine: (s) => mineEdit(s, "r1", { audioText: "one 2" }),
    theirs: (s) => theirEdit(s, "r3", { audioText: "" })
  },

  {
    name: "comments-edited-both-sides",
    spec: doc({
      rows: commentRows(),
      comments: [cm("c1"), cm("c2"), cm("c3"), cm("cTitle", { field: "title", rowId: null, anchorId: null, quotedText: "" })]
    }),
    mine: (s) => {
      Object.assign(findComment(s, "c1"), {
        resolved: true, resolvedBy: "Sam", resolvedAt: at(5), assignee: "Ada", updatedAt: at(5),
        replies: [reply("rpM", at(3))]
      });
      Object.assign(findComment(s, "c2"), { resolved: true, resolvedBy: "Sam", resolvedAt: at(7), updatedAt: at(7) });
      Object.assign(findComment(s, "c3"), { body: "Mine body", updatedAt: at(8) });
      Object.assign(findComment(s, "cTitle"), { body: "Title, mine", updatedAt: at(4) });
    },
    theirs: (s) => {
      Object.assign(findComment(s, "c1"), { body: "Look at c1, edited", updatedAt: at(6), replies: [reply("rpT", at(4), "Bo")] });
      Object.assign(findComment(s, "c2"), { resolved: true, resolvedBy: "Bo", resolvedAt: at(8), updatedAt: at(8) });
      Object.assign(findComment(s, "c3"), { body: "Their body", updatedAt: at(7) });
      Object.assign(findComment(s, "cTitle"), { assignee: "Bo", updatedAt: at(3) });
    }
  },
  {
    name: "comments-deleted-and-added",
    spec: doc({ rows: commentRows(), comments: [cm("c1"), cm("c2"), cm("c3"), cm("c4")] }),
    mine: (s) => {
      dropComment(s, "c1");
      dropComment(s, "c2");
      Object.assign(findComment(s, "c4"), { resolved: true, resolvedBy: "Sam", resolvedAt: at(5), updatedAt: at(5) });
      s.comments.push(cm("cM", { rowId: "r2", anchorId: null, body: "Mine new", createdAt: at(5), updatedAt: at(5) }));
    },
    theirs: (s) => {
      findComment(s, "c2").replies = [reply("rpT", at(6), "Bo")];
      dropComment(s, "c3");
      dropComment(s, "c4");
      s.comments.push(cm("cT", { rowId: "r2", anchorId: null, body: "Their new", createdAt: at(6), updatedAt: at(6) }));
      s.comments.push(cm("cX", {
        kind: "conflict", anchorId: null, quotedText: "", body: "an older unmerged edit", conflictField: "Audio",
        emptyValue: false, createdAt: at(4), updatedAt: at(4)
      }));
    }
  },
  {
    name: "comments-anchor-moved",
    spec: doc({
      rows: [row("r1", anchor("c1", "moving words") + " stay."), row("r2", "Second row.")],
      comments: [cm("c1", { quotedText: "moving words" })]
    }),
    mine: (s) => { Object.assign(findComment(s, "c1"), { body: "Look again", updatedAt: at(5) }); },
    theirs: (s) => {
      theirEdit(s, "r1", { audioText: "stay." });
      theirEdit(s, "r2", { audioText: "Second row. " + anchor("c1", "moving words") });
    }
  },
  {
    name: "comments-no-base", noBase: true,
    spec: doc({ rows: commentRows(), comments: [cm("c1")] }),
    mine: (s) => {
      Object.assign(findComment(s, "c1"), { resolved: true, resolvedBy: "Sam", resolvedAt: at(5), updatedAt: at(5) });
      s.comments.push(cm("cM", { rowId: "r2", anchorId: null, createdAt: at(5), updatedAt: at(5) }));
    },
    theirs: (s) => {
      Object.assign(findComment(s, "c1"), { body: "Look at c1, edited", updatedAt: at(6) });
      s.comments.push(cm("cT", { rowId: "r2", anchorId: null, createdAt: at(6), updatedAt: at(6) }));
    }
  },

  {
    name: "people-each-side",
    spec: doc({
      people: [{ id: "p1", name: "Sam" }, { id: "p2", name: "Ada" }, { id: "p3", name: "Cy" }],
      productionTags: [tagEntry("t_kettle", "prop", "Kettle", { owner: "p3" })]
    }),
    mine: (s) => {
      s.people = s.people.filter((p) => p.id !== "p2");
      s.people.find((p) => p.id === "p3").name = "Cyril";
      s.people.push({ id: "p4", name: "Bo" });
      s.productionTags.push(tagEntry("t_ladder", "prop", "Ladder", { owner: "p4" }));
    },
    theirs: (s) => {
      s.people.push({ id: "p5", name: "bo" });
      s.people.push({ id: "p6", name: "Dee" });
    }
  },
  {
    name: "production-tags-each-side",
    spec: doc({
      people: [{ id: "p1", name: "Sam" }],
      productionTags: [
        tagEntry("t_kettle", "prop", "Kettle"), tagEntry("t_pier", "location", "Pier"),
        tagEntry("t_mug", "prop", "Mug"), tagEntry("t_lamp", "prop", "Lamp")
      ]
    }),
    mine: (s) => {
      s.productionTags.find((t) => t.id === "t_kettle").name = "Copper kettle";
      s.productionTags = s.productionTags.filter((t) => t.id !== "t_pier");
      s.productionTags.find((t) => t.id === "t_mug").notes = "chipped";
      s.productionTags.find((t) => t.id === "t_lamp").cat = "gear";
      s.productionTags.push(tagEntry("t_mineladder", "prop", "Ladder", { owner: "p1", notes: "6 ft" }));
    },
    theirs: (s) => {
      Object.assign(s.productionTags.find((t) => t.id === "t_kettle"), { status: "have", owner: "p1" });
      s.productionTags = s.productionTags.filter((t) => t.id !== "t_mug");
      s.productionTags.push(tagEntry("t_theirladder", "prop", "ladder", { status: "sourcing" }));
      s.productionTags.push(tagEntry("t_tripod", "gear", "Tripod", { status: "returned" }));
    }
  },
  {
    name: "production-tags-no-base", noBase: true,
    spec: doc({ people: [{ id: "p1", name: "Sam" }] }),
    mine: (s) => { s.productionTags = [tagEntry("", "prop", "Kettle", { owner: "p1" }), tagEntry("t_pier", "location", "Pier")]; },
    theirs: (s) => { s.productionTags = [tagEntry("", "prop", "kettle", { status: "have", notes: "copper" })]; }
  },
  {
    name: "broll-shots-each-side",
    spec: doc({
      people: [{ id: "p1", name: "Sam" }],
      productionTags: [tagEntry("t_kettle", "prop", "Kettle"), tagEntry("t_ladder", "prop", "Ladder")],
      brollShots: [
        shot("b1", "Gulls", { props: [{ id: "t_kettle", name: "Kettle" }] }), shot("b2", "Pier"), shot("b3", "Drone")
      ]
    }),
    mine: (s) => {
      Object.assign(s.brollShots[0], {
        owner: "p1", notes: "wide", location: "Harbour",
        props: [{ id: "t_kettle", name: "Kettle" }, { id: "t_ladder", name: "Ladder" }]
      });
      s.brollShots = s.brollShots.filter((b) => b.id !== "b2");
      s.brollShots.find((b) => b.id === "b3").notes = "at dusk";
      s.brollShots.push(shot("b4", "Mine shot", { origin: "list" }));
    },
    theirs: (s) => {
      Object.assign(s.brollShots[0], { status: "shot", reshoot: true, props: [] });
      s.brollShots = s.brollShots.filter((b) => b.id !== "b3");
      s.brollShots.push(shot("b5", "Their shot", { audioRef: "Waves." }));
    }
  },
  {
    name: "broll-props-edges",
    spec: doc({
      productionTags: [tagEntry("t_kettle", "prop", "Kettle")],
      brollShots: [
        shot("b1", "No list yet"), shot("b2", "Named only", { props: [{ id: "t_kettle", name: "Kettle" }] }),
        shot("b3", "Many")
      ]
    }),
    mine: (s) => {
      s.brollShots[0].props = [{ id: "t_kettle", name: "Kettle" }];
      s.brollShots[1].props = [{ id: "", name: "kettle" }, { id: "", name: "Tripod" }];
      s.brollShots[2].props = Array.from({ length: 15 }, (_, i) => ({ id: "", name: "Mine prop " + (i + 1) }));
    },
    theirs: (s) => {
      s.brollShots[0].props = [{ id: "", name: "Kettle" }];
      s.brollShots[2].props = Array.from({ length: 30 }, (_, i) => ({ id: "", name: "Their prop " + (i + 1) }));
    },
    after: (d) => { delete d.base.brollShots[0].props; }
  },

  {
    name: "editor-anonymous", editor: "", spec: four(),
    mine: (s) => { mineEdit(s, "r1", { audioText: "One, mine." }); mineEdit(s, "r2", { audioText: "Two, mine." }); },
    theirs: (s) => theirEdit(s, "r2", { audioText: "Two, theirs." })
  }
];

function inputsOf(c) {
  const side = (fn) => {
    const s = jsonCopy(c.spec);
    if (fn) fn(s);
    return migrateRows(s);
  };
  const docs = { base: side(c.base), mine: side(c.mine), theirs: side(c.theirs) };
  if (c.after) c.after(docs);
  if (c.noBase) docs.base = null;
  return jsonCopy(docs);
}

function produce(c, inputs) {
  saveAuthorName(c.editor === undefined ? EDITOR : c.editor);
  const args = jsonCopy(inputs);
  const before = JSON.stringify(args);
  const res = mergeStates(args.base, args.mine, args.theirs);
  const inputsUntouched = JSON.stringify(args) === before;
  const out = jsonCopy({ merged: res.merged, conflicts: res.conflicts, stats: res.stats });

  const docs = [inputs.base, inputs.mine, inputs.theirs].filter(Boolean);
  const known = new Set(docs.flatMap((d) => d.comments.map((x) => x.id)));
  const cards = out.merged.comments.filter((x) => !known.has(x.id));
  cards.forEach((x) => {
    assert.equal(x.kind, "conflict", "only conflict cards are new: " + x.id);
    assert.match(x.id, /^c[0-9a-z]+$/);
  });
  assert.equal(cards.length, out.conflicts.length, "one new card per conflict");
  assert.equal(new Set(cards.map((x) => x.id)).size, cards.length, "every card has an id of its own");
  let masked = maskTokens(out, cards.map((x) => x.id), "minted-comment-id");

  if (!docs.some((d) => d.docId === out.merged.docId)) {
    assert.match(out.merged.docId, /^d[0-9a-f]{32}$/);
    masked = maskTokens(masked, [out.merged.docId], "minted-doc-id");
  }
  return Object.assign({ inputs, inputsUntouched }, masked);
}

test("the clock, the random source and the editor are fixed for every case", () => {
  assert.equal(new Date().toISOString(), FIXED_ISO);
  assert.equal(new Set(CASES.map((c) => c.name)).size, CASES.length, "case names are unique");
});

for (const c of CASES) {
  test("merge golden: " + c.name, () => {
    const name = "merge-" + c.name;
    const built = inputsOf(c);
    if (updatingGoldens("merge")) {
      assertGolden(name, produce(c, built));
      return;
    }
    const stored = readGolden(name);
    assert.equal(goldenText(built), goldenText(stored.inputs),
      name + ": the case builds the inputs its fixture recorded, key order included");
    assertGolden(name, produce(c, stored.inputs));
  });
}

test("every STATE_FIELDS key is changed by each side in at least one merge fixture", () => {
  const changedBy = { mine: new Set(), theirs: new Set() };
  const val = (d, k) => JSON.stringify(d ? d[k] : undefined);
  for (const name of goldenNames("merge-")) {
    const { inputs } = readGolden(name);
    for (const f of STATE_FIELDS) {
      for (const side of ["mine", "theirs"]) {
        const other = inputs.base || inputs[side === "mine" ? "theirs" : "mine"];
        if (val(inputs[side], f.key) !== val(other, f.key)) changedBy[side].add(f.key);
      }
    }
  }
  const keys = STATE_FIELDS.map((f) => f.key);
  assert.deepEqual(keys.filter((k) => !changedBy.mine.has(k)), [], "keys no fixture changes on my side");
  assert.deepEqual(keys.filter((k) => !changedBy.theirs.has(k)), [], "keys no fixture changes on their side");
});

test("every merge fixture belongs to a case, and every case has one", () => {
  assert.deepEqual(goldenNames("merge-"), CASES.map((c) => "merge-" + c.name).sort());
});
