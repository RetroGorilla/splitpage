import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateRows } from "../../src/core/migrate.ts";
import { toHtml } from "../../src/core/text/html.ts";
import { B, T } from "./text/cells.ts";
import { cue, tag } from "./production/cells.ts";
import { fakeMigration } from "./migrate-ports.ts";

type Doc = Record<string, unknown>;
type Item = Record<string, unknown>;

const GRIN = "\u{1F600}";
const x = (n: number): string => "x".repeat(n);

function list(doc: Doc, key: string): Item[] {
  return doc[key] as Item[];
}

function run(f: ReturnType<typeof fakeMigration>, doc: Doc): Doc {
  return migrateRows(Object.assign({ schema: 2, comments: [], people: [{ id: "p1", name: "Ann" }], productionTags: [], brollShots: [] }, doc), f.ports);
}

function soundTags(out: Doc): Item[] {
  return list(out, "productionTags").filter((t) => t.cat === "sound");
}

function tagNamesIn(html: unknown): string[] {
  return [...String(html).matchAll(/data-tag-name="([^"]*)"/g)].map((m) => m[1] as string);
}

function cueRow(f: ReturnType<typeof fakeMigration>, line: string, id = "r1"): Item {
  return { id: id, status: "todo", audioText: f.cell([cue("SFX: " + line)]), visualText: "" };
}

function shotRow(f: ReturnType<typeof fakeMigration>, text: string): Item {
  return { id: "r1", status: "todo", audioText: "", visualText: f.cell([T(text)]) };
}

const OLD_CUTS: [string, (n: number) => string, (n: number) => string, (n: number) => string][] = [
  ["half an emoji", (n) => x(n - 1) + "\uD83D", (n) => x(n - 1) + GRIN + " tail", (n) => x(n - 1) + GRIN],
  ["whole emoji only", (n) => GRIN.repeat(n / 2), (n) => GRIN.repeat(n), (n) => GRIN.repeat(n)]
];

for (const [what, stored, line, whole] of OLD_CUTS) {
  test("a sound cue whose tag an older build cut by UTF-16 unit stays one tag, keeping its owner and notes: " + what + " (#344)", () => {
    const f = fakeMigration();
    const out = run(f, {
      rows: [cueRow(f, line(80))],
      productionTags: [{ id: "t_old1", cat: "sound", name: stored(80), status: "have", owner: "p1", notes: "keep me" }]
    });
    assert.deepEqual(soundTags(out).map((t) => [t.id, t.name, t.status, t.owner, t.notes]), [["t_old1", whole(80), "have", "p1", "keep me"]]);
  });

  test("an unkeyed B-roll line whose shot an older build cut by UTF-16 unit stays one shot, keeping its notes: " + what + " (#344)", () => {
    const f = fakeMigration();
    const out = run(f, {
      rows: [shotRow(f, "B-roll: " + line(200))],
      brollShots: [{ id: "bs1", name: stored(200), notes: "keep me", status: "shot", origin: "script" }]
    });
    assert.deepEqual(list(out, "brollShots").map((b) => [b.id, b.name, b.notes, b.status]), [["bs1", whole(200), "keep me", "shot"]]);
  });
}

test("a sound cue whose text differs from its tag only in case leaves the tag's stored casing alone (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [cueRow(f, "door slam " + x(70))],
    productionTags: [{ id: "t_old1", cat: "sound", name: "DOOR SLAM " + x(70), status: "have", owner: "p1", notes: "keep me" }]
  });
  assert.deepEqual(soundTags(out).map((t) => [t.id, t.name, t.owner, t.notes]), [["t_old1", "DOOR SLAM " + x(70), "p1", "keep me"]]);
});

