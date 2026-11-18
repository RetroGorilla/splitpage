# Design: the shared-document layer on standard Yjs

Proposal, 2026-11-18, third revision; nothing is built. It replaces `src/adapters/collab/` under rule 12 of
`AGENTS.md` (PR #1624). It rests on the native spike (`prototypes/collab/src/native/REPORT.md`, "spike"),
experiments E1, E2, E3 and E5 (section 8), the rule inventory (`docs/collaboration/native-rule-inventory.md`, ids such
as M01), the checks in [appendix B](#b-evidence) and the sources in [appendix A](#a-sources). Server, invitations,
disk storage, pictures and the screen are out of scope.

## Owner decisions

| Question | What a person notices | Cost | Recommendation |
| --- | --- | --- | --- |
| Are formatting keys one per kind (`b`) or one per formatting action? | Per kind: now and then a word stays plain that someone bolded, or undo leaves formatting behind. Per action: the same in rarer cases. Text is never lost under either (section 1) | Per action: about 19% more storage after a realistic year, 48% to 54% after heavy use, special reading code (E4, pending review) | None yet: after E4 |
| Are comment and reply bodies whole values or shared text? | Whole: when two people edit one body at once, one person's edit is lost. Shared text: both edits stay, letters interleaved | Whole: nothing new. Shared text: the comment editor writes insertions and deletions instead of the whole body, a `Y.Text` per body, and the reply editor needs the same | Shared text: a lost edit is lost typed text |
| Can people reorder beats or scenes, or cut and paste whole rows, in the first version? | Refused: shared mode says reordering is not available; ordinary copy, paste, cross-beat selection and delete still work, and a cut across rows is a delete then a paste of new text. Allowed: everything works as now | Refused: nothing; the plan allows it (`docs/COLLABORATION-PLAN.md`, "Normal writing is mandatory"). Allowed: a design experiment, then tests for identity, writes at source and destination, headings, shots and undo | Refuse in the first version |
| Must every shared script stay within one shared history for its whole life? | Yes: a script far past a measured lifetime budget warns its owner to start a fresh shared copy from an export. No: a later version can replace the history, which needs mixed-version, offline-return and cutover handling | Yes: a realistic-year measurement and a visible budget. No: a protocol experiment before release | Yes, with the budget set from a measured realistic year |
| Does undoing typing in a removed beat wait for its restore (U14)? | Wait: the press does nothing visible until a restore. Not wait: the press undoes at once inside the removed beat, still in recovery | Wait: extra code around `Y.UndoManager`. Not wait: none | Not wait |

## 1. Stored shape

Native Yjs: one `Y.Doc` per script, no subdocuments; an ordered `Y.Array`; records as `Y.Map`s with one key per
field; `Y.Text` with length-1 embeds that no edit can split. Application choices, measured in the spike, E2 and E5:
segment heads plus inline boundary embeds, a separate visual cell per beat, and flags for join and removal.

| Root | Type | Holds |
| --- | --- | --- |
| `meta` | `Y.Map` | `format` (section 7), `docId`, `wordsPerMinute`, `targetSeconds`, `paragraphsDecided`, the file's `schema`, unknown file fields as one JSON string; `title` is a `Y.Text` |
| `births` | `Y.Map` | creation id to `{at, by}` (section 6) |
| `order` | `Y.Array` | segment keys in script order |
| `segments` | `Y.Map` of `Y.Map` | `head` (`{b: beatId}` or `{h: headingId}`) and `text`: narration, heading names, boundary embeds, atoms (`{k: shotId, label}`, `{w: name}`, `{img: ref}`, `{video, host}`) |
| `beats` | `Y.Map` of `Y.Map` | `status`, `lengthSeconds`, `paragraphStart`, `extra`; `joined = {glue}` and `removed = {by, at}` when set |
| `visuals` | `Y.Map` of `Y.Text` | one visual cell per beat |
| `headings` | `Y.Map` of `Y.Map` | heading fields other than the name; `removed` when set |
| `comments`, `replies`, `people`, `tags`, `shots` | `Y.Map` of `Y.Map` | the file's fields and `rank` (ties by id, F30); bodies per the owner decision |
| `edited` | `Y.Map` | per beat, `{by, at}` of the last typing group |

A beat or heading runs from its boundary to the next; a split inserts an embed and text never moves between
containers. Every other field is an atomic value: of two writes at once Yjs keeps one, with both copies agreeing
(statuses, `resolved`, `edited`, decided 2026-11-18). Not stored: derived values (sections, row order, joined-row
fields, tag extents, comment anchors, recovery entries, durations; paragraph positions until a paragraph edit commits
them, T14), the script's `rev` and last editor (export only), presence, undo stacks and selections.

**Formatting: owner decision pending, E4.** Native attributes with the value `true`, keyed by kind (`b`, `i`, `u`,
`s`, `hl`, `dir`, `cue`, `c:<commentId>`, `t:<tagId>`, `l:<url>`) or by action (the kind, U+001F, the acting copy's
client id and clock in base 36, stripped on read). Neither scheme lost text or made copies disagree in any run; the
evidence for each, with what each counter means, is in [appendix E](#e-formatting-evidence).

## 2. Writing contract

**Direct and buffered edits.** A direct command (Enter, boundary Backspace, delete, paste, formatting, split, join,
remove, restore, record edits, undo, redo) is planned and run in one synchronous call against the live document, so
its base is always current. An edit held across tasks (a composition, a Split cell buffer) is buffered: it keeps the
cell's painted units and folds every `Y.Text` event into them (section 4), then commits through them.

**Targets.** Every write resolves its target by id when it runs and checks it is live. Yjs deletes what is written
into a deleted type, and a replaced cell leaves a held position resolving to `null` and a write through the old cell
unseen (appendix B; E1, stale cells). A buffered edit whose cell is gone, or that cannot be applied, is refused: its
text goes to the session's local recovery list, kept with the local replica and shown in the recovery panel; nothing
is written to the shared document (R02 is dropped).

**Compounds.** A compound command (paste over beats, split with fields, cross-beat delete) validates every part
(targets live, size bound, section 7) before its first write, then writes all parts in one transaction under the local
origin. A throw after the first write inside `doc.transact` still commits and emits that write (appendix B). A product
no-op compares before `Y.Map.set`: setting a key to its current value emits an update and wakes remote observers.
Typed and pasted text inserts before it deletes (spike `splice`); offsets never cut a surrogate pair (rule T11).

**What happens after a transaction.**

| Transaction | Origin | Revision | Editor | Provider |
| --- | --- | --- | --- | --- |
| A command | local object, tracked | advances | one notification per command | sends what Yjs emits |
| A command without undo (resolve, reopen) | second local object, untracked | advances | one per command | sends |
| Undo, redo | the `Y.UndoManager` | advances on each update | one per press, after the caret is restored | sends every update, cleanup included |
| Yjs formatting cleanup | `null` | advances | joined to the command or press that caused it | sends |
| Converting a file | `"hydration"` | advances | the first full projection | sends only after the birth is committed |
| A remote update | the provider | advances only if Yjs emits `update`; a packet missing a dependency emits nothing until it arrives, a duplicate nothing | changed rows only; none when no row changed | nothing back |

The wire carries whatever Yjs emits; one update per press is not required. One editor notification per press is
checked at the editor boundary.

## 3. Undo

Standard selective undo (decided 2026-11-18): one `Y.UndoManager` per shared session, made on entry, destroyed on exit
(U38), `undo()` and `redo()` called directly so the manager owns its transaction; wrapped in an outer transaction it
left one undo entry and no redo (appendix B). E3 (`prototypes/collab/src/native-undo/RESULTS.md`) kept every
character and field in its command tests and 600 generated histories with action keys, copies and late joiners
agreeing at each settled check.

| Setting | Value |
| --- | --- |
| Scope | every root a command writes, `headings` included (E5); not `births` or `edited` (F33) |
| `trackedOrigins` | the local command object; remote, hydration and cleanup untracked (U01, U12) |
| Grouping | infinite `captureTimeout`; `stopCapturing()` by the app's rule in `src/application/editing/undo/history.ts` (pause, cell, command, replaced selection, word, undo). E3: 8.33 against 8.07 µs per key, overlapping |
| `deleteFilter` | keep-always: undo never deletes a record or cell it created (section 9) |
| `ignoreRemoteMapChanges` | `false` |
| Depth | no cap: Yjs has no public bound; a 200-entry cap through `undoStack.shift()` skipped the manager's cleanup and saved no encoded bytes (E3) |

**Fields.** Undo does not restore a value over a field someone else has written since (E3). It does restore the value
its own write displaced, which can be another person's earlier value, and a step whose effect is gone is passed over
for an older one. An absent status reads `todo`; when two people set the same status and the presser's write stood,
undo leaves it absent and redo brings it back. A fallback written after undo blocked the next redo (appendix B).

**Caret.** Specified: each step keeps the caret as a relative position captured before the group's first edit,
restored on `stack-item-popped`; an undo press stores the caret before it in the redo entry. Checked: a caret in one
cell (E3), local heading creation and removal (E5). Not checked: selections wider than a caret, grouped steps across
rows that changed meanwhile, the caret after a structural undo in Split.

**Declared difference.** Both copies delete the same `b` of `abc`, then each undoes before seeing the other's undo:
both show `abbc` (appendix B). Nothing is lost and copies agree; it needs one letter deleted and undone by two people at
once, so it is accepted under the guide in section 9.

## 4. Incoming updates and composition

The stock provider applies updates itself (y-protocols `readSyncMessage` calls `Y.applyUpdate(doc, update,
provider)`); main's ingress gate, byte bound and trial copy go. The reader is lenient and writes nothing back (plan
section 4): odd stored states are read by fixed rules (S07, S08, S17, M08 to M12) or listed in recovery, at a reading
cost measured in slice 6.

**Composition (T04).** Remote updates apply at once; only the composing cell's repaint waits. E1
(`prototypes/collab/src/native-e1/RESULT.md`; 43 hand tests, 7 undo tests, 40,000 generated histories) lost and
doubled nothing and caught every fault control. The fold keeps the cell's painted UTF-16 units (an embed is one) and
folds every `Y.Text` event, any origin: a retain moves over live units, a delete marks them dead, an insert adds
unpainted units. The commit, after `stopCapturing()`, is one transaction: each typed run goes after its nearest painted
unit to the left, then only deleted units still live are deleted; at a tie the person's text goes first, where
CodeMirror keeps a caret. Outcomes: `written`, `unchanged`, `moved` (appended to the cell that replaced it) or
`recovery` (section 2). Painted offsets and one relative position per character were the rejected designs. Outside
E1's proof: two people composing in one cell, caret placement and real input methods (slice 6). Declared
difference, plain Yjs: text composed next to a character already deleted can land on the other side of a simultaneous
insertion there, 25 of 20,000 histories with undo and 28 without.

## 5. Telling the editor what changed

The session's `ReplicaPort` (`src/application/session/shared-session.ts`) stays. `observeDeep` marks dirty segments,
beats and records; a change to `order`, a boundary, `joined` or `removed` is structural and regroups rows, otherwise
only rows owning a dirty beat are rebuilt, plus rows showing a dirty tag, person or shot through an index from record
id to rows. Rows that differ become `SharedProjectionChanges`; unchanged rows keep their identity. The spike's remote
keystroke with its change set took 0.022 to 0.023 ms median at 30, 300 and 900 beats (main 1.58, 6.83 and 23.52 ms),
on a narrower path than the session's: the wired path is measured in slice 6 before that figure is relied on.

## 6. One birth

Two conversions merge badly: with independent creation they list the beat twice and drop one copy's typing; under one
creation id they keep one `births` entry, list the segment twice and keep one copy's cell (appendix B), so a second
birth cannot be detected reliably. Birth is therefore a slice 1 contract. An authoritative, durable create-or-load,
keyed by the plan's persisted creation id, stores the first converted state and returns the same encoded bytes to every
later call, retries included. Every caller adopts the committed bytes before it enables editing or publishing, so no
edit is ever made on an unconfirmed conversion. The conversion is one `"hydration"` transaction into an empty document
writing `meta.format = 1` and `births[creationId]`; every record is a `Y.Map`, never a plain object (E3), and every
heading is a segment head (E5). Client ids are unique per session: each session makes a new `Y.Doc`. Where the store
lives is the server's design.

## 7. Contracts settled before slice 1

- **Format admission.** A copy edits only a document whose `meta.format` equals its own. A higher one opens read-only
  with export; the connection carries the format and the server refuses a different one, so an older copy, online or
  returning offline, cannot write a newer shape and keeps its unsent work for export. Reason: an older copy cannot
  know what a newer field means. Any format change needs its own upgrade design before it ships.
- **Size.** A command is bounded by encoded bytes, not characters: 1,000 pasted characters emitted 1,014 bytes plain,
  37,809 with one identified key per character and 145,593 with four (appendix B). Reconnect sync sends the whole
  missing state as one message, so the transport must accept a message up to the document's lifetime budget (owner
  decisions), and a command whose estimated bytes, from per-character, per-key and per-embed costs measured in slice 2,
  would pass that budget is refused before writing.
- **Reload against new history.** Reloading the same binary history into a fresh copy drops undo history and the
  deleted content it holds, and still merges remote work: the only rebuild in the first version (section 10). Creating
  a new shared history from the visible text duplicated it when synced with the old (appendix B), and the plan forbids
  rebuilding an instance from its plain projection.
- **Moves and clipboard.** Normal writing is mandatory (plan, "Normal writing is mandatory"): typing, formatting, Enter,
  boundary Backspace, cross-beat selections, copy and paste, paste within a beat, scene headers. A cut across rows is
  a delete, and its paste writes new text and beats. Explicit reordering, which would move rows with their records,
  keeps main's refusal (appendix D) before any write, pending the owner decision.

## 8. Joins, removal and headings

Retaining containers under flags is the smallest tested way to keep concurrent writes editable. Copying a joined
visual cell lost another copy's typing (appendix B); deleting a narration boundary left the later beat's visual cell
in recovery with no restore (E2); deleting a heading's segment head stranded 790 letters in 525 of 1,000 E5 runs where
nothing could reach them.

- **Join** (E2, `prototypes/collab/src/native/E2-RESULT.md`), read contiguously: `joined = {glue}` hides the boundary
  above its beat, which attaches to the nearest visible row above in stored order; `glue` is the separator shown at the
  seam. No writer or recovery needs the earlier `into`, so it is not stored. Over the same seeds, following `into`
  showed rows out of stored order in 325 of 1,000 histories, this reading in 0; 680 showed some difference. Typing at
  the seam goes to the end of the earlier beat; a deletion across it deletes in each beat and keeps the flag; a split at
  the seam deletes the flag, elsewhere it splits the beat holding the place.
- **Removal**: `removed` on every beat of the row, since a flag on its head alone would attach the joined beats to the
  row above (E2). Restore deletes the keys; typing in a removed beat stays recoverable (decided 2026-11-18).
- **Headings** (E5, `prototypes/collab/src/native/E5-RESULT.md`): removed by a flag on the record, with the name in
  place and recoverable; restore clears it in one write.

Known outcomes, accepted under the guide in section 9 since no text is lost: a beat joined to a row someone removes
at the same time shows merged into the row above until the restore; of two removals at once Yjs keeps one, and a
restore that saw only the other leaves the row removed; a removal racing a split leaves the split-off half visible; a
join flag across a visible heading stays dormant, and restoring that heading splits the row; a letter typed at the end
of a name can land in a heading created there at the same moment, still editable (not for hydrated segment heads).

## 9. Departures and declared differences

**The guide** (owner, 2026-11-18): when two people change the same spot at the same moment, it is enough that the
merge keeps data about nine times in ten, because people understand that editing the same text at once is messy; it
is a guide, not a hard rule. Data means typed text and record fields; formatting that fails to show and returns with
one press is not data loss. Lost text, copies that disagree and crashes are never acceptable.

| Departure | Defect that forces it | Cost (appendix B) | Decision |
| --- | --- | --- | --- |
| Keep-always creation filter, against the official binding's policy of letting empty types go | Undo before another copy's write arrived deleted that write: 38 losses in 600 E3 histories under keep-holding | 37.67 bytes per undone record, 38.05 per undone split, never reclaimed in v1 | Engineering choice from a reproduced loss, owner informed |
| Formatting key per action | Kind-key formatting losses (section 1) | Section 1 | Pending, E4 |
| Join as a flag, read contiguously | Copying loses typing; boundary deletion strands the visual cell | About 40 bytes per live join | Reading: engineering choice from E2, owner told |
| Beat removal as a flag | Deleting the beat discards unseen typing (R01) | Removed text kept for the document's life; multi-beat removal not measured | Decided 2026-11-18 |
| Heading removal as a flag | Deleting the head strands the name (E5) | 15 bytes to set; 66 to 123 bytes kept per create-and-remove cycle | From E5, as beat removal |
| Composition fold | Painted offsets and per-character positions delete the wrong text (E1) | About the size of y-codemirror.next's observer | T04, set earlier |

Declared differences, plain Yjs, accepted under the guide: the composition order case (section 4); the double restore
`abbc` (section 3); an identical status left absent and read as `todo` (section 3); the join, removal and heading
outcomes (section 8); and, if bodies stay whole values, one of two simultaneous body edits.

## 10. Before release

- **Local rebuild.** An editing copy keeps every letter its own commands deleted, and `clear()` frees nothing: 20,000
  editing operations gave 83,348 encoded bytes against 77,649 freshly loaded, and pasting and deleting a 10,000-letter
  block 100 times 1,003,678 against 3,678 (E3; encoded sizes of those ASCII workloads, not heap). A copy rebuilds from
  its own stored state on entry and, at an idle moment, once deleted letters pass a threshold (E3 proposes 1,000,000),
  telling the person that undo history was cleared. Heap is measured separately before the threshold is fixed.
- **Lifetime budget.** Never reclaimed in v1: live formatting keys, 54.51 bytes per split, about 40 per live join,
  the keep-always and heading costs above, removed text. A realistic year with structure and retained content is
  measured against a stated ceiling (owner decisions).
- **Large cells and anchors.** Marked pastes into a 100,000-character cell (packets, reconnect state, render time);
  comment and tag attachment after split, join, remove, restore, cross-row paste and undo.
- **Presence**, late and optional. If built: standard Yjs awareness per session (client id, person id and name,
  selections as relative positions); nothing stored in the document; state cleared on exit and after the awareness
  timeout. It does not cover edits made offline or not yet synced, which arrive without warning, so the merge rules
  must hold on their own.
- **Open product points.** Where composed text goes when its cell was replaced (E1 appends it; the text is already
  safe under section 2), and how often an end-of-name keystroke changes heading in real scripts (E5).

## 11. Experiments and slices

| # | Experiment | State |
| --- | --- | --- |
| E1 | Composition fold | Done: [`native-e1/RESULT.md`](../../prototypes/collab/src/native-e1/RESULT.md) |
| E2 | Split, join, remove and restore races | Done: [`native/E2-RESULT.md`](../../prototypes/collab/src/native/E2-RESULT.md) |
| E3 | Standard undo under simultaneous changes | Done for action keys: [`native-undo/RESULTS.md`](../../prototypes/collab/src/native-undo/RESULTS.md) |
| E4 | Formatting keys over a long life | Open, in a fix round |
| E5 | Heading races | Done: [`native/E5-RESULT.md`](../../prototypes/collab/src/native/E5-RESULT.md) |

**Condition on choosing kind keys.** E3's verdict holds for action keys only. Kind keys need a follow-up on E3's
harness: seed 254 as a fixed regression, checked through the real provider for both updates, convergence, text,
fields, stacks, one notification and caret restoration; each of the 131 command disagreements classified as a model
limit, a permitted mark outcome, or a lost or wrong write, with representative cases pinned; and the 600 histories
rerun with kind-key mutations.

**Evidence rule for every generated test**, after three first reviews that failed on it. The model imports neither
Yjs nor the code under test. The gate runs a clean baseline that passes, then one silent-write mutation per effective
command and per sub-write of each compound; each mutation must be reported at the affected command, before a later
command fails for a missing target, and the gate lists the seeds that exercised it. A throw or lost coverage fails the
gate. Every value read from the implementation is listed with where it enters the model and which claim it prevents
the test from making. E5's immediate checks are the template; E2 borrowed concurrent order and flag winners, and E3
the library's selected undo entry on some presses.

Each slice is one pull request in `src/adapters/collab/native/`, the only place the dependency gate admits Yjs
(`tools/dep-report.mjs`). Each reports the spike's measures: stored bytes per typed character after the
11,287-character tape with two writers, as the increase over the starting fixture on a copy without undo history
(spike 1.84 with action keys); adapter keystroke median and p95 at 30, 300 and 900 beats. Proposed stop: over 2.0
bytes per character or an adapter median over 1 ms at 900 beats, apart from the app's 8 ms end-to-end limit in
`tools/perf-ab.mjs`.

| # | Slice | Exit check |
| --- | --- | --- |
| 1 | Shape, birth, typing, deleting, projection, change sets, the section 7 contracts | Literal fixture round-trip with every record a `Y.Map`; stale-target and partial-compound cases (refused text in local recovery, nothing written); birth: retries under one id with different candidate bytes, a reply lost after the durable commit, restart, racing first loads, no edit or publish before adoption; the tape on three copies and a late joiner in every delivery order |
| 2 | Formatting, identified marks, atoms | After the owner's E4 decision and, for kind keys, the condition above; the marks generator extended with comments, tags, links and embeds; the size table for section 7 |
| 3 | Split, join, removal, restore, headings, new beats, cross-row delete and paste | E2 and E5 histories on the adapter; cut and paste across rows with concurrent typing at the source; structural change with its change set at 900 beats, proposed median 8 ms or less |
| 4 | Records, status, comments, replies, stamps | Exact row, outline and recovery changes as well as values; renaming a tag, person or shot lists exactly the rows that show it; absent status reads `todo` |
| 5 | Undo | E3's tests on the adapter with the chosen key scheme; the double restore pinned; caret checks |
| 6 | Session and editor wiring, composition, test hook | E1 on the Writer; composition events through the existing harness (plan, IME); two connected editors through disconnect and reconnect; one notification per press at the editor boundary; wired-path timing for text, title, heading, recovery and record-only changes |
| 7 | Delete the old adapter and tests | The app's shared mode runs on the new layer; every deleted behaviour test mapped to its replacement or a retired rule; `npm run verify` |

## Appendix

### A. Sources

Yjs 13.6.33 `src/utils/UndoManager.js`, `src/types/YText.js`; y-prosemirror 1.3.7 `sync-plugin.js` and
`undo-plugin.js` (`defaultDeleteFilter`); y-codemirror.next 0.3.5 `y-sync.js`, `y-undomanager.js`; y-quill 1.0.0;
y-protocols 1.0.6 `sync.js`; y-websocket on its default branch, 2026-11-18; Hocuspocus 4.8.0 provider
`MessageReceiver.ts`; Yjs documentation "Y.UndoManager", "Y.Text", "Y.Doc", "Document Updates", "Relative Positions".
Experiments E1, E2, E3, E5 (section 11) and E4's draft results on branch `collab/native-e4-format-keys`, pending review.

### B. Evidence

Checks in `prototypes/collab/test/native-design/native-design.test.mjs`, Yjs 13.6.33, Node 24.22.1; all 20 pass:
`npm ci --prefix prototypes/collab`, then `node --test test/native-design/native-design.test.mjs` in
`prototypes/collab`.

| Check | Result |
| --- | --- |
| Two independent conversions merged | The beat listed twice; one copy's typing gone |
| Two conversions under one fixed client id, different text | The copies disagree |
| A retried birth under one creation id, both copies typing | One `births` entry, the segment listed twice, one copy's typing gone |
| Join by copying the second visual cell while another copy types in it / join as a flag | That typing gone / kept |
| A throw after the first write in `doc.transact` | The first write committed and emitted |
| A map key set to its current value | One update emitted; the remote observer called |
| A visual cell replaced after a position was taken in it | The position resolves to `null`; a write through the old cell is not shown |
| Plain undo of a group that deleted all it typed | Passed over; the same press undoes the step before |
| Plain undo of a record's creation after another copy set a field | Record and field gone on both copies (why keep-always) |
| `undo()` inside `doc.transact(..., undoManager)` | 1 undo entry, 0 redo entries |
| Two identical statuses, the winner undoes / a fallback written after | Absent on both, redo restores / the next redo does nothing |
| Both copies delete the same `b` of `abc` and undo before seeing each other's undo | `abbc` on both |
| 10,000 characters inserted and deleted, then `clear()` | Over 10,000 bytes encoded; under 100 in a fresh copy |
| 100 growing prefixes bolded with action keys | 100 live keys on the first character; 3,610 bytes; 1,739 decoded into a fresh copy after unformatting; 113 plain |
| A 1,000-character paste | 1,014 bytes plain; 37,809 with one identified key per character; 145,593 with four |
| A new history built from the visible text, synced with the old | The text doubled |
| A comment body as a whole string / as `Y.Text`, two people adding at once | One addition kept / both kept |

| Measured cost, never reclaimed in v1 | Bytes | Source |
| --- | --- | --- |
| Split | 54.51 | E2 |
| Live join, over a split | about 40 | E2 |
| Undone record / undone split under keep-always (over keep-holding) | 37.67 / 38.05 (+23.68 / +2.54) | E3 |
| Heading removal flag set; one heading removed and restored 1,000 times | 15; 21 in total | E5 |
| Heading create-and-remove cycle, embed / segment head | 66 / 123 | E5 |
| Typed character on the spike tape, action keys | 1.84 | spike B |

### C. Rules dropped

Assumed, class C or D, dropped 2026-11-18 with no reproduced defect: M02 to M04, M15; S11 to S15, S22; F03 to F05,
F35 to F39; U03, U04, U15, U16, U18, U21, U25 to U33, U39; R02, R03, R05, R06, R08 to R10, R13, R17; Q02, Q04, Q06,
Q07. Owner-set and changed 2026-11-18: F01, M01, U02, U13, F13, F32. Dropped after E3: U10. Pending the owner: F40
(bodies), U14. Kept: R01.

### D. What stays, changes and goes

| Code | Fate |
| --- | --- |
| Adapter: document state, ingress gate, trial replica, read caches; identities, anchors, text units, birth, creation and mark records; undo executors | Go: Yjs items, relative positions and `Y.UndoManager` replace them |
| Adapter: executors and preparation | Rewritten as four writers: text, formatting, structure, records |
| Adapter: projection, indexes; hydrate, text import | Rewritten: sections 5 and 6 |
| Adapter: buffer, painted base, recorded selection | Replaced by the fold |
| Adapter: B-roll keying, move refusal | Stay as policy |
| Core: `operations.ts`, `read-operation.ts`, `base-reference.ts` | Change: text by cell, offset and base; operations for dropped rules go |
| Core: `undo-record.ts` | Goes; a description keeps label, selection, typing key |
| Core: `recovery.ts`, `removal-state.ts` | Change: discard, deleted people and deleted records go; local refused text comes in |
| Core: projection, buffer, cell text, comment marks, records, B-roll, refusals | Stay |
| Application: `shared-session.ts` | Stays |
| Application: `shared-undo.ts`, `replayed-steps.ts` | Shrink to admission and the grouping policy |
| Application: `buffered-field.ts`; features: Writer and cell buffers | Change for the fold |
| Application: shared commands; feature: recovery panel | Change where they build unit identities or dropped operations |
| Bootstrap: `shared-session.ts`, `shared-test*.ts`, `ports/shared-*.ts` | Rewired; old tools (`tools/perf-shared.mjs`, `tools/perf-ab.mjs`) change in slice 7 |
| Tests: `tests/collab/` delivery, agreement, checker, oracles, fixtures | Carry over; dropped rules marked |
| Tests: spike and experiment tests | Move to `tests/collab/` against the adapter |
| Tests: `tests/adapters/collab/` (173 files), `tests/collab/*-mutants.json` (41 lists) | Deleted once slice 7 maps each behaviour to its replacement |
| Tests: `src/test/shared-*-app.test.mjs` (41 files) | Kept; outcomes change only for dropped rules |

### E. Formatting evidence

The counters measure different things and do not give a field failure rate side by side.

- Spike D generator: with kind keys, histories losing selected formatting, 110 to 155 per 1,000 across
  configurations, and formatting nobody applied, 2 to 5 per 1,000; with action keys, inherited formatting dropped,
  5 to 7 per 1,000.
- E3, both schemes (standard Yjs): B bolds `abcd`, A types plain `oo` between `b` and `c`, B undoes: `aboo[cd]`.
  Settled mark-model differences in 600 histories: 45 with action keys, 61 with kind keys. Command-model
  disagreements: 5 and 131. Presses decided by the library's selected entry: 294 and 281. One press, kind keys only,
  emitted two updates (seed 254); one press, action keys only, took back an older step.
- Size: 100 growing bolded prefixes leave 100 live action keys on the first character (appendix B). E4 draft, pending
  review: 437,985 bytes with kind keys against 521,823 with action keys after a one-writer realistic year (+19%),
  48% to 54% more in the heavy rows; at worst 301 keys on one letter and 698.7 bytes per action at 300 rounds.
- E4 proposals: collapse is withdrawn, because after a collapse another writer's undo of their own bold of `cde`
  changed nothing; the normalisation rule changed visible formatting in 3.4% to 4.6% of histories per configuration
  against the variant without it and is not adopted.
