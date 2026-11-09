# Stage 0 audit 5: invariant matrix

What each invariant in [invariants.md](../../architecture/invariants.md) means in shared mode, and the concrete check a Stage 1 trace must pass for it ([plan](../../COLLABORATION-PLAN.md) §12 item 5).

Baseline: `0ca1929177ffc84bced412ad2be3aa99690761d0`.

How to read the pass criteria. "Checker" is the independent character-identity model of plan §13. It knows every character's identity, every mark's identity and every record id, and it gets the expected result written by hand. "Assert" is a plain assertion on a counter, spy or byte scan in the harness. "Recovery" means the recovery list of plan §6: each entry names its source beat or comment id and its character identities. Each criterion holds on every replica, including the late joiner, under every delivery order the queue produces (delays, duplicates, reorders).

## Table 1: invariants in the named areas

Statements are as the code does them today; where the ledger differs, see "Doc mismatches".

| Invariant | Held by | In shared mode | Why | Pass criterion for Stage 1 | Serves |
| --- | --- | --- | --- | --- | --- |
| **Comments** | | | | | |
| INV-18: a comment is anchored by its `cmt` mark. After any change that moves runs, `syncCommentAnchors` (`src/core/text/anchors.ts`) points the comment at the first cell holding its mark, in the same transaction and undo record. A comment whose mark is gone keeps its last position; a fully removed beat takes its comments | `src/test/comment-anchors.test.mjs` "a comment points at the first cell holding its mark, in document order", "a comment whose mark is nowhere keeps what it had…"; `tests/application/split-join.test.ts` "E9 (seeded): split and join leave every comment where reconciliation would put it, in one undo record" | Intentionally different | §5 keeps the intent (marks travel with their words) but anchors become a derivation that never writes back (§4), and removed comments go to recovery instead of being deleted with their beat (§5, §6) | After T11, and after T05, T06, T08 and T09, for every comment id present before: (checker) the characters carrying its mark are exactly the hand-written expected identities. If none remain active, the id is in recovery with its body and replies. The projected `rowId` and `field` equal the first marked character in document order. (Assert) The projection writes zero shared updates for anchor repair | T11, T05, T06, T08, T09, T10, PROJ |
| Replies (no INV-n): independent records under their comment | none; `src/test/migrate-rows.test.mjs` "comments: bodies and replies are sanitised, authors are plain text" covers only cleaning | Left to an experiment | §5 asks for independent reply records in a fixed display order, which nothing holds today | After T11, with concurrent replies to one comment from two replicas: (checker) both reply ids are present, in the same order on every replica. A reply made while another replica removes its comment is in recovery under that comment id | T11 |
| INV-21: split and join use the same text primitives; comment marks follow the surviving text; a join keeps both visual descriptions, pictures in order, and comment anchors; each gesture is one undo step | `tests/application/split-join.test.ts` "E9: a join brings the later scene's comments to the earlier scene…"; `src/test/split-join-app.test.mjs` | Left to an experiment | §5: copying the visual into the surviving beat fails while another replica can still edit the original; the join rule is a prototype output | T06: (checker) every character identity of both visuals appears once in the active projection; the picture sha list is the two beats' lists joined with no repeats; the joining whitespace appears once. T07: (checker) every character the other client typed is in the joined visual or in recovery with its source beat id. T05: two splits at one point give the same boundaries on every replica, and no text is lost | T05, T06, T07 |
| INV-03: tags nest only by full containment; a comment or link covers all of a tag or none of it | `src/test/doc-model.test.mjs` "a comment or link covers all of a tag or none of it"; `tests/features/tags/occurrence-editor.test.ts` | Left to an experiment | §5: Yjs gives each attribute one winner per character, so each tag, comment and link needs its own representation and the projection must read crossing states one fixed way | After overlapping tag and comment edits: (checker) every replica gives each character the same tag stack. For any two tags, their character sets are nested or disjoint. Every comment or link covers all or none of each tag's characters. Every tag id from before is either active or in recovery | T11 (see Open questions) |
| INV-55: comment and reply draft boxes own their undo (`editDraft`); pictures in a draft survive every edit | `src/test/draft-edit.test.mjs`; browser `81-draft-edit.txt` | Preserved | §4: comment and reply draft editors keep their own undo | In the slice, during T11 with a comment draft open: (assert) a remote update to that comment leaves the draft box's text and undo stack unchanged, and Ctrl+Z in the box changes only the box | T11, SLICE |
| **Work per keystroke** | | | | | |
| INV-06: typing runs no document-wide derivation; refreshes coalesce in one 180 ms idle window (`createEffectScheduler`); the undo owner's whole-document `flush` diff is the one kept exception | `tests/application/cell-text.test.ts` "INV-06: a burst of keystrokes through the typing command runs each derivation once per idle window"; browser `67-render-perf.txt` | Preserved | §3: remote changes go through the session as a transaction kind and publish the same change set as edits | In the slice: (assert) a burst of remote one-character updates into one beat runs each derivation at most once per idle window (scheduler counter). A remote update followed by a local no-op sends zero new shared updates (§4) | SLICE, T02, PERF |
| INV-07: a change inside one row repaints only that row's changed fields; other rows keep their DOM nodes, focus and caret | browser `67-render-perf.txt`, `288-scene-status-effects.txt` | Preserved | §3: one-row repaints keep working; the session stays the only publisher of change | T02 in the slice: (assert) a remote update to beat B, while beat A is focused, repaints only B. A's node is the same object and its caret offset is unchanged. (Checker) the remote text survives the next keystroke in A | T02, SLICE, PERF |
| **B-roll key ids** | | | | | |
| INV-54: no two b-roll keys share an id. A paste gets a fresh id when the id is taken; split, join and cut keep it; the anchoring pass re-keys any duplicate that still gets through | `tests/core/production/broll.test.ts` "INV-54: anchoring gives a key repeating an earlier line's id an id of its own…"; `tests/application/clipboard.test.ts` "seeded: a pasted copy never leaves two keys with one id in the script" | Left to an experiment | §4 and §5: the backstop writes into the document on commit; in shared mode it becomes a pure projection rule or an explicit command | After T05 and T06 with keyed lines, and two replicas pasting one copied key: (checker) no two active keys share an id on any replica, and every replica gives the same keys the same ids. (Assert) the projection writes zero shared updates | T05, T06, PROJ |
| **Blob completeness** | | | | | |
| INV-52: no durable record names an image its store lacks. Today only the client half exists: history, drafts and app-data import `persist()` the shas `refsIn()` lists before writing the record. `server/server.ts` is a static server with no blob checks | `src/test/blob-store.test.mjs` "persist resolves only once the backend has stored the bytes"; `src/test/blob-policy.test.mjs` (`refsIn`); browser `65-blobs.txt` | Left to an experiment | §7: upload-before-sync or the pending-image contract; the second changes the server half of the rule and needs approval first | T16, upload-before-sync: (assert, harness log) every sha in any outbound update frame has a durable server blob-membership record logged before that frame. Pending-image: the reference arrives marked pending, other clients show a placeholder, and no status says saved for it before its bytes are durable. T17: (assert) `refsIn(projection)` is a subset of the server's blob set. T13: no invitation is shown before every `refsIn` sha of the initial state is durable | T16, T17, T13, STORE |
| INV-31: a `.splitpage` file is `inlineBlobs(migrateRows(state))`, with every picture inline | `src/test/formats.test.mjs` ".splitpage carries its pictures inline; the page names them by imageRef" | Preserved | §7: an export keeps standalone-format behaviour and names missing assets | After T16, a standalone export: (assert) every `refsIn` sha is inline, or is named as missing before the export is reported complete (§2 item 7) | T16, PROJ |
| INV-04: every top-level field survives migration, merge and save, through `STATE_FIELDS` | `src/test/state-fields.test.mjs` "INV-04: a field added to STATE_FIELDS survives migrateRows, mergeStates and a .splitpage save, with no other edit" | Intentionally different | §5: the projection derives every persisted field; merge strategies are replaced by shared-state policies | (Checker) the projection of each canonical fixture round-trips with no field or metadata lost, and the "omitted field" defect makes the checker fail | PROJ |
| **Edit recording** | | | | | |
| INV-53: every edit is a session command (`run`, kind `edit`) or `noteEdit` of unknown extent: one generation, one undo record. `disk`, `reload`, `recovery` and `adopt` add no generation and no undo record; a no-op has no effects | `tests/application/document-session.test.ts` "E2: an accepted command makes one generation transition, records undo once and runs one effect pass, in that order", "E3: a no-op…have no effects", "E4: user edits, disk updates, reloads, recoveries and adoptions are published as distinct kinds"; `src/test/undo.test.mjs` | Intentionally different | §3: a remote change records no undo, stamps no attribution and triggers no save; §4: shared undo is selective, scoped to local origins | In every trace: (assert) a remote transaction adds 0 undo entries, 0 attribution writes, 0 save schedules and 0 file writes. Local undo entries equal local user actions under the grouping rules. T12: (checker) undoing a local structural action after remote edits leaves every remote character active and duplicates no restored identity | T12, T10, T02, SLICE |
| Undo owner behaviours (no INV-n): `COALESCE_MS = 1000`, `MAX_ENTRIES = 200` (`src/application/editing/undo/history.ts`), redo parking, composition marks | `src/test/undo.test.mjs` (the coalesced-back and redo tests); browser `73-undo.txt`, `289-script-cell-ime.txt` | Left to an experiment | §4: each one shared undo does not keep is a recorded difference | The T12 report lists each of the four as kept (with an assertion naming it) or as a recorded difference | T12, T04 |
| INV-20: one save status (`flowSaveStatus`) for both modes; a failed retry stays actionable | `tests/features/title/save-status.test.ts`; browser `363-writer-flow-save-status.txt` | Intentionally different | §8 adds the shared wordings to the same surface, with no second status surface | T14, T15, T19: (assert, against the harness-owned send log) "Your changes saved to server" for generation g appears only after a receipt covers every update this device sent through g. The covered generation never goes down. T19: status never shows saved for a rejected update | T14, T15, T19 |
| INV-51: autosave writes only to a file the user picked, only when on, and halts after unreviewed work | browser `28-autosave.txt`, `42-local-merge.txt`; `tests/application/save-status.test.ts` "INV-51 where…" | Intentionally different | §3: a shared instance is detached from automatic file writers | In the slice: (assert) zero calls reach the file writer or any autosave destination during any trace | SLICE |
| **Document identity** | | | | | |
| INV-35: a loaded document has a `docId` matching `DOC_ID_RE` (`/^d[0-9a-f]{32}$/`, `shared/doc-id-policy.ts`); the seed and Standalone HTML export have none; an invalid id counts as unique | `src/test/doc-id.test.mjs` "normalizeDocId treats anything but the canonical shape as absent"; `src/test/export-capture-app.test.mjs` "an exported Splitpage copy is the saved file without the document's id…" | Preserved | §3: an instance mints its own `docId`; the source file keeps its id and history; every export gets a new id | T13: (assert) the instance id matches `DOC_ID_RE` and differs from the source file's id; the source file's id and history are unchanged. Two exports from one instance carry different ids, neither equal to the instance id, so opening both triggers no `chooseDuplicateLoser` reassignment (`desktop/doc-claims.ts`) | T13, SLICE |
| INV-36: the id forks only when a Save As or detached draft recovery writes out; a restore keeps it; whether a file is already open is decided by path, never by `docId` | `tests/application/transitions.test.ts` "INV-36: a copy written elsewhere forks the id once it was written out, and keeps it before"; `src/test/doc-id-policy.test.mjs` | Intentionally different | §3 and §9: instance creation mints an id, and a shared instance needs its own tab source for duplicate detection | T13 retry: (assert) the same creation-operation id returns one instance id, and no second active instance exists. T17: the joining client's `docId` comes from shared state and equals the instance id; it is not minted locally | T13, T17 |
| **Credential exclusion** | | | | | |
| INV-48: before an app-data export writes a byte, a key walk with `APPDATA_SECRET_RE` (`src/features/settings/app-data.ts`) finds nothing; a matching import is refused; unreadable images go in `missingBlobs` | browser `27-app-data.txt` cases 2 and 7; `34-desktop-app-data-export.txt` | Preserved, extended | §14: extend the scan to cover the replica and credential stores | After T13 and T17, with an invitation token held on the device: (assert) the app-data bundle's key walk matches nothing, and the token string and its hash appear nowhere in the bundle bytes | T13, T17, STORE |
| INV-29 and INV-62: connection secrets never persist in shared places | none live. The cited desktop smoke, `connection`, `server-transport`, `collaboration-authority` and `collaborate` tests are gone | Left to an experiment | §14: revive or replace them instead of adding parallel rules; see N1 in Table 3 | See N1 | T13, T17, T19 |
| **Recovery** | | | | | |
| INV-40: a desktop crash draft is removed only when its tab is clean or by a user decision; the browser keeps no drafts | `desktop/test/drafts.test.mjs` "session states, take never deletes…"; `src/test/m4-matrix-recovery.test.mjs` | Intentionally different | §3: no separate drafts of the live document in shared mode; the replica is the recovery source | In the slice: (assert) the draft writer receives zero writes for the shared session. STORE: after a kill and restart, (checker) the rehydrated replica holds every character whose local write was confirmed | SLICE, STORE |
| INV-41: restoring a draft never writes the user's file; a `recovery` settle schedules no autosave | `desktop/test/smoke.mjs` "the file on disk is untouched by the restore (invariant #41)"; matrix T5, K1 in `src/test/m4-matrix-*.test.mjs` | Preserved (standalone) | §3: restoring a history checkpoint in shared mode must not overwrite the replica | In the slice, after a checkpoint restore: (checker) the restored text arrives as new identities and the replaced characters stay recoverable. (Assert) zero file writes | SLICE |
| Merge and conflict stash (no INV-n): the local three-way merge and `applyStashedWork` (`src/application/recovery/stashed-work.ts`) over `splitpage-conflict-stash` | `tests/application/conflict-stash.test.ts`; `tests/application/apply-merge.test.ts` | Intentionally different | §3: both are disabled in shared mode | In the slice: (assert) the shared session never reads or writes the stash key and never calls the merge port | SLICE |