const HALF_INSIDE: [string, (n: number) => string, (n: number) => string, (n: number) => string][] = [
  ["one half", (n) => x(n - 2) + "\uD83D y", (n) => x(n - 2) + "\uD83D", (n) => x(n - 2) + " y"],
  ["two halves, so the name is now under the cap", (n) => x(n - 4) + "\uD83D\uD83D yz", (n) => x(n - 4) + "\uD83D\uD83D y", (n) => x(n - 4) + " yz"]
];

for (const [what, line, stored, now] of HALF_INSIDE) {
  test("a cue whose old text held a lone half inside its cut stays one tag once the half is dropped: " + what + " (#344)", () => {
    const f = fakeMigration();
    const out = run(f, {
      rows: [cueRow(f, line(80))],
      productionTags: [{ id: "t_old1", cat: "sound", name: stored(80), status: "have", owner: "p1", notes: "keep me" }]
    });
    assert.deepEqual(soundTags(out).map((t) => [t.id, t.name, t.owner, t.notes]), [["t_old1", now(80), "p1", "keep me"]]);
  });

  test("an unkeyed B-roll line whose old text held a lone half inside its cut stays one shot: " + what + " (#344)", () => {
    const f = fakeMigration();
    const out = run(f, {
      rows: [shotRow(f, "B-roll: " + line(200))],
      brollShots: [{ id: "bs1", name: stored(200), notes: "keep me", status: "shot", origin: "script" }]
    });
    assert.deepEqual(list(out, "brollShots").map((b) => [b.id, b.name, b.notes]), [["bs1", now(200), "keep me"]]);
  });
}

test("a cue that its own tag's heal already matches renames no other broken tag (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [cueRow(f, x(78) + "g\uD83D y")],
    productionTags: [
      { id: "t_old1", cat: "sound", name: x(78) + "\uD83D", notes: "one" },
      { id: "t_old2", cat: "sound", name: x(78) + "g\uD83D", notes: "two" }
    ]
  });
  assert.deepEqual(list(out, "productionTags").map((t) => [t.id, t.name, t.notes]), [["t_old1", x(78), "one"], ["t_old2", x(78) + "g", "two"]]);
});

test("a cue with two names that share an old cut renames the first tag it meets, and never a second one (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [cueRow(f, x(79) + GRIN + " one"), cueRow(f, x(79) + GRIN + " two", "r2")],
    productionTags: [
      { id: "t_old1", cat: "sound", name: x(79) + "\uD83D", notes: "one" },
      { id: "t_old2", cat: "sound", name: x(79) + "\uD83D", notes: "two" }
    ]
  });
  assert.deepEqual(list(out, "productionTags").map((t) => [t.id, t.name, t.notes]), [["t_old1", x(79) + GRIN, "one"], ["t_old2", x(79), "two"]]);
});

test("a cue shorter than 80 whose tag is a longer broken name finds it by its stored text, once (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [cueRow(f, x(77) + "\uD83D yy")],
    productionTags: [
      { id: "t_old1", cat: "sound", name: x(77) + "\uD83D", notes: "one" },
      { id: "t_old2", cat: "sound", name: x(77) + "\uD83D", notes: "two" }
    ]
  });
  assert.deepEqual(list(out, "productionTags").map((t) => [t.id, t.name, t.notes]), [["t_old1", x(77) + " yy", "one"], ["t_old2", x(77), "two"]]);
});

test("a long cue name finds the broken tag it extends, for the first tag of a name only, and each cue name is used once (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [cueRow(f, x(77) + "abc"), cueRow(f, x(77) + "def", "r2")],
    productionTags: [
      { id: "t_old1", cat: "sound", name: x(77) + "\uD83D", notes: "one" },
      { id: "t_old2", cat: "sound", name: x(77) + "\uD83D", notes: "two" },
      { id: "t_old3", cat: "sound", name: x(77) + "\uD83D\uD83D", notes: "three" }
    ]
  });
  assert.deepEqual(list(out, "productionTags").slice(0, 3).map((t) => [t.id, t.name, t.notes]), [
    ["t_old1", x(77) + "abc", "one"], ["t_old2", x(77), "two"], ["t_old3", x(77) + "def", "three"]
  ]);
});

