import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";

await bootApp();

const { migrateRows } = await import("../js/02-state.js");
const { render } = await import("../js/05-render.js");
const { applyTag, findOrAddPerson, openTagComposer, registerProductionTag, renameTag } = await import("../js/07-production-tags.js");
const { plainTagPhrase } = await import("../js/07b-plain-tags.js");
const { addBrollProp } = await import("../js/08c-broll.js");
const { closeBrollPanel, openBrollPanel } = await import("../js/08d-broll-panel.js");
const { COMMENT_NAME_KEY, renderComments, setCommentAssignee } = await import("../js/10-comments.js");
const { PERSON_COLOR_KEY, writePref } = await import("../js/00p-prefs.js");
const { recordMyColor } = await import("../js/13a-presence.js");
const { maybeAskGuestName } = await import("../js/13b-collaborate.js");
const { PERSON_COLORS } = await import("../core/document/person-colors.ts");

after(closeApp);

const GRIN = String.fromCodePoint(0x1F600);
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const x = (n) => "x".repeat(n);
const ACROSS = { typed: (cap) => x(cap - 1) + GRIN + " tail", kept: (cap) => x(cap - 1) + GRIN };
const AFTER_SPACE = { typed: (cap) => x(cap - 1) + " y", kept: (cap) => x(cap - 1) };
const CASES = [["an emoji across the cap", ACROSS], ["a cut that lands after a space", AFTER_SPACE]];

function load(extra) {
  S.state = migrateRows(Object.assign({
    schema: 2, title: "Names",
    rows: [
      { id: "r1", status: "todo", audioText: "the mug and the mug", visualText: '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> Old shot' },
      { id: "r2", status: "todo", audioText: "", visualText: "" }
    ],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", anchorId: "c1", quotedText: "mug", author: "Ann", body: "x", createdAt: "2026-10-01T10:00:00Z", kind: "anchor", replies: [] }],
    people: [],
    productionTags: [{ cat: "prop", name: "Kettle" }],
    brollShots: [
      { id: "bs1", name: "Old shot", origin: "script" },
      { id: "bs2", name: "Listed shot", origin: "list" }
    ]
  }, extra || {}));
  render();
}

function panel() { return document.getElementById("broll-panel"); }
function click(sel) {
  const el = panel().querySelector(sel);
  assert.ok(el, "no " + sel);
  el.click();
}
function expand(id) {
  if (!panel().querySelector('.broll-card[data-id="' + id + '"]')) click('.broll-row-main[data-id="' + id + '"]');
  assert.ok(panel().querySelector('.broll-card[data-id="' + id + '"]'), id + " is open");
}
function enter(el) { el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); }
function shot(id) { return S.state.brollShots.filter((b) => b.id === id)[0]; }

