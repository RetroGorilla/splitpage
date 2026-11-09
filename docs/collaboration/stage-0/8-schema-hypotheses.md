# Stage 0 artifact 8: schema hypotheses, expected traces and supported-API questions

The two schema candidates as buildable layouts, the three buffer mechanisms, every Stage 1 trace with its expected result written by hand, the predicted failures, the checker's deliberate defects, and the Yjs and Hocuspocus behaviours the prototype relies on, checked in package source. It selects nothing; selection is a Stage 1 output.

The required outcomes (expected script, carets, recovery, undo outcome, receipts and status) are binding oracles: Stage 1 may change a layout or mechanism, never an oracle. The `Y`, `H` and `P` rows and every cell that says what a library does are predictions Stage 1 tests; each is marked `read` (from package source) or `run` (observed in a throwaway Node script against the packed packages, 2026-11-09). A row marked "oracle fixed, mechanism open" keeps its expected result while the layout that delivers it is a hypothesis below.

Baseline commit: `0ca1929177ffc84bced412ad2be3aa99690761d0`. Package source read: `yjs@13.6.33`, `@hocuspocus/server@4.8.0`, `@hocuspocus/provider@4.8.0`, `y-protocols@1.0.7`, `y-indexeddb@9.0.12` (from `npm pack`, 2026-11-09). Both Hocuspocus packages declare peer `yjs ^13.6.8` and `y-protocols ^1.0.6`.

## Today's model, as the candidates must reproduce it

| Fact | Where | Serves |
| --- | --- | --- |
| A beat is a row `{id, audioText, visualText, imageRef, imageLinks, moreImages, status, lengthSeconds?, paragraphStart?, updatedAt?, updatedBy?}`; cells are canonical HTML of runs | `src/core/document/validated.ts` `DocumentRow`, `src/core/document/fields.ts` `ROW_FIELDS` | PROJ |
| A scene is `{id, name, firstSceneId}`; name at most 200 characters, plain text, no tags or comments; a scene with an empty name is dropped on load | `src/core/document/scenes.ts` `DocumentScene`, `normalizeScenes`; `src/core/flow/flow.ts` `SCENE_NAME_MAX`, `finalizeHeading` | T08, PROJ |
| The flow surface edits narration (`audioText`) only; headings edit `scene.name` | `flow.ts` `writeCell`, `renameHeading` | T01–T09 |
| Split: `splitCell` at the caret, new row after with a minted id | `flow.ts` `splitBeat`, `startBeat` | T05, T12 |
| Join: narration `joinCells(a, b, glue)` with one space unless `a` ends in whitespace or either side is empty; the glue carries `href` only if both neighbours share it, the comments both neighbours carry, and `dir` if both are directions; visuals joined as stored HTML `first + "<br>" + second`; pictures combined, deduplicated by sha256; status takes the higher rank; refused across a scene header or over 61 pictures | `flow.ts` `joinWithPrevious`, `joinedVisualText`, `joinedPictures`, `STATUS_RANK`; `src/core/text/edits.ts` `joinCells` | T06, T07 |
| Remove header: the scene name becomes the narration of a new beat before the scene's first beat, which gets `paragraphStart` | `flow.ts` `removeHeader` | T08 |
| Create header from `# name`: the name is copied into `scene.name`; `# `, the name and the line break are removed from narration; an emptied beat is removed only if it has no visual text and no gallery item (`removeBeat = !cellLength(rest) && !ports.hasVisual(row)`; `hasVisual` in `src/bootstrap/wiring/writer.ts` checks both), else kept with empty narration; a removed beat leaves a blank beat when nothing follows | `flow.ts` `finalizeHeading` | T08 |
| Cross-beat replace: fully covered beats are removed, partly covered beats lose the range | `flow.ts` `replaceRange` | T09 |
| Marks per run: `b i u s hl dir` (true), `href` (string), `tag` plus `innerTags` (outer to inner), `cmt` (sorted ids). Across one tag stretch `cmt` is the union, `href` the first found, `dir` if any | `docs/DOCUMENT-MODEL.md` §3, `normalizeCell` in `src/core/text/runs.ts` | T11, T20 |
| Typing at a tag edge carries neither `tag` nor `innerTags` | `docs/DOCUMENT-MODEL.md` §3 "Nested containment" | T20 |
| Comment anchor = runs carrying its id; `rowId`/`field` derived: first marked cell in document order | `src/core/text/anchors.ts` `syncCommentAnchors` | T11 |
| Typing groups 1 s, 200 entries | `src/application/editing/undo/history.ts` `COALESCE_MS`, `MAX_ENTRIES` | T12, T21 |
| Repaint of a focused beat restores the caret by model position; owed, not done, while composing | `src/features/writer/flow-surface.ts` `repaint`, `remapForRepaint` | T01, T02, T04 |
| The surface's `rendered` map is a paint cache: `paint` reads it to skip unchanged beats, `syncBeatEl` overwrites it with the typed result. It holds no identities and is not an editor base | `flow-surface.ts` `rendered`, `syncBeatEl` | T02, T04, SLICE |
| Ordinary typing goes native, then the whole beat is decoded back to runs | `flow-surface.ts` `syncBeatEl` | T01–T04, SLICE |

## Notation

| Symbol | Meaning |
| --- | --- |
| S, A, B, C | Seed writer (clientID 10), Alice (1), Bob (2), Carol (3, late joiner). The fixture sets `doc.clientID` explicitly |
| `abcd = s1..s4` | Characters and their identities in order. Seed identities are numbered across the whole fixture. `a1` is Alice's first new item, `b1` Bob's |
| `s2*` | A character restored by undo (`read`): `redoItem` creates a new item with the undoing client's id and copied content and sets `s2.redone` to it (`yjs` `structs/Item.js` `redoItem`). It is a new identity, not `s2` |
| `R1 "ab"` | Beat R1 with narration `ab`. `V(R1) "v"` is its visual text. `#H1 "In"` is a scene heading |
| `⟦R2⟧`, `⟦#H1⟧` | A boundary embed (`{b: rowId}`, `{h: sceneId}`) in a `Y.Text` |
| `|` in a caret | `"a|Xd"`: the caret's place in the projected beat |
| Same-gap rule | `read`: concurrent insertions with the same left origin are ordered by clientID, lower first (`yjs` `Item.integrate`, case 1). With A=1, B=2, Alice's insertion lands left of Bob's |
| Map-conflict rule | `run`: concurrent writes to one map key: the higher clientID's value wins. Seed `status: "ready"`; client 1 sets `shot`, client 2 sets `todo`: both replicas read `todo`; with the ids swapped both read `shot` |
| D1 | Full concurrency: both clients apply their operations, then exchange updates |
| D2 | Sequential: the first client's updates reach the second before it acts |
| D3 | Hazard order: Bob's update reaches Alice's replica after her buffer started and before it commits |
| dup | Every update delivered twice |
| rev | One client's updates delivered in reverse order (Yjs holds the later one pending) |
| late-C | Carol joins after all operations, from the server state or a third replica's state only |

## 1 Candidates as concrete layouts

### Shared layer (both candidates)