test("a cue name an older cut already renamed one tag to is not taken by a second broken tag (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [cueRow(f, x(79) + GRIN + " tail")],
    productionTags: [
      { id: "t_old1", cat: "sound", name: x(79) + "\uD83D", notes: "one" },
      { id: "t_old2", cat: "sound", name: x(79) + "\uD83D\uD83D", notes: "two" }
    ]
  });
  assert.deepEqual(list(out, "productionTags").map((t) => [t.id, t.name, t.notes]), [["t_old1", x(79) + GRIN, "one"], ["t_old2", x(79), "two"]]);
});

test("a broken tag is not renamed to a cue name that another tag's stored text already normalises to (#344)", () => {
  const f = fakeMigration();
  const name = x(38) + " " + x(38);
  const out = run(f, {
    rows: [cueRow(f, name)],
    productionTags: [
      { id: "t_old1", cat: "sound", name: x(38) + " ".repeat(10) + x(38), notes: "spaced" },
      { id: "t_old2", cat: "sound", name: x(38) + "\uD83D".repeat(39), notes: "broken" }
    ]
  });
  const tags = soundTags(out);
  assert.deepEqual(tags.slice(0, 2).map((t) => [t.id, (t.name as string).length, t.notes]), [["t_old1", 80, "spaced"], ["t_old2", 38, "broken"]]);
  assert.deepEqual(tags.slice(2).map((t) => t.name), [name], "the cue's own name gets a tag of its own");
});

test("a B-roll shot cut to 197 units is still found by the line that extends it (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [shotRow(f, "B-roll: " + x(196) + GRIN + " a")],
    brollShots: [{ id: "bs1", name: x(196) + "\uD83D", notes: "keep me", status: "shot", origin: "script" }]
  });
  assert.deepEqual(list(out, "brollShots").map((b) => [b.id, b.name, b.notes]), [["bs1", x(196) + GRIN + " a", "keep me"]]);
});

test("one B-roll line renames one broken shot, not every shot that shares its old cut (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [shotRow(f, "B-roll: " + x(199) + GRIN + " a")],
    brollShots: [
      { id: "bs1", name: x(199) + "\uD83D", notes: "one", status: "shot", origin: "script" },
      { id: "bs2", name: x(199) + "\uD83D", notes: "two", status: "shot", origin: "script" }
    ]
  });
  assert.deepEqual(list(out, "brollShots").map((b) => [b.id, b.name, b.notes]), [["bs1", x(199) + GRIN, "one"], ["bs2", x(199), "two"]]);
});

test("a broken shot is not renamed to a line's name when another shot's text already normalises to it (#344)", () => {
  const f = fakeMigration();
  const name = x(98) + " " + x(98);
  const out = run(f, {
    rows: [shotRow(f, "B-roll: " + name)],
    brollShots: [
      { id: "bs1", name: x(98) + " ".repeat(10) + x(98), notes: "spaced", status: "shot", origin: "list" },
      { id: "bs2", name: x(98) + "\uD83D".repeat(99), notes: "broken", status: "shot", origin: "list" }
    ]
  });
  assert.deepEqual(list(out, "brollShots").map((b) => [b.id, (b.name as string).length, b.notes]), [["bs1", 200, "spaced"], ["bs2", 98, "broken"], ["bs-load-c58d6ce701dc2a154393c2eb-1", 197, ""]]);
});

test("a B-roll line that a shot's heal already matches renames no other broken shot (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [shotRow(f, "B-roll: " + x(198) + "g\uD83D y")],
    brollShots: [
      { id: "bs1", name: x(198) + "\uD83D", notes: "one", status: "shot", origin: "list" },
      { id: "bs2", name: x(198) + "g\uD83D", notes: "two", status: "shot", origin: "script" }
    ]
  });
  assert.deepEqual(list(out, "brollShots").map((b) => [b.id, b.name, b.notes]), [["bs1", x(198), "one"], ["bs2", x(198) + "g", "two"]]);
});

