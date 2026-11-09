# Stage 0 artifact 8: schema hypotheses, expected traces and supported-API questions

The two schema candidates as buildable layouts, the three buffer mechanisms, every Stage 1 trace with its expected result written by hand, the predicted failures, the checker's deliberate defects, and the Yjs and Hocuspocus behaviours the prototype relies on, checked in package source. It selects nothing; selection is a Stage 1 output.

Baseline commit: `0ca1929177ffc84bced412ad2be3aa99690761d0`. Package source read: `yjs@13.6.33`, `@hocuspocus/server@4.8.0`, `@hocuspocus/provider@4.8.0`, `y-protocols@1.0.7`, `y-indexeddb@9.0.12` (from `npm pack`, 2026-11-09). Both Hocuspocus packages declare peer `yjs ^13.6.8` and `y-protocols ^1.0.6`.

## Today's model, as the candidates must reproduce it

| Fact | Where | Serves |
| --- | --- | --- |
| A beat is a row `{id, audioText, visualText, imageRef, imageLinks, moreImages, status, lengthSeconds?, paragraphStart?, updatedAt?, updatedBy?}`; cells are canonical HTML of runs | `src/core/document/validated.ts` `DocumentRow`, `src/core/document/fields.ts` `ROW_FIELDS` | PROJ |
| A scene is `{id, name, firstSceneId}`; name at most 200 characters, plain text, no tags or comments | `src/core/document/scenes.ts` `DocumentScene`, `src/core/flow/flow.ts` `SCENE_NAME_MAX`, `finalizeHeading` | T08, PROJ |
| The flow surface edits narration (`audioText`) only; headings edit `scene.name` | `src/core/flow/flow.ts` `writeCell`, `renameHeading` | T01–T09 |
| Split: `splitCell` at the caret, new row after with a minted id | `flow.ts` `splitBeat`, `startBeat` | T05, T12 |
| Join: narration `joinCells(a, b, glue)` with one space unless `a` ends in whitespace; visuals joined as stored HTML `first + "<br>" + second`; pictures combined, deduplicated by sha256; status takes the higher rank; refused across a scene header or over 61 pictures | `flow.ts` `joinWithPrevious`, `joinedVisualText`, `joinedPictures`, `STATUS_RANK` | T06, T07 |
| Remove header: the scene name becomes the narration of a new beat before the scene's first beat, which gets `paragraphStart` | `flow.ts` `removeHeader` | T08 |
| Create header from `# name`: the name is copied into `scene.name`, `# ` and the name are deleted from narration; an emptied beat is removed | `flow.ts` `finalizeHeading` | T08 |
| Cross-beat replace: fully covered beats are removed, partly covered beats lose the range, a beat holding the selection start may be replaced by a fresh row | `flow.ts` `replaceRange` | T09 |
| Marks per run: `b i u s hl dir` (true), `href` (string), `tag` (registry id) plus `innerTags` (outer to inner), `cmt` (sorted ids). Across one tag stretch `cmt` is the union, `href` the first found, `dir` if any | `docs/DOCUMENT-MODEL.md` §3, `normalizeCell` in `src/core/text/runs.ts` | T20, T11 |
| Typing at a tag edge carries neither `tag` nor `innerTags` | `docs/DOCUMENT-MODEL.md` §3 "Nested containment" | T20 |
| Comment anchor = runs carrying its id; `rowId`/`field` derived: first marked cell in document order | `src/core/text/anchors.ts` `syncCommentAnchors` | T11 |
| Typing groups 1 s, 200 entries | `src/application/editing/undo/history.ts` `COALESCE_MS`, `MAX_ENTRIES` | T12, T21 |
| Painting into a focused beat restores the caret; repaint is owed, not done, while composing | `src/features/writer/flow-surface.ts` `repaint`, `remapForRepaint`; the per-element `rendered` map is each beat's last painted HTML | T01, T02, T04 |
| Ordinary typing goes native, then the whole beat is decoded back to runs | `flow-surface.ts` `syncBeatEl` | T01–T04, SLICE |

## Notation

| Symbol | Meaning |
| --- | --- |
| S, A, B, C | Seed writer (clientID 10), Alice (1), Bob (2), Carol (3, late joiner). The fixture sets `doc.clientID` explicitly |
| `abcd = s1..s4` | Characters and their identities, in order. `a1` is Alice's first new character, `b1` Bob's |
| `R1 "ab"` | Beat R1 with narration `ab`. `V(R1) "v"` is its visual text. `#H1 "In"` is a scene heading |
| `⟦R2⟧`, `⟦#H1⟧` | Candidate A boundary atom (a `Y.Text` embed); in Candidate B the same boundary is a cut record |
| `x̂` | A character restored by undo: Yjs re-creates it with a new id linked from the old one (`redoItem`) |
| Same-gap rule | Concurrent insertions with the same left origin are ordered by clientID, lower first (`yjs` `Item.integrate`, case 1). So with A=1, B=2, Alice's insertion lands left of Bob's |
| D1 | Full concurrency: each client applies its own operations, then updates are exchanged |
| D2 | Sequential: Alice's updates reach Bob before Bob acts |
| D3 | Hazard order: Bob's update reaches Alice's replica after her buffer started and before it commits |
| dup | Every update delivered twice |
| rev | Updates from one client delivered in reverse creation order (Yjs holds the later one pending) |
| late-C | Carol joins after all operations, from the server state or a third replica's state only |

## 1 Candidates as concrete layouts

### Shared layer (both candidates)