| Root | Type | Holds | Serves |
| --- | --- | --- | --- |
| `beats` | `Y.Map<rowId, Y.Map>` | `status` (LWW), `lengthSeconds` (LWW), `paragraphStart` (LWW, written only by explicit commands), `joins: Y.Map<joinId, {into: rowId, glue: " " or ""}>`, `removals: Y.Map<removalId, true>`, `stamp` (see edit stamps). Join and removal are per-writer entries, never one shared flag, so a local undo deletes only its own entry. That undo is not always effective: an entry another writer rewrote (glue deletion writes every live entry) is no longer the undoing client's item, and the undo then reaches an older step (§6 Y7; open, U-H1). `status` as one LWW key cannot give the highest rank under concurrent writes (open, A-H12) | T05–T10, PROJ |
| `visuals` | `Y.Map<componentId, Y.Map{text: Y.Text, beat: rowId, rank: string}>` | `beat` is the component's origin beat and is never rewritten by a join. A beat's `visualText` = components of every beat in its join group, ordered by beat order then `rank` then componentId, empty ones skipped, joined with `<br>` | T06, T07 |
| `gallery` | `Y.Map<itemId, Y.Map{beat, rank, ref, name, annotation, links}>` | Pictures and links of an origin beat; `ref` keeps the sha256 reference, bytes outside Yjs; a link's `location` is in a per-device table, not here | T06, T16 |
| `comments` | `Y.Map<commentId, Y.Map{author, createdAt, text, quote, resolved, resolvedAt, resolvedBy, assignee, kind, anchorId, rowId, field}>` | Comment records; anchor is the `c:<commentId>` attribute. `rowId`/`field` are derived while a mark exists. A detached comment (every marked character deleted) and a media comment (`mediaComments` in `src/core/document/media.ts`: `anchorId: null`, no mark) cannot derive them from absent marks, so the record stores them: media comments from load, anchored comments their last derived value. Which writer updates the stored value when marks move concurrently is open (PROJ-detached) | T11, T21, PROJ |
| `replies` | `Y.Map<replyId, Y.Map{commentId, author, createdAt, text}>` | Display order `(createdAt, replyId)` | T11, T21 |
| `people`, `tags`, `shots` | `Y.Map<id, Y.Map>` with `rank` | Registry records; order by `rank`, ties by id | PROJ |
| `meta` | `Y.Map` | `title` (`Y.Text`), `titleOrigin`, `titleVersion`, `wordsPerMinute`, `targetSeconds`, `paragraphsDecided` (only ever set), `schemaVersion` | PROJ |
| `removalRecords` | `Y.Map<removalId, Y.Map{kind, by, at, observed, atoms, components}>` | `kind` (`beat`, `range`, `header`, `became-heading`), `observed` = identity ranges `[{client, clock, len}]` the user saw removed (§6 Y1), boundary ids and components involved | T09–T11 |
| Character attributes | every `Y.Text` | `b i u s hl dir cue` (true); `c:<commentId>` (true); `t:<occurrenceId>` (registry id); `l:<linkId>` (URL). One key per comment, tag occurrence and link, so concurrent marks never compete for one key. `cue` is stored as today; whether `settleCues` may instead derive it from `SFX:`/`MUSIC:` lines is PROJ-cue | T11, T20, T21, PROJ |
| Content atoms | visual and narration `Y.Text` | B-roll key: embed `{k: shotId}`. `@Name`: embed `{w: name}`, name at most 60, projected as text `"@" + name` (`whoRun` in `src/core/text/runs.ts`). Both carry the atom marks `cleanMarks(…, true)` keeps: `b i u s hl`, `href`, `cmt`; never `dir`, `cue` or tags | PROJ, T06 |
| Unknown keys | top level, beats, comments, replies, shots, people, tags | Each record holds an `extra` JSON value with the keys `migrateRows` kept but the schema does not name (fixture `doc.unknownField.kept`); `meta.extra` for top-level keys. Written at hydration, never edited, re-emitted unchanged by the projection (PROJ-unknown) | PROJ, T18 |
| Awareness | outside the document | Participant name and connection state | S2 |

Typed text is always inserted with explicit attributes computed by Splitpage's rules (§6 Y12).

Soft removal: removing a whole beat adds an entry to `beats[R].removals` and writes a `removalRecords` entry; characters, components and gallery items stay live. Range deletion inside beats is a Yjs delete of the observed identities. Undo deletes the entry; nothing is re-inserted.

Join: adds `beats[R2].joins[joinId] = {into: R1, glue}`; `glue` is decided by today's `joinCells` rule at join time. No character is copied, no boundary deleted, no component or gallery item rewritten. The glue is projected, not stored; deleting it is a command that writes `glue: ""` into every live join entry of that beat, which replaces other writers' entries and can make their join undo ineffective (U-H1).

### Candidate A: one document-wide sequence

