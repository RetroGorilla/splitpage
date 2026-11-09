# Stage 0 closing: the Stage 1 experiment table

For every Stage 1 trace: where its inputs and expected result are written, which commands in the real editor reach it, which hypotheses and library facts it tests, and what else in the audit bears on it. It is an index. It copies no inputs and no expected results, so there is one place to correct each of them.

Baseline commit: `7fb11553`. Built from the "Serves" cells of artifacts 1 to 6 and 8 (782 tagged rows).

## How to read a row

- **Inputs and expected result**: row names in [8-schema-hypotheses.md](8-schema-hypotheses.md), section 3. Each row there gives the starting text with character identities, the steps, the delivery orders, the expected script, carets, recovery list and undo result. Those results are binding. A layout or mechanism may change in Stage 1; an expected result changes only through a product decision.
- **Entry paths**: command ids in [1-commands.md](1-commands.md). The identity model drives the trace directly; the real-editor slice must reach it through these commands.
- **Tests**: hypothesis ids (`A-H`, `B-H`, `U-H`, `PROJ-`), buffer mechanisms (`M1` to `M3`) and library facts (`Y`, `H`) in artifact 8. A fact marked `read` there was taken from package source and is confirmed by the trace; one marked `run` was already observed in a script.
- **Also read**: the rows of the other artifacts tagged with this trace.

## Order of work

Stage 1a and 1b have separate exits and may run side by side (plan section 11).

1a, in this order:

1. The identity model, the deterministic delivery queue and the late-joining third replica, with the checker failing on each deliberate defect of artifact 8 section 5 before it endorses anything.
2. T01 under M1, M2 and M3, then T04 (composition), T02 and T03. This selects the buffer mechanism and needs none of the open product decisions.
3. T05 to T12, T20, T21 and the MOVE rows under both schema candidates, with the PROJ round trip of the canonical fixtures.
4. The throwaway real-editor slice bound to two replicas through the same queue, entered through the commands listed below.

1b: the Hocuspocus 4.8.0 container with the write-ahead journal first (T22, T23, T14, T15), then T13 and T17, refusal (T18, T19), images (T16), the one-tab lock (T24) and the STORE experiments.

## Stage 1a: editing feasibility

| Trace | Inputs and expected result (8 §3) | Entry paths (1-commands) | Tests | Also read |
| --- | --- | --- | --- | --- |
| T01 | `T01` | F1, F13, S1, C1 | M1, M2, M3; Y1, Y2; defects "Lost remote character", "Stale base" | 3: `epoch()`, `generation()`, `run(command)`, `Undo.compositionMark`, the selection buffer |
| T02 | `T02`, `T02 boundary` | F1, F4, F22, S1, S12 | M1, M2; A-H7; Y1 | 5: INV-06, INV-07, INV-53. 6: its one-list summary of everything that can repaint an editable element |
| T03 | `T03`, `T03 replace` | F1, F15, S1, B1, B2, B3 | M2; Y1 | 8 open question on repeated words under M2; 1 open question 5 |
| T04 | `T04`, `T04 removed` | F2, F15, V2, S2 | M1, M2, M3; Y1, Y2 | 1 open questions 1, 2, 3, 6. 3: `Undo.hold`, `Undo.compositionMark`, `Undo.dropEmptySince`. 6 open question 2 |
| T05 | `T05`, `T05 two splits` | F8, V4, S6 | A-H1, A-H6, B-H1; Y3, Y4, Y10 | 5: INV-18, INV-21, INV-54. 2 open question 7 (beat ids minted on two replicas) |
| T06 | `T06` | F10, F11, F12 | A-H1, A-H4, A-H12, U-H1; Y7; defect "Duplicated identity (join)" | 5: INV-18, INV-21, INV-54. 2 open question 8 (gallery slot identity) |
| T07 | `T07` | F12, V1 | A-H5 | 5: INV-21 |
| T08 | `T08 remove`, `T08 create`, `T08 race` | F8, F10, F15, F16, F17, R5, R7 | A-H1, A-H11, B-H1, B-H3; Y3, Y10 | 3: `amend(task)`, `Undo.settleAfterApply`. 6: writer host blur, scene-name blur |
| T09 | `T09`, `T09 header` | F13, F14, C9, C10 | A-H3, B-H1, B-H4 | 5: INV-18 |
| T10 | `T10` | F13, C6, R4, U1, U2 | A-H2; Y6, Y8, Y9; defect "Duplicated identity" | 3: `replay(task)`, `Undo.noteRemote`. 5: INV-18, INV-53 |
| T11 | `T11` | F20, S11, P1, P2, P3, P4, P6 | A-H3, PROJ-detached; Y8, Y11, Y12; defect "Lost mark" | 5: INV-18, Replies, INV-03, INV-55, with the three comment decisions of 2026-11-09 |
| T12 | `T12`, `T12 join` | U1, U2, W4, W8, W10 | A-H9, U-H1, B-H1; Y3, Y5, Y6 | 3: 27 rows, most of them the undo owner. 1 open question 4 (undo of a move) |
| T20 | `T20 nest`, `T20 cross`, `T20 mark` | F6, F19, F20, S4, S10, S11, P8, P9, P10, P13, P14, P16, B4 | A-H8; Y11, Y12; defect "Lost mark (tag)" | 5: INV-03, INV-18. 2 open question 3 (tag ids minted on two replicas) |
| T21 | `T21`, `T21 comment`, `T21 scalar` | F18, F19, F20, S9, S10, S11, P2, P6, P8, P9, P13, P14, P15 | A-H9, A-H12, U-H1; Y5, Y7 | 3: `Undo.noteEdit`, `Undo.noteRemote`, `Undo.last`, `Undo.nextRedo`. 5: INV-53 |
| MOVE | `MOVE concurrent`, `MOVE destination`, `MOVE delete`, `MOVE cut-paste` | F21, S8, C1, C2, C5, C6, C7, C9, C10, R1, R2, R8, R10 | B-H2, B-H3 | Optional gate; Candidate A refuses a move in shared mode |

