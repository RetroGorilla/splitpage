# Text and mark execution

`registerSharedTextOperationHandlers(handle)` installs text insertion and deletion
handlers for `executeSharedOperations`. Formatting supplied on inserted content is
explicit: each chunk has a birth record excluding known additions and immutable
addition records for its requested positive marks; null attributes mean absent.
Comment, tag and link records contain only
the mark; this executor creates no comment body, registry entry or other record.
The following mark-handler change adds range additions and removals to this same entry.

All handlers prepare through the read-only view. Their per-text scratch plan contains
only plain objects and arrays: original units, units of earlier insertions, moving
gap indices and known record identities. It contains no live type, facade or resolver.
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
An ordinary adapter anchor can also name a position or one observed character.
Each operation targets one text; a list can edit several texts atomically.

Narration and heading owner aliases from flow map to the hydrated `b:<owner>` and
`h:<owner>` segments. Explicit segment addresses, visual components and the title use
their existing typed targets. Missing text or store is refused; nothing retrofits a
store or implicitly creates a title, visual text or segment. Structure commands must
create a text and its store together before sharing it.

Every stored mark identity uses the shared stable-identity check: well-formed UTF-16
with no U+FFFD. Unstable record keys and identified mark identities are absent to the
reader; authoring them refuses. Keys remain `[writer, operation id]`; command ids are
expected to be unique, and writer scoping defends against reuse on different copies.
No command rewrites or deletes mark records. Inline payloads use `w` for a person,
`k` and optional `label` for B-roll, `img` for an image reference, and `video` plus
`host` for a video. Embedded atoms occupy one UTF-16 unit in the shared text.
