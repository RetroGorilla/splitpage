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
merged records. The view's `has(path)` distinguishes an absent key from stored
`undefined` through planned create/delete/recreate effects, without enumerating
root keys. JSON fields are read only when their stored kind is `value` in both
native and prepared sources; shared maps, arrays and texts are not coerced into
JSON record fields. Preparation does not encode the document.

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
deterministic winner; a removal wins over concurrent changes, which stay
recoverable ([Removal and a concurrent edit](#removal-and-a-concurrent-edit)).
In the fixtures the higher client id wins concurrent creation and field writes.
Metadata changes and explicit removal are unrestricted by author. A later
recreation reuses its identity and any retained status events. Distinct nested
additions survive in existing link/prop maps; removing a record or a list entry
wins over concurrent child additions, which stay recoverable as below. Equal ranks use UTF-16 key order.

Every interpreted stored identity uses `isStableSharedIdentity`: root keys, ids,
reply parents, beat/anchor references, authors/assignees/owners, resolution writers,
and nested link/prop keys, field keys and identity components. Unstable root records and
nested entries are absent; reconciliation deletes only validated visible entries
and refuses to overwrite a hidden key. Unstable authoring is
refused before writes. Opaque unknown JSON is not interpreted as an identity.

## Removal and a concurrent edit

Assumed rules 170 to 179 on #1414. Before them, `record-delete` deleted the record's map, and the sync library drops a write into a deleted map: an edit made by someone who had not seen the removal disappeared on every copy, with no recovery entry, and the remover's undo brought the record back without it.

Now a `record-delete` of a comment, reply, person, tag, b-roll shot or picture keeps the map and writes a removal mark under `deletion` (`src/adapters/collab/record-deletion.ts`). A prop or video link taken out of its list is marked the same way, and so is every entry of a list a `record-set` with `clear` empties: no command deletes a record's or an entry's map any more. The mark holds the removal's identity, who removed it, and one short digest per field as the removal saw it; a tag or shot also gets a digest of its standing status events. Every reader treats a marked record as gone, and preparation refuses commands on it as on a missing record. A visual record is still deleted outright.

- An edit made without seeing the removal lands in the kept map. The projection lists the record once, as a `deleted-record` recovery entry, while any field differs from what the removal saw. A removal nothing raced lists nothing. A rank, and a comment's `resolution` and `updatedAt` stamps, are not watched.
- Each raced edit is held in exactly one entry, whichever way the record or entry stopped being shown. An entry's own mark holds an edit to that entry, also inside a record removed later; the record's mark holds the rest. A record's mark keeps one digest per list entry, and an entry that carries its own mark at comparison time is left out of both sides, so removing an entry is never an edit of the record around it, also when the record is removed at the same moment. `record-removal-ways.test.ts` pins this with one row per way: an entry taken out, a list cleared, the record removed, the record removed while an entry is added, the record removed after an entry's removal raced an edit, and both removals unseen by the editor.
- A tag's or shot's entry shows the status a restore will give, read from its status events.
- The owner of a child record is read only from the keys `sharedCreationOwnerKeys` declares (its removal mark and its owner field), and the retired-creation cache and the owner index watch exactly that list; `creation-undo-cost.test.ts` fails if the owner reader reads a key the cache does not watch. A removal or restore of a child record therefore refreshes the creation on every copy.
- A record behind a removal mark no longer belongs to the beat it names, so the watch of an undone beat creation (#1590) leaves it out, as it left out a deleted map: a comment or picture added and removed again leaves the creation undone. A picture of an undone beat removed while someone captions it is listed once, and the entry and the picture agree on every copy through the creation's redo and a restore (`undo-creation.test.ts`).
- Restore sends `record-revive`, which deletes the mark: the record comes back with every raced edit. Restoring an entry kept inside a removed record deletes both marks, so the record comes back with that entry. Discard hides the entry until another unseen edit arrives.
- The remover's undo also sends `record-revive`, so the record comes back with the other person's edit; the redo removes it again with a mark that has seen the edit.
- The editor's own undo of a field edit, or of a status, is used up while the removal stands; the edit stays in the entry.
- A `record-create` with a removed record's id brings that record back, keeping each field a raced edit changed.

Stored size: the map stays, so a removal now adds bytes where it used to free them: 162 for a b-roll shot and 126 for a person, pinned in `record-removal-edit.test.ts`. A raced edit adds only its own write. Nothing deletes a mark or its map; clean-up belongs to the retention work in section 6 of the collaboration plan.

## Same-id creation exposure in the app

**Tags have derived ids and entered content at stake in ordinary use.** Two
people adding the same absent category/name can mint the same id, then enter
different notes or owners before exchanging their creations. The current
assumption keeps one entire record, so the losing record's entered values are
not present on another copy. This table records the exposure; it does not change
that assumption or add recovery for losing creations.

There is no application caller for these shared record handlers yet. The table
traces today's standalone authoring and the adapter's existing ID assignment,
distinguishing independent creation from updates to already-hydrated records.
Derived cases with potentially different content are listed first.

| Kind | Where its id comes from today | Can ordinary inputs produce the same id concurrently? | Content lost if two creates reach the same id |
| --- | --- | --- | --- |
| Tags | [`newRegistryTag`](../../src/core/production/tags.ts) calls [`mintTagId`](../../src/core/document/tags.ts): hash of category plus trimmed, lowercased, whitespace-normalized name; local collision suffixes inspect only the current registry. [`updateTagsCommand`](../../src/application/commands/production-records.ts) can create a missing entry and set notes/owner/status in the same command. | Yes. The same absent category/name on the same base yields the same unsuffixed id. | Losing name spelling/case, owner, notes, initial status and unknown metadata; later local field edits on its losing map also disappear. |
| Shots | Manual [`newBrollRecord`](../../src/application/commands/production-actions.ts) mints `bs`; [`planBrollRecords`](../../src/core/production/broll.ts) instead reuses an existing script key's `found.id` when materializing that key's record. [`migrateRows`](../../src/core/migrate.ts) also materializes script records and repairs missing ids. | Independent manual shots/new keys are randomly minted. Two materializations of the same already-identified key use the same id; this is a reconstruction/load path, not name-based minting. A normal validated load already has those records. | Losing script-derived name/description, audio/location seed, and any owner, notes, props, reshoot or initial status entered on the losing creation before exchange. |
| Gallery | The app stores slot arrays without slot ids: [`addGalleryPicture` / `addGalleryVideo`](../../src/core/document/gallery.ts) append or fill a slot and `setRowSlots` writes it back. [`hydrateSharedDocument`](../../src/adapters/collab/hydrate.ts) assigns `<beat id>:slot:<index>`. | Two independent appends on the same base choose the same next index. They receive the same adapter id if the current positional assignment is used for their shared creates; no shared append caller exists yet. Filling an already-hydrated first slot is an update, not a create. | One picture/reference/name/annotation and that slot's links/attachment metadata. This package does not delete the external blob bytes. |
| Visuals | The app has one `row.visualText` field per beat, without a separate component id. [`hydrateSharedDocument`](../../src/adapters/collab/hydrate.ts) keys its visual record by the beat id; [`flow operations`](../../src/core/flow/operations.ts) likewise derive visual component references from a beat id. | Normal visual edits update the pre-created component, so they do not independently create records. Independent hydration or future missing-component creation for the same beat would reuse its id; independent new beats mint different ids normally. | Losing beat/rank metadata and any text/mark children attached by another package. This record handler itself creates no text or marks. |
| Comments | Selection comments call `ids.id("c")` in [`rows`](../../src/features/rows/render.ts) or [`writer wiring`](../../src/bootstrap/wiring/writer.ts); [`conflictComment`](../../src/core/merge/rows.ts) also mints `c`. Media migration uses [`mediaCommentId`](../../src/core/document/ids.ts), a hash of beat, field and media key, from [`mediaComments`](../../src/core/document/media.ts). | Independent posted comments use random ids even on the same selected words; only an accidental random collision shares one. The same moved media produces a deterministic migration id, with the same initial generated body for the same source. | Losing body, author, quote/anchor, resolution and other metadata. Replies are separate records and are not cascaded away. |
| Replies | [`postReply`](../../src/features/comments/comments.ts) mints `ids.id("rp")`; shared hydration keys it by `[commentId,replyId]`. | Two replies to the same comment normally have different random reply ids; an accidental collision within that parent can share the key. | Losing reply body, author, creation time and unknown metadata. |
| People | [`addPerson`](../../src/core/production/records.ts) reuses an already-known normalized name locally, otherwise mints `ids.id("p")`. | Two people adding the same previously absent name normally mint different ids; duplicate names are a separate merged-state limit. Same-id creation requires an accidental random collision. | Losing person's name/metadata; references to that shared id can then identify the winner instead. |

The wired [`randomIds`](../../src/bootstrap/wiring/ports/identity.ts) uses
[`makeId`](../../src/adapters/identity/ids.ts): prefix, seven random base-36
characters and time. This makes collisions unlikely, not impossible. Missing
comment, reply, person and shot ids in old files instead use
[`createLoadIds`](../../src/core/document/load-ids.ts), derived from the canonical
source hash and a per-kind counter in `migrateRows`; the same source repairs the
same entries to the same ids. These are load/repair identities, not independent
posted-record ids. Existing records changed after creation use per-field conflict
resolution; the whole-record loss above specifically concerns competing creates.
Status events are separate records and survive record removal/recreation;
"initial status" in the table means the scalar carried inside the new record,
not later causal status events.

## Evidence boundaries

T11's comment and reply record portions reproduce the copied literal oracles over
all six delivery schedules with encoded late joiners. Its overlapping marks,
split/removal recovery and restoration need marks, structure, recovery and undo.
The existing T21 causal status tests remain part of package 5d's first PR.
Hand-written hydration and command fixtures cover all seven roots plus scalars;
the generator independently models status, author-only edits and reply order
from the command list, and compares settled readings with encoded reloads.
