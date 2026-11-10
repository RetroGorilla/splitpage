// why: literal copy of prototypes/collab/test/oracles.ts; Stage 0 rows per export are in ../fixtures.ts.
// tools/test-collab-oracle-copies.mjs pins it to the original, so expected results change only by product decision.
import type { ScriptOracle } from "../checker.ts";

export const deletionOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], ["b1", "X", {}], ["s4", "d", {}]] }],
  carets: { A: { beat: "R1", offset: 1 } },
  recovery: []
};

export const restorationOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] },
    { id: "R2", characters: [["s3", "c", {}], ["b1", "X", {}], ["s4", "d", {}]] },
    { id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}]] }
  ],
  carets: { A: { beat: "R2", offset: 0 } },
  recovery: []
};

export const removedOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] },
    { id: "R3", characters: [["s5", "e", {}], ["s6", "f", {}]] }
  ],
  carets: { A: { beat: "R3", offset: 0 } },
  recovery: [{ row: { id: "R2", characters: [["s3", "c", {}], ["b1", "X", {}], ["s4", "d", {}]] }, by: "Alice", edited: ["b1"] }]
};

export const joinNarrationOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", { b: true }], ["s2", "b", { b: true }], ["[glue]", " ", {}], ["s3", "c", {}], ["s4", "d", {}]] }],
  carets: { A: { beat: "R1", offset: 3 }, B: { beat: "R1", offset: 3 } },
  recovery: []
};

export const joinOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", { b: true }], ["s2", "b", { b: true }], ["[glue]", " ", {}], ["s3", "c", {}], ["s4", "d", {}]],
    status: "ready", visualText: "v<br>w", visuals: [{ id: "V1", characters: [["v1", "v", {}]] }, { id: "V2", characters: [["w1", "w", {}]] }],
    gallery: [{ ref: "P", name: "wide", annotation: "", links: [{ href: "https://v/1", poster: "poster" }, { href: "https://v/2" }] }, { ref: "Q", name: "", annotation: "", links: [] }] }],
  carets: { A: { beat: "R1", offset: 3 }, B: { beat: "R1", offset: 3 } }, recovery: [],
  records: { gallery: {
    gP1: { id: "gP1", beat: "R1", rank: "0", ref: "P", name: "", annotation: "", links: [{ href: "https://v/1" }] },
    gP2: { id: "gP2", beat: "R2", rank: "0", ref: "P", name: "wide", annotation: "", links: [{ href: "https://v/1", poster: "poster" }, { href: "https://v/2" }] },
    gQ: { id: "gQ", beat: "R2", rank: "1", ref: "Q", name: "", annotation: "", links: [] }
  } }
};

export const joinUndoOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", { b: true }], ["s2", "b", { b: true }]], status: "todo", visualText: "v", visuals: [{ id: "V1", characters: [["v1", "v", {}]] }],
      gallery: [{ ref: "P", name: "", annotation: "", links: [{ href: "https://v/1" }] }] },
    { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]], status: "ready", visualText: "w", visuals: [{ id: "V2", characters: [["w1", "w", {}]] }],
      gallery: [{ ref: "P", name: "wide", annotation: "", links: [{ href: "https://v/1", poster: "poster" }, { href: "https://v/2" }] }, { ref: "Q", name: "", annotation: "", links: [] }] }
  ], carets: { A: { beat: "R2", offset: 0 }, B: { beat: "R2", offset: 0 } }, recovery: [], records: { ...joinOracle.records }
};

export const joinBoldUndoOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "todo", visualText: "v", visuals: [{ id: "V1", characters: [["v1", "v", {}]] }],
      gallery: [{ ref: "P", name: "", annotation: "", links: [{ href: "https://v/1" }] }] },
    { id: "R2", characters: [["s3", "c", {}], ["s4", "d", {}]], status: "ready", visualText: "w", visuals: [{ id: "V2", characters: [["w1", "w", {}]] }],
      gallery: [{ ref: "P", name: "wide", annotation: "", links: [{ href: "https://v/1", poster: "poster" }, { href: "https://v/2" }] }, { ref: "Q", name: "", annotation: "", links: [] }] }
  ], carets: { A: { beat: "R2", offset: 0 }, B: { beat: "R2", offset: 0 } }, recovery: [], records: { ...joinOracle.records }
};