## Table 2: other invariants

| Id | Statement | Shared mode |
| --- | --- | --- |
| INV-01 | Edit source one site at a time (practice) | untouched by shared mode |
| INV-02 | Script cells change only through the document model | `S2`: the shared adapter becomes the write path |
| INV-05 | Script-only behaviour stays out of comment boxes | untouched by shared mode |
| INV-08 | CSS attribute selector values are escaped | untouched by shared mode |
| INV-09 | Markdown table cells are escaped | untouched by shared mode |
| INV-10 | Cells enter only in canonical, sanitised form | `S2`: projection emits `toHtml(runs)`; T18 covers wire input |
| INV-11 | Tag-card head controls beat expand | untouched by shared mode |
| INV-12 | Modifier-click on a card beats its controls | untouched by shared mode |
| INV-13 | Scene drags and file drags stay apart | untouched by shared mode |
| INV-14 | A tag category is complete everywhere | untouched by shared mode |
| INV-15 | The writer edits through one host | `S2`: the shared session is that host |
| INV-16 | Full-screen views close side panels | untouched by shared mode |
| INV-17 | A hint never edits the document | untouched by shared mode |
| INV-19 | A full-screen overlay owns focus and stacking | untouched by shared mode |
| INV-22 | Scroll to the caret, not the cell | untouched by shared mode |
| INV-23 | Ending a selection never fires a click | untouched by shared mode |
| INV-24 | Export comment order ignores panel sort | untouched by shared mode |
| INV-25 | Tag cards have one event path | untouched by shared mode |
| INV-26 | Quick-add forgets only what it added | `S2`: registry concurrency policy |
| INV-27 | `jsclick` registry symptom is not proof (practice) | untouched by shared mode |
| INV-28 | Native entry points take the least they need | `S2`: correct the removed-server text (§14) |
| INV-30 | Setup wizard only over a pristine copy | `S2`: join arrival path |
| INV-32 | Markdown data block is authoritative | untouched by shared mode |
| INV-33 | Automated desktop launches are invisible | untouched by shared mode |
| INV-34 | The renderer never sends a file path | untouched by shared mode |
| INV-37 | `sha256Hex` and `deriveDocId` are frozen | untouched by shared mode |
| INV-38 | History addressed only by `(docId, snapshot id)` | `S2`: checkpoints under the instance id |
| INV-39 | Snapshots captured synchronously | `S2`: history as explicit checkpoints |
| INV-42 | Main is the authority on tabs | `S2`: shared-instance tab source |
| INV-43 | The tab strip is a separate origin | untouched by shared mode |
| INV-44 | One quit, one question | `S2`: close with pending sync (§8) |
| INV-45 | Voice listener only for its own tab | untouched by shared mode |
| INV-46 | Listener output rebuilt before the page | untouched by shared mode |
| INV-47 | One listener, never outlives its tab | untouched by shared mode |
| INV-49 | App-data import only adds | `S2`: replica stores in app data |
| INV-50 | Installer waits for a 1.0.x folder | untouched by shared mode |
| INV-56 | B-roll shot stores only hand-added props | `S2`: per-shot set policy |
| INV-57 | Exports state facts through one kit | untouched by shared mode |
| INV-58 | Export decoration skipped on re-import | untouched by shared mode |
| INV-59 | The `.md` human half is frozen | untouched by shared mode |
| INV-60 | An export is the same bytes all day | untouched by shared mode |
| INV-61 | PDF footer is a pagination artifact | untouched by shared mode |

