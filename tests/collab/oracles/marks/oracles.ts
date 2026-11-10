// why: literal copy of prototypes/collab/test/marks/oracles.ts; Stage 0 rows per export are in ../../fixtures.ts.
// tools/test-collab-oracle-copies.mjs pins it to the original, so expected results change only by product decision.
import type { ScriptOracle } from "../../checker.ts";

export const markOracles: Record<string, ScriptOracle> = {
  "T11 fully deleted": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s4", "d", {}]] }], carets: {}, recovery: [],
    records: { comments: { C1: { author: "Alice", createdAt: 0, text: "", rowId: "R1", field: "audioText", recovery: true, replies: [{ id: "r1", commentId: "C1", author: "Bob", createdAt: 0, text: "" }] } }, recoveryReplies: [] }
  },
  "T20 nest": {
    rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["s5", "r", { tag: "P" }], ["s6", "e", { tag: "P" }], ["s7", "d", { tag: "P" }], ["s8", " ", { tag: "P" }], ["s9", "m", { tag: "P", innerTags: ["S"] }], ["s10", "u", { tag: "P", innerTags: ["S"] }], ["s11", "g", { tag: "P", innerTags: ["S"] }]] }], carets: {}, recovery: []
  },
  "T20 nest undo": {
    rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["s5", "r", {}], ["s6", "e", {}], ["s7", "d", {}], ["s8", " ", {}], ["s9", "m", { tag: "S" }], ["s10", "u", { tag: "S" }], ["s11", "g", { tag: "S" }]] }], carets: {}, recovery: []
  },
  "T20 cross": {
    rows: [{ id: "R1", characters: [["s1", "t", { tag: "S" }], ["s2", "h", { tag: "S" }], ["s3", "e", { tag: "S" }], ["s4", " ", { tag: "S" }], ["s5", "r", { tag: "S" }], ["s6", "e", { tag: "S" }], ["s7", "d", { tag: "S" }], ["s8", " ", {}], ["s9", "m", {}], ["s10", "u", {}], ["s11", "g", {}]] }], carets: {}, recovery: [],
    records: { tagRecovery: [{ occurrence: "oA", tag: "P", words: "red mug", identities: ["s5", "s6", "s7", "s8", "s9", "s10", "s11"] }] }
  },
  "T20 cross undo": {
    rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["s5", "r", { tag: "P" }], ["s6", "e", { tag: "P" }], ["s7", "d", { tag: "P" }], ["s8", " ", { tag: "P" }], ["s9", "m", { tag: "P" }], ["s10", "u", { tag: "P" }], ["s11", "g", { tag: "P" }]] }], carets: {}, recovery: []
  },
  "T20 mark": {
    rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["s5", "r", { tag: "P", "c:C1": true, href: "http://x" }], ["s6", "e", { tag: "P", "c:C1": true, href: "http://x" }], ["s7", "d", { tag: "P", "c:C1": true, href: "http://x" }], ["s8", " ", { tag: "P", "c:C1": true, href: "http://x" }], ["s9", "m", { tag: "P", "c:C1": true, href: "http://x" }], ["s10", "u", { tag: "P", "c:C1": true, href: "http://x" }], ["s11", "g", { tag: "P", "c:C1": true, href: "http://x" }]] }], carets: {}, recovery: []
  },
  "T20 mark undo": {
    rows: [{ id: "R1", characters: [["s1", "t", {}], ["s2", "h", {}], ["s3", "e", {}], ["s4", " ", {}], ["s5", "r", { tag: "P", "c:C1": true }], ["s6", "e", { tag: "P", "c:C1": true }], ["s7", "d", { tag: "P", "c:C1": true }], ["s8", " ", { tag: "P", "c:C1": true }], ["s9", "m", { tag: "P", "c:C1": true }], ["s10", "u", { tag: "P", "c:C1": true }], ["s11", "g", { tag: "P", "c:C1": true }]] }], carets: {}, recovery: []
  },
  T21: {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", { b: true }], ["b1", "X", { b: true }], ["s3", "c", { b: true }], ["s4", "d", {}]] }], carets: {}, recovery: []
  },
  "T21 undo": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["b1", "X", {}], ["s3", "c", {}], ["s4", "d", {}]] }],
    carets: { A: { beat: "R1", offset: 1, selection: { beat: "R1", from: 1, to: 4 } } }, recovery: []
  },
  "T21 comment undo": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["s3", "c", { "c:C2": true }], ["s4", "d", { "c:C2": true }]] }], carets: {}, recovery: [],
    records: { comments: { C2: { author: "Bob", createdAt: 0, text: "", rowId: "R1", field: "audioText", recovery: false, replies: [] } }, recoveryReplies: [{ id: "r1", commentId: "C1", author: "Bob", createdAt: 0, text: "" }] }
  },
  "T21 comment redo": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", { "c:C1": true }], ["s3", "c", { "c:C1": true, "c:C2": true }], ["s4", "d", { "c:C2": true }]] }], carets: {}, recovery: [],
    records: { comments: {
      C1: { author: "Alice", createdAt: 0, text: "", rowId: "R1", field: "audioText", recovery: false, replies: [{ id: "r1", commentId: "C1", author: "Bob", createdAt: 0, text: "" }] },
      C2: { author: "Bob", createdAt: 0, text: "", rowId: "R1", field: "audioText", recovery: false, replies: [] }
    }, recoveryReplies: [] }
  },
  "T21 scalar": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}], ["a1", "Z", {}]], status: "todo" }], carets: {}, recovery: [],
    notices: ["Alice: concurrent status change did not apply", "Bob: concurrent status change did not apply"]
  },
  "T21 scalar undo": {
    rows: [{ id: "R1", characters: [["s1", "a", {}], ["s2", "b", {}]], status: "todo" }], carets: {}, recovery: [],
    notices: ["Alice: concurrent status change did not apply", "Bob: concurrent status change did not apply"]
  }
};
