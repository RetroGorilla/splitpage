# Painted base of a Writer beat

In shared mode the Writer surface records, at the end of every paint pass, the
shared text each painted beat was painted from: the revision and one identity
per painted unit. `surface.paintedBase(rowId)` returns the record, or `null`.
An identity is a `SharedContentRef` that names the unit itself, so it resolves
to the same character, or to the gap it left, after other people's edits.

The port is `PaintedTextSource` in `src/application/editing/ports.ts`. The record
lives in `src/features/writer/flow-painted-base.ts`. The adapter-side supplier is
`readSharedPaintedText` in `src/adapters/collab/paint-base.ts`. No wiring supplies
the port, so the running app creates no record and reads nothing.

## What the wiring must supply

`documentRevision()` returns the shared revision that the document returned by
the surface's `doc()` was projected at. It is not the live revision of the shared
document. A beat gets a base only when the revision the source reports at the
read equals it. Returning the live revision instead would let a paint from a
projection that is behind record units nobody saw whenever the text reads the
same: delete the first `a` of `aa` and append an `a`, and the string is unchanged
while both positions name other units.

`read(rowId, field)` addresses the beat by owner and physical segment. After a
split a beat is one part of a segment: `segment` is the `segment` field of the
beat record when it has one, otherwise `b:<rowId>`. The supplier returns only
the span the segment's boundaries give that owner, with index 0 at its first
unit, and `null` for an owner that holds no part of the segment.

## When a beat has no base

- The source reports another revision than `documentRevision()`.
- The painted text differs from the shared text of the beat, unit for unit. The
  production projection does not show a prefix split yet, so the halves of one
  have no base until it does.
- The address names no text, or an owner with no span in it.

The record is replaced by each paint, holds only the beats that pass painted,
and is cleared when the surface is disposed. Only narration is recorded;
headings, the visual box and the title are a later package.

## Open for the buffer package

1. What the editor does with input in a beat that has no base.
2. When a local commit refreshes the record. Only a paint does now.
3. The gap at offset 0 of an empty beat has no unit; it is an anchor at offset 0
   with `before` affinity and does not depend on state.
4. Headings, the visual box and the title.
5. A paint during the buffered interval drops the typed beat's base. Paint `ab`
   (base recorded), type `Z` (native typing makes no read; the model holds
   `abZ`), then any paint before the commit: `repaint()`, the paint after orphan
   repair in the input handler, or an inline-markdown edit. That paint compares
   `abZ` with shared `ab` and drops the record. One reading to test there: the
   record describes the shared text at a revision, not the painted text, so a
   beat with uncommitted input keeps its previous record while the revision has
   not moved.

## Cost

A paint makes one read per painted beat, and the Writer paints every row, so
each paint reads the whole document. For a non-empty beat with L painted units,
`readSharedPaintedText` constructs L native unit positions, one framing anchor and
one end-gap anchor. An empty beat constructs one anchor, reused for both its
empty and end gaps. The commit-mapping slice therefore adds one anchor per beat,
including empty beats. No extra read is made on the standalone keystroke path.

Let U be the physical text's units and I its native items, including other beats
that share that text after a split. Span discovery scans U units and can search
backward through earlier spans at each `before` boundary, costing O(U²) in the
worst case. Each position or anchor can walk I items from the start. The supplier's
bound per non-empty beat is O(U² + (L + 2)I), and per empty beat O(U² + I), with
O(U + L) temporary storage. Valid hand-seeded records headed by `{b:"R1"}`, then
`{b:"B0"}`, `{b:"B1"}`, `{b:"P0",before:"R1"}`, `{b:"P1",before:"B0"}`, extended
to 128 units, caused 4,096 backward span-predicate reads in review. No normal
editing history producing that shape has been identified: the creation forms
insert within the addressed owner's span. This is not a proof that concurrent
editing cannot produce it; accepted shared records are covered by the worst-case
bound regardless of their origin.
A whole paint sums those bounds across painted beats; no shared latency bound is
claimed. A historical throwaway probe read 300 freshly hydrated beats (75,600
units, one item per beat) in 2 to 5 ms. It predates the gap captures; edited text
was not measured and no timing rerun is claimed here. Capturing identities only
when a buffer opens remains an option, provided its revision still equals the
painted one.
