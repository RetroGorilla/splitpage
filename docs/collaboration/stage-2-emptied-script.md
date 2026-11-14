# Typing after the shared script is emptied

Rule 91 on #1414 requires somewhere to type after all beats disappear. This cut supplies a shared-only typing target and its wiring factory. It changes no operation family, stored format, projection, removal, recovery or standalone edit path.

## Before this cut

The literal histories in `tests/features/empty-script/before.test.ts` run on real replicas in reversed and duplicate delivery, with a fresh encoded joiner. Every history projects `rows: []` on all three copies. Writer renders zero beats/headings and has no selection; Split renders zero editable cells/headings and one Add first row button. Neither view has a narration caret target.

| History | Recovery retained on every copy |
| --- | --- |
| Remove the last beat | R1 with `ab`, removed by Alice |
| Each copy removes a different last beat | R1 `ab` by Alice and R2 `cd` by Bob |
| Removal races typing in the last beat | R1 with `aXb`, including Bob's edit evidence |
| Removal races an interior split | R1 with `a` and Bob's split beat with `b` |
| Remove every beat of the only scene | Both removed beats and H1 `Scene` as `scene-with-no-beats` |

Standalone `replaceRange` in `src/core/flow/flow.ts` retains the last row when clearing its text. Its repair block calls `blankRow` when whole-start removal leaves no beat, and also repairs a retained heading's missing follower. Three literals pin the retained row, fresh blank row and retained scene heading. Standalone copies have no concurrent-delivery mechanism; each removal keeps the remaining beat, or this final empty target. Split's explicit `deleteBeatCommand` can instead remove its last row and leave its existing Add first row button; this cut does not change that path.

## Existing operations suffice

The feasibility literals precede the feature: each copy sends the existing `segment-create` with initial narration at the front of retained structure. Both created beats survive on both copies and a late joiner; the removed content and empty scene heading stay in recovery. Appending after the retained heading would attach the new beat to that scene, so the target uses the gap before the first stored segment.

`startEmptyScript` mounts a local textarea outside the editable host. It shows while the shared projection is empty and creates no document content until native input commits. Beforeinput/composition takes the existing M1 ingress hold. One command creates a fresh beat carrying the plain text, empty visual and normal creation stamp; the existing structure key resolves its id before caret placement. IME waits for compositionend, cancelled input creates nothing, and refused creation retains its local text for retry. A committed command with an effect error is accepted as committed and is never retried as another beat.

Concurrent first inputs get distinct author-derived beat ids, so both texts survive. Initial text goes before the retained structure; no removal or recovery event is changed. A native input/composition, stale draft or refused creation prevents unsafe disposal. A target cannot take another surface's buffer hold. Rejected input without a hold restores the empty DOM value, so a later command cannot publish unadmitted text; an already-held draft is retained.

## Evidence and limits

Complete projected documents and recovery are literal on two copies and a fresh encoded joiner after all five histories. Both actual Writer and Split renderers receive the new target and place the caret in the resolved beat after typing. The empty-state target is also mounted on an encoded joiner. Both delivery orders cover simultaneous starts; twenty seeded histories add a third writer, reordered duplicates and a fresh late joiner. Composition, cancellation, read-only/epoch admission, missing authors, invalid placement/identity, command failures and effect failures are pinned.

The first input is one command and one undo entry. Its existing structural inverse is refused as `undo-unsupported:segment-create`, with unchanged encoded state; undo is not widened here. Other refusals are `buffer-pending`, `buffer-composition`, `empty-script-stale`, `empty-script-no-author`, `empty-script-placement-unavailable`, `empty-script-identity-unavailable`, and the session's own admission refusal. An unexpected no-op is `empty-script-no-change`; a failed command surfaces its error without clearing the draft.

## Shared app wiring in C6/C7

Call `mountSharedEmptyScript({ handle, session, author, writer, stamps }, { host, edits, report, place })` for the active shared view only. `host` is Writer's narration root or Split's rows root, already attached; the factory inserts the target before it. Use the existing author, stamp and editing ports; `report` is the existing buffered-field feedback port. `writer()` returns the current handle's client id string, as in the Writer flow ports. Do not construct this factory or subscribe it in standalone mode: standalone keys and pastes execute no added read, branch, allocation or hook.

`place(rowId, offset)` must paint the current committed projection, then place the narration caret in that resolved beat in the active view, returning whether it succeeded. Call `finish()` before leaving the view; honor a false result. Likewise honor `dispose()` returning false while native input, composition or a retained draft cannot settle. The running app does not call this factory in this cut.

## Assumed rules

No new product rule is assumed. Rule 91 permits a place to type and explicitly permits two beats for simultaneous starts. Rule 6 keeps the emptied scene heading in recovery. The existing structure placement and undo contracts decide the implementation and retained undo refusal.