## Table 3: draft new invariants (plan §14)

All four are **draft, not adopted**.

| Id | Testable statement | First trace | Serves |
| --- | --- | --- | --- |
| N1 (revives INV-62 and INV-29 app side, extends INV-48) | Credentials never enter document content: no outbound update frame, stored replica state, projection, standalone export, history checkpoint or app-data bundle contains the invitation token, the management secret, or either one's hash, and no key in them matches `APPDATA_SECRET_RE`. Checked by a byte scan for the known token strings | T13 | T13, T17, T19, STORE |
| N2 | A receipt covers the edits it acknowledges: "saved to server" for generation g is shown only if the harness's own record has durable journal or checkpoint coverage for every update this device sent through g, plus durable membership for every `refsIn` sha in them. Coverage within one connection never decreases, and a receipt from a closed connection never raises coverage for updates sent later | T14 | T14, T15, T19 |
| N3 | Recovery keeps removed concurrent work: after all deliveries, every character identity any replica inserted is either active exactly once or in recovery with its source beat or comment id, never neither. Restoring adds no second active copy | T10 | T10, T04, T07, T11, T12 |
| N4 | Instance isolation: two instances on one device share no `docId`, replica storage key or credential entry. An update for instance A never changes instance B's replica, and a replacement instance never hydrates from its predecessor's storage | STORE (no T trace; plan §13 "Isolation" is release evidence) | STORE |