## Stage 1b: service feasibility

| Trace | Inputs and expected result (8 §3) | Entry paths | Tests | Also read |
| --- | --- | --- | --- | --- |
| T13 | `T13` | W1; 4: W01, W02, W06, W09, W14, W31, W35, W51, W52, W53 | The handoff owns no library fact; it tests the session | 3: `adopt(raw)`, `stamp(task)`, `Operations.capture()`, `Operations.stillOwns(ctx)` (19 rows). 5: INV-35, INV-36, INV-48, INV-52 |
| T14 | `T14` | none (server side) | Y14, H5, H6; defect "Premature receipt (barrier)" | 5: INV-20, N2. Runs only if the barrier design is needed |
| T15 | `T15` | none (server side) | H6, H8 | 3: `dispose()` and the async-operation rows. Runs only if the barrier design is needed |
| T16 | `T16 upload-before-sync`, `T16 pending-image` | C3, P21, P22; 4: W48, W49, W50, W58 | H11; M3 | 5: INV-52, INV-31. 6: the blob store, delayed picture add, thumbnail callbacks, bundle copy |
| T17 | `T17` | W9, W11 | Y8, H14 | 5: INV-36, INV-48, INV-52. 6: the history store and its `versionchange` handling |
| T18 | `T18` | none (hostile input) | Y13, Y15, H2, H7, H9, H10, H12, H13; PROJ-unknown | 6: the ten rows on how the join URL and token are read, kept and logged. 5 open question on refusing a body edit by someone who is not the author |
| T19 | `T19 (a)`, `T19 (b)`, `T19 (c)` | none (server side) | Y13, H3, H8, H9, H11 | 6: the connection policy rows (`wss:` is not allowed today) and open question 1. 5: INV-20, N1, N2 |
| T22 | `T22` | none (server side) | H1, H2, H5, H7; defect "Premature receipt" | 5: INV-20, N2 |
| T23 | `T23 (i) ordinary close`, `T23 (ii) discarded queue` | none (provider) | H3, H4 | 5: INV-20, N2 |
| T24 | `T24` | W12; 4: W38, W39, W41, W59 | The one-tab lock owns no library fact | 6: the 16 rows on tab sources and ownership. 5: INV-40 |

## Gates that are not single traces

| Gate | Where the evidence is | What Stage 1 runs |
| --- | --- | --- |
| PROJ | [2-fields.md](2-fields.md), complete by rule (93 rows); 8: A-H10, PROJ-cue, PROJ-detached, PROJ-unknown | Round trip of every canonical fixture through each candidate, byte-identical `.splitpage`; the fuzz of merged-state limits (2 open question 5); the checker fails on an omitted field |
| SLICE | [3-session-callers.md](3-session-callers.md) (120 rows), [4-writers-merge-drafts.md](4-writers-merge-drafts.md) (55), 1 (29) | What the throwaway slice hooks, bypasses or isolates. The stamps, the writable `documentReader.current`, `liveSession()` and three comment commands bypass tracked edits today |
| STORE | [6-boundaries.md](6-boundaries.md) (60 rows), 4 (29), 3 (25) | 6 open questions 3 to 7; 8 open question on one storage transaction for M3 |
| PERF | [7-performance-baseline.md](7-performance-baseline.md) | Standalone A/B under the tolerance rule fixed there; shared-mode numbers against its provisional limits; 8 open questions on identity passes and soft-removal growth |

## Mechanisms still open

The expected result is fixed; what delivers it is not. Each is settled inside the trace named.

| Open | Trace | In 8 |
| --- | --- | --- |
| A status that keeps the highest rank under concurrent changes and still allows a reset | T06, T21 | A-H12 |
| Undo that stops when its step changed nothing, including a join another person rewrote | T06, T12, T21 | U-H1 |
| An id for the later of two b-roll keys that share one | PROJ | A-H13 |
| Where a comment with no marked words keeps its row and field | T11 | PROJ-detached |
| Whether the cue flag is stored or derived | PROJ | PROJ-cue |
| Tag ids when two replicas create the same tag at once | T20 | 2 open question 3 |
| Whether a server can refuse a comment edit by someone who is not its author, with no verified identity in v1 | T18 | 5 open questions |
| Which dependencies of an update can be checked before it is applied | T18, T19 | Y13 |

