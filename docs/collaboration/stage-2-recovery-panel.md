# Stage 2 recovery panel (C9)

The test build mounts the recovery panel after Settings, before the shared-session hook mount planned in section 4 of the composition plan. The bridge's `sharedRecoverySession()` returns only the running shared owner's `recovery` and `subscribe` ports, or null. It creates no owner and answers null before startup and after shutdown. This is the only addition to `session-owner.ts`.

The feature receives named ports from its wiring. It imports no bridge, adapter or other feature. Its action registers when the bridge becomes shared and unregisters when it becomes standalone; no recovery action is registered in standalone. A closed panel reads no entry content. Standalone input installs no handler and does no new read, allocation or callback. Existing comments/history panel classes provide the presentation; no styles are added.

## Entries and actions

Every entry kind has readable, selectable text. Removed groups include narration, visual, picture names, anchored comments and replies, plus removal, last-editor and split provenance where recorded. Orphan replies use the existing validated record reader in the wiring; the feature never reads shared storage. A missing author is shown as “No author recorded”. Tag names use the document registry or the existing name-bearing tag id rule.

| Entry | Restore | Discard |
| --- | --- | --- |
| Removed beat | Existing `restore`, naming its removal ids | Existing `discard`, naming the removals it saw |
| Removed heading | Existing `restore`, naming its removal ids | Existing `discard`, naming the removals it saw |
| Deleted person | Existing person restore builder; same original id, existing caseless namesake rule | Existing `discard` |
| Crossing tag, deleted tag | None in the model | Existing `discard` when the first character names it |
| Gallery overflow | None in the model | Existing `discard` |
| Unprojectable fragment | None in the model | Existing `discard` when the first character names it |
| Comment without words, reply without comment | None in the model | Existing `discard` |
| Scene without beats | None in the model | None in the model |

Damaged removals without readable provenance have neither button. An unnamed fragment/tag part remains readable without a discard button. These cases keep the model's existing limits; no operation, format, removal or recovery rule changes. Ordinary commands that resolve merged states are outside this panel's restore/discard actions.

Commands resolve both entry kind and key against the owner's current published list. Stale entries, absent sessions/authors, unreadable removal ids, namesakes and unsupported actions refuse without writing. One action sends one existing operation with its own semantic undo description. The feature preserves an already-notified rejection and uses the existing rule 73 warning otherwise.

## Undo and evidence

Rule 52 governs discard, restore, undo and redo. A restore racing an unseen discard wins visibly; that unseen discard remains active until its own undo retires it. A restore that observed a discard retires it, and undo of that already-retired discard is used up without writing. The panel does not widen any inverse.

Literal feature cases cover all ten kinds on two copies, both delivery orders, and an encoded joiner's model and panel content. Restore, discard, undo and redo agree on their content and original place. Additional races cover rule 52's observed/unseen distinction and named refusals. The seeded test runs three writers through restore, discard, undo and redo with normal, reversed and duplicated delivery, checking complete documents and recovery against an encoded joiner at every checkpoint; its declared-limit table is empty.

Both compiled entry points fold the build flag before constructing ports or callbacks. The release-bundle test checks the same mount/action entry points used by the app: panel ids, wording, action search words and command callbacks disappear when the flag is false and remain when it is true. A hidden runtime flag cannot restore code that was removed.

## Hook cut

The composition root calls `mountRecoveryPanelFeature()` and action startup calls `registerRecoveryPanelActions(registry)`. The hook cut starts/leaves the existing switch and delivers replica updates; the wiring follows the bridge's reader and the switch's current author/handle automatically. Invoke the `recovery` action after entering to open the panel. Dispose it on app teardown through `stopRecoveryPanelFeature()`. The browser suite belongs to that cut: `recovery-panel-shared`, covering opening the panel, copyable text and restore/discard through the composed app. No browser or timing run is part of C9.

## Assumed rules

Both restore and discard use edit admission. D35, rules 51/52 and the existing recovery-kind capabilities determine the remaining behaviour. Entries without recorded provenance are labelled honestly rather than assigning an author.