test("an unkeyed B-roll line renames the free shot with its old cut, not one a keyed line holds (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [{ id: "r1", status: "todo", audioText: "", visualText: f.cell([B("bs1"), T(" " + x(199) + GRIN + " a\nB-roll: " + x(199) + GRIN + " b")]) }],
    brollShots: [
      { id: "bs1", name: x(199) + "\uD83D", notes: "held", status: "shot", origin: "script" },
      { id: "bs2", name: x(199) + "\uD83D", notes: "free", status: "shot", origin: "script" }
    ]
  });
  assert.deepEqual(list(out, "brollShots").map((b) => [b.id, b.name, b.notes]), [["bs1", x(199) + GRIN, "held"], ["bs2", x(199) + GRIN, "free"]]);
});

test("two unkeyed B-roll lines with the same old cut rename two shots, one each (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [shotRow(f, "B-roll: " + x(199) + GRIN + " a\nB-roll: " + x(199) + GRIN + " b")],
    brollShots: [
      { id: "bs1", name: x(199) + "\uD83D", notes: "one", status: "shot", origin: "script" },
      { id: "bs2", name: x(199) + "\uD83D", notes: "two", status: "shot", origin: "script" }
    ]
  });
  assert.deepEqual(list(out, "brollShots").map((b) => [b.id, b.name, b.notes]), [["bs1", x(199) + GRIN, "one"], ["bs2", x(199) + GRIN, "two"]]);
});

test("a keyed B-roll line renames no other shot that shares its old cut (#344)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [{ id: "r1", status: "todo", audioText: "", visualText: f.cell([B("bs1"), T(" " + x(199) + GRIN + " a")]) }],
    brollShots: [
      { id: "bs1", name: x(199) + "\uD83D", status: "shot", origin: "script" },
      { id: "bs2", name: x(199) + "\uD83D", notes: "listed", status: "shot", origin: "list" }
    ]
  });
  assert.deepEqual(list(out, "brollShots").map((b) => [b.id, b.name, b.notes]), [["bs1", x(199) + GRIN, ""], ["bs2", x(199), "listed"]]);
});

const CUE_AND_WORDS: [string, string, string, string, string][] = [
  ["40 emoji stored, 50 in the cue", GRIN.repeat(40), GRIN.repeat(50), GRIN.repeat(40), GRIN.repeat(50)],
  ["half an emoji stored", x(79) + "\uD83D", x(79) + GRIN + " tail", x(79), x(79) + GRIN]
];

for (const [what, stored, line, words, whole] of CUE_AND_WORDS) {
  test("a sound tag that a cue and tagged words share stays one tag once the cue renames it: " + what + " (#445)", () => {
    const f = fakeMigration();
    const out = run(f, {
      rows: [
        cueRow(f, line),
        { id: "r2", status: "todo", audioText: f.cell([T("a "), tag("sound", words, "door"), T(" b")]), visualText: f.cell([tag("sound", words, "slam")]) }
      ],
      productionTags: [{ id: "t_old1", cat: "sound", name: stored, status: "have", owner: "p1", notes: "keep me" }]
    });
    assert.deepEqual(soundTags(out).map((t) => [t.id, t.name, t.status, t.owner, t.notes]), [["t_old1", whole, "have", "p1", "keep me"]]);
    const row = list(out, "rows")[1] as Item;
    assert.deepEqual(tagNamesIn(row.audioText).concat(tagNamesIn(row.visualText)), [whole, whole]);
    assert.equal((list(out, "rows")[0] as Item).audioText, toHtml([cue("SFX: " + line)]));
  });
}