| Root (`doc.getMap`/`getText` name) | Type | Holds | Serves |
| --- | --- | --- | --- |
| `beats` | `Y.Map<rowId, Y.Map>` | Per-beat scalars: `status` (LWW), `lengthSeconds` (LWW), `paragraphStart` (LWW, written only by explicit commands), `joinedInto` (rowId or absent), `glue` (`" "` or `""`, set with `joinedInto`), `removed` (removal id or absent), `stamp` (see edit stamps). No narration, no visual | T05–T10, PROJ |
| `visuals` | `Y.Map<componentId, Y.Map{text: Y.Text, beat: rowId, rank: string}>` | Visual text as components. A beat's `visualText` = its components ordered by `rank`, empty ones skipped, joined with `<br>` (today's `joinedVisualText`) | T06, T07 |
| `gallery` | `Y.Map<itemId, Y.Map{beat, rank, ref, name, annotation, links}>` | Pictures and links as items owned by a beat; `ref` keeps the sha256 reference, bytes outside Yjs. A link's `location` is not here (per-device table) | T06, T16 |
| `comments` | `Y.Map<commentId, Y.Map{author, createdAt, text, quote, resolved, resolvedAt, resolvedBy, assignee}>` | Comment records; anchor is the `c:<commentId>` attribute on characters; `rowId`/`field` derived | T11, T21 |
| `replies` | `Y.Map<replyId, Y.Map{commentId, author, createdAt, text}>` | Replies; display order `(createdAt, replyId)` | T11 |
| `people`, `tags`, `shots` | `Y.Map<id, Y.Map>` with a `rank` field | Registry records (people, `productionTags`, `brollShots`); array order derived from `rank` then id | PROJ |
| `meta` | `Y.Map` | `title` (`Y.Text`), `titleOrigin`, `titleVersion`, `wordsPerMinute`, `targetSeconds`, `paragraphsDecided` (true-if-either: only ever set), `schemaVersion` | PROJ |
| `removals` | `Y.Map<removalId, Y.Map{kind, by, at, observed, atoms, beats, components}>` | Durable structural-removal record: `kind` (`beat`, `range`, `header`, `became-heading`), `observed` = identity ranges `[{client, clock, len}]` of the characters the user saw removed (read through relative positions, §6 Y1), the boundary ids and visual components involved | T09–T11 |
| Character attributes | on every `Y.Text` | `b i u s hl dir` (true), `href` (string), `c:<commentId>` (true; one key per comment), `t:<occurrenceId>` (`{tag: registryId, parent: occurrenceId or null}`; one key per tag occurrence) | T11, T20, T21 |
| Awareness | outside the document | Participant name and connection state | S2 |

Soft removal: deleting a whole beat sets `beats[R].removed` and writes a `removals` record; its characters and components stay live in Yjs. Range deletion inside beats is a real Yjs delete of the observed identities. Restoring or undoing a removal clears the field; nothing is re-inserted.

Join: sets `beats[R2].joinedInto = R1` and `glue`, reassigns R2's components (`beat = R1`, `rank` after R1's last) and gallery items. No character is copied, no boundary deleted. The glue is a projected character, not stored text; deleting it is a command that sets `glue: ""`.

### Candidate A: one document-wide sequence

| Element | Representation |
| --- | --- |
| Narration and heading text | One root `Y.Text` `flow`. Characters carry the attributes above |
| Beat start | Embed `{b: rowId}` (`insertEmbed`, `ContentEmbed`). A beat is its atom plus the characters up to the next atom |
| Scene start | Embed `{h: sceneId}`. Heading text is the characters between `⟦#H⟧` and the next `⟦R⟧`; that beat is `firstSceneId` |
| B-roll key | Embed `{k: shotId}` inside narration |
| Line break | `"\n"` character |
| Split | Insert `⟦Rnew⟧` at the caret plus a `beats` record |
| Join | Shared layer join; `⟦R2⟧` stays in `flow` and projects as glue |
| Remove header | Delete `⟦#H⟧`, insert `⟦Rn⟧` at the same index: the heading characters become Rn's narration with their identities |
| Create header from `# name` | Delete `# `; insert `⟦#Hn⟧` before the name and, if text follows, delete the `"\n"` after the name and insert `{b: R2}` after the name, deleting the old `⟦R2⟧`. The row id survives in the embed JSON; the Yjs item is new |
| Beat identity | The `b` id in the embed. Two live atoms with one id: the first in document order wins, later ones project as glue-less joins |
| Second visual during a join | Component `V2` changes owner; another replica keeps typing into the same `Y.Text` |

### Candidate B: stable text segments with explicit membership

| Element | Representation |
| --- | --- |
| Text | `segments: Y.Map<segId, Y.Text>`; one segment per beat narration or heading at creation |
| Order | `order: Y.Array<segId>`. The only order authority |
| Beat and scene boundaries | `cuts: Y.Map<cutId, Y.Map{seg, at, kind, id}>`. `at` is a JSON relative position (`relativePositionToJSON`), `kind` is `beat` or `heading`, `id` the rowId or sceneId. A beat or heading runs from its cut to the next cut in (segment order, resolved index, cutId) order |
| Cut affinity | `assoc = 0` (attached to the character after the cut): text typed exactly at the cut stays before it, with the preceding beat |
| Split | Add a cut record at the caret plus a `beats` record. No text moves |
| Join, removal, visuals, marks | Shared layer |
| Remove header | Change the heading cut's `kind` to `beat` with a new rowId (a map write, no text moves) |
| Create header from `# name` | Delete `# `; add a heading cut before the name and a beat cut after it |
| Move a whole-segment beat | Delete and insert its `segId` in `order`; the `Y.Text` keeps its identity. A beat that is part of a segment must first be cut out into a new segment, which copies text: refused in shared mode until MOVE passes |

### Projection answers for merged states (both candidates)