## Open questions

- Plan §13 has rows that no Stage 1 tag names: concurrent tag edits with a comment across part of a tag (INV-03), undo of a mark or comment change, "acknowledged then killed before any debounced store", "reconnect with acknowledged, unacknowledged and never-sent updates", and the second tab. INV-03 cites T11 for now. The coordinator should give these rows tags.
- If a comment's words are all deleted inside a surviving beat, standalone keeps its last position. Shared mode might keep that position or list the comment in recovery. T11 settles which.
- Reply display order under concurrent replies (post time, then id?) is unspecified. T11 settles it.
- Comment body versus an open draft box when a remote edit changes that body: INV-55 keeps the box, but nothing says which text Save writes. Settled by T11 in the slice.

## Decisions for Adam

- If Stage 1 picks the pending-image contract, the server half of INV-52 changes, and plan §7 says that change is approved before implementation. Assumed for now: no decision until a design is picked.

## Doc mismatches

- INV-52: the server half (422 `missing-blobs`, `acceptMissing`, 426) describes the removed server. `server/server.ts` is static, and `tools/test-server.mjs` checks that `api/blobs/missing` is not served.
- INV-53 and INV-06 "As built": `markDirty()` no longer exists in `src/`. Legacy writers call the session's `noteEdit` (unknown extent).
- INV-29: the cited `src/test/connection.test.mjs`, `server-transport.test.mjs`, `collaboration-authority.test.mjs` and the desktop smoke "no token and no PIN in desktop-state.json" check are gone. Nothing asserts the desktop half. The E15 test is now titled "a capture taken with a file home holds no file name or handle".
- INV-62: the cited `src/test/collaborate.test.mjs` and `260/261/263-collaborate-*` suites are gone (the row is retired).
- INV-36: it says whether a document is open is decided "by path or server document id". Desktop tab sources are only `file` and `blank` (`desktop/desktop-state.ts` `normalizeTabSource`).
- INV-41: the cited `tests/application/restore-policy.test.ts` does not exist.
- Plan §3 lists transaction kinds `edit`, `disk`, `reload`, `recovery`, `adopt`. `TransactionKind` (`src/application/session/change-set.ts`) also has `replay` and `amend`, which both advance the generation without recording undo.