test("words tagged with a renamed sound tag's old name stay on another sound tag that holds that name (#445)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [cueRow(f, x(79) + GRIN + " tail"), { id: "r2", status: "todo", audioText: f.cell([tag("sound", x(79), "door")]), visualText: "" }],
    productionTags: [
      { id: "t_old1", cat: "sound", name: x(79) + "\uD83D", owner: "p1", notes: "cue" },
      { id: "t_old2", cat: "sound", name: x(79), notes: "words" }
    ]
  });
  assert.deepEqual(list(out, "productionTags").map((t) => [t.id, t.name, t.notes]), [["t_old1", x(79) + GRIN, "cue"], ["t_old2", x(79), "words"]]);
  assert.deepEqual(tagNamesIn((list(out, "rows")[1] as Item).audioText), [x(79)]);
});

test("tagged words follow their renamed sound tag whatever their case, as they matched it before (#445)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [
      { id: "r1", status: "todo", audioText: f.cell([cue("SFX: Door " + GRIN.repeat(45))]), visualText: "" },
      { id: "r2", status: "todo", audioText: f.cell([tag("sound", "DOOR " + GRIN.repeat(37), "door")]), visualText: "" }
    ],
    productionTags: [{ id: "t_old1", cat: "sound", name: "Door " + GRIN.repeat(37) + "\uD83D", owner: "p1", notes: "keep me" }]
  });
  assert.deepEqual(list(out, "productionTags").map((t) => [t.id, t.name, t.notes]), [["t_old1", "Door " + GRIN.repeat(45), "keep me"]]);
  assert.deepEqual(tagNamesIn((list(out, "rows")[1] as Item).audioText), ["Door " + GRIN.repeat(45)]);
});

test("words of a sound tag whose cue rename was refused never join the tag that refused it (#445)", () => {
  const f = fakeMigration();
  const out = run(f, {
    rows: [cueRow(f, x(79) + GRIN + " tail"), { id: "r2", status: "todo", audioText: f.cell([tag("sound", x(79), "door")]), visualText: "" }],
    productionTags: [
      { id: "t_old1", cat: "sound", name: x(79) + "\uD83D", owner: "p1", notes: "words" },
      { id: "t_old2", cat: "sound", name: x(79) + GRIN, notes: "cue" }
    ]
  });
  assert.deepEqual(list(out, "productionTags").slice(0, 2).map((t) => [t.id, t.name, t.notes]), [["t_old1", x(79) + "\uD83D", "words"], ["t_old2", x(79) + GRIN, "cue"]]);
  assert.deepEqual(tagNamesIn((list(out, "rows")[1] as Item).audioText), [x(79)]);
});

test("a prop tag with a sound tag's old name keeps its tagged words, and the sound words still follow (#445)", () => {
  for (const propFirst of [false, true]) {
    const f = fakeMigration();
    const registry = [
      { id: "t_old1", cat: "sound", name: GRIN.repeat(40), notes: "cue" },
      { id: "t_old2", cat: "prop", name: GRIN.repeat(40), notes: "prop" }
    ];
    const out = run(f, {
      rows: [
        { id: "r1", status: "todo", audioText: f.cell([cue("SFX: " + GRIN.repeat(50))]), visualText: "" },
        { id: "r2", status: "todo", audioText: f.cell([tag("prop", GRIN.repeat(40), "a"), T(" b "), tag("sound", GRIN.repeat(40), "c")]), visualText: "" }
      ],
      productionTags: propFirst ? registry.slice().reverse() : registry
    });
    const expected = [["t_old1", "sound", GRIN.repeat(50)], ["t_old2", "prop", GRIN.repeat(40)]];
    assert.deepEqual(list(out, "productionTags").map((t) => [t.id, t.cat, t.name]), propFirst ? expected.reverse() : expected, String(propFirst));
    assert.deepEqual([...String((list(out, "rows")[1] as Item).audioText).matchAll(/data-tag-cat="(\w+)" data-tag-name="([^"]*)"/g)].map((m) => [m[1], m[2]]),
      [["prop", GRIN.repeat(40)], ["sound", GRIN.repeat(50)]], String(propFirst));
  }
});