for (const [what, c] of CASES) {
  test("07 findOrAddPerson: " + what + " (#344, #419)", () => {
    load();
    const id = findOrAddPerson(c.typed(60));
    assert.equal(S.state.people.filter((p) => p.id === id)[0].name, c.kept(60));
  });

  test("07 renameTag: " + what + " (#344, #419)", () => {
    load();
    assert.ok(renameTag("prop", "Kettle", c.typed(80)));
    assert.deepEqual(S.state.productionTags.map((t) => t.name), [c.kept(80)]);
  });

  test("07 applyTag, the tag composer's name: " + what + " (#344, #419)", () => {
    load();
    openTagComposer({ quotedText: "mug", cat: "prop", rowId: "r1", field: "audioText", occurrenceIndex: 0 });
    document.getElementById("tag-name").value = c.typed(80);
    document.getElementById("tag-all").checked = true;
    applyTag();
    assert.ok(S.state.productionTags.some((t) => t.name === c.kept(80)), JSON.stringify(S.state.productionTags.map((t) => t.name)));
    assert.equal(S.state.rows[0].audioText.split('data-tag-name="' + c.kept(80) + '"').length, 3);
  });

  test("07b plainTagPhrase: " + what + " (#344, #419)", () => {
    assert.equal(plainTagPhrase(" " + c.typed(80)).name, c.kept(80));
  });

  test("08c addBrollProp: " + what + " (#344, #419)", () => {
    load();
    assert.ok(addBrollProp("bs2", c.typed(80)));
    assert.deepEqual(shot("bs2").props.map((p) => p.name), [c.kept(80)]);
    assert.ok(S.state.productionTags.some((t) => t.cat === "prop" && t.name === c.kept(80)));
  });

  test("08d the b-roll panel's new shot: " + what + " (#344, #419)", () => {
    load();
    openBrollPanel();
    document.getElementById("broll-add-input").value = c.typed(200);
    document.getElementById("broll-add-save").click();
    assert.ok(S.state.brollShots.some((b) => b.origin === "list" && b.name === c.kept(200)), JSON.stringify(S.state.brollShots.map((b) => b.name)));
    closeBrollPanel();
  });

  test("08d a shot's location: " + what + " (#344, #419)", () => {
    load();
    openBrollPanel();
    expand("bs2");
    click('[data-action="broll-loc-edit"][data-id="bs2"]');
    const box = panel().querySelector('.broll-loc-input[data-id="bs2"]');
    box.value = c.typed(80);
    enter(box);
    assert.equal(shot("bs2").location, c.kept(80));
    closeBrollPanel();
  });

  test("08d the selected shots' location: " + what + " (#344, #419)", () => {
    load();
    openBrollPanel();
    if (!panel().querySelector("#broll-bulk-location")) {
      panel().querySelector('.broll-row-main[data-id="bs2"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    }
    const pick = panel().querySelector("#broll-bulk-location");
    assert.ok(pick, "the bulk bar shows");
    pick.value = "__new__";
    pick.dispatchEvent(new window.Event("change", { bubbles: true }));
    document.getElementById("broll-bulk-input").value = c.typed(80);
    click('[data-action="broll-bulk-input-save"]');
    assert.equal(shot("bs2").location, c.kept(80));
    click('[data-action="broll-bulk-clear"]');
    closeBrollPanel();
  });

  test("08d renaming a script shot: " + what + " (#344, #419)", () => {
    load();
    openBrollPanel();
    expand("bs1");
    click('[data-action="broll-menu"][data-id="bs1"]');
    click('[data-action="broll-rename"][data-id="bs1"]');
    panel().querySelector('.broll-rename-input[data-id="bs1"]').value = c.typed(200);
    click('[data-action="broll-rename-save"][data-id="bs1"]');
    const text = new window.DOMParser().parseFromString(S.state.rows[0].visualText, "text/html").body.textContent;
    assert.equal(text, "B-roll: " + c.kept(200));
    closeBrollPanel();
  });

  test("10 setCommentAssignee: " + what + " (#344, #419)", () => {
    load();
    setCommentAssignee("c1", c.typed(80));
    assert.equal(S.state.comments[0].assignee, c.kept(80));
  });

  test("13b the guest's name: " + what + " (#344, #419)", () => {
    load();
    writePref(COMMENT_NAME_KEY, null);
    sessionStorage.clear();
    assert.ok(maybeAskGuestName());
    document.getElementById("guest-name").value = c.typed(30);
    document.querySelector('#guest-modal [data-guest-action="save"]').click();
    assert.equal(localStorage.getItem(COMMENT_NAME_KEY), c.kept(30));
  });
}

test("13a my colour is recorded under my name cut by code point (#344)", () => {
  load();
  writePref(COMMENT_NAME_KEY, x(29) + GRIN + "y");
  writePref(PERSON_COLOR_KEY, PERSON_COLORS[1]);
  const state = { personColors: null };
  assert.ok(recordMyColor(state));
  assert.deepEqual(state.personColors, { [x(29) + GRIN]: PERSON_COLORS[1] });
});

const OLD_CUTS = [
  ["half an emoji", (n) => x(n - 1) + "\uD83D", (n) => x(n - 1) + GRIN + " tail", (n) => x(n - 1) + GRIN],
  ["whole emoji only", (n) => GRIN.repeat(n / 2), (n) => GRIN.repeat(n), (n) => GRIN.repeat(n)]
];

function migrated(doc) {
  S.state = migrateRows(Object.assign({ schema: 2, title: "Old cuts", comments: [], people: [{ id: "p1", name: "Ann" }], productionTags: [], brollShots: [] }, doc));
  render();
}

for (const [what, stored, line, whole] of OLD_CUTS) {
  test("a sound cue whose tag an older build cut by UTF-16 unit stays one tag, keeping its owner and notes: " + what + " (#344)", () => {
    migrated({
      rows: [{ id: "r1", status: "todo", audioText: '<span class="audio-cue">SFX: ' + line(80) + "</span>", visualText: "" }],
      productionTags: [{ id: "t_old1", cat: "sound", name: stored(80), status: "have", owner: "p1", notes: "keep me" }]
    });
    const sound = S.state.productionTags.filter((t) => t.cat === "sound");
    assert.deepEqual(sound.map((t) => [t.id, t.name, t.status, t.owner, t.notes]), [["t_old1", whole(80), "have", "p1", "keep me"]]);
  });

  test("an unkeyed B-roll line whose shot an older build cut by UTF-16 unit stays one shot, keeping its notes: " + what + " (#344)", () => {
    migrated({
      rows: [{ id: "r1", status: "todo", audioText: "", visualText: "B-roll: " + line(200) }],
      brollShots: [{ id: "bs1", name: stored(200), notes: "keep me", status: "shot", origin: "script" }]
    });
    assert.deepEqual(S.state.brollShots.map((b) => [b.id, b.name, b.notes, b.status]), [["bs1", whole(200), "keep me", "shot"]]);
  });
}

test("a sound cue whose text differs from its tag only in case leaves the tag's stored casing alone (#344)", () => {
  migrated({
    rows: [{ id: "r1", status: "todo", audioText: '<span class="audio-cue">SFX: door slam ' + x(70) + "</span>", visualText: "" }],
    productionTags: [{ id: "t_old1", cat: "sound", name: "DOOR SLAM " + x(70), status: "have", owner: "p1", notes: "keep me" }]
  });
  const sound = S.state.productionTags.filter((t) => t.cat === "sound");
  assert.deepEqual(sound.map((t) => [t.id, t.name, t.status, t.owner, t.notes]), [["t_old1", "DOOR SLAM " + x(70), "have", "p1", "keep me"]]);
});

const HALF_INSIDE = [
  ["one half", (n) => x(n - 2) + "\uD83D y", (n) => x(n - 2) + "\uD83D", (n) => x(n - 2) + " y"],
  ["two halves, so the name is now under the cap", (n) => x(n - 4) + "\uD83D\uD83D yz", (n) => x(n - 4) + "\uD83D\uD83D y", (n) => x(n - 4) + " yz"]
];

for (const [what, line, stored, now] of HALF_INSIDE) {
  test("a cue whose old text held a lone half inside its cut stays one tag once the half is dropped: " + what + " (#344)", () => {
    migrated({
      rows: [{ id: "r1", status: "todo", audioText: '<span class="audio-cue">SFX: ' + line(80) + "</span>", visualText: "" }],
      productionTags: [{ id: "t_old1", cat: "sound", name: stored(80), status: "have", owner: "p1", notes: "keep me" }]
    });
    const sound = S.state.productionTags.filter((t) => t.cat === "sound");
    assert.deepEqual(sound.map((t) => [t.id, t.name, t.owner, t.notes]), [["t_old1", now(80), "p1", "keep me"]]);
  });

  test("an unkeyed B-roll line whose old text held a lone half inside its cut stays one shot: " + what + " (#344)", () => {
    migrated({
      rows: [{ id: "r1", status: "todo", audioText: "", visualText: "B-roll: " + line(200) }],
      brollShots: [{ id: "bs1", name: stored(200), notes: "keep me", status: "shot", origin: "script" }]
    });
    assert.deepEqual(S.state.brollShots.map((b) => [b.id, b.name, b.notes]), [["bs1", now(200), "keep me"]]);
  });
}

test("a cue that its own tag's heal already matches renames no other broken tag (#344)", () => {
  migrated({
    rows: [{ id: "r1", status: "todo", audioText: '<span class="audio-cue">SFX: ' + x(78) + "g\uD83D y</span>", visualText: "" }],
    productionTags: [
      { id: "t_old1", cat: "sound", name: x(78) + "\uD83D", notes: "one" },
      { id: "t_old2", cat: "sound", name: x(78) + "g\uD83D", notes: "two" }
    ]
  });
  assert.deepEqual(S.state.productionTags.map((t) => [t.id, t.name, t.notes]), [["t_old1", x(78), "one"], ["t_old2", x(78) + "g", "two"]]);
});

test("a B-roll line that a shot's heal already matches renames no other broken shot (#344)", () => {
  migrated({
    rows: [{ id: "r1", status: "todo", audioText: "", visualText: "B-roll: " + x(198) + "g\uD83D y" }],
    brollShots: [
      { id: "bs1", name: x(198) + "\uD83D", notes: "one", status: "shot", origin: "list" },
      { id: "bs2", name: x(198) + "g\uD83D", notes: "two", status: "shot", origin: "script" }
    ]
  });
  assert.deepEqual(S.state.brollShots.map((b) => [b.id, b.name, b.notes]), [["bs1", x(198), "one"], ["bs2", x(198) + "g", "two"]]);
});

test("an unkeyed B-roll line renames the free shot with its old cut, not one a keyed line holds (#344)", () => {
  const key = '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> ';
  migrated({
    rows: [{ id: "r1", status: "todo", audioText: "", visualText: key + x(199) + GRIN + " a<br>B-roll: " + x(199) + GRIN + " b" }],
    brollShots: [
      { id: "bs1", name: x(199) + "\uD83D", notes: "held", status: "shot", origin: "script" },
      { id: "bs2", name: x(199) + "\uD83D", notes: "free", status: "shot", origin: "script" }
    ]
  });
  assert.deepEqual(S.state.brollShots.map((b) => [b.id, b.name, b.notes]), [["bs1", x(199) + GRIN, "held"], ["bs2", x(199) + GRIN, "free"]]);
});

test("two unkeyed B-roll lines with the same old cut rename two shots, one each (#344)", () => {
  migrated({
    rows: [{ id: "r1", status: "todo", audioText: "", visualText: "B-roll: " + x(199) + GRIN + " a<br>B-roll: " + x(199) + GRIN + " b" }],
    brollShots: [
      { id: "bs1", name: x(199) + "\uD83D", notes: "one", status: "shot", origin: "script" },
      { id: "bs2", name: x(199) + "\uD83D", notes: "two", status: "shot", origin: "script" }
    ]
  });
  assert.deepEqual(S.state.brollShots.map((b) => [b.id, b.name, b.notes]), [["bs1", x(199) + GRIN, "one"], ["bs2", x(199) + GRIN, "two"]]);
});

test("a keyed B-roll line renames no other shot that shares its old cut (#344)", () => {
  const key = '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> ';
  migrated({
    rows: [{ id: "r1", status: "todo", audioText: "", visualText: key + x(199) + GRIN + " a" }],
    brollShots: [
      { id: "bs1", name: x(199) + "\uD83D", status: "shot", origin: "script" },
      { id: "bs2", name: x(199) + "\uD83D", notes: "listed", status: "shot", origin: "list" }
    ]
  });
  assert.deepEqual(S.state.brollShots.map((b) => [b.id, b.name, b.notes]), [["bs1", x(199) + GRIN, ""], ["bs2", x(199), "listed"]]);
});

test("a comment over text that held a lone half is not marked Changed once the half is gone (#344)", () => {
  migrated({
    rows: [{ id: "r1", status: "todo", audioText: 'say <span class="cmt-anchor" data-cmt="c1">hi\uD83D there</span> now', visualText: "" }],
    comments: [{ id: "c1", rowId: "r1", field: "audioText", anchorId: "c1", quotedText: "hi\uD83D there", author: "Ann", body: "x", createdAt: "2026-10-01T10:00:00Z", kind: "anchor", replies: [] }]
  });
  renderComments();
  assert.ok(document.querySelector('.comment-card[data-id="c1"]'), "the card is drawn");
  assert.equal(document.querySelector('.comment-card[data-id="c1"] .comment-quote.changed'), null);
  assert.equal(S.state.comments[0].quotedText, "hi there");
});

test("07 registerProductionTag cuts by code point and refuses a name that cleans to nothing (#344, #437)", () => {
  load();
  registerProductionTag("prop", "\uD83D");
  registerProductionTag("prop", " " + x(79) + GRIN + " tail");
  registerProductionTag("prop", "kettle\uD83D");
  assert.deepEqual(S.state.productionTags.map((t) => t.name), ["Kettle", x(79) + GRIN]);
});

test("07 the tag composer offers the selected words cut by code point (#344)", () => {
  load();
  openTagComposer({ quotedText: x(79) + GRIN + "y", cat: "prop", rowId: "r1", field: "audioText", occurrenceIndex: 0 });
  const value = document.getElementById("tag-name").value;
  assert.equal(value, x(79) + GRIN);
  assert.ok(!LONE.test(value));
});

const soundWords = (name, text) => '<span class="tag-anchor" data-tag-cat="sound" data-tag-name="' + name + '" contenteditable="false">' + text + "</span>";
const cue = (name) => '<span class="audio-cue">SFX: ' + name + "</span>";
const tagNamesIn = (html) => [...html.matchAll(/data-tag-name="([^"]*)"/g)].map((m) => m[1]);

const CUE_AND_WORDS = [
  ["40 emoji stored, 50 in the cue", GRIN.repeat(40), GRIN.repeat(50), GRIN.repeat(40), GRIN.repeat(50)],
  ["half an emoji stored", x(79) + "\uD83D", x(79) + GRIN + " tail", x(79) + "\uD83D", x(79) + GRIN]
];

for (const [what, stored, line, words, whole] of CUE_AND_WORDS) {
  test("a sound tag that a cue and tagged words share stays one tag once the cue renames it: " + what + " (#445)", () => {
    migrated({
      rows: [
        { id: "r1", status: "todo", audioText: cue(line), visualText: "" },
        { id: "r2", status: "todo", audioText: "a " + soundWords(words, "door") + " b", visualText: soundWords(words, "slam") }
      ],
      productionTags: [{ id: "t_old1", cat: "sound", name: stored, status: "have", owner: "p1", notes: "keep me" }]
    });
    const sound = S.state.productionTags.filter((t) => t.cat === "sound");
    assert.deepEqual(sound.map((t) => [t.id, t.name, t.status, t.owner, t.notes]), [["t_old1", whole, "have", "p1", "keep me"]]);
    assert.deepEqual(tagNamesIn(S.state.rows[1].audioText).concat(tagNamesIn(S.state.rows[1].visualText)), [whole, whole]);
    assert.equal(new window.DOMParser().parseFromString(S.state.rows[1].audioText, "text/html").body.textContent, "a door b");
    assert.equal(S.state.rows[0].audioText, cue(line));
    const once = JSON.stringify(S.state);
    assert.equal(JSON.stringify(migrateRows(JSON.parse(once))), once, "a second load changes nothing");
  });
}

test("words tagged with a renamed sound tag's old name stay on another sound tag that holds that name (#445)", () => {
  migrated({
    rows: [
      { id: "r1", status: "todo", audioText: cue(x(79) + GRIN + " tail"), visualText: "" },
      { id: "r2", status: "todo", audioText: soundWords(x(79), "door"), visualText: "" }
    ],
    productionTags: [
      { id: "t_old1", cat: "sound", name: x(79) + "\uD83D", owner: "p1", notes: "cue" },
      { id: "t_old2", cat: "sound", name: x(79), notes: "words" }
    ]
  });
  assert.deepEqual(S.state.productionTags.map((t) => [t.id, t.name, t.notes]), [["t_old1", x(79) + GRIN, "cue"], ["t_old2", x(79), "words"]]);
  assert.deepEqual(tagNamesIn(S.state.rows[1].audioText), [x(79)]);
});

test("tagged words follow their renamed sound tag whatever their case, as they matched it before (#445)", () => {
  migrated({
    rows: [
      { id: "r1", status: "todo", audioText: cue("Door " + GRIN.repeat(45)), visualText: "" },
      { id: "r2", status: "todo", audioText: soundWords("DOOR " + GRIN.repeat(37) + "\uD83D", "door"), visualText: "" }
    ],
    productionTags: [{ id: "t_old1", cat: "sound", name: "Door " + GRIN.repeat(37) + "\uD83D", owner: "p1", notes: "keep me" }]
  });
  assert.deepEqual(S.state.productionTags.map((t) => [t.id, t.name, t.notes]), [["t_old1", "Door " + GRIN.repeat(45), "keep me"]]);
  assert.deepEqual(tagNamesIn(S.state.rows[1].audioText), ["Door " + GRIN.repeat(45)]);
});

test("words of a sound tag whose cue rename was refused never join the tag that refused it (#445)", () => {
  migrated({
    rows: [
      { id: "r1", status: "todo", audioText: cue(x(79) + GRIN + " tail"), visualText: "" },
      { id: "r2", status: "todo", audioText: soundWords(x(79) + "\uD83D", "door"), visualText: "" }
    ],
    productionTags: [
      { id: "t_old1", cat: "sound", name: x(79) + "\uD83D", owner: "p1", notes: "words" },
      { id: "t_old2", cat: "sound", name: x(79) + GRIN, notes: "cue" }
    ]
  });
  assert.deepEqual(S.state.productionTags.slice(0, 2).map((t) => [t.id, t.name, t.notes]), [["t_old1", x(79) + "\uD83D", "words"], ["t_old2", x(79) + GRIN, "cue"]]);
  assert.deepEqual(tagNamesIn(S.state.rows[1].audioText), [x(79)]);
});

test("a sound tag whose cue has its own tag keeps its tagged words (#445)", () => {
  migrated({
    rows: [
      { id: "r1", status: "todo", audioText: cue(GRIN.repeat(50)), visualText: "" },
      { id: "r2", status: "todo", audioText: soundWords(GRIN.repeat(40), "door"), visualText: "" }
    ],
    productionTags: [
      { id: "t_old1", cat: "sound", name: GRIN.repeat(40), owner: "p1", notes: "words" },
      { id: "t_old2", cat: "sound", name: GRIN.repeat(50), notes: "cue" }
    ]
  });
  assert.deepEqual(S.state.productionTags.map((t) => [t.id, t.name, t.notes]), [["t_old1", GRIN.repeat(40), "words"], ["t_old2", GRIN.repeat(50), "cue"]]);
  assert.deepEqual(tagNamesIn(S.state.rows[1].audioText), [GRIN.repeat(40)]);
});

test("a prop tag with a sound tag's old name keeps its tagged words, and the sound words still follow (#445)", () => {
  migrated({
    rows: [
      { id: "r1", status: "todo", audioText: cue(GRIN.repeat(50)), visualText: "" },
      { id: "r2", status: "todo", audioText: soundWords(GRIN.repeat(40), "a").replace('"sound"', '"prop"') + " b " + soundWords(GRIN.repeat(40), "c"), visualText: "" }
    ],
    productionTags: [
      { id: "t_old1", cat: "sound", name: GRIN.repeat(40), notes: "cue" },
      { id: "t_old2", cat: "prop", name: GRIN.repeat(40), notes: "prop" }
    ]
  });
  assert.deepEqual(S.state.productionTags.map((t) => [t.id, t.cat, t.name]), [["t_old1", "sound", GRIN.repeat(50)], ["t_old2", "prop", GRIN.repeat(40)]]);
  assert.deepEqual([...S.state.rows[1].audioText.matchAll(/data-tag-cat="(\w+)" data-tag-name="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    [["prop", GRIN.repeat(40)], ["sound", GRIN.repeat(50)]]);
});

test("a keyed B-roll line whose id has no stored shot keeps the shot its old cut named (#445)", () => {
  const key = '<span class="broll-key" data-broll-id="bsX" contenteditable="false">B-roll:</span> ';
  migrated({
    rows: [{ id: "r1", status: "todo", audioText: "", visualText: key + x(199) + GRIN + " a" }],
    brollShots: [{ id: "bs9", name: x(199) + "\uD83D", notes: "two", status: "shot", origin: "script" }]
  });
  assert.deepEqual(S.state.brollShots.map((b) => [b.id, b.name, b.notes]), [["bs9", x(199) + GRIN, "two"]]);
  openBrollPanel();
  assert.deepEqual(S.state.brollShots.map((b) => [b.id, b.name, b.notes]), [["bs9", x(199) + GRIN, "two"]]);
  closeBrollPanel();
});

test("a keyed B-roll line whose id is a stored shot still renames no other shot (#445)", () => {
  const key = '<span class="broll-key" data-broll-id="bs1" contenteditable="false">B-roll:</span> ';
  migrated({
    rows: [{ id: "r1", status: "todo", audioText: "", visualText: key + x(199) + GRIN + " a" }],
    brollShots: [
      { id: "bs1", name: "Other", status: "todo", origin: "script" },
      { id: "bs9", name: x(199) + "\uD83D", notes: "two", status: "shot", origin: "list" }
    ]
  });
  assert.deepEqual(S.state.brollShots.map((b) => [b.id, b.name, b.notes]), [["bs1", x(199) + GRIN, ""], ["bs9", x(199), "two"]]);
});
