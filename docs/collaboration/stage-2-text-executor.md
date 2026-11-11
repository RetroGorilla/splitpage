# Text and mark execution

`registerSharedTextOperationHandlers(handle)` installs text insertion, deletion and mark
handlers for `executeSharedOperations`. Formatting supplied on inserted content is
explicit: each chunk has a birth record excluding known additions and immutable
addition records for its requested positive marks; null attributes mean absent.
Comment, tag and link records contain only
the mark; this executor creates no comment body, registry entry or other record.
Identified marks follow the [Stage 2 occurrence and payload convention](stage-2-identified-marks.md).
Range additions and removals use this same entry and the same prepare translator.

In a shared script, identified names (tag registry ids, link URLs and comment anchors)
are present or absent per character: shared content readers union surviving additions
by kind and payload. The preparation facade retains native identities so a removal
can name every observed addition.
Occurrences are immutable storage records, not visible layers. Applying a name adds it
where missing; clearing a name removes every observed addition with that payload on
the selected units. Two concurrent additions of one name therefore read once, and
one later clear removes both. The translator's observed-addition rule is unchanged.
Standalone can nest the same tag name twice; a shared script shows that name once,
including when sharing text that already contains doubled tags. The literal add and
clear differences in narration and visual text are declared in
`tests/core/flow/mark-occurrence-cases.ts` and pinned by the adapter occurrence tests.

All handlers prepare through the read-only view. Their per-text scratch plan contains
only plain objects and arrays: original units, units of earlier insertions, moving
gap indices, known record identities and the active additions on each planned unit.
It contains no live type, facade or resolver.
Prepare returns a deeply frozen description, including fixed text edits, mark plans,
targets and indices. Apply closes over that description alone. Retaining or mutating
scratch after prepare cannot change the writes that apply carries out.
Prepare establishes an existing text and store, bounds at each apply step and
serializable plain payloads. The guarded mechanical writers may throw on defective
descriptions; that is a handler defect, not an atomic refusal.

## References and the base precondition

At paint time capture `const base = readSharedRevision(handle)`. For the M1 buffered
edit, hold received updates until it closes; execute the ordered list with `{base}`.
The entry refuses a changed revision before preparing anything. The token is local
to that handle, never encoded or compared between replicas. A deletion-only received
update changes it even when the state vector does not change.

`resolveSharedBaseReference(handle, target, reference, base)` gives checked half-open
UTF-16 indices and the canonical shared text target. It refuses a stale token or a
malformed, foreign or missing target. Inside execution the same conversion runs from
the view and scratch plan. Original-base references map through earlier planned edits;
references naming an earlier insertion resolve through that command's units. Deleted
positions collapse to gaps. Flow's left reference names the preceding character, so
its position is after that character; an adapter anchor already names its position.
Shared heading edits clamp pair boundaries the same way narration does. Standalone
heading edits retain their current raw-offset behavior.

`captureSharedTextRange(handle, target, from, to)` captures a canonical
`["shared-text-span", target, startAnchor, endAnchor, unitAnchors]` reference.
The endpoints follow concurrent text edits. Unit anchors retain the exact observed
characters for deletion, so a concurrent insertion inside the range is not deleted.
Reversed live endpoints are refused before mapping through earlier planned edits;
valid endpoints collapsed to one gap by deletion remain accepted.
An ordinary adapter anchor can also name a position or one observed character.
Each operation targets one text; a list can edit several texts atomically.

Narration and heading owner aliases from flow map to the hydrated `b:<owner>` and
`h:<owner>` segments. Explicit segment addresses, visual components and the title use
their existing typed targets. A segment's declared owner and narration/heading kind
must match the address before its plan is built; visual components must name their
beat, and title addresses must name this document. Missing text or store is refused; nothing retrofits a
store or implicitly creates a title, visual text or segment. Structure commands must
create a text and its store together before sharing it.

Every stored mark identity uses the shared stable-identity check: well-formed UTF-16
with no U+FFFD. Unstable record keys and identified mark identities are absent to the
reader; authoring them refuses. Keys remain `[writer, operation id]`; command ids are
expected to be unique, and writer scoping defends against reuse on different copies.
No command rewrites or deletes mark records. Inline payloads use `w` for a person,
`k` and optional `label` for B-roll, `img` for an image reference, and `video` plus
`host` for a video. Embedded atoms occupy one UTF-16 unit in the shared text.

## Range marks and ordered plans

`mark-executor.ts` prepares all ten mark kinds. It resolves observed ranges at that
operation's own planned step, clamps UTF-16 pairs, sorts ranges and merges overlapping
or adjacent spans. One operation addresses one text; the flow vocabulary expresses
a cross-segment selection as ordered operations for its individual beats.

For each resulting range, the handler gathers its active observed additions from the
plain plan and calls `prepareSharedMarkTranslation`. Positive marks create an occurrence
at position `[rangeIndex]`; removals name the selected additions with matching kind
and standalone payload. The immutable record operation id is
`JSON.stringify(["range-mark",operationId,rangeIndex])`, scoped by the live writer.
This record identity is distinct from the native occurrence id. The store writes the
fixed record description through its guarded apply-phase writer, without a transaction
of its own. Comment bodies, replies, registries and scalar records are separate handlers.

`text-description.ts` owns the common deeply frozen description, its mechanical apply
interpreter and mark-plan preparation. The per-text plan advances after every text or
mark command: additions become active on their units and removals suppress the observed
identities there. Thus a later command sees earlier planned changes, including marks
on text that will be inserted earlier in this call. Apply retains only the frozen
description, never this scratch plan. Retained scratch values remain the handler's
responsibility after the store closes, as the entry contract states.

## Retained trace coverage

The test-only reader compares stored per-character marks without creating records or
performing production projection. It matches the copied identity/caret literals for
T01 and the T04, T01/composition, T02/boundary, T03/replace buffer command intents,
plus all seven replacement-intent fixtures. Those replays do not claim DOM buffering,
composition lifecycle or actual editor binding.

The complete mark literals reproduced are T11 step 1 (overlapping comments), T20 nest
and T21 (bold across a concurrent insertion), each in six real schedules and with a
late joiner. The T21 scalar concurrent-status literal uses D1, duplicated and reversed
delivery; sequential delivery is not claimed as the same concurrent history. T20 mark's
raw stored-span phase is pinned separately; its whole-tag presentation stays with 6b.
Full T11 body/reply metadata needs record-handler integration, structural traces need
5c, crossing-tag/recovery projection needs 6b, and undo/redo needs package 10.

The three mark-design histories run for all ten kinds through the entry, along with
the outside-edge literal. The independent seeded model now executes every command
through the entry: text insertion/deletion and all range mark additions/removals.
Its declared limits table is empty. The structural and range-flow generators retain
the separately decided heading rule: raw offsets inside a surrogate pair keep a
half in standalone headings, while shared edits clamp to pair boundaries. Range-flow
test reading uses the app's cell serialization and sanitizer; production projection
is not implemented here. The additional literal tag-name limit covers exactly the
same-name addition and clear in narration and visual text: standalone may keep nested
copies of one name; shared content shows that name once, and one clear removes it.
