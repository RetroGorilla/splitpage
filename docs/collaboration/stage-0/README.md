# Collaboration Stage 0: audit and baseline

The audit artifacts that [COLLABORATION-PLAN.md](../../COLLABORATION-PLAN.md) section 12 asks for. They are evidence for Stage 1, not design, and they change no product code. Progress is tracked in [#1364](https://github.com/RetroGorilla/splitpage/issues/1364).

Audited against `0ca1929177ffc84bced412ad2be3aa99690761d0`. Each file names the commit it was checked against; reconcile with `main` before Stage 1 uses it.

## Artifacts

| File | What it holds | Issue |
| --- | --- | --- |
| `1-commands.md` | Every way a user action changes the document, the DOM reconciliation paths, and what paints into an editable element | [#1356](https://github.com/RetroGorilla/splitpage/issues/1356) |
| `2-fields.md` | Every persisted field, mark and atom with its default, owner, export behavior and provisional concurrency policy | [#1357](https://github.com/RetroGorilla/splitpage/issues/1357) |
| `3-session-callers.md` | `DocumentSession` methods and callers by class, and the paths that would bypass shared state | [#1358](https://github.com/RetroGorilla/splitpage/issues/1358) |
| `4-writers-merge-drafts.md` | Automatic writers, merge, conflict stash and drafts by entry point, and how the prototype isolates from each | [#1359](https://github.com/RetroGorilla/splitpage/issues/1359) |
| `5-invariants.md` | Invariants that are preserved, intentionally different or left to an experiment in shared mode, with Stage 1 pass criteria | [#1360](https://github.com/RetroGorilla/splitpage/issues/1360) |
| `6-boundaries.md` | Stores and origins, hydration entry, inbound update sources, app-data export, CSP, service worker and join-route delivery | [#1361](https://github.com/RetroGorilla/splitpage/issues/1361) |
| `7-performance-baseline.md` | The standalone baseline, the tolerated regression, the noise treatment and provisional limits | [#1362](https://github.com/RetroGorilla/splitpage/issues/1362) |
| `8-schema-hypotheses.md` | Schema candidates as layouts, expected outcome of every trace written by hand, expected failures and provider API questions | [#1363](https://github.com/RetroGorilla/splitpage/issues/1363) |

A file appears here when its pull request merges.

## Reading an entry

Every entry has a "Serves" cell that names the Stage 1 trace or experiment it serves. An entry tagged `S2` serves none: it is named and located, not analysed, and waits for Stage 2. The field inventory is complete for every field regardless of tag.

Code is cited as a path and a symbol name, not a line number.

## Stage 1 tags

Traces, in the order of the plan's section 13 table:

| Tag | Trace |
| --- | --- |
| T01 | Buffered deletion of observed content with a concurrent remote insertion inside it (`abcd`, delete `bc`, remote `X`) under both buffer mechanisms |
| T02 | Ordinary keystroke while a remote update is integrated but the focused beat is unpainted |
| T03 | Same-word edits and repeated text |
| T04 | Held IME input with remote insertion and deletion, driven by synthetic composition events |
| T05 | Concurrent split and edit; two splits at the same point |
| T06 | Two clients join the same pair of beats |
| T07 | Join while another client edits the second visual |
| T08 | Create or remove a scene header while another client edits following narration |
| T09 | Cross-beat or cross-header selection replacement with concurrent input |
| T10 | Delete a beat, offline edit it, late join, then undo the deletion |
| T11 | Overlapping comments, replies and structural edits |
| T12 | Structural undo after intervening remote edits |
| T13 | Initial upload while the owner continues typing |
| T14 | Older server write finishes after a newer flush request; pure deletes |
| T15 | Two barriers completing out of order; a receipt from a closed connection |
| T16 | Offline image insertion followed by automatic reconnect |
| T17 | Server restart and join with all previous clients offline |
| T18 | Invalid and oversized input at the chosen hooks |
| T19 | Reconnect with a rejected update still in the local replica |

Other tags:

| Tag | Meaning |
| --- | --- |
| MOVE | The optional structural-movement gate |
| PROJ | Projection coverage: every persisted field derives from the shared state and canonical fixtures round-trip |
| SLICE | The throwaway real-editor slice: what it must hook, bypass or isolate |
| STORE | Local replica storage and hydration experiments |
| PERF | Performance baseline and budgets |
| S2 | Serves no Stage 1 experiment; deferred to Stage 2 |

## Closing step

Stage 0 ends with the Stage 1 experiment table: for each trace, its inputs, its expected user-visible outcome and the entry paths it touches, drawn from `8-schema-hypotheses.md` and `1-commands.md`. It is added to this folder once the eight artifacts are merged.
