# Painted base of a Writer beat

In shared mode the Writer surface records, at the end of every paint pass, the
shared text each painted beat was painted from: the revision and one identity
per painted unit. `surface.paintedBase(rowId)` returns the record, or `null`.
An identity is a `SharedContentRef` that names the unit itself, so it resolves
to the same character, or to the gap it left, after other people's edits.

The port is `PaintedTextSource` in `src/application/editing/ports.ts`. The record
lives in `src/application/editing/painted-beats.ts`. The adapter-side supplier is
`readSharedPaintedText` in `src/adapters/collab/paint-base.ts`. The explicit
`sharedBufferPorts` factory builds this port with the buffer port; no
running-app wiring calls it, so the running app creates no record and reads nothing.

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
- The painted text differs from the shared text of the beat, unit for unit.
- The address names no text, or an owner with no span in it.

The record is replaced by each paint, holds only the beats that pass painted,
and is cleared when the surface is disposed. The Writer also records each shown
scene heading under its field key ([Scene headings in the Writer](stage-2-buffer.md#scene-headings-in-the-writer));
the visual box and the title are a later package.

The Split view keeps the same record (`createPaintedBeats`, handed to its cell
buffer by the wiring). It records at every rows paint, one read per narration
cell, and only for cells whose row signature matches the shown document; a cell
the binding rewrote or kept after a commit is recorded on its own with `field`.

## Buffer cases

The five cases raised by the painted-base slice have these ends in the buffer
binding. The named tests below are in `tests/features/writer/buffer-binding.test.ts`.

1. **Closed, rule 27:** no base refuses the native input, reports its occurrence
   through `missingBase`, and requests a repaint with the existing document.
   "rule 27: missing base counts once, refuses native input and repaints; the very
   next input works" types immediately after that repaint, without another action.
2. **Closed:** a successful commit repaints and refreshes the base before another
   native input. "commit refreshes the painted base before the next keystroke"
   and "identical native replacement refreshes identities even while the painted
   text is unchanged" cover both text changes and replacement of equal letters.
3. **Closed:** the empty beat records its native zero gap with `before` affinity;
   "empty beat native typing uses the painted zero gap" commits its first letter.
4. **Declared:** the visual box and title remain packages 9d and 9e, whose field
   bindings have not been migrated. Writer headings are bound since 9d.
5. **Closed for this binding:** while dirty, paint/repaint/refresh keep the native
   DOM and its original base. "paint during a dirty composition keeps the typed
   DOM and its original identities until commit" and "orphan repair keeps the
   dirty painted base until the native insertion commits" cover composition and
   repair. "inline markdown reaches its command port only after native typing
   commits and refreshes its base" pins that ordering; it does not claim a shared
   implementation of the command port's markdown transformation. Finishing or
   cancelling invalidates the edited beat's render cache before repainting.

Assumed rule 31 separately declares cross-beat composition a limit, with no write
and no hold. It is not a package 14 task. Ordinary cross-beat input goes through
the existing structural command port after settling typing; current whole-start
cases refuse until removal/join handlers land. The named rule 31 tests in the
same binding test file pin the refusal, selection and document, so enabling that
dependency requires an explicit expected-result change.

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

The buffer's selection restoration makes one additional shared painted read
after the local write when a selection was supplied. After held updates drain,
it reads the projected blocks, units, marks, tags and join groups once, then
projects those groups for each of the two endpoints with a zero-width marker.
This adds a document projection's discovery/mark costs and up to two joined-unit
projections, including their existing mark-policy costs. Finding each joined
member's block adds O(B²) lookups in the worst case for B blocks, per endpoint.
No constant-time shared selection cost
is claimed. The following repaint has the paint cost above. These costs are
shared-only, with no latency claim. The production-dispatch counter in
`tests/features/writer/buffer-cost.test.ts` pins 17 row reads for a standalone
native key in both a two-row and a 200-row document, with no buffer construction;
its shared control constructs one. The extra-row-walk mutant fails that test.

The shared ownership checkpoint walks the shown beats and decodes their DOM text
at each native entry and exit and before paint/settlement. For B shown beats and
L shown units this adds O(B + L) scanning per checkpoint, plus DOM decoding and
normalization costs. Unreported replacement discovery uses O(L) code-point work
and temporary space for the affected field. A refused unowned field is repainted
individually and refreshes its base. No shared constant-work or latency claim is
made. These checkpoints and the additional painted strings are only constructed
when the shared ports are supplied; the standalone input counter remains bound
to the unchanged production dispatch.