## Product decisions

Decided on 2026-11-09:

- A comment whose words are all deleted goes to recovery.
- Replies show oldest first; replies posted at the same time are ordered by their id.
- A comment and its replies belong to their author. Only the author edits their text.

Assumed until decided. Every trace above is written to the assumption, so a different answer changes one expected result, not the design.

| # | Question | Assumed | Source |
| --- | --- | --- | --- |
| 1 | One person sets a beat, tag or shot back to To do while another marks it Filmed | The highest status wins; stepping back is an explicit reset that wins only over changes it has seen | 2, 8 |
| 2 | One person resolves a comment while another reopens it | The later of the two wins | 2 |
| 3 | Two people press Enter at the same point | Both breaks show, leaving an empty beat | 8 |
| 4 | Someone types exactly where another person splits a beat | The text lands on one side, the same side on every device | 8 |
| 5 | An edit to a beat someone else removed | It goes to recovery, not into a neighbouring beat | 8 |
| 6 | A beat is split by one person after another removed it | Both parts stay removed | 8 |
| 7 | Two tags cross after merging | The tag that starts later is shown untagged and listed in recovery | 8 |
| 8 | A reply to a comment whose creation was undone | Kept in recovery | 8 |
| 9 | Undo when another person made the same change | Nothing visible changes, the step is used up, a short notice says so | 8 |
| 10 | Edit stamps | A beat's "last edited" updates once per typing group; the script's revision and last editor are written only on export | 8 |
| 11 | A scene left with no beats; a script left with none | The scene is listed in recovery; the empty script waits for the first keystroke | 8 |
| 12 | A scene name longer than 200 characters after merging | Shown in full with a notice; it cannot grow further | 8 |
| 13 | Two b-roll keys with one id after merging | The later key is unanchored in the shot list until reassigned | 8 |
| 14 | An owner assigned to a person someone else removed | The assignment is kept as text; the person is listed in recovery | 8 |
| 15 | A comment is two undo steps today (the highlight, then the text on Post) | Kept as two | 1 |
| 16 | Cutting beats and pasting them elsewhere: other people see the beats gone in between | Kept as two commands | 1 |
| 17 | The same author edits one comment on two devices while a draft box is open | The open box is kept and its Save replaces the text | 5 |
| 18 | Is the local replica part of app-data export? | No; people export a Standalone copy | 6 |
| 19 | Ship the collaboration code in every build and export (115,589 bytes minified, 33,176 gzip, about 6.2% of `index.html`), or load a second script for shared sessions only | Not decided; Stage 1 measures inside a scratch bundle | 6 |
| 20 | Wording shown when the server refuses an update | Written with the rest of the status wording | 8 |
| 21 | The limits a person feels: time to join a large script and time until "saved to server" | The provisional limits in 7, section 7 | 7 |
| 22 | The server half of INV-52, if the pending-image design is chosen | No decision until Stage 1 picks an image design | 5 |

The defaults the third review added to plan section 14 stay open on the same terms.

## What the audit corrected in the plan

Corrected in `docs/COLLABORATION-PLAN.md` with this file:

| Section | Was | Is |
| --- | --- | --- |
| 2 | The desktop main process decides which tab owns a document | Only for file-backed tabs keyed by path; a shared tab needs its own kind and key (6) |
| 3 | Five transaction kinds | Seven: also `replay` and `amend` (3, 5) |
| 3 | Dropping the `docId` on export is enough | A file with no id gets one derived from its content, so identical exports share it (4) |
| 4 | The surface's last painted HTML is already an editor base | It is a paint cache, overwritten after every sync and never read (1, 8) |
| 4 | Every commit mints tag and shot records | Only edits do; undo replay and an amended edit do not (3) |
| 5 | Reply order and comment editing unstated | The three comment decisions above (5) |
| 8 | Unsent buffered updates are dropped when the socket closes | Kept on an ordinary close; dropped on three other paths (8, H4) |
| 8 | The provider's count stays truthful across a reconnect | It can reach 0 with a message unacknowledged (8, H3) |
| 8 | The built-in acknowledgement means "applied in memory" | It is also sent when the apply threw or the update waits on dependencies (8, Y15, H2) |
| 8 | A read-only connection answers "not applied" to updates with new changes | To every update message (8, H2) |

Stale statements in other documents (`invariants.md`, `session.md`, `DOCUMENT-MODEL.md`, `HANDOFF.md`, `WRITER-FLOW-PLAN.md`), listed under "Doc mismatches" in artifacts 1 to 5, were corrected separately ([#1379](https://github.com/RetroGorilla/splitpage/issues/1379)).