export const commentsOverlapOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [
    ["s1", "a", {}], ["s2", "b", { "c:C1": true }],
    ["s3", "c", { "c:C1": true, "c:C2": true }], ["s4", "d", { "c:C2": true }]
  ] }],
  carets: {},
  recovery: []
};

export const commentsOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", { "c:C1": true }], ["s3", "c", { "c:C1": true, "c:C2": true }], ["s4", "d", { "c:C2": true }]] },
    { id: "R2", characters: [["s5", "e", {}], ["s6", "f", {}]] }
  ], carets: {}, recovery: [], records: { comments: {
    C1: { author: "Alice", createdAt: 0, text: "", rowId: "R1", field: "audioText", recovery: false, replies: [] },
    C2: { author: "Bob", createdAt: 0, text: "", rowId: "R1", field: "audioText", recovery: false, replies: [] }
  }, recoveryReplies: [] }
};

export const commentsReplyOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", { "c:C1": true }], ["s3", "c", { "c:C1": true, "c:C2": true }], ["s4", "d", { "c:C2": true }]] },
    { id: "R2", characters: [["s5", "e", {}], ["s6", "f", {}]] }
  ], carets: {}, recovery: [], records: { comments: {
    C1: { author: "Alice", createdAt: 0, text: "", rowId: "R1", field: "audioText", recovery: false, replies: [{ id: "r1", commentId: "C1", author: "Bob", createdAt: 0, text: "" }] },
    C2: { author: "Bob", createdAt: 0, text: "", rowId: "R1", field: "audioText", recovery: false, replies: [] }
  }, recoveryReplies: [] }
};

export const commentsRemovedOracle: ScriptOracle = {
  rows: [{ id: "R2", characters: [["s5", "e", {}], ["s6", "f", {}]] }],
  carets: { A: { beat: "R2", offset: 0 }, B: { beat: "R2", offset: 0 } },
  recovery: [
    { row: { id: "R1", characters: [["s1", "a", {}], ["s2", "b", { "c:C1": true }]] }, by: "Alice", edited: [] },
    { row: { id: "Rb", characters: [["s3", "c", { "c:C1": true, "c:C2": true }], ["s4", "d", { "c:C2": true }]] }, by: "Alice", edited: [], splitBy: "Bob" }
  ], records: { comments: {
    C1: { author: "Alice", createdAt: 0, text: "", rowId: "R1", field: "audioText", recovery: true, replies: [{ id: "r1", commentId: "C1", author: "Bob", createdAt: 0, text: "" }] },
    C2: { author: "Bob", createdAt: 0, text: "", rowId: "Rb", field: "audioText", recovery: true, replies: [] }
  }, recoveryReplies: [] }
};

export const commentsRestoredOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", { "c:C1": true }]] },
    { id: "Rb", characters: [["s3", "c", { "c:C1": true, "c:C2": true }], ["s4", "d", { "c:C2": true }]] },
    { id: "R2", characters: [["s5", "e", {}], ["s6", "f", {}]] }
  ], carets: { A: { beat: "R1", offset: 0 }, B: { beat: "Rb", offset: 0 } }, recovery: [],
  records: { comments: {
    C1: { author: "Alice", createdAt: 0, text: "", rowId: "R1", field: "audioText", recovery: false, replies: [{ id: "r1", commentId: "C1", author: "Bob", createdAt: 0, text: "" }] },
    C2: { author: "Bob", createdAt: 0, text: "", rowId: "Rb", field: "audioText", recovery: false, replies: [] }
  }, recoveryReplies: [] }
};

export const lengthOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], lengthSeconds: 12 }],
  carets: {},
  recovery: []
};

export const splitOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]] },
    { id: "Ra", characters: [["b1", "X", {}], ["s3", "c", {}], ["s4", "d", {}]] }
  ],
  carets: { A: { beat: "Ra", offset: 0 }, B: { beat: "Ra", offset: 1 } },
  recovery: []
};

export const swappedSplitOracle: ScriptOracle = {
  rows: [
    { id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "X", {}]] },
    { id: "Ra", characters: [["s3", "c", {}], ["s4", "d", {}]] }
  ],
  carets: { A: { beat: "Ra", offset: 0 }, B: { beat: "R1", offset: 3 } },
  recovery: []
};

export const splitUndoOracle: ScriptOracle = {
  rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "X", {}], ["s3", "c", {}], ["s4", "d", {}]] }],
  carets: { A: { beat: "R1", offset: 3 }, B: { beat: "R1", offset: 3 } },
  recovery: []
};