| Merged state | Candidate A | Candidate B | Serves |
| --- | --- | --- | --- |
| Scene with no live beat | Heading kept visible; scene listed in recovery as "scene with no beats"; left out of `sections` export until a beat exists | Same | T08, T10, PROJ |
| Script with no live beats | Empty script shown; the first keystroke runs an explicit add-beat command. No synthetic row in the projection | Same | T09, T10 |
| Paragraph flag on a beat whose start is implicit, joined or removed | Ignored by the projection; stored value untouched; exports write it only for visible beats | Same | PROJ |
| Duplicate b-roll key id (INV-54) | First key in document order keeps the id; later ones project with a derived id `<id>~<client>.<clock>` of the atom's Yjs id, unanchored in the shot list; an explicit command may persist a new id | Same, key atom lives in the segment | PROJ |
| Comment mark on characters of two beats | Allowed as today; anchor = first marked cell | Same | T11 |
| Tag occurrence cut by a concurrent split | Each part projects as its own occurrence of the same registry tag | Same | T20, T05 |
| Crossing tag occurrences (INV-03) | Occurrences ordered by occurrence id; a later occurrence that crosses an accepted one projects untagged and appears in recovery | Same | T20 |
| Comment or link over part of a tag | `normalizeCell` rule: comment union over the whole tag stretch, first `href` found; shared state not rewritten | Same | T20 |
| Mark attribute on an atom or a heading character | Ignored; a comment only on heading characters is detached | Same (cut records carry no marks) | T08, T11 |
| Scene name over 200 characters after merge | Projected in full with a notice; further growth refused by the input rule | Same | T08 |
| Gallery over 61 pictures after merge | First 61 by `rank` shown; the rest listed in recovery, kept in state | Same | T06 |
| Tag attribute naming a deleted registry entry | Projected untagged (today's `normalizeCell` drops unresolved ids); recovery lists it | Same | T20 |
| Edit stamps (`updatedAt`, `updatedBy`, `rev`, `lastEditedBy`, `lastEditedAt`, `personColors`) | `beats[R].stamp = {by, at}` written once when a local typing group closes, never per keystroke; `rev` and `lastEdited*` absent from shared state and set at export; `personColors` derived from `people` | Same | PROJ, PERF |

### Hypotheses Stage 1 must confirm or refute

| Id | Hypothesis | Refuted by | Serves |
| --- | --- | --- | --- |
| A-H1 | Split, join, header removal and header creation never give a narration or heading character a new identity, except undo restores (`x̂`) | Checker finds a new-id character whose text equals a removed one in T05, T06, T08 | T05, T06, T08 |
| A-H2 | Soft removal keeps concurrent edits to a removed beat discoverable on every replica, late ones included, and undo restores without duplicates | T10 result differs from the table, or C's recovery differs from A's | T10 |
| A-H3 | Removal classified by observed identities: a beat created concurrently inside removed content is itself removed | T11 shows `cd` active | T11, T09 |
| A-H4 | Join as record fields gives one glue under two concurrent joins | T06 shows `ab  cd` | T06 |
| A-H5 | Visual components keep a remote visual edit in the joined beat | T07 shows `Q` outside R1's visual | T07 |
| A-H6 | Concurrent split and insertion at one gap are deterministic by clientID | T05 differs across delivery orders | T05 |
| A-H7 | Capture and projection per keystroke stay beat-local on one document-wide `Y.Text` | PERF under T02 on the 2 MiB fixture exceeds the Stage 0 input budget; `createRelativePositionFromTypeIndex` walks from the type start (§6 Y1) | T02, PERF |
| A-H8 | Per-id attribute keys plus the projection rules give the same well-formed nesting everywhere | T20 differs across replicas or crosses | T20 |
| A-H9 | `UndoManager` scoped to the local origin reverts only local changes, keeps typing groups with `stopCapturing`, and a no-op undo is detectable | T12, T21; §6 Y7 skip observed | T12, T21 |
| A-H10 | Projection derives `rows`, `sections`, `firstSceneId`, paragraph flags and exports; canonical fixtures round-trip | Any field differs after round-trip | PROJ |
| A-H11 | A duplicated `b` id in two atoms resolves first-wins with no visible duplicate | T08 create-header race, T12 redo race | T08, T12 |
| B-H1 | Cut affinity, not clientID, decides where text typed at a split point goes | T05 differs across client id swaps | T05 |
| B-H2 | Whole-segment moves keep identity and a concurrent edit | MOVE loses `X` | MOVE |
| B-H3 | `order` plus cut positions is the only order authority; no projection needs a second order | T05 two splits, T08 | T05, T08 |
| B-H4 | A cut whose anchor character is deleted still resolves (deleted items keep their place until their parent is collected, §6 Y8) | T09, T01 at a boundary: a cut resolves to `null` | T09 |
| B-H5 | Cross-segment selection maps to per-segment deletes in one transaction | T09 | T09 |
| B-H6 | Per-keystroke cost local to one segment | PERF | PERF |
| B-H7 | Undo of a split deletes its cut record; redo restores it by map key | T12 | T12 |
| B-H8 | Shared-layer hypotheses A-H2, A-H3, A-H4, A-H5, A-H8, A-H9, A-H10 hold unchanged | Same traces | T06–T11, T20, T21, PROJ |

## 2 Buffer mechanisms for the stale-base experiment

A buffer starts at the first native input in a beat after its last paint, or at `compositionstart`. All three capture the epoch, beat or heading id, the last painted HTML from the surface's `rendered` map, the selection as relative positions, the intended operation for intercepted keys, and the local undo group.

| Mechanism | Also captured at buffer start | Commit | Expected failures | Serves |
| --- | --- | --- | --- | --- |
| M1 Deferral, one document | Replica state vector; inbound updates from then on go to a bounded queue instead of `applyUpdate` | Diff DOM against the painted base (today's `syncBeatEl` decode) into operations at base indices; apply them in one local-origin transaction on the unchanged replica; then apply queued updates in arrival order; repaint | The provider applies sync messages straight to its document (`MessageReceiver.applySyncMessage`), so a real provider path bypasses the queue unless wrapped (§6 H11); every other inbound path must be gated too (hydration, recovery restore); a long composition grows the queue to its bound and must force a commit; save status and presence lag while held; the plan's "replica accepts remote updates during composition" rule changes | T01, T02, T04 |
| M2 Immediate integration, identity mapping | The Yjs id of every character and atom in the base (one pass of relative positions, §6 Y1) and the caret's left-neighbour id | Diff DOM against base; a deletion deletes exactly the base ids still live; an insertion goes right after its base left neighbour's current index (or that neighbour's nearest live left base character); then `repaint()` the beat with the caret restored from its relative position, before the next native input. Outside composition, remote changes are painted at once | Per-character id capture walks the type from its start: O(document) per capture in Candidate A (A-H7); deletedness has no documented check (§6 Y2); an insertion whose left neighbour was removed by a remote structural edit has no target and must go to recovery; caret restore during typing bursts; the DOM diff can be ambiguous with repeated text (T03) | T01–T04, PERF |
| M3 Deferral through two documents | As M1, on the editor document E. The provider holds network document N | E applies the commit; E's local-origin updates are forwarded to N only when image ordering allows; N's inbound updates are forwarded to E only while no buffer is dirty (`applyUpdate(E, u, NET)`); forwarding is idempotent | Double memory and update work; the replica to persist is ambiguous (N holds received updates E has not seen, E holds local updates N has not released): both must be stored, and a crash between them must be tested; echo loops if the origin filter is wrong; text typed after a held image waits (Yjs per-client order); queue bounds as M1 | T01, T04, T16, STORE |

Run order (plan §4): T04 composition first under M1, M2 and M3, then T01, then T02 across a beat boundary, with repeated text (T03) and through undo. M2 starts from today's `repaint()` and `rendered` map and is measured first.

Stale-base defect for all three: commit the whole beat from DOM HTML against the current replica (today's whole-beat sync). T01 must then fail with `ad`.

## 3 Trace table

Expected results hold for every listed delivery order unless a row says otherwise. Candidate columns differ only where noted "A:" / "B:".

### Stage 1a: editing feasibility (two replicas and the deterministic queue, no server)

| Serves | Initial | Operations in order | Delivery | Expected visible script | Recovery | Undo outcome | Entry paths |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | `R1 "abcd" = s1..s4` | A: buffer starts on painted `abcd`; A deletes `bc` (selection, Backspace; composition variant: composes `β` over `bc`). B: inserts `X` between `b` and `c`. A commits | D1, D3, dup, rev, late-C; under M1, M2, M3 | `R1 "aXd" = s1 b1 s4`. Composition variant: `R1 "aβXd" = s1 a1 b1 s4` | empty | A undo: `R1 "abXcd" = s1 ŝ2 b1 ŝ3 s4` (each restore goes back beside its old place, so `X` stays between them); variant: the same, `β` removed | |
| T02 | `R1 "ab" = s1 s2`; A's caret at end of R1 | B: inserts `X` at R1 offset 0. A's replica has it, R1 not repainted. A types `c` | D3, dup, late-C; M1, M2, M3 | `R1 "Xabc" = b1 s1 s2 a1`; A's caret after `c` (offset 4) | empty | A undo: `R1 "Xab"` | |
| T02 boundary | `R1 "ab"`, `R2 "cd"`; A's caret at R2 offset 0 | B: appends `Y` to R1. A types `Z` | D3 | `R1 "abY"`, `R2 "Zcd"` | empty | A undo: `R2 "cd"`, `R1 "abY"` | |
| T03 | `R1 "the the" = s1..s7` | B: bolds `the` = s1..s3. A: caret at end, Backspace ×4 (deletes s4..s7 by caret evidence, not by text diff) | D1, D3 | `R1 "the"` = s1..s3, bold | empty | A undo: `R1 "the the"`, first `the` bold | |
| T03 replace | `R1 "the the" = s1..s7` | A: selects second `the` (s5..s7), types `a`. B: appends `n` after s7 | D1, D3, dup | `R1 "the an" = s1..s4 a1 b1` | empty | A undo: `R1 "the then"` | |
| T04 | `R1 "abcd" = s1..s4`, `R2 "ef"`; both surfaces (flow and Split view) | A: `compositionstart` after `b`, composes `xy`. During it B inserts `Z` at R1 offset 0 and deletes `d`. A: `compositionend` | D3, dup, late-C; M1, M2, M3 | `R1 "Zabxyc" = b1 s1 s2 a1 a2 s3`, `R2 "ef"` | empty | A undo: `R1 "Zabc"` | |
| T04 removed | as T04 | During A's composition B removes beat R1. A ends composition | D3, late-C | `R2 "ef"` only | `R1 "abxycd"` removed by Bob; `xy` marked as Alice's edit after removal | A undo: `xy` leaves the recovery copy; recovery shows `R1 "abcd"` | |
| T05 | `R1 "abcd" = s1..s4` | A: Enter at `b|c` (split, new beat Ra). B: types `X` at the same gap | D1, dup, rev, late-C | A: `R1 "ab"`, `Ra "Xcd"` (Alice's atom sorts left of `X` by clientID); with clientIDs swapped `R1 "abX"`, `Ra "cd"`. B: `R1 "abX"`, `Ra "cd"` in both id orders. A's caret at Ra 0; B's caret after `X` | empty | A undo: `R1 "abXcd"` | |
| T05 two splits | `R1 "abcd"` | A and B both press Enter at `b|c` | D1, dup, rev, late-C | Provisional: `R1 "ab"`, `Ra ""`, `Rb "cd"` (both breaks visible; A: Ra left by clientID; B: cuts ordered by cutId). Alternative: the empty concurrent beat is hidden, `R1 "ab"`, `Rb "cd"` | empty | A undo: `R1 "ab"`, `Rb "cd"` | |
| T06 | `R1 "ab"` `V(R1) "v"`; `R2 "cd"` `V(R2) "w"`, picture `P` (sha `p`) on R2, status `ready` | A and B both join R2 into R1 | D1, dup, rev, late-C | `R1 "ab cd"` (one space), `V(R1) "v<br>w"`, pictures `[P]`, status `ready` | empty | A undo: unchanged (Bob's identical join stands); provisional, see Decisions | |
| T07 | `R1` `V(R1) "v"`; `R2` `V(R2) "wz"` | A: joins R2 into R1. B: types `Q` in R2's visual between `w` and `z` | D1, D3, dup, late-C | `V(R1) "v<br>wQz"` | empty | A undo: `V(R1) "v"`, `V(R2) "wQz"` | |
| T08 remove | `R0 "x"`, `#H1 "In"`, `R1 "ab"` | A: Backspace at heading start. B: types `Z` at heading end and `Y` at R1 end | D1, D3, dup, late-C | `R0 "x"`, `Rn "InZ"` (heading characters keep ids), `R1 "abY"` with `paragraphStart`; no heading | empty | A undo: `R0 "x"`, `#H1 "InZ"`, `R1 "abY"` | |
| T08 create | `R1 "x"`, `R2 "# Ab"` (pending heading, starts a paragraph), `R3 "cd"` | A: Enter at end of R2 (becomes scene H2, R2 emptied and removed, R3 first beat). B: types `e` after `Ab` and `Q` at R3 start | D1, D3, dup, late-C | `R1 "x"`, `#H2 "Abe"`, `R3 "Qcd"`; `Ab` keep ids | empty (R2's removal kind `became-heading` is not listed) | A undo: `R1 "x"`, `R2 "# Abe"`, `R3 "Qcd"` | |
| T09 | `R1 "abc"`, `R2 "de"`, `R3 "fgh"` | A: selects R1 offset 1 to R3 offset 2, types `Z`. B: types `W` between `b` and `c`, `X` in R2 (`dXe`), `Y` between `g` and `h` | D1, D3, dup, late-C | `R1 "aZW"`, `R3 "Yh"` (same paragraph as R1) | `R2 "dXe"` removed by Alice; `X` marked as Bob's edit after removal | A undo: `R1 "abWc"`, `R2 "dXe"`, `R3 "fgYh"` | |
| T09 header | `R1 "ab"`, `#H1 "Cd"`, `R2 "ef"` | A: selects R1 offset 1 to heading offset 1, Backspace. B: types `Q` at heading end | D1, D3 | `R1 "a"`, `#H1 "dQ"`, `R2 "ef"` | empty | A undo: `R1 "ab"`, `#H1 "CdQ"` | |
| T10 | `R1 "ab"`, `R2 "cd"`, `R3 "ef"` | A: deletes beat R2. B offline: types `X` in R2 (`cXd`). B reconnects. C joins. A undoes the deletion | D1, dup, rev, late-C | Before undo: `R1 "ab"`, `R3 "ef"`. After undo: `R1 "ab"`, `R2 "cXd"`, `R3 "ef"`; no second `cd` anywhere | Before undo, on A, B and C alike: `R2 "cXd"` removed by Alice, `X` edited after removal by Bob. After undo: empty | as Expected | |
| T11 | `R1 "abcd"`, `R2 "ef"` | A: comment C1 on `bc`. B: comment C2 on `cd`. B receives C1, replies r1. A removes R1. B (not yet seeing it) splits R1 at `b|c` into R1 + Rb | D1, D2, dup, rev, late-C | `R2 "ef"` | Removed by Alice: `R1 "ab"` + `Rb "cd"` (split by Bob after removal); C1 on `b`+`c` across both, with r1; C2 on `cd` | A undo: `R1 "ab"`, `Rb "cd"`, `R2 "ef"`; C1 active, anchor R1; C2 anchor Rb; recovery empty | |
| T12 | `R1 "abcd"` | A: splits at `b|c` (R1, Ra). B: types `Y` at R1 end, `X` at Ra start. A undoes the split. A redoes | D1, dup, late-C | After undo: `R1 "abYXcd"`; caret between `Y` and `X`. After redo: `R1 "abY"`, `Ra "Xcd"` | empty | as Expected | |
| T12 join | `R1 "ab"`, `R2 "cd"` | A: joins. B: types `Z` after `c`. A undoes | D1 | After undo: `R1 "ab"`, `R2 "cZd"` | empty | as Expected | |
| T20 nest | `R1 "the red mug" = s1..s11` | A: tags `red mug` as Prop P (occurrence oA). B: tags `mug` as Sound S (oB) | D1, dup, late-C | `red mug` tag P with `mug` inner S (`tag: P, innerTags: [S]`) | empty | A undo: `mug` tag S only | |
| T20 cross | as above | A: tags `red mug` (oA). B: tags `the red` (oB) | D1, dup, rev, late-C | Provisional: `red mug` tag P; `the red` untagged on every replica. Alternative: `the` tagged S | Tag S on `the red` conflicts with Prop on `red mug` | B undo: recovery entry gone | |
| T20 mark | as above | A applies tag P. B, not yet seeing it: comment C1 on `mug`, link `http://x` on `red` | D1, D3 | Comment C1 and link projected over all of `red mug`; shared attributes unchanged | empty | B undo of C1: no comment; link stays | |
| T21 | `R1 "abcd"` | A: bolds `bc`. B (not seeing it): inserts `X` between `b` and `c`. A undoes the bold | D1, D3, late-C | `R1 "abXcd"`, no bold | empty | as Expected | |
| T21 comment | `R1 "abcd"` | A: comment C1 on `bc`. B: reply r1 to C1; comment C2 on `cd`. A undoes C1 | D2, late-C | `R1 "abcd"` with C2 on `cd` only | Provisional: r1 listed as "reply to a removed comment" | A redo: C1 back with r1 | |
| MOVE | `R1 "ab"`, `R2 "cd"`, `R3 "ef"` (B: each its own segment) | A: moves R3 before R1. B: moves R3 after R1 and types `X` in R3 (`eXf`) | D1, dup, late-C | A: refused in shared mode before any change (move would copy text). B: `R3 "eXf"`, `R1 "ab"`, `R2 "cd"` (first `order` entry wins) | empty | A undo of the move (B): `R1`, `R3 "eXf"`, `R2` | |

### Stage 1b: service feasibility

| Serves | Initial | Event sequence | Expected receipt, status (plan §8 wording) or refusal | Entry paths |
| --- | --- | --- | --- | --- |
| T13 | Owner's standalone script, generation g0 `R1 "abcd"`, image `P` | Collaborate (creation op id k). Upload of g0 and `P` starts. Owner types `X` (g1), `Y` (g2). Server commits the instance. Local replica built from g0 plus the g1–g2 journal. Retry of k after a lost response. Restart during upload | Server and local state `R1 "abcdXY"`, `P` durable. Retry returns the same pending instance; restart leaves the standalone file or a recoverable membership, never two instances. Guest join while pending: refused. Invitation shown only after both persistence contracts; then "Your changes saved to server" after the receipt covering g2 | |
| T14 | Barriers. Connection K1, server sequence 0 | u1 accepted (seq 1); store S1 captures `{state, seq 1}` and is slow. u2 = delete of one character (seq 2; state vector unchanged). Flush f1 (requires 2). S1 completes. S2 captures seq 2, completes | No receipt on S1. Receipt for f1 on S2, reporting captured seq 2. Status "Saved on this device, sending" until then, then "Your changes saved to server" | |
| T15 | Barriers, K1 | f1 requires 3, f2 requires 5. f2's store completes first: coverage 5. f1's late completion (3) arrives. K1 closes; K2 opens; local edit u6 unsent; a receipt for f3 tagged K1 arrives | Coverage stays 5 after the late f1; f1 counts as covered. The K1 receipt changes nothing; u6 pending: "Saved on this device, sending" until a K2 barrier covers it | |
| T16 upload-before-sync | A online, then offline. `R1 "ab"` | A inserts image `P` in R1 offline (blob stored and verified locally, then the record), types `Z`. Reconnect | While offline: "Offline, saved on this device". Online, upload pending: "Saved on this device, waiting for images to upload"; neither `P`'s reference nor `Z` reaches N or the server, including the provider's initial full-state exchange. After `P`'s membership is durable: document sync released, then "Your changes saved to server" | |
| T16 pending-image | as above | as above | The reference reaches the server marked pending with `Z`; B shows a placeholder for `P`. A: "Saved on this device, waiting for images to upload" until `P`'s bytes and membership are durable; no client shows `P` saved before that; then "Your changes saved to server". If A never returns: B keeps the placeholder; export discloses the missing image | |
| T17 | A and B edited; last receipt covers `R1 "abcd"` and `P` | All clients leave. Server killed, restarted. C joins with a valid invitation | C loads `R1 "abcd"` and `P` from journal, checkpoint and blobs; editing enabled after hydration; C's status "Saved on this device" (nothing of C's pending) | |
| T18 | Instance open on K1 | (a) Frame over the configured payload limit. (b) Truncated update (delete set cut short). (c) Update pushing total state over the limit. (d) Rate above the limit | (a) Socket closed before processing. (b) Refused in `beforeSync` before the journal; nothing broadcast; connection set read-only, answered "not applied". (c) As (b), permanent. (d) Temporary refusal, retried after backoff. Never "Your changes saved to server" for the refused update; user told how to export and rejoin (wording: Decisions) | |
| T19 | Device holds rejected update u_bad (permanent) and u_tmp (temporary: its image not yet durable) | Reconnect: provider sends SyncStep1; server answers SyncStep2 and SyncStep1; provider answers SyncStep2 containing u_bad and u_tmp | u_bad refused again in `beforeSync`; client stops automatic publication after the first permanent refusal (provider detached), keeps work exportable: no reconnect loop. u_tmp accepted once its image is durable | |
| T22 | Journal in `beforeSync` | A sends u1. `beforeSync` commits u1's bytes to SQLite, returns. Server applies, sends status "applied". Server SIGKILL before the 2 s store | Provider count 0; "Your changes saved to server". After restart the journal replays u1. Defect: status sent before the journal commit makes the checker fail | |
| T23 | u1 acknowledged, u2 sent unacknowledged, u3 queued while the socket was closed (dropped by the provider) | Reconnect: count reset to 1; SyncStep2 from the provider carries u2 and u3; server journals and acknowledges | "Your changes saved to server" covers u1 only until that acknowledgement; then u1–u3. Saved generation advances by the application's own FIFO matching, never by the provider count alone | |
| T24 | Browser tab 1 holds the Web Lock for (deployment, instance) | Tab 2 opens the instance; tab 1 crashes; tab 2 retries | Tab 2 refused or read-only with an explanation; after the crash the lock is released, tab 2 becomes writable after hydration; every write tab 1 reported saved is present | |

## 4 Expected failure traces

| Under | Expected to break | Why | Serves |
| --- | --- | --- | --- |
| Candidate A | T05 (product, not correctness) | Text typed at a split point goes left or right by clientID; Alice and Bob see the rule as arbitrary | T05 |
| Candidate A | PERF in T02 | Identity capture and index lookups walk one `Y.Text` holding the whole script | T02, PERF |
| Candidate A | T08 create, T12 redo | Re-inserting `{b: R2}` can leave two atoms with one id under a race; relies on first-wins | T08, T12 |
| Candidate A | MOVE | Moving text copies it; a concurrent edit stays with the removed original | MOVE |
| Candidate B | T05 two splits, T09 | Cut ordering at one resolved index needs the cutId tiebreak; a cut anchored to a deleted character must still resolve | T05, T09 |
| Candidate B | T08 create | Heading creation in the middle of a segment adds two cuts and a delete; three writes must land in one transaction | T08 |
| Candidate B | T12 | Undo of a cut-record insertion is a map-key delete; redo is re-creation of the key, which a concurrent overwrite blocks (§6 Y7) | T12 |
| Both, without soft removal | T10, T11 | Text inserted into a deleted nested type is deleted on arrival and never redone by undo (§6 Y6); with `gc: true` it is gone | T10, T11 |
| Both, copy-on-join | T07 | Bob's `Q` lands in the original R2 visual, not the joined one | T07 |
| Both, glue as a character | T06 | Two joins insert two glue spaces | T06 |
| Both, implicit attribute inheritance | T20, T11 | `Y.Text.insert` without attributes copies every attribute at the position, including `c:` and `t:` keys (§6 Y12) | T20, T11 |
| Both, `UndoManager` defaults | T12, T21 | 500 ms capture merges across beats; a no-op stack item makes one Ctrl+Z undo an older action (§6 Y7) | T12, T21 |
| M1 | T04 with a real provider, T16 | The provider applies inbound sync without a hook; deferral needs a wrapped or second document | T04, T16 |
| M1, M3 | T04 long composition | Queue reaches its bound while composing | T04 |
| M2 | T03 | Repeated text makes the DOM diff ambiguous without caret or target-range evidence | T03 |
| M2 | T04 removed | The buffered insertion's left neighbour is gone; mapping must route it to recovery, not to a neighbour | T04 |
| M3 | STORE restart | Crash between persisting N and E loses either received or local updates | STORE |
| Write-ahead journal | T18 (b) | Without a `beforeSync` decode check the built-in path acknowledges an undecodable update as applied (§6 H2) | T18, T22 |
| Write-ahead journal | T23 | Status acknowledgements carry no id; a dropped queued update breaks naive counting | T23 |
| Barriers | T15 | Stateless callbacks are not awaited; completions reorder | T15 |

## 5 The checker's deliberate defects

| Defect | Injection | Trace that must fail | Serves |
| --- | --- | --- | --- |
| Lost remote character | Binding commits the whole beat from DOM (stale whole-beat sync) | T01 (`ad` instead of `aXd`), T02 (`abc`) | T01, T02 |
| Duplicated identity | Join copies R2's narration into R1 as new characters and soft-removes R2 | T06 (recovery shows `cd` as removed) and T10 undo (`cd` twice) | T06, T10 |
| Omitted field | Projection drops `lengthSeconds` (and separately `paragraphsDecided`) | PROJ round-trip of the canonical fixtures | PROJ |
| Stale base | M2 maps a deletion by base offsets instead of base ids | T01 (`aXd` becomes `abd` or `ad` depending on order) | T01 |
| Lost mark | Insert without explicit attributes, then strip all `c:` keys from typed text after the fact (or projection ignores `t:` keys) | T20 nest (inner tag missing), T21 comment | T20, T21 |
| Premature receipt | Send the "applied" status before the journal commit returns, or let a barrier accept an older snapshot's sequence | T22 (u1 missing after kill), T14 (receipt on S1) | T22, T14 |

## 6 Supported-API questions

Risk: **public** = documented API; **exported** = exported but undocumented low-level; **internal** = needs fields or functions outside the export (a feasibility risk per plan §4).

| Id | Question | What the source says | Prototype must still prove | Risk | Serves |
| --- | --- | --- | --- | --- | --- |
| Y1 | Can the binding read the identity of each character a selection covered? | `yjs@13.6.33` `utils/RelativePosition.js` `createRelativePositionFromTypeIndex(type, i, 0).item` is the id `{client, clock + offset}` of the live character at index `i`; the walk starts at `type._start` each call | Capture of a whole beat in one pass; cost on the 2 MiB fixture in Candidate A | public | T01, T03, T09, PERF |
| Y2 | Can it tell whether a captured character was deleted? | `createAbsolutePositionFromRelativePosition` returns the position a deleted character occupied, without saying it is deleted; it returns `null` only when the struct was replaced by a GC struct. `isDeleted(ds, id)` and `createDeleteSetFromStructStore(store)` are exported but need `doc.store` | Use a fresh id scan and set difference instead; prove equal results | exported (`doc.store` internal) | T01, T04 |
| Y3 | Relative positions and deleted anchors | Same function, `followUndoneDeletions = true` by default follows `redone` links, which only the undoing client knows (yjs issue 638) | Stored and shared positions (cuts, presence) pass `false`; local caret restore may pass `true` | public | T12, T05 |
| Y4 | Can an insertion choose its side relative to a concurrent one? | No. `structs/Item.js` `integrate` orders same-origin insertions by clientID, lower left | T05 outcome per candidate | public behaviour | T05 |
| Y5 | `UndoManager` scope and tracked origins | `utils/UndoManager.js` constructor: `trackedOrigins` default `{null}` plus the manager; a transaction is captured only if its origin (or its constructor) is tracked; `captureTimeout` default 500 ms merges any captured transaction in the window regardless of beat; `stopCapturing()`; `stack-item-added/popped` carry `meta` for selections; no size limit option (`undoStack` is a plain array) | Local origin object, 1 s groups via `captureTimeout: 1000` plus `stopCapturing` on word and cell changes, manual 200 limit, redo cleared on new local change as today | public | T12, T21 |
| Y6 | What does undo of a deletion restore? | `structs/Item.js` `redoItem` creates a new item with the local clientID and copied content, linked by `redone`; a nested type is re-created empty and its children redone into it; an item inserted remotely into a deleted parent is deleted on integrate (`Item.integrate`, "delete if parent is deleted") and is not in the stack item, so it is not restored | Soft removal avoids both effects; checker accepts `x̂` restores as non-duplicates | public behaviour | T10, T12 |
| Y7 | What if the undone value was overwritten remotely? | `redoItem` for a map key returns `null` when a newer value exists (unless `ignoreRemoteMapChanges`); `popStackItem` keeps popping while nothing changed, so one `undo()` can revert an older stack item | Detect empty pops (`undo()` result, `stack-item-popped`) and stop; product rule in Decisions | public behaviour | T06, T12, T21 |
| Y8 | Does deleted text survive for recovery? | `Doc` option `gc` defaults true; `utils/Transaction.js` cleanup runs `tryGcDeleteSet`: a deleted item not `keep` and passing `gcFilter` gets `ContentDeleted`; it becomes a `GC` struct only when its parent is collected. `UndoManager` sets `keep` on its own deletions. Server default `yDocOptions: {gc: true}` (`Hocuspocus.ts` `defaultConfiguration`) | Recovery never relies on tombstones; growth of soft-removed text measured | public | T10, T11, T17 |
| Y9 | Do candidates need snapshots or subdocuments? | Snapshot rendering of deleted text (`YText.toDelta(snapshot, prevSnapshot)`) needs `gc: false`. Subdocuments need `shouldLoad`/`autoLoad` and a provider per document; Hocuspocus syncs one `Y.Doc` per provider | Neither candidate uses them; keep it so | public | T10 |
| Y10 | Embeds as structural atoms | `types/YText.js` `insertEmbed(index, Object or AbstractType, attributes)`; `toDelta` returns `{insert: object}`; `format` applies to embeds too | Projection ignores marks on atoms; embed JSON immutable | public | T05, T08 |
| Y11 | One attribute key per comment and tag occurrence | `format(index, length, attributes)` writes one `ContentFormat` per key; concurrent writes to one key leave one winner per character; keys are free strings | Cost of many keys on long texts; `cleanupYTextFormatting` exported | public | T11, T20 |
| Y12 | Does typed text inherit marks? | `YText.insert` without `attributes` copies every attribute at the position (`pos.currentAttributes`) | Always pass explicit attributes computed from Splitpage rules (no `t:` at edges) | public | T20, T11 |
| Y13 | Can an update be validated without applying it? | `utils/updates.js` `decodeUpdate`, `parseUpdateMeta`, `encodeStateVectorFromUpdate` work on bytes. `utils/encoding.js` `readUpdateV2` integrates structs before reading the delete set, so a corrupt tail can leave a partial apply; missing dependencies sit in `store.pendingStructs` / `pendingDs` with no public signal | Decode fully in `beforeSync` before journal or apply; detect missing dependencies by comparing `parseUpdateMeta(u).from` with the server state vector | exported; pending state internal | T18, T19 |
| Y14 | Do pure deletes advance the state vector? | Deletes travel in the delete set; `encodeStateVector` counts inserted clocks only | Receipt by sequence, shown with a delete-only update | public | T14 |
| Y15 | y-protocols error handling | `y-protocols@1.0.7` `sync.js` `readSyncStep2` (and `readUpdate`, the same function) catches any error from `applyUpdate`, logs it, and returns normally unless an `errorHandler` is passed | See H2 | public | T18 |
| H1 | Does `beforeSync` see the raw bytes before apply? | `@hocuspocus/server@4.8.0` `MessageReceiver.readSyncMessage` awaits `connection.callbacks.beforeSync(connection, {type, payload: message.peekVarUint8Array()})` before `readSyncStep1/2` or `readUpdate`; `Connection.processMessages` awaits each message in turn. `type` 0 carries a state vector, 1 and 2 an update | Journal commit cost per update on the deployment disk (plan §8 proof 1) | public | T22 |
| H2 | Status message values | `readSyncMessage` sends `writeSyncStatus(true)` after `readSyncStep2` and after `readUpdate`. Because Hocuspocus passes no `errorHandler` (Y15), an update that throws is still answered "applied". Read-only: an update message is always answered "not applied"; a SyncStep2 is answered "applied" if `snapshotContainsUpdate` says it adds nothing, else "not applied". An update with missing dependencies is answered "applied" while its structs wait pending | Refuse undecodable input in `beforeSync` (plan §8 proof 2); journal and receipt must treat "pending" updates explicitly | public | T18, T22 |
| H3 | Provider's unacknowledged count | `@hocuspocus/provider@4.8.0` `HocuspocusProvider.documentUpdateHandler` increments `unsyncedChanges` per update (per batch with `flushDelay`); `startSync` calls `resetUnsyncedChanges()` which sets 1; `MessageReceiver.applySyncStatusMessage` decrements only on "applied"; "not applied" changes nothing and emits nothing | Application matches acknowledgements FIFO per connection; detects "not applied" through a server stateless message (H8), not the count | public | T19, T23 |
| H4 | Are unsent updates dropped on close? | `HocuspocusProviderWebsocket.send` queues while the socket is not open (`addToQueue`); the queue is emptied in `createWebSocketConnection`, `disconnect` and on close | The next SyncStep2 carries them again (T23) | public behaviour | T23 |
| H5 | Store hook errors | `Hocuspocus.storeDocumentHooks` catches, logs "Document stays in memory to avoid data loss", returns normally | Splitpage's own store code reports failure | public | T14, T22 |
| H6 | Store completion | `util/debounce.ts` `debounce` resolves when the timer is set; `executeNow` returns the run promise but `flushPendingStores()` discards it; `storeDocumentHooks(document, payload, true)` returns a promise that resolves after the store hooks, also after a logged failure; defaults 2 s / 10 s | Barriers never treat that promise as success | public method, undocumented | T14, T15 |
| H7 | `onChange` and broadcast order | `Hocuspocus.handleDocumentUpdate` calls `onChange` without await, synchronously from the document `update` event; `Document.handleUpdate` then broadcasts, batched with `setImmediate` by default (`flushDelay: 0`); the sender's status is written right after apply, so it can precede fan-out | Nothing is broadcast before `beforeSync` returns; journal-first therefore covers fan-out | public | T22, T18 |
| H8 | Stateless messages | Server: `MessageReceiver` stateless case calls `statelessCallback` without await; `Connection.sendStateless`, `Document.broadcastStateless`. Provider: `sendStateless`, `stateless` event | Barrier requests and refusal notices ride this path; out-of-order completion handled (T15) | public | T15, T19 |
| H9 | Read-only refusal without disconnect | `connection.readOnly` is a public mutable field checked after `beforeSync` in the same call; the connection stays open | Setting it inside `beforeSync` refuses that very update with "not applied" and no reconnect loop | public field | T18, T19 |
| H10 | Hook exceptions | `Connection.processMessages` catch: closes with the error's code or reset and empties the queue | Never used for permanent refusal (reconnect replays the update) | public | T18 |
| H11 | Can the app hold back the provider's initial full-state exchange? | `startSync` sends SyncStep1; the server answers SyncStep2 then SyncStep1; the provider answers with `Y.encodeStateAsUpdate(provider.document, serverStateVector)`; `documentUpdateHandler` sends every non-provider-origin update at once. No filter hook exists; only `attach()`/`detach()` | Hold through M3's network document N | public | T16, T19 |
| H12 | Per-connection revocation | `onAuthenticate` runs once per connection; `connection.context` holds what it set; `Hocuspocus.closeConnections(documentName)` closes a whole document; per connection: `document.getConnections()` filtered by context, then `connection.close()`. `close()` does not clear `messageQueue`, so already queued messages may still be applied after it | `beforeSync` rechecks a revocation flag; prove no queued update lands after revoke | public | T18 |
| H13 | Limits before processing | `ClientConnection`: `maxUnauthenticatedQueueSize` 5 MiB, `maxUnauthenticatedQueueMessages` 1000, `maxPendingDocuments` 100; `Server.ts` passes WebSocket server options such as `maxPayload`, applied before authentication | Values for T18 (a) | public | T18 |
| H14 | Loading does not re-trigger stores | `Hocuspocus.createDocument` applies what `onLoadDocument` returns, then registers `onUpdate` | Replay from journal on restart causes no store or broadcast | public | T17 |
| P1 | Local replica write completion | `y-indexeddb@9.0.12` `_storeUpdate` calls `idb.addAutoKey` without reporting completion | Own adapter (plan §8) | n/a | STORE |

## Open questions

| Question | Settled by | Serves |
| --- | --- | --- |
| Does a one-pass id capture of a beat in Candidate A stay under the input budget on the 2 MiB fixture, or does it need a beat-start index cache? | PERF run under T02 | T02, PERF |
| Does soft-removed text keep server and replica growth within the Stage 0 limits under repeated delete and restore? | Growth measurement with T10 looped | T10, PERF |
| Can M2 tell which repeated word a native deletion removed from `beforeinput` target ranges alone? | T03 under M2 in Chromium | T03 |
| Does setting `connection.readOnly` inside `beforeSync` refuse the current update in 4.8.0 as read (H9)? | T18 (b) in the 1b container | T18 |
| Does a revoked connection's queued update still apply after `close()` (H12)? | Revocation test in 1b | T18 |
| Is the M3 crash window between persisting N and E closable with one storage transaction? | STORE restart test | STORE, T16 |

## Decisions for Adam

| Decision | Assumed meanwhile | Serves |
| --- | --- | --- |
| Two people press Enter at the same point | Both breaks show, leaving an empty beat between; alternative: hide the empty one | T05 |
| Someone types exactly where another splits | Text stays with the words before it (Candidate B); Candidate A cannot promise a side | T05 |
| An edit to a beat someone else removed | Goes to recovery, not into a neighbouring beat | T04, T09, T10 |
| A beat split by someone after another removed it | The split parts stay removed | T11 |
| Two tags cross after merging | The later tag shows untagged and is listed in recovery; alternative: keep it on its non-overlapping words | T20 |
| A reply to a comment whose creation was undone | Kept in recovery as a reply to a removed comment | T21 |
| Undo when another person made the same change (both joined) | Nothing visible changes and the undo step is used up, with a short notice | T06, T12 |
| Edit stamps in shared mode | Beat `updatedAt`/`updatedBy` written once per typing group; `rev` and `lastEdited*` set only on export | PROJ |
| A scene left with no beats, or a script with none | Scene listed in recovery; empty script waits for the first keystroke | T10 |
| Wording for a refused update (T18, T19) | Not in the plan's status table; to be written with the status wording | T18, T19 |

## Doc mismatches

| Doc | Code | Serves |
| --- | --- | --- |
| `docs/COLLABORATION-PLAN.md` §8 and §10: a read-only connection is answered "not applied" for an update that carries new changes | 4.8.0 answers every update message "not applied" on a read-only connection; only SyncStep2 is checked with `snapshotContainsUpdate` | T18 |
| Same sections: the built-in acknowledgement means "applied in memory" | It is also sent when `applyUpdate` threw and the error was swallowed (Y15, H2) | T18, T22 |