| Element | Representation |
| --- | --- |
| Narration and heading text | One root `Y.Text` `flow` |
| Beat start | Embed `{b: rowId}`; a beat is its embed plus the characters up to the next embed |
| Scene start | Embed `{h: sceneId}`; heading text is the characters up to the next embed; the next `{b}` is `firstSceneId` |
| B-roll key | Embed `{k: shotId}` inside narration |
| Split | Insert `⟦Rnew⟧` at the caret plus a `beats` record |
| Remove header | Delete `⟦#H⟧`, insert `⟦Rn⟧` at its index: the heading characters become Rn's narration with their identities |
| Create header, name only | Delete `# `; delete `⟦R2⟧`, insert `⟦#Hn⟧` at its index. If R2 has visual text or a gallery item (`finalizeHeading` keeps it), insert `{b: R2}` after the name: R2 survives with empty narration. Otherwise add a removal entry of kind `became-heading` to R2, and if no beat follows, also insert `⟦Rnew⟧` after the name (today's blank beat) |
| Create header, text follows | Delete `# ` and the line break; insert `⟦#Hn⟧` at `⟦R2⟧`'s index, delete `⟦R2⟧`, insert `{b: R2}` after the name. The row id survives in the embed; the Yjs item is new |
| Two live embeds with one id | First in document order wins; later ones project as nothing (no boundary, no glue) |

### Candidate B: stable text segments with explicit membership

| Element | Representation |
| --- | --- |
| Text | `segments: Y.Map<segId, Y.Map{text: Y.Text, head: {b: rowId} or {h: sceneId}}>`; one segment per beat or heading at creation |
| Order | `order: Y.Array<segId>`, the only order authority between segments |
| Boundaries | A segment's first boundary is its `head` (a map field). Boundaries inside a segment are embeds `{b}` / `{h}` exactly as in Candidate A. A relative position cannot be a boundary: it cannot tell text typed at the end of one beat from text typed at the start of the next (§6 Y3) |
| Split | Insert `⟦Rnew⟧` in the segment at the caret plus a `beats` record |
| Remove header | If the heading is a segment head: set `head = {b: Rn}`. If it is an inner embed: as Candidate A |
| Create header | If R2 is a segment head: delete `# `; set `head = {h: Hn}`; if text follows, delete the line break and insert `{b: R2}` after the name; if R2 has visual text or a gallery item, insert `{b: R2}` after the name with no narration; else add a `became-heading` removal entry to R2 (and add a new empty segment `{b: Rnew}` after it in `order` if no beat follows) |
| Move a beat that is a whole segment | Delete and insert its `segId` in `order`; the `Y.Text` keeps its identity. Two live entries of one `segId`: first wins |
| Move part of a segment, cross-scene cut-and-paste of beats | Would copy text: refused in shared mode before any change and before consuming a cut |

### Projection answers for merged states (both candidates)

| Merged state | Answer | Serves |
| --- | --- | --- |
| Beat with join entries | Joined into the `into` of its smallest joinId; chains (R3 into R2 into R1) resolve to the first live beat. A beat whose join target is removed is projected inside the removed group | T06, T07, T12 |
| Status of a join group | Highest rank (`STATUS_RANK`: todo 0, ready 1, shot 2) across the group's beat records, also after concurrent status writes; an explicit reset wins only over writes it has seen. Oracle fixed, mechanism open: one LWW key per beat gives the higher clientID's value, not the higher rank (`run`, Notation map-conflict rule); A-H12 | T06, T21 |
| Gallery of a join group | Today's `joinedPictures` (`flow.ts`) applied at projection over the group's items in (beat order, `rank`, itemId): items with the same sha256 fold into the first; their links fold by `videoLinkKey` (`gallery.ts`: `u:` + href, else `f:` + name + size), the first link kept and `poster` and `location` filled from later ones; `name` and `annotation` are the first non-empty; items with no picture never fold. Stored items are not rewritten | T06, PROJ |
| Component or gallery item whose origin beat is removed | Shown with that beat in recovery; restored with it | T10, T07 |
| Scene with no live beat | Heading kept visible; listed in recovery as "scene with no beats"; left out of `sections` export until a beat exists | T08, T10, PROJ |
| Heading embed with no characters before the next embed | No scene (today's `normalizeScenes` drops an empty name) | T08 race |
| Script with no live beats | Empty script shown; the first keystroke runs an explicit add-beat command; no synthetic row | T09, T10 |
| Paragraph flag on a beat whose start is implicit, joined or removed | Ignored; stored value untouched; exports write it only for visible beats | PROJ |
| Duplicate b-roll key id (INV-54) | First key in document order keeps the id; later ones are unanchored in the shot list until an explicit command assigns a new id. Their projected id is open: it must survive `normalizeCell` (which strips everything outside `[A-Za-z0-9_-]`, so `<id>~<client>.<clock>` would become `<id><client><clock>` and can equal a real id), be unique in the document and be the same on every replica. Oracle fixed, mechanism open; A-H13 | PROJ |
| Comment mark on characters of two beats | Allowed as today; anchor = first marked cell | T11 |
| Tag stack per character | Ignore any stored nesting. Take each occurrence's extent (its characters in one beat). Accept occurrences in order of (extent start, longer first, occurrenceId); an occurrence that overlaps an accepted one without containing or being contained by it is rejected. Stack outer to inner by extent length, then occurrenceId | T20 |
| Rejected (crossing) occurrence | Projected untagged; listed in recovery with its words and tag | T20 |
| Tag occurrence cut by a concurrent split | Each part is its own extent of the same occurrence key, projected per beat | T20, T05 |
| Several links on one character | The smallest linkId wins per character; across a tag stretch, the first found (`normalizeCell`) | T20 |
| Comment or link over part of a tag | `normalizeCell`: comment union over the stretch, first link; shared state not rewritten | T20 |
| Glue marks | Today's `joinCells` rule, computed from the live last character before and first character after the joined boundary | T06 |
| Mark attribute on a structural boundary (`{b}`, `{h}`) or a heading character | Ignored; a comment only on heading characters is detached | T08, T11 |
| Mark attribute on a content atom (`{k}`, `{w}`) | Kept as today: `b i u s hl`, `href` and `cmt` (`cleanMarks(…, true)`, `normalizeCell`, written back by `toHtml`); `dir`, `cue` and tag keys ignored | PROJ, T11 |
| Scene name over 200 characters after merge | Projected in full with a notice; further growth refused by the input rule | T08 |
| Gallery over 61 pictures after merge | First 61 by (beat order, `rank`, itemId) shown; the rest listed in recovery, kept in state | T06 |
| Tag attribute naming a deleted registry entry | Projected untagged; recovery lists it | T20 |
| Tag or shot `owner` naming a person removed concurrently | Owner kept as stored text; the person is listed in recovery as removed while assigned | PROJ |
| Two rank values equal | Ties broken by record id | PROJ |
| Edit stamps | `beats[R].stamp = {by, at}` written once when a local typing group closes; `rev` and `lastEdited*` absent and set at export; `personColors` derived from `people` | PROJ, PERF |

### Hypotheses Stage 1 must confirm or refute

| Id | Hypothesis | Refuted by | Serves |
| --- | --- | --- | --- |
| A-H1 | Split, join, header removal and creation never give an existing narration or heading character a new identity; only undo restores create `x*` | Checker finds a new-id character outside an undo restore in T05, T06, T08 | T05, T06, T08 |
| A-H2 | Soft removal keeps concurrent edits to a removed beat discoverable on every replica and undo restores without duplicates | T10 | T10 |
| A-H3 | Removal is classified by observed identities: a beat created concurrently inside removed content is removed too | T11 | T11, T09 |
| A-H4 | Join entries give one glue under two concurrent joins | T06 | T06 |
| A-H5 | Components keep a remote visual edit in the joined beat | T07 | T07 |
| A-H6 | Same-gap races resolve deterministically by clientID | T05 differs across delivery orders | T05 |
| A-H7 | Identity capture and projection per keystroke stay beat-local on one document-wide `Y.Text` | PERF under T02 on the 2 MiB fixture over the Stage 0 input budget | T02, PERF |
| A-H8 | Per-id attribute keys plus the tag-stack rule give the same well-formed nesting everywhere | T20 | T20 |
| A-H9 | `UndoManager` scoped to the local origin reverts only local changes with today's grouping | T12, T21 | T12, T21 |
| A-H10 | Projection derives every field and canonical fixtures round-trip | PROJ | PROJ |
| A-H11 | Two embeds with one row id (concurrent header creation) project once | T08 race | T08 |
| A-H12 | Mechanism open: some representation of `status` gives the highest rank under concurrent writes and lets an explicit reset win over the writes it has seen; one LWW key does not (`run`) | Experiment: on one beat, `ready` against `shot` and `todo` against `shot`, each under both clientID orders, D1 and late-C; then a reset to `todo` by a client that has seen `shot`. Oracle: `shot`, `shot`, then `todo` on every replica | T06, T21 |
| A-H13 | Mechanism open: a projected id for a later duplicate b-roll key exists that stays inside `[A-Za-z0-9_-]`, is unique in the document and is the same on every replica | Experiment: two replicas paste the same key (id `bs1`) concurrently; a fixture also holds every candidate derived id as a real key. Oracle: one key per id after projection, identical on A, B and late-C, every id unchanged by `normalizeCell` | PROJ |
| U-H1 | Mechanism open: an undo step that changes nothing can be stopped from reaching an older step by running `undo()` with only the top item on `undoStack`. Covers scalar writes and join and removal entries another writer rewrote | Experiments: T21 scalar; T12 join with Bob deleting the glue (rewriting jA) in step 2, oracle after A's undo `R1 "ab"`, `R2 "cZd"`, A's earlier steps untouched. U-H1 can at most stop the skip; the unjoin itself is mechanism open | T06, T12, T21 |
| PROJ-cue | The stored `cue` attribute round-trips; whether `settleCues` can derive it instead is open (`2-fields.md` Open question 2) | Round-trip every canonical fixture holding `audio-cue` spans with `cue` stored, then with `cue` derived. Oracle: every `cue` flag of the fixture retained, byte-identical `.splitpage` | PROJ |
| PROJ-detached | Mechanism open: a detached comment keeps its last `rowId`/`field`, a media comment its load values, under concurrent mark moves | Experiment: T11 with all of C1's characters deleted by A while B moves C1's mark to R2; a fixture with a media comment from `mediaComments`. Oracle: the detached comment lists one row and field, identical on every replica; the media comment's `rowId`, `field`, `anchorId: null` byte-identical after round-trip | T11, PROJ |
| PROJ-unknown | `extra` keeps every unknown key `migrateRows` keeps | Round-trip `doc.unknownField.kept` and fixtures with unknown keys on rows, comments, replies, shots, people and tags. Oracle: each key and value byte-identical; concurrent edits to a record leave its `extra` unchanged | PROJ, T18 |
| B-H1 | Segment heads plus inner embeds give the same results as Candidate A for T05, T08, T09, T12 | Those traces | T05, T08, T09, T12 |
| B-H2 | Whole-segment moves keep identity and a concurrent edit | MOVE concurrent | MOVE |
| B-H3 | `order` is the only order authority between segments; no projection needs another | MOVE, T08 | MOVE, T08 |
| B-H4 | Cross-segment selection maps to per-segment deletes in one transaction | T09 | T09 |
| B-H5 | Per-keystroke cost local to one segment | PERF | PERF |
| B-H6 | Shared-layer hypotheses A-H2–A-H5, A-H8–A-H10, A-H12, A-H13, U-H1 and the PROJ rows hold unchanged | Same traces | T06–T11, T20, T21, PROJ |

## 2 Buffer mechanisms for the stale-base experiment

The base must be what was painted, not what the replica holds when native input starts: in T02 the replica has already changed and the beat has not been repainted, and no later capture or deferral can recover what was on screen.

| Part | Rule | Serves |
| --- | --- | --- |
| Paint-time retention (all mechanisms) | Every paint of a beat or heading records `{epoch, id, painted runs, painted identities in order, replica version of that beat}`. One pass of relative positions per painted beat (§6 Y1). This replaces the `rendered` paint cache as the editor base | T01–T04 |
| Stale-beat safeguard (all mechanisms, outside composition) | In `beforeinput`, if the beat's replica version is newer than its painted version, cancel the native input, apply it as a model edit at the caret mapped through painted identities, repaint. Today's pending-mark path already cancels `insertText` and inserts through the model | T02 |
| Composition | Cannot be cancelled; the commit at `compositionend` diffs DOM against the paint-time base and maps through painted identities | T04 |

| Mechanism | Commit | Expected failures | Serves |
| --- | --- | --- | --- |
| M1 Deferral, one document | From buffer start, inbound updates go to a bounded queue. Commit diffs DOM against the paint-time base, maps operations through painted identities (the replica may still be ahead of the paint, T02), applies them in one local-origin transaction, then applies the queue in order and repaints | The provider applies inbound sync to its own document with no hook (`MessageReceiver.applySyncMessage`), so a real provider bypasses the queue unless wrapped; other inbound paths (hydration, recovery restore) need the same gate; a long composition reaches the queue bound; status and presence lag | T01, T02, T04 |
| M2 Immediate integration, identity mapping | Remote updates integrate at once; outside composition the beat is repainted before the next native input. Commit diffs DOM against the paint-time base: a deletion deletes exactly the painted identities still live; an insertion goes after its painted left neighbour's current position (or that neighbour's nearest live left painted character); then repaint with the caret restored | Candidate A identity capture walks the whole `flow` (A-H7); no documented deletedness check (§6 Y2); an insertion whose painted neighbours were all removed has no target and must go to recovery; repeated text needs caret or target-range evidence (T03) | T01–T04, PERF |
| M3 Deferral through two documents | As M1 on editor document E; the provider holds network document N. E's local updates go to N when image ordering allows; N's inbound updates go to E only while no buffer is dirty (`applyUpdate(E, u, NET)`, idempotent) | Double memory and work; both N (received, not yet in E) and E (local, not yet released) must persist, and a crash between the two writes must be tested; echo loops if origins are wrong; text typed after a held image waits | T01, T04, T16, STORE |

Run order (plan §4): T04 under M1, M2 and M3 first, then T01, then T02 across a beat boundary, T03, and each through undo. M2 is measured first.

## 3 Trace table

Expected results hold for every listed delivery order unless the row says otherwise, and for both candidates unless it says "A:" or "B:". Undo means the named client's next Ctrl+Z after all updates are exchanged.

### Stage 1a: editing feasibility (two replicas and the deterministic queue, no server)

| Serves | Initial | Operations in order | Delivery | Expected visible script, carets | Recovery | Undo outcome | Entry paths |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | `R1 "abcd" = s1..s4`, painted | A: selects `bc`, Backspace (composition variant: composes `β` over `bc`). B: inserts `X` (b1) after `s2`. A commits | D1, D3, dup, rev, late-C; M1, M2, M3 | `R1 "aXd" = s1 b1 s4`, A's caret `"a|Xd"`. Variant: `"aβXd" = s1 a1 b1 s4`, caret `"aβ|Xd"` | empty | `R1 "abXcd" = s1 s2* b1 s3* s4`, selection `s2*` through `s3*` (`bXc`). Variant: the same, `a1` deleted | |
| T02 | `R1 "ab" = s1 s2` painted; A's caret `"ab|"` | B: inserts `X` (b1) at R1 offset 0; A's replica integrates it; R1 not repainted. A types `c` (a1) | D3, dup, late-C; M1, M2, M3 | `R1 "Xabc" = b1 s1 s2 a1`, A's caret `"Xabc|"` | empty | `R1 "Xab" = b1 s1 s2`, caret `"Xab|"` | |
| T02 boundary | `R1 "ab" = s1 s2`, `R2 "cd" = s3 s4`; A's caret `R2 "|cd"` | B: appends `Y` (b1) to R1. A types `Z` (a1) | D3 | `R1 "abY" = s1 s2 b1`, `R2 "Zcd" = a1 s3 s4`, caret `R2 "Z|cd"` | empty | `R2 "cd"`, caret `R2 "|cd"` | |
| T03 | `R1 "the the" = s1..s7`; A's caret at end | B: bolds `s1..s3`. A: Backspace ×4 (targets `s7..s4`) | D1, D3 | `R1 "the" = s1 s2 s3`, bold; A's caret at end | empty | `R1 "the the" = s1 s2 s3 s4* s5* s6* s7*`, first word bold, caret at end | |
| T03 replace | `R1 "the the" = s1..s7` | A: selects `s5..s7`, types `a` (a1). B: appends `n` (b1) after `s7` | D1, D3, dup | `R1 "the an" = s1..s4 a1 b1`, caret `"the a|n"` | empty | `R1 "the then" = s1..s4 s5* s6* s7* b1`, selection `s5*..s7*` | |
| T04 | `R1 "abcd" = s1..s4`, `R2 "ef" = s5 s6`; flow surface and Split view | A: `compositionstart` after `s2`, composes `xy` (a1 a2). Meanwhile B inserts `Z` (b1) at R1 offset 0 and deletes `s4`. A: `compositionend` | D3, dup, late-C; M1, M2, M3 | `R1 "Zabxyc" = b1 s1 s2 a1 a2 s3`, caret `"Zabxy|c"`; `R2 "ef"` | empty | `R1 "Zabc" = b1 s1 s2 s3`, caret `"Zab|c"` | |
| T04 removed | as T04 | During A's composition B removes beat R1. A ends composition | D3, late-C | `R2 "ef"`; A's caret `R2 "|ef"` | `R1 "abxycd" = s1 s2 a1 a2 s3 s4`, removed by Bob; `a1 a2` marked as Alice's edit after removal | Recovery `R1 "abcd" = s1..s4` | |
| T05 | `R1 "abcd" = s1..s4` | A: Enter at `s2|s3` (embed a1 `{b: Ra}`). B: types `X` (b1) at the same gap | D1, dup, rev, late-C | `R1 "ab" = s1 s2`, `Ra "Xcd" = b1 s3 s4`; A's caret `Ra "|Xcd"`, B's `Ra "X|cd"`. With clientIDs swapped: `R1 "abX"`, `Ra "cd"` | empty | `R1 "abXcd" = s1 s2 b1 s3 s4`, caret `"abX|cd"` (restored selection is anchored to `s3`) | |
| T05 two splits | `R1 "abcd" = s1..s4` | A and B both press Enter at `s2|s3` (a1 `{b: Ra}`, b1 `{b: Rb}`) | D1, dup, rev, late-C | Provisional: `R1 "ab"`, `Ra ""`, `Rb "cd" = s3 s4`; A's caret `Ra` 0, B's `Rb` 0. Alternative: the empty concurrent beat is hidden | empty | `R1 "ab"`, `Rb "cd"` | |
| T06 | `R1 "ab" = s1 s2`, `V(R1) "v" = v1`, picture `P` (item gP1, no name, link `https://v/1`), status `todo`; `R2 "cd" = s3 s4`, `V(R2) "w" = w1`, picture `P` again (item gP2, name `wide`, links `https://v/1` with `poster` and `https://v/2`) and picture `Q` (gQ), status `ready`. A earlier bolded `ab` (its own undo step) | A and B both join R2 into R1 (entries jA, jB) | D1, dup, rev, late-C | `R1 "ab cd" = s1 s2 [glue] s3 s4`, bold on `ab`; `V(R1) "v<br>w" = v1, w1`; pictures `[P (name wide; links https://v/1 with poster, https://v/2), Q]`, items gP1, gP2, gQ unchanged in state; status `ready`. Each caret `"ab |cd"` | empty | A's first undo deletes jA; jB keeps the join: visible unchanged, bold kept (notice). Second undo removes the bold | |
| T07 | `V(R1) "v" = v1`; `V(R2) "wz" = w1 w2` | A: joins R2 into R1. B: types `Q` (b1) between `w1` and `w2` | D1, D3, dup, late-C | `V(R1) "v<br>wQz" = v1, w1 b1 w2`; B's caret after `Q` in R1's visual | empty | `V(R1) "v"`, `V(R2) "wQz"` | |
| T08 remove | `R0 "x" = s1`, `#H1 "In" = s2 s3`, `R1 "ab" = s4 s5` | A: Backspace at heading start. B: types `Z` (b1) at heading end, `Y` (b2) at R1 end | D1, D3, dup, late-C | `R0 "x"`, `Rn "InZ" = s2 s3 b1`, `R1 "abY" = s4 s5 b2` with `paragraphStart`; no heading. A's caret `Rn "|InZ"` | empty | `R0 "x"`, `#H1 "InZ"` (new embed `{h: H1}`; B: head restored), `R1 "abY"`; caret at heading start | |
| T08 create | `R1 "x" = s1`, `R2 "# Ab" = s2..s5` (starts a paragraph), `R3 "cd" = s6 s7` | A: Enter at end of R2. B: types `e` (b1) after `s5`, `Q` (b2) before `s6` | D1, D3, dup, late-C | `R1 "x"`, `#H2 "Abe" = s4 s5 b1`, `R3 "Qcd" = b2 s6 s7`; A's caret `R3 "Q|cd"` | empty (R2's `became-heading` entry is not listed) | `R1 "x"`, `R2 "# Abe" = s2* s3* s4 s5 b1`, `R3 "Qcd"` | |
| T08 race | `R1 "x" = s1`, `R2 "# Ab\nrest" = s2..s10` | A and B both press Enter after `Ab` (A: `{h: Ha}`, `{b: R2}` as a1 a2; B: `{h: Hb}`, `{b: R2}` as b1 b2) | D1, dup, late-C | `R1 "x"`, `#Hb "Ab" = s4 s5`, `R2 "rest" = s7..s10`. A: `⟦#Ha⟧` has no characters (no scene), second `{b: R2}` inert. B: head map conflict gives `Hb`, second embed inert | empty | not exercised | |
| T09 | `R1 "abc" = s1 s2 s3`, `R2 "de" = s4 s5`, `R3 "fgh" = s6 s7 s8` | A: selects R1 offset 1 to R3 offset 2, types `Z` (a1). B: `W` (b1) after `s2`, `X` (b2) after `s4`, `Y` (b3) after `s7` | D1, D3, dup, late-C | `R1 "aZW" = s1 a1 b1`, `R3 "Yh" = b3 s8` (runs on in R1's paragraph); A's caret `"aZ|W"` | `R2 "dXe" = s4 b2 s5` removed by Alice; `b2` marked as Bob's edit after removal | `R1 "abWc" = s1 s2* b1 s3*`, `R2 "dXe"`, `R3 "fgYh" = s6* s7* b3 s8`; selection R1 offset 1 to R3 offset 2 | |
| T09 header | `R1 "ab" = s1 s2`, `#H1 "Cd" = s3 s4`, `R2 "ef" = s5 s6` | A: selects R1 offset 1 to heading offset 1, Backspace. B: types `Q` (b1) at heading end | D1, D3 | `R1 "a" = s1`, `#H1 "dQ" = s4 b1`, `R2 "ef"`; A's caret `"a|"` | empty | `R1 "ab" = s1 s2*`, `#H1 "CdQ" = s3* s4 b1` | |
| T10 | `R1 "ab" = s1 s2`, `R2 "cd" = s3 s4`, `R3 "ef" = s5 s6` | A: removes beat R2 (entry rA). B offline: types `X` (b1) after `s3`. B reconnects. C joins. A undoes | D1, dup, rev, late-C | Before undo: `R1 "ab"`, `R3 "ef"`. After: `R1 "ab"`, `R2 "cXd" = s3 b1 s4`, `R3 "ef"`; A's caret `R2 "|cXd"` | Before undo, identical on A, B, C: `R2 "cXd" = s3 b1 s4` removed by Alice, `b1` edited after removal by Bob. After: empty | as Expected | |
| T11 | `R1 "abcd" = s1..s4`, `R2 "ef" = s5 s6` | 1. A: comment C1 on `s2 s3`; B: comment C2 on `s3 s4` (D1). 2. C1 reaches B (D2); B replies r1. 3. A removes R1 (rA, observed `s1..s4`, `⟦R1⟧`); B, not yet seeing it, splits R1 at `s2|s3` (b1 `{b: Rb}`) (D1) | as listed, dup, late-C | `R2 "ef"`; A's caret `R2 "|ef"`; B's caret `R2 "|ef"` | Removed by Alice: `R1 "ab" = s1 s2`, `Rb "cd" = s3 s4` (split by Bob after removal); C1 on `s2 s3` with r1; C2 on `s3 s4` | `R1 "ab"`, `Rb "cd"`, `R2 "ef"`; C1 anchored R1, C2 anchored Rb; recovery empty; A's caret `R1 "|ab"` (as T10) | |
| T12 | `R1 "abcd" = s1..s4` | 1. A: splits at `s2|s3` (a1 `{b: Ra}`); reaches B (D2). 2. B: `Y` (b1) at R1 end, `X` (b2) at Ra start; reaches A. 3. A undoes, then redoes | as listed, dup, late-C | After undo: `R1 "abYXcd" = s1 s2 b1 b2 s3 s4`, A's caret `"abYX|cd"`. After redo: `R1 "abY"`, `Ra "Xcd" = b2 s3 s4` (new embed `{b: Ra}` after `b1`) | empty | as Expected | |
| T12 join | `R1 "ab" = s1 s2`, `R2 "cd" = s3 s4` | 1. A joins (jA); reaches B. 2. B types `Z` (b1) after `s3`; reaches A. 3. A undoes | as listed | Before undo `R1 "ab cZd"`, A's caret `"ab |cZd"`, B's `"ab cZ|d"`; after `R1 "ab"`, `R2 "cZd" = s3 b1 s4`, A's caret `R2 "|cZd"`, B's `R2 "cZ|d"` | empty | as Expected | |
| T20 nest | `R1 "the red mug" = s1..s11` | A: tags `s5..s11` Prop P (`t:oA`). B: tags `s9..s11` Sound S (`t:oB`) | D1, dup, late-C | `s5..s8` stack `[P]`; `s9..s11` stack `[P, S]` (`tag: P, innerTags: [S]`) | empty | A: `s9..s11` stack `[S]` | |
| T20 cross | as above | A: tags `s5..s11` P (oA). B: tags `s1..s7` S (oB) | D1, dup, rev, late-C | Provisional, on every replica: `the red` (`s1..s7`) tag S; `red mug` carries no P. Alternative: P kept on `s8..s11` | P on `red mug` conflicts with S on `the red` | B: oB gone, `red mug` tag P, recovery empty | |
| T20 mark | as above | A: tags `s5..s11` P. B, not yet seeing it: comment C1 on `s9..s11`, link L1 `http://x` on `s5..s7` | D1, D3 | Run `red mug` (`s5..s11`): tag P, comment C1, link `http://x`; stored `c:C1` still only on `s9..s11` | empty | B undo of L1: link gone; C1 stays | |
| T21 | `R1 "abcd" = s1..s4` | A: bolds `s2 s3`. B, not yet seeing it: inserts `X` (b1) after `s2`, no attributes. A undoes | D1, D3, late-C | Before undo `"abXcd"`, `bXc` (`s2 b1 s3`) bold on both replicas: `b1` lies between Alice's format markers, with or without explicit `{}` attributes (`run`). After: `"abXcd" = s1 s2 b1 s3 s4`, no bold on either replica (`run`); selection `s2..s3` (`bXc`) | empty | as Expected | |
| T21 comment | `R1 "abcd" = s1..s4` | A: C1 on `s2 s3`; reaches B. B: reply r1; C2 on `s3 s4`. A undoes C1 | D2, late-C | `R1 "abcd"`, C2 on `s3 s4` | Provisional: r1 listed as a reply to a removed comment | A redo: C1 back on `s2 s3` with r1 | |
| T21 scalar | `R1 "ab" = s1 s2`, status `todo` | A types `Z` (a1) after `s2` (its own undo step). A sets status `ready`; B concurrently `shot` | D1 | Status `shot` (highest rank; the map-conflict rule gives the same only with these clientIDs; oracle fixed, mechanism open, A-H12), `R1 "abZ"` | empty | A's first undo: status write overwritten, nothing to undo: status `shot`, `Z` kept, notice (oracle fixed, mechanism open: U-H1). Plain `UndoManager` instead removes `Z`. Second undo removes `Z` | |
| MOVE concurrent | `R1 "ab" = s1 s2`, `R2 "cd" = s3 s4`, `R3 "ef" = s5 s6`; B: each its own segment | A: moves R3 before R1. B: moves R3 after R1 and types `X` (b1) after `s5` | D1, dup, late-C | A: refused before any change. B: `R3 "eXf" = s5 b1 s6`, `R1`, `R2` (first live `order` entry wins); Alice's caret `R3 "|eXf"`, Bob's `R3 "eX|f"` (carets keep their character) | empty | B (Alice's move undone): `R1`, `R3 "eXf"`, `R2`; Alice's caret `R3 "|eXf"` | |
| MOVE destination | `R1 "ab" = s1 s2`, `R2 "cd" = s3 s4`, `R3 "ef" = s5 s6`; B: each its own segment; Alice's caret `R3 "|ef"` | Alice: moves R3 before R1. Bob, not yet seeing it: types `Y` (b1) at R1 offset 0 and `W` (b2) at R2's end | D1, D3, dup, late-C | Candidate A: refused before any change; `R1 "Yab"`, `R2 "cdW"`, `R3 "ef"`. Candidate B: `R3 "ef"`, `R1 "Yab" = b1 s1 s2`, `R2 "cdW" = s3 s4 b2`; Alice's caret `R3 "|ef"`, Bob's `R2 "cdW|"` | empty | Alice undoes (B): `R1 "Yab"`, `R2 "cdW"`, `R3 "ef"`; Alice's caret `R3 "|ef"`; Bob's text unchanged | |
| MOVE delete | as above, B layout | A: moves R3 before R1. B: removes R3 | D1, late-C | `R1 "ab"`, `R2 "cd"` (provisional: removal wins); Alice's caret `R1 "|ab"` (the beat after the removed one in her order) | `R3 "ef"` removed by Bob | B undo: `R3 "ef"` before R1; Bob's caret `R3 "|ef"` | |
| MOVE cut-paste | `#H1 "A"`, `R1 "ab"`, `#H2 "B"`, `R2 "cd"` | A: cuts R1, pastes after R2 | — | Refused in shared mode before content changes and before the cut is consumed (both candidates); caret and selection unchanged | empty | none | |

### Stage 1b: service feasibility

Updates are concrete Yjs updates on `R1 "abcd" = s1..s4` from client A unless stated: `u1` inserts `e` at R1 offset 4 (A:1), `u2` inserts `f` after it (A:2), `u3` inserts `g` (A:3), `u4` inserts `h` (A:4), `ud` deletes `s2` (delete set only).

| Serves | Initial | Event sequence | Expected receipt, status (plan §8 wording) or refusal | Entry paths |
| --- | --- | --- | --- | --- |
| T13 | Owner's standalone script, generation g0 `R1 "abcd"`, image `P` | Collaborate (creation op id k); upload of g0 and `P` starts; owner types `X` (g1), `Y` (g2); server commits the instance; local replica = g0 plus g1–g2 as updates; a lost response then retry of k; separately, restart during upload | Server and local `R1 "abcdXY"`, `P` durable. Retry returns the same pending instance; restart leaves the standalone file or a recoverable membership, never two instances. A guest join while pending is refused. Invitation shown only after both persistence contracts; "Your changes saved to server" after the receipt covering g2 | |
| T14 | Barriers; connection K1, sequence 0 | `u1` accepted (seq 1); store S1 captures `{state, seq 1}`, slow. `ud` accepted (seq 2; state vector unchanged). Flush f1 (requires 2). S1 completes. S2 captures seq 2 and completes | No receipt on S1. Receipt f1 on S2, reporting 2. "Saved on this device, sending" until then; then "Your changes saved to server" | |
| T15 | Barriers, K1 after `u1..u4`, `ud` (seq 1–5) | f1 requires 3, f2 requires 5. f2's store completes (coverage 5); f1's store completes late (3). K1 closes; K2 opens; A types `i` (A:5), unsent; a receipt for f3 tagged K1 arrives | Coverage stays 5; f1 covered. The K1 receipt changes nothing; `i` pending: "Saved on this device, sending" until a K2 barrier covers it | |
| T16 upload-before-sync | A online, then offline; `R1 "ab"` | Offline A inserts picture `P` (sha p; blob stored and verified locally, then gallery item gP), types `Z` (A:k). Reconnect | Offline: "Offline, saved on this device". Online, upload pending: "Saved on this device, waiting for images to upload"; neither gP nor `Z` reaches N or the server, including the provider's SyncStep2 after reconnect. After `p`'s membership is durable, release; "Your changes saved to server" after the covering acknowledgement | |
| T16 pending-image | as above | as above | gP arrives at the server marked pending, with `Z`; B shows a placeholder for `P`. A: "Saved on this device, waiting for images to upload" until `p`'s bytes and membership are durable; no client shows `P` saved before; then "Your changes saved to server". If A never returns: B keeps the placeholder; export discloses the missing image | |
| T17 | A and B edited; last receipt covers `R1 "abcd"`, `P` | All clients leave; server killed and restarted; C joins with a valid invitation | C loads `R1 "abcd"` and `P` from journal, checkpoint and blobs; editing enabled after hydration; C's status "Saved on this device" | |
| T18 | Instance open on K1 | (a) a 20 MiB frame; (b) `u1` with its last 3 bytes cut (delete set truncated); (c) an insert of 3 MiB of text against a 2 MiB state limit; (d) 200 updates per second against a limit of 50 | (a) Socket closed before processing. (b) Refused in `beforeSync` before the journal; nothing applied or broadcast; connection set read-only for it, answered "not applied", stateless refusal sent. (c) As (b), permanent. (d) Temporary refusal as in T19 (c). No "Your changes saved to server" for any of them | |
| T19 (a) | Device holds `ubig` (3 MiB insert) | Sent as an incremental update | `beforeSync` refuses: read-only, "not applied", stateless "rejected". Client detaches the provider (stops publication), keeps work exportable, shows the rejoin explanation (wording: Decisions) | |
| T19 (b) | Device restarts with `ubig` in its replica | Reconnect: provider sends SyncStep1; server sends SyncStep1, then SyncStep2; provider answers SyncStep2 containing `ubig` | Refused again in `beforeSync`; client detaches after this first refusal: no reconnect loop | |
| T19 (c) | Device holds `up` (gallery item naming blob p, not yet durable on the server) | Sent; `beforeSync` sets read-only for this message, sends stateless "retry after p"; `afterHandleMessage` clears read-only. Client uploads p; on durable membership calls `provider.forceSync()`; provider sends SyncStep1; SyncStep2 carries `up` | First send "not applied"; after p is durable, `up` journaled and "applied"; "Your changes saved to server" | |
| T22 | Journal in `beforeSync` | A sends `u1`. `beforeSync` commits its bytes to SQLite and returns; server applies; status "applied". SIGKILL before the 2 s store | Provider count 0; "Your changes saved to server". After restart the journal replays `u1`: `R1 "abcde"` | |
| T23 (i) ordinary close | `u1` acknowledged; `u2` sent, unacknowledged; network drops (socket `close` event); A types `u3` while closed (queued in the provider's websocket queue) | Reconnect: provider sends token and SyncStep1 (count reset to 1); the first server message flushes the queued `u3`; server sends SyncStep1 then SyncStep2; provider answers SyncStep2 carrying `u2`, `u3`; A types `u4` right after the socket opens, before any acknowledgement | Status: "Offline, saved on this device" while closed; "Saved on this device, sending" until the application has matched acknowledgements for `u3`, `u4` and the SyncStep2, in any arrival order; only then "Your changes saved to server" covering `u1..u4`. Provider count (`run`, server `beforeSync` delayed 400 ms per message): 1 at reconnect (reset), 2 after `u4`; the server received SyncStep1, `u3`, `u4`, SyncStep2 in that order; 1 after `u3`'s acknowledgement, 0 after `u4`'s while the SyncStep2 was still unacknowledged, still 0 after the SyncStep2's. Arrival order depends on timing; the count reaches 0 with a message unacknowledged either way (§6 H3) | |
| T23 (ii) discarded queue | as (i), but `u3` is queued while a new socket is still connecting, and that socket is replaced or `disconnect()` is called before it opens. Control: `disconnect()` after the ordinary close, when the socket is already `null` | Queue emptied (`read`); reconnect; SyncStep2 carries `u2`, `u3`. Control: queue kept and flushed by `connect()` (`run`) | As (i) with one expected acknowledgement for the SyncStep2 before `u4`; the control as (i) | |
| T24 | Browser tab 1 holds the Web Lock for (deployment, instance) | Tab 2 opens the instance; tab 1 crashes; tab 2 retries | Tab 2 refused or read-only with an explanation; after the crash the lock is released, tab 2 becomes writable after hydration; every write tab 1 reported saved is present | |

## 4 Expected failure traces

| Under | Expected to break | Why | Serves |
| --- | --- | --- | --- |
| Both candidates | T05 (product, not correctness) | Text typed at a split point goes left or right by clientID | T05 |
| Candidate A | PERF in T02 | Identity capture walks one `Y.Text` holding the whole script | T02, PERF |
| Candidate A | MOVE | Moving text copies it; refused | MOVE |
| Candidate B | T08 create, T08 race | Head conversion plus inner embed must land in one transaction; head is a map field, so the race resolves by map conflict | T08 |
| Both, without soft removal | T10, T11 | Text inserted into a deleted nested type is deleted on arrival and not restored by the deleting client's undo (§6 Y6) | T10, T11 |
| Both, join as one shared flag | T06 | Alice's undo either does nothing (then `UndoManager` undoes her older bold) or unjoins despite Bob's join, depending on clientID | T06 |
| Both, copy-on-join | T07 | `Q` lands in R2's original visual | T07 |
| Both, glue as a character | T06 | Two joins insert two spaces | T06 |
| Both, implicit attribute inheritance | T20, T11 | `Y.Text.insert` without attributes copies every attribute, including `c:` and `t:` keys (§6 Y12) | T20, T11 |
| Both, plain `UndoManager` | T21 scalar, T12 | 500 ms capture merges across beats; an ineffective item makes one undo revert an older one (§6 Y7) | T21, T12 |
| Any mechanism, base taken at input start | T02, T04 | The replica is ahead of the paint | T02, T04 |
| M1 | T04 with a real provider, T16 | Inbound sync has no hook | T04, T16 |
| M1, M3 | T04 long composition | Queue reaches its bound | T04 |
| M2 | T03 | Repeated text makes the DOM diff ambiguous | T03 |
| M2 | T04 removed | The insertion's painted neighbours are gone; mapping must route it to recovery | T04 |
| M3 | STORE restart | Crash between persisting N and E | STORE |
| Write-ahead journal | T18 (b) | Without a decode check the built-in path acknowledges a failing update as applied (§6 H2) | T18, T22 |
| Write-ahead journal | T23 (i) | Acknowledgements carry no id and the provider count is reset while queued updates are still in flight | T23 |
| Barriers | T15 | Stateless callbacks are not awaited; completions reorder | T15 |

## 5 The checker's deliberate defects

| Defect | Injection | Triggering history | Failing oracle | Serves |
| --- | --- | --- | --- | --- |
| Lost remote character | Commit replaces the whole beat with the DOM result (today's whole-beat sync) | T01, D3, M2 | Expected `s1 b1 s4`; got `"ad"` with `b1` deleted | T01 |
| Stale base | M2 maps the deletion by base offsets 1–2 instead of painted identities | T01, D3, M2 | Expected `"aXd" = s1 b1 s4`; got `"acd" = s1 s3 s4` (`b1` and `s2` deleted) | T01 |
| Duplicated identity | Undo of a removal re-inserts the removal record's observed text as new characters, then deletes the removal entry | T10, D1, late-C | Expected after undo `R2 = s3 b1 s4`; got `R2 "cdcXd"` with two new-id characters equal to `s3`, `s4` | T10 |
| Duplicated identity (join) | Join inserts copies of R2's narration as new characters `x1 x2` (`cd`, no glue) at the end of R1, after `s2`, then adds the join entry | T06, D1 | Expected `R1 "ab cd" = s1 s2 [glue] s3 s4`; got `R1 "abcd cd" = s1 s2 x1 x2 [glue] s3 s4` | T06 |
| Omitted field | Projection drops `lengthSeconds` | PROJ fixture: `R1 {lengthSeconds: 12}` loaded, projected, serialized | `rows[0].lengthSeconds` missing | PROJ |
| Lost mark | Comments stored in one attribute key `cmt` instead of one key per id | T11 step 1, D1 | Expected `s3` carrying C1 and C2; got one of them | T11 |
| Lost mark (tag) | Tags stored in one attribute key `tag` | T20 nest, D1 | Expected `s9..s11` stack `[P, S]`; got `[P]` or `[S]` | T20 |
| Premature receipt | Server sends the "applied" status, then commits the journal; SIGKILL between them | T22 | Harness record: acknowledgement for `u1` received; recovered journal lacks `u1` | T22 |
| Premature receipt (barrier) | Barrier accepts the first completing store regardless of its captured sequence | T14 | Receipt for f1 after S1 (coverage 1 < 2) | T14 |

## 6 Supported-API questions

Risk: **public** = documented API; **exported** = exported but undocumented; **internal** = needs fields or functions outside the export (a feasibility risk per plan §4).

| Id | Question | What the source says | Prototype must still prove | Risk | Serves |
| --- | --- | --- | --- | --- | --- |
| Y1 | Can the binding read the identity of each painted character? | `read`: `yjs@13.6.33` `utils/RelativePosition.js` `createRelativePositionFromTypeIndex(type, i, 0).item` is the id `{client, clock + offset}` of the live item at index `i`; each call walks from `type._start` | One pass per painted beat; cost on the 2 MiB fixture in Candidate A | public | T01–T04, PERF |
| Y2 | Can it tell what happened to a captured character? | `read`: `createAbsolutePositionFromRelativePosition` returns `null` when the item's client clock has not arrived (`getState(store, client) <= clock`) or the struct is a `GC` struct; for a deleted item it returns the position it occupied, without saying it is deleted. `isDeleted(ds, id)` and `createDeleteSetFromStructStore(store)` are exported but need `doc.store` | Distinguish "not arrived" (wait) from "collected" (recovery); detect deletion by a fresh identity scan and set difference | exported (`doc.store` internal) | T01, T04 |
| Y3 | Relative positions as anchors | `read`: the same function attaches a position to one item (`assoc >= 0` the item after, `< 0` the item before); text inserted at that gap lands on one side of every such position, so a position cannot separate the end of one beat from the start of the next. `followUndoneDeletions` defaults to true and follows `redone` links only the undoing client knows (yjs issue 638) | Carets and selections only, never boundaries; stored positions pass `false` | public | T05, T08, T12 |
| Y4 | Can an insertion choose its side relative to a concurrent one? | `read`: no. `structs/Item.js` `integrate` orders same-origin insertions by clientID | T05 outcome | public behaviour | T05 |
| Y5 | `UndoManager` scope and tracked origins | `read`: `utils/UndoManager.js`: `trackedOrigins` default `{null}` plus the manager; a transaction is captured only if its origin or its origin's constructor is tracked; `captureTimeout` 500 ms merges any captured transaction in the window; `stopCapturing()`; `stack-item-added/popped` carry `meta`; no size limit option | Local origin object, `captureTimeout: 1000` plus `stopCapturing` on word and cell changes, manual 200 limit | public | T12, T21 |
| Y6 | What does undo of a deletion restore? | `read`: `redoItem` creates a new item with the local clientID, copied content and a `redone` link; a nested type is re-created empty and its deleted children redone into it. An item inserted into an already deleted parent is deleted on integrate (`Item.integrate`). Caveat: that loss concerns remote work outside the deletion's own undo entry; items inside the entry are redone | Soft removal avoids it; checker accepts `x*` restores as non-duplicates | public behaviour | T10, T12 |
| Y7 | What if the undone change was overwritten remotely? | `read`: `redoItem` for a map key returns `null` when a newer value exists (unless `ignoreRemoteMapChanges`). `popStackItem` keeps popping while nothing changed and emits `stack-item-popped` only for the item that finally changed something; `undo()` returns that item. Neither can stop an older step that is already undone. No documented mechanism prevents it | Per-writer entries for join and removal are not always effective: an entry another writer rewrote (glue deletion) leaves the undo nothing to change. Mechanism open, U-H1 (move all but the top item out of the public `undoStack` array, call `undo()`, restore the rest); T21 scalar and the U-H1 join experiment | public fields, undocumented use | T06, T21 |
| Y8 | Does deleted text survive for recovery? | `read`: `Doc` option `gc` defaults true; `utils/Transaction.js` cleanup `tryGcDeleteSet` replaces a deleted, not `keep`, `gcFilter`-passing item's content with `ContentDeleted`; it becomes a `GC` struct only when its parent is collected. `UndoManager` keeps its own deletions. Server default `yDocOptions: {gc: true}` (`Hocuspocus.ts` `defaultConfiguration`) | Recovery never relies on tombstones; growth of soft-removed text measured | public | T10, T11, T17 |
| Y9 | Snapshots or subdocuments? | `read`: snapshot rendering of deleted text needs `gc: false`; subdocuments need their own provider. Neither candidate uses them | Keep it so | public | T10 |
| Y10 | Embeds as boundaries | `read`: `types/YText.js` `insertEmbed(index, Object or AbstractType, attributes)`; `toDelta` returns `{insert: object}`; `format` also formats embeds | Projection ignores marks on structural embeds (`{b}`, `{h}`) and keeps the atom marks on content embeds (`{k}`, `{w}`) | public | T05, T08, PROJ |
| Y11 | One attribute key per comment, tag occurrence and link | `read`: `format` writes one `ContentFormat` per key; one winner per character per key; keys are free strings | Cost of many keys on long texts | public | T11, T20 |
| Y12 | Does typed text inherit marks? | `read`: `YText.insert` without `attributes` copies every attribute at the position (`pos.currentAttributes`). `run`: explicit attributes do not keep a concurrent insertion out of a remote format range; Bob's `X`, typed with `{}` between `s2` and `s3`, is bold once Alice's `format` of `s2 s3` arrives (T21) | Explicit attributes on every insert | public | T11, T20 |
| Y13 | Can an update's dependencies be checked without applying it? | `read`: `utils/updates.js` `parseUpdateMetaV2` reports only each client's inserted clock range. `structs/Item.js` `getMissing` also depends on cross-client `origin`, `rightOrigin` and `parent`; delete-only dependencies live in the delete set. `decodeUpdate` exposes structs (with those fields) and the delete set. `utils/encoding.js` `readUpdateV2` integrates structs before reading the delete set, so a corrupt tail can leave a partial apply; unresolved parts sit in `store.pendingStructs` / `pendingDs` | Experiment over three histories, each sent out of order to the server: a same-client gap, a cross-client origin dependency, a delete of an item not yet received. Record what a check over `decodeUpdate` catches; no completeness claim before that | exported; pending state internal | T18, T19 |
| Y14 | Do pure deletes advance the state vector? | `read`: `encodeStateVector` counts inserted clocks only | Receipt by sequence, shown with `ud` | public | T14 |
| Y15 | y-protocols error handling | `read`: `y-protocols@1.0.7` `sync.js` `readSyncStep2` (and `readUpdate`, the same function) runs `Y.applyUpdate(doc, decoding.readVarUint8Array(decoder), …)` inside one `try`, so a bad length prefix and a failing apply are both caught, logged and returned normally; an `errorHandler` only propagates them if it throws. `run`: a length prefix of 1000 over 1 byte and an update cut by 2 bytes both log "Caught error while handling a Yjs update" without throwing; the cut update leaves the document empty. The framing failure that closes a connection is in Hocuspocus, not here: `MessageReceiver.readSyncMessage` calls `message.peekVarUint8Array()` for the `beforeSync` payload outside any catch, and `Connection.processMessages` closes the connection (`run`: a 5000-byte prefix over 1 byte) | See H2 | public | T18 |
| H1 | Does `beforeSync` see the raw bytes before apply? | `read`; `run` that each message waits for the hook (T23 (i) order): `@hocuspocus/server@4.8.0` `MessageReceiver.readSyncMessage` awaits `connection.callbacks.beforeSync(connection, {type, payload: message.peekVarUint8Array()})` before handling; `Connection.processMessages` awaits each message in turn. Type 0 carries a state vector, 1 and 2 an update | Journal commit cost per update on the deployment disk | public | T22 |
| H2 | Status message values | `read`; `run` for the swallowed apply error (Y15): `readSyncMessage` writes `writeSyncStatus(true)` after `readSyncStep2` and after `readUpdate`, and Hocuspocus passes no `errorHandler`, so an update whose apply threw is answered "applied". An update with missing dependencies is also "applied" while its structs wait pending. Read-only: every update message gets "not applied"; a SyncStep2 gets "applied" if `snapshotContainsUpdate` finds nothing new, else "not applied", and a malformed SyncStep2 can throw inside that check (closing the connection) | Decode and size checks in `beforeSync`; pending updates handled explicitly in receipts | public | T18, T22 |
| H3 | Provider's acknowledgement count | `read`: `@hocuspocus/provider@4.8.0` `HocuspocusProvider.documentUpdateHandler` increments `unsyncedChanges` per update (per batch with `flushDelay`); `startSync` calls `resetUnsyncedChanges()`, which sets 1; `applySyncStatusMessage` decrements only on "applied", never below 0; "not applied" changes nothing and emits nothing. `run` (T23 (i)): after reconnect the count is reset to 1 although the queued `u3` and the SyncStep2 are both in flight; with `u4` typed after open it went 1, 2, then 1, 0, 0 on the acknowledgements of `u3`, `u4` and the SyncStep2, reaching 0 while the SyncStep2 was unacknowledged. The `synced` event follows the server's SyncStep2, not any acknowledgement | FIFO matching per connection in the application; "not applied" learned from a server stateless message | public | T19, T23 |
| H4 | When are queued updates kept or dropped? | `read`: `HocuspocusProviderWebsocket.send` queues while the socket is not open. Kept: `onClose` calls `cleanupWebSocket` (which nulls the socket) without clearing the queue; the next `createWebSocketConnection` skips its clear because the socket is null; `resolveConnectionAttempt`, run on the first received message, sends the queue. `disconnect()` returns before touching the queue when `webSocket === null`, so after an ordinary close it keeps the queue (`run`: queue 1 before and after, flushed by `connect()`). Dropped: `disconnect()` while a socket object exists (`close()`, then `messageQueue = []`; an open socket has an empty queue, so this loses updates only while a socket is connecting), `createWebSocketConnection` while a socket still exists (replacement), and the connection checker's early forced close (`this.webSocket?.close(); this.messageQueue = []`). `run`: after `disconnect()` of an open socket, updates typed while disconnected are queued and flushed by `connect()` | T23 (i) and (ii) | public behaviour | T23 |
| H5 | Store hook errors | `read`: `Hocuspocus.storeDocumentHooks` catches, logs "Document stays in memory to avoid data loss", returns normally | Splitpage's own store code reports failure | public | T14, T22 |
| H6 | Store completion | `read`: `util/debounce.ts` `debounce` resolves when the timer is set; `executeNow` returns the run promise but `flushPendingStores()` discards it; `storeDocumentHooks(document, payload, true)` returns a promise that resolves after the store hooks, also after a logged failure | Barriers never treat that promise as success | public method, undocumented | T14, T15 |
| H7 | `onChange` and broadcast order | `read`: `Hocuspocus.handleDocumentUpdate` calls `onChange` without await from the document `update` event; `Document.handleUpdate` then broadcasts, batched with `setImmediate` by default (`flushDelay: 0`); the sender's status is written after apply and can precede fan-out | Nothing is broadcast before `beforeSync` returns | public | T22, T18 |
| H8 | Stateless messages | `read`: server: stateless case calls `statelessCallback` without await; `Connection.sendStateless`, `Document.broadcastStateless`. Provider: `sendStateless`, `stateless` event | Barrier requests and refusal notices ride this path | public | T15, T19 |
| H9 | Read-only refusal without disconnect | `read`: `connection.readOnly` is a public mutable field checked after `beforeSync` in the same call; the connection stays open. `afterHandleMessage` runs after apply | Setting it in `beforeSync` refuses that update; clearing it in `afterHandleMessage` makes the refusal temporary (T19 c) | public field | T18, T19 |
| H10 | Hook exceptions | `read`; `run` for the close (Y15): `Connection.processMessages` catch: closes with the error's code or reset and empties the queue | Never used for permanent refusal | public | T18 |
| H11 | Can the app hold back the provider's initial exchange? | `read`; `run` for the order (T23 (i): the provider's SyncStep2 reached the server after its queued updates): `startSync` sends SyncStep1. Server `readSyncMessage` for SyncStep1 writes SyncStep2 into the reply buffer and sends its own SyncStep1 at once (`connection.send`); `apply` sends the buffered SyncStep2 afterwards. The provider answers the server's SyncStep1 with `Y.encodeStateAsUpdate(provider.document, serverStateVector)`. `documentUpdateHandler` sends every non-provider-origin update at once. No filter hook; only `attach()`/`detach()` | Hold through M3's network document N | public | T16, T19 |
| H12 | Per-connection revocation | `read`: `onAuthenticate` runs once per connection; `connection.context` holds what it set; `Hocuspocus.closeConnections(documentName)` closes a whole document; per connection: `document.getConnections()` filtered by context, then `connection.close()`, which does not clear `messageQueue` | `beforeSync` rechecks a revocation flag; no queued update lands after revoke | public | T18 |
| H13 | Limits before processing | `read`: `ClientConnection`: `maxUnauthenticatedQueueSize` 5 MiB, `maxUnauthenticatedQueueMessages` 1000, `maxPendingDocuments` 100; `Server.ts` passes WebSocket server options such as `maxPayload`, applied before authentication | Values for T18 (a) | public | T18 |
| H14 | Loading does not re-trigger stores | `read`: `Hocuspocus.createDocument` applies what `onLoadDocument` returns while `document.isLoading` is true, then sets it false and registers `onUpdate` (which leads to `onChange` and the store debounce). `Document`'s constructor already listens with `this.on("update", this.handleUpdate)`, so the replayed update enters broadcast batching like any other | Journal replay triggers no `onChange` and no store hook; it does enter broadcast batching, harmless only while the document has no connection, which the test records | public | T17 |
| P1 | Local replica write completion | `read`: `y-indexeddb@9.0.12` `_storeUpdate` calls `idb.addAutoKey` without reporting completion | Own adapter | n/a | STORE |

## Open questions

| Question | Settled by | Serves |
| --- | --- | --- |
| Does one identity pass per painted beat in Candidate A stay under the input budget on the 2 MiB fixture? | PERF under T02 | T02, PERF |
| Does soft-removed text keep growth within the Stage 0 limits under repeated delete and restore? | T10 looped | T10, PERF |
| Can M2 tell which repeated word a native deletion removed from `beforeinput` target ranges? | T03 under M2 | T03 |
| Does U-H1 (truncating `undoStack` around `undo()`) stop the skip without side effects on redo? | T21 scalar | T21 |
| Does setting and clearing `connection.readOnly` around one message behave as H9 reads? | T18 (b), T19 (c) | T18, T19 |
| Does a revoked connection's queued update still apply after `close()`? | Revocation test in 1b | T18 |
| Which dependency forms can a pre-apply check detect (Y13)? | Y13 experiment | T18, T19 |
| Can the N and E writes of M3 share one storage transaction? | STORE restart test | STORE, T16 |

## Decisions for Adam

| Decision | Assumed meanwhile | Serves |
| --- | --- | --- |
| Two people press Enter at the same point | Both breaks show, leaving an empty beat; alternative: hide it | T05 |
| Someone types exactly where another splits | Which side the text lands on depends on internal client order; accepted as long as every replica agrees | T05 |
| An edit to a beat someone else removed | Goes to recovery, not into a neighbouring beat | T04, T09, T10 |
| A beat split after another person removed it | The parts stay removed | T11 |
| Two tags cross after merging | The tag starting later is shown untagged and listed in recovery | T20 |
| A reply to a comment whose creation was undone | Kept in recovery | T21 |
| Undo when another person made the same change | Nothing visible changes, the step is used up, a short notice | T06, T21 |
| A join group's status, and concurrent status changes | Highest status across the joined beats and across concurrent changes; a reset wins only over changes it has seen (as `2-fields.md` Decision 1) | T06, T21 |
| Edit stamps | Beat `updatedAt`/`updatedBy` once per typing group; `rev` and `lastEdited*` only on export | PROJ |
| A scene left with no beats, a script with none | Scene listed in recovery; empty script waits for the first keystroke | T10 |
| A scene name over 200 characters after merging | Shown in full with a notice; it can't grow further | T08 |
| Two b-roll keys with one id after merging | The later key is unanchored in the shot list until reassigned | PROJ |
| An owner assigned to a person someone removed | Assignment kept as text; the person listed in recovery | PROJ |
| Wording for a refused update (T18, T19) | Not in the plan's status table; to be written with the status wording | T18, T19 |

## Doc mismatches

| Doc | Code | Serves |
| --- | --- | --- |
| `docs/COLLABORATION-PLAN.md` §8 and §10: a read-only connection is answered "not applied" for an update that carries new changes | 4.8.0 answers every update message "not applied" on a read-only connection; only SyncStep2 is checked with `snapshotContainsUpdate` | T18 |
| Same sections: the built-in acknowledgement means "applied in memory" | It is also sent when `applyUpdate` threw and the error was swallowed, and for updates whose structs wait pending (Y15, H2) | T18, T22 |
| Same, §8: "unsent buffered updates are dropped when the socket closes" | Kept on an ordinary close and sent after reconnect, also when `disconnect()` follows the close (`run`); dropped by `disconnect()` while a socket object exists, socket replacement and the connection checker's early close (H4) | T23 |
