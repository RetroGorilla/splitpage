# Record handlers

`registerSharedRecordHandlers(handle)` in `src/adapters/collab/record-executor.ts`
registers `record-create`, `record-set` and `record-delete` through the existing
per-handle registry. Preparation reads the live view and plans map writes;
application uses `applySharedMapWrites` in the entry's one transaction. A small
candidate view validates each proposed record with the same field reader used
for stored records. No changes to `execute.ts`, `prepare.ts` or `state.ts` are
needed, and there is no application caller or typing/undo/save path change.

`record-codec.ts` is the validator for all seven record kinds, with one assembly
path for native and prepared field sources. `record-reader.ts` reads a public
wire snapshot and assembles known fields in declared order, then unknown JSON
fields in UTF-16 code-unit order. Types and immutability belong to each kind;
names owned only by another kind remain opaque JSON, with `id` always reserved
for the record's identity. Replies sort by finite creation time and id;
unparseable times sort as zero. Other roots sort by rank and key. No result uses
map iteration order or locale collation. ISO creation times use explicit UTC
calendar validation, including offsets; there is no host-dependent date parsing.

## Field coverage

Names below refer to the [field inventory](stage-0/2-fields.md). Record fields
match hydration's stored vocabulary; file projection remains packages 6a/6b.

| Plain-document fields | Record coverage |
| --- | --- |
| Comment `id`, `anchorId`, `author`, `createdAt`, `quotedText` | Creation only; quoted text is `quote` |
| Comment `rowId`, `field` | Mutable last-known anchor metadata; mark/structure reconciliation is elsewhere |
| Comment `body` | Atomic HTML string `text`; only its author edits or clears it |
| Comment `updatedAt`, `assignee` | Mutable scalar fields |
| Comment `kind`, `imageValue`, `conflictField`, `emptyValue`, `titleValue` | Creation only |
| Comment `resolved`, `resolvedAt`, `resolvedBy` | One atomic `resolution` value |
| Comment `replies` | Separate reply root; removal of a comment leaves replies available |
| Reply `id`, parent `commentId`, `author`, `createdAt` | Creation only; map key is JSON `[commentId,id]` |
| Reply `body` | Atomic string `text`, author-only |
| Person `id`, `name` | Immutable id; mutable name, assumed until a rename policy is decided |
| Tag `id`, `cat`, `name`, `owner`, `notes` | Immutable id; separate mutable fields matching hydration and the prototype |
| Tag/shot `status` | Initial record value only; subsequent changes use the existing causal status handler |
| Shot `id`, `origin` | Creation only |
| Shot `name`, `desc`, `reshoot`, `notes`, `audioRef`, `location`, `owner` | Mutable scalar fields; stored fallback names are retained |
| Shot `props` | Nested map keyed by `brollPropKey`; logical array input reconciles observed entries |
| Gallery slot `beat`, `rank` | Mutable component metadata |
| Slot `imageRef`, `imageName`/`name`, `imageAnnotation`/`annotation` | One atomic `picture` value, including original image reference and annotation marks |
| Gallery links `href`, `name`, `size`, `duration`, `poster` | Nested map keyed by `videoLinkKey`; logical array input reconciles observed entries |
| Gallery link `location` | Excluded: device-local paths and bundles are not shared |
| Visual `beat`, `rank` | Component metadata creation/change/removal |
| Visual `text`, `html`, `markRecords` | Excluded: the text/mark executor owns these, including clear; no shared text or mark is authored here |
| Unknown JSON fields, `rank`, `extra` | Retained; `extra` is an atomic JSON-object string matching hydration |

The inventory's provisional atomic tag-key grouping is not implemented: existing
hydration and the prototype store `cat` and `name` separately. Per-field writes
are assumed here; rename/retag command semantics and merged name uniqueness,
length/count limits and derived names/owners remain the production/projection
packages. This reader validates storage shapes without truncating or repairing
merged records. Native creation checks root keys to distinguish an absent key
from a stored `undefined`; preparation does not encode the document.

## Decisions and assumptions

The [Product decisions](stage-0/9-stage-1-experiments.md#product-decisions) decide
oldest-first replies with id ties, author-only comment/reply text edits, recovery
when a comment's marked words are all deleted, and later resolve/reopen wins.
Author names in operations are trusted input from the future session caller,
not authentication. Causally later resolution writes win as in the prototype;
concurrent resolution writes use the library's deterministic conflict order.

Recovery packages receive retained `anchorId`, last-known `rowId/field`, `quote`,
body and replies. This package interprets no marks and never removes a comment
because its body is empty or its marked words disappear. Explicit record removal
does not cascade to replies. Missing-parent replies remain available for recovery.

Where Product decisions give no answer, assumed: simultaneous same-id creation
uses the native atomic parent-map winner; same-field changes use the native
deterministic winner; parent removal wins over concurrent child-map changes.
In the fixtures the higher client id wins concurrent creation and field writes.
Metadata changes and explicit removal are unrestricted by author. A later
recreation reuses its identity and any retained status events. Distinct nested
additions survive in existing link/prop maps; clearing/removing a parent map wins
over concurrent child additions. Equal ranks use UTF-16 key order.

Every interpreted stored identity uses `isStableSharedIdentity`: root keys, ids,
reply parents, beat/anchor references, authors/assignees/owners, resolution writers,
and nested link/prop keys, field keys and identity components. Unstable root records and
nested entries are absent, never rewritten or deleted; unstable authoring is
refused before writes. Opaque unknown JSON is not interpreted as an identity.

## Evidence boundaries

T11's comment and reply record portions reproduce the copied literal oracles over
all six delivery schedules with encoded late joiners. Its overlapping marks,
split/removal recovery and restoration need marks, structure, recovery and undo.
The existing T21 causal status tests remain part of package 5d's first PR.
Hand-written hydration and command fixtures cover all seven roots plus scalars;
the generator independently models status, author-only edits and reply order
from the command list, and compares settled readings with encoded reloads.
