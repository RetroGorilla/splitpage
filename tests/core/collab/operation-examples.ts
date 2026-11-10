const target = { segment: "seg-R1", owner: "R1", field: "audioText" };
const at = { left: "s1", right: "s2", affinity: "after" };

export const operationExamples = [
  { fixture: "T01 composition", operation: { kind: "text-insert", id: "insert-A", by: "Alice", target, at,
    content: [{ value: "β", marks: [] }] } },
  { fixture: "T01", operation: { kind: "text-delete", id: "delete-A", by: "Alice", target, observed: ["s2", "s3"] } },
  { fixture: "T21", operation: { kind: "mark", id: "bold-A", by: "Alice", target, observed: ["s2", "s3"], mark: { kind: "b", value: true } } },
  { fixture: "T10 initial R1 segment", operation: { kind: "segment-create", id: "create-A", by: "Alice",
    segment: "seg-R1", beat: "R1", at: { left: null, right: "order-R2", affinity: "before" }, fields: { status: "todo" } } },
  { fixture: "T05 two splits", operation: { kind: "split", id: "split-A", by: "Alice", target,
    at: { left: "s2", right: "s3", affinity: "after" }, observed: ["s1", "s2", "s3", "s4"], boundary: "a1", beat: "Ra", fields: {} } },
  { fixture: "T06", operation: { kind: "join", id: "jA", by: "Alice", from: "R2", into: "R1", glue: " " } },
  { fixture: "T12 join / U-H1 glue rewrite", operation: { kind: "join-glue", id: "glue-B", by: "Bob", joins: ["jA", "jB"], glue: "" } },
  { fixture: "T10", operation: { kind: "remove", id: "rA", by: "Alice", removalKind: "beat", targets: ["R2"],
    observed: ["s3", "s4"], boundaries: ["seg-R2"], components: [], gallery: [], at: 0 } },
  { fixture: "T10 undo / identical simultaneous removal", operation: { kind: "restore", id: "restore-A", by: "Alice", removals: ["rA", "rB"] } },
  { fixture: "MOVE concurrent", operation: { kind: "segment-move", id: "move-A", by: "Alice", segments: ["seg-R3"],
    observedOrder: ["order-R3"], at: { left: null, right: "order-R1", affinity: "before" } } },
  { fixture: "T08 create", operation: { kind: "heading-create", id: "heading-A", by: "Alice", segment: "seg-H1", heading: "H1",
    firstBeat: "R2", at: { left: "order-R1", right: "order-R2", affinity: "before" } } },
  { fixture: "T08 race / text follows", operation: { kind: "heading-finalize", id: "finalize-A", by: "Alice",
    target: { segment: "seg-R2", owner: "R2", field: "audioText" }, heading: "Ha",
    prefix: ["s2", "s3"], name: ["s4", "s5"], separator: ["s6"], tail: { left: "s5", right: "s7", affinity: "before" },
    retainedBeat: "R2", emptyBeat: null } },
  { fixture: "T08 remove", operation: { kind: "heading-remove", id: "unheading-A", by: "Alice", heading: "H1", observed: ["s2", "s3"], newBeat: "Rn", nextBeat: "R1" } },
  { fixture: "T11", operation: { kind: "record-create", id: "comment-A", by: "Alice", target: { collection: "comments", record: "C1" },
    fields: { author: "Alice", createdAt: 0, text: "", rowId: "R1", field: "audioText" } } },
  { fixture: "T21 comment", operation: { kind: "record-set", id: "body-A", by: "Alice", target: { collection: "comments", record: "C1" },
    field: "text", value: "Look here" } },
  { fixture: "T21 comment undo creation", operation: { kind: "record-delete", id: "delete-C1", by: "Alice", target: { collection: "comments", record: "C1" } } },
  { fixture: "T21 scalar", operation: { kind: "scalar", id: "length-A", by: "Alice", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 12 } },
  { fixture: "T21 status / causal branch", operation: { kind: "status", id: "c", by: "Alice", target: { scope: "beat", record: "R1" }, value: "ready", parents: ["a", "x"] } }
] as const;
