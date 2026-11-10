# Real Writer binding experiment

**M1, M2 and M3 each pass the 24 prescribed real-app cases, including selective undo: 72/72. Recommend M2 for the narration binding.** The app does not force deferral: its existing composition repaint guard preserves the native DOM while M2's session projection advances. M1 and M3 also bind, but add an editor-update hold; M3 additionally owns a second document. This is a buffer recommendation for the tested narration seam, not a schema decision or a production integration endorsement.

Every measurement in this report, the evidence and the histories uses throwaway app commit **[`f807ca39dcc5feb03f5746209cb806ee66dab3f8`](https://github.com/RetroGorilla/splitpage/commit/f807ca39dcc5feb03f5746209cb806ee66dab3f8)**, pushed on `proto/collab-1a-app-binding-throwaway`. Never merge that branch. Its base is `035b053d`; its app patch is seven files, 115 insertions and 16 deletions. This deliverable changes only `prototypes/collab/`. The app patch remains separate.

Browser: Edge 157.0.4341.42, headless, protocol 1.3, Node 24.22.1. One real built Splitpage page, its actual `#writer-doc`, `createFlowWriter` and `createSurface`; no copied renderer. Candidate A supplies two in-page replicas and the existing deterministic queue. M3 also supplies each replica's network document. No replica server, provider, transport socket or replica persistence. The browser's debugging connection is test infrastructure.

## What was bound

The app boots normally from an archived copy of the pinned throwaway commit. `?app-binding=1` enables the experiment bridge and isolation. Without that switch the bridge is absent; the same built page starts and renders its two seed rows. The bound fixture receives a freshly minted valid instance docId in the embedded document before boot; it uses no source file's id and offers no export. The runner injects the prototype bundle through the debugging protocol after startup, then projects the fixture's narration into the existing session. The document retains unrelated fields. Only narration in the selected Writer beat is editable through the replica binding; other visible beats are projected context.

Capture listeners retain real `beforeinput` targets and the directed DOM selection through the app's `domToPos`. Native `input` supplies the changed DOM; the binding validates that it is the observed splice and sends it through `EditableBeatBuffer.dispatch`. The real app's `syncBeatEl` still decodes that DOM. The new optional `syncBeatOverride` intercepts `flow-writer.syncBeat` immediately before its whole-field `cellTextCommand`, checks the decoded value against the buffer, commits Yjs intent and projects the result. In composition this callback is reached by the app's own `syncComposition` at `compositionend`.

Projection uses a session-owned stamp with an explicit experiment-only name, followed by the real Writer's `repaint` and `place`. This deliberately **bypasses SessionChange publication, generation, attribution, reconciliation, saving and snapshot undo**. It is not a substitute for the production remote transaction kind. Painting waits until the surface's event handler has finished updating its `rendered` cache. Composition always preserves the existing DOM. Selection restoration comes from buffer identities, then is checked by reading the real DOM back through the app mapper. The selection buffer is also checked against that DOM selection after forward and undo.

No answer is passed from an expected result into the binding. Fixture seeds and gestures select inputs; Bob's literal operations define the concurrent history. Inserted identity labels are assigned at creation. Forward and undo outputs go through the existing independent checker and unchanged `test/buffer-oracles.ts`. Browser checks include every active beat's text and bold marks, actual directed carets/selections, session projection equality and the app's DOM check. M3 checks every E and N; late-C hydrates from B.N through the existing queue.

## Actual dirty intervals

The input observations use the app's normal Writer mutation path with the replica override uninstalled. The experiment switch still isolates external writers. Capture and bubble observations contain immutable session snapshots, event order, native targets and DOM selections; no elapsed-time threshold establishes correctness. Tests: `ordinary native edits enter with a stale session...`, `paste, cut, Enter and undo shortcut...`, and `Writer composition remains dirty...` in `test/app-binding/evidence.test.ts`.

| Input | Native change and model commit | Dirty interval | Repaint opportunities within it |
| --- | --- | --- | --- |
| Typing | `beforeinput(insertText)` allows default; input capture sees new DOM and old session; input bubble sees the new session and generation +1 | Native mutation through synchronous `onInput → syncBeatEl → syncBeat → cellTextCommand` | Synchronous handlers in the same task only: orphan repair, shortcut/model paths, sanitization/decorating. A queued network/timer task cannot run between native mutation and input commit |
| Backspace inside a beat | Same, `deleteContentBackward`; observed target 6:7 | Same synchronous input handler | Same |
| Delete inside a beat | Same, `deleteContentForward`; observed target 4:5 | Same synchronous input handler | Same |
| Typing over selection | Target 4:7; DOM `the a` arrives while session still says `the the`; input bubble commits it | Same synchronous input handler | Same |
| Paste | Real clipboard contains Q. `onPaste` cancels default; `pasteData → apply("paste")` commits `the Q` before paste bubble | No native dirty DOM interval for this clipboard text fixture | Model command then synchronous paint. Async media preparation is a separate entry and is isolated |
| Cut | Real Ctrl+X; `onCut` cancels default, applies `replaceRange`; session and DOM say `the ` before cut bubble | No native dirty DOM interval | Command and paint are synchronous |
| Enter | Keydown cancels default and calls `enterAt`; session already contains `the ` and `the` at keydown bubble; no input event | No native dirty DOM interval | Structural command and paint are synchronous; structure is unbound during the replica experiment |
| Composition | Three real protocol `insertCompositionText` inputs are noncancelable. Session stays `the the` while DOM becomes `the xthe`, then `the xythe`; compositionend capture still sees the old session, bubble sees generation +1 and the complete text | First native composition mutation until synchronous `onCompositionEnd → syncComposition → syncBeatEl` finishes; spans multiple browser tasks | All asynchronous repaint sources below can run. The surface's `paint`/`repaint` guards owe the paint until composition sync finishes |
| Native undo request, Ctrl+Z | The app handles keydown, cancels default and replays its document history before bubble; no browser `historyUndo` input is emitted | No native dirty DOM interval on this route | Replay and repaint are synchronous. Bound traces replace snapshot replay with selective undo |

Thus ordinary typing commits synchronously. The mechanisms' meaningful long-lived difference is composition; the other hazard is an already-integrated but unpainted remote update before `beforeinput`. `T02` tests the latter. The ordinary D3 rows deliberately hold `syncBeat` after real input so the driver can deliver B before commit, exactly as the earlier slice did. Those are labeled `driver:instrumented-held-sync`, not evidence of an actual asynchronous typing commit. Three additional synchronous-input probes commit in the real handler before the driver can send anything else.

Artifact 6's complete repaint list applies to the composition interval: clock/comment-author/person-color preference events; shot-hiding grace timer; every whole-document replacement; undo/redo replay; cell-blur sanitizing; writer heading finalization/removal; scene-name save; beat-length commit; delayed media paste; picture add, thumbnail click, annotation save and bundle relinkPath (full rendering); paste thumbnail and folded relink (row rendering); save completion when title or rows change; remote text projection. No browser task from that list can interrupt ordinary native mutation → input commit. Synchronous listeners can still invoke a repaint and must respect the same base/DOM contract.

The experiment exercises the real Writer repaint during composition, host blur, a clean remote edit to the other beat, sync removal and the isolated writer entry points. It does not claim that each gallery/preference/desktop entry was driven. Their callbacks are either absent in this browser fixture or their document writes are refused while bound. Existing paint guards protect the Writer path; a production integration must preserve that protection for every ingress.

## Prescribed results

All rows below use app `f807ca39dcc5feb03f5746209cb806ee66dab3f8`. Each count includes forward state and selective undo, character identities, marks, carets, selection and recovery. No expected result was changed or disputed.

| Trace | M1 | M2 | M3 | Orders |
| --- | --- | --- | --- | --- |
| T04 | PASS 3/3 | PASS 3/3 | PASS 3/3 | D3, dup, late-C |
| T04 removed | PASS 2/2 | PASS 2/2 | PASS 2/2 | D3, late-C |
| T01 | PASS 5/5 | PASS 5/5 | PASS 5/5 | D1, D3, dup, rev, late-C |
| T01 composition | PASS 5/5 | PASS 5/5 | PASS 5/5 | D1, D3, dup, rev, late-C |
| T02 | PASS 3/3 | PASS 3/3 | PASS 3/3 | D3, dup, late-C |
| T02 boundary | PASS 1/1 | PASS 1/1 | PASS 1/1 | D3 |
| T03 | PASS 2/2 | PASS 2/2 | PASS 2/2 | D1, D3 |
| T03 replace | PASS 3/3 | PASS 3/3 | PASS 3/3 | D1, D3, dup |

`T02 boundary` paints both actual app beats in one paragraph. R2 begins with U+200B. Its real target is raw text-node offset 1:1, while the app mapper returns narration offset 0:0. Z becomes a1 before s3/s4; Bob's Y stays in R1; undo returns the caret to R2 offset 0. The `T02 boundary uses the real leading sentinel...` test asserts these raw and mapped offsets. It would fail if this case silently fell back to the copied slice's raw text counting.

## Mechanism differences and recommendation

All measurements in this table use app `f807ca39dcc5feb03f5746209cb806ee66dab3f8`; `all mechanisms reach real synchronous syncBeatEl...` asserts the differences.

| Mechanism | What bound cleanly | Actual composition state after B arrives | Additional obligation |
| --- | --- | --- | --- |
| M1 | Same app hooks as M2, unchanged buffer interface | DOM `abxcd`; E and session `abcd`; 18 bytes held; final `Zabxyc` | Gate every replica ingress during dirty composition and bound the queue. Earlier provider-bypass and overflow histories still apply |
| M2 | Same app hooks; existing composition guard already permits projection to advance | DOM `abxcd`; E and session `Zabc`; 0 held bytes; final `Zabxyc` | Retain painted identities despite newer session data; stale-beforeinput handling; never let another sync recapture the base |
| M3 | Same app hooks; forwarding stays behind existing mechanism interface | DOM `abxcd`; E and session `abcd`; N `Zabc`; 18 bytes held; final `Zabxyc` | Own and coordinate E/N, origin-filter forwarding and both persistence paths. No app-hook reduction compared with M2 |

All three use the same two-line feature seam and the same bootstrap bridge/isolation patch. Binding all three cost little more than binding one; none was omitted. M2 is the preferred next implementation because immediate projection works with the real surface and needs neither the dirty ingress queue nor a second editor document. This comparison does not measure memory, crash safety, large-script projection or latency and does not invalidate M1/M3 as feasible alternatives. No provider fact is newly confirmed or refuted here. Artifact 8's repeated-text/M2 ambiguity remains conditional on missing target evidence; real targets disambiguate these fixtures under all mechanisms. A-H7's performance claim remains unproved.

## SLICE seams

These are the throwaway commit's changes or deliberately retained paths. A hook is an experiment seam, not an approved production API.

| File and function | Treatment | Evidence or remaining change |
| --- | --- | --- |
| `src/features/writer/flow-surface.ts`: `onBeforeInput`, `range0`, `onInput`, `syncBeatEl`, `syncComposition`, `syncSpots` | Retained, observed by capture listeners; no edits in this file | Real default input, target ranges, sentinel, decoding and composition sync. Prototype adds painted identity state beside the existing HTML cache |
| `prototypes/collab/src/app-binding/page.ts`: capture `beforeinput` listener, `buffer.paintHeld` branch | Hooked and bypassed | Cancels a stale native input, dispatches identity-mapped intent through the prototype and repaints. The app's `flow-surface.onBeforeInput` then returns on `defaultPrevented`; T02 therefore bypasses that app handler as well as hooking `syncBeat` |
| `src/features/writer/flow-writer.ts`: `FlowWriterPorts`, `syncBeat` | Hooked with optional override, two added lines | `sync hook removed` probe fails when source command bypasses the replica. Composition must commit here before driver finish |
| `src/bootstrap/wiring/writer.ts`: `mountWriterRuntimeFeature` | Hooked | Switch-gated sync, selective undo and bridge exposing mapper, actual session, repaint, place and diagnostics |
| Same wiring: `leaveBeat` | Bypassed while bound | Its independent `cells().sync` must not write whole DOM into the projection. `transitionBeat` still reaches the hooked `syncBeatEl` |
| `src/features/common/cell-dom.ts`: `domToPos`, `posToDom` | Retained | Capture/selection mapping skips U+200B. No copied DOM mapper |
| `src/application/editing/selection.ts`: `rememberFlow`, `resolveFlow` | Retained | Numeric selection belongs to painted DOM during composition; explicit identity remap/place refreshes it after projection. Every forward/undo checks it against actual DOM |
| `src/bootstrap/wiring/writer.ts`: experiment `project`; `DocumentSession.stamp` | Projection-only bypass | Session applies active narration rows without effects/publication. Production needs a remote change kind, precise change sets and derivations, not this stamp |
| `src/bootstrap/wiring/session-owner.ts`: `run`, `replay`, `amend`, `stamp`, `noteEdit`, `settle`, adoption/absorption | Isolated while bound | Only experiment projection stamp is allowed. All normal commands, including comments with `needs: nothing`, are refused; whole replacement throws before adoption |
| `src/bootstrap/wiring.ts`: `wireApp` | Isolated | No save destinations under the switch; existing read-only document guard enabled. `documentReader.current` and `liveSession().held()` mutation probes throw `DocumentWriteError` |
| `src/bootstrap/wiring/session-effects.ts`: `sessionEffects` | Isolated under switch | No dirty, draft, save or attribution effects. Ordinary unbound observations retain session commits and row command stamps but suppress persistence effects |
| `src/bootstrap/wiring/startup.ts`: `applyStash`, `resumeLastProject` | Isolated under switch | No global stash application or remembered file replacement. Fresh profile and file URL; no desktop bridge, prior jobs or file home |
| `src/application/commands/comments.ts`: `addCommentCommand`, `addReplyCommand`, `unwrapCommentAnchorCommand` | Explicitly probed/refused through session gate | All three bypass edit-capability checks today; experiment does not rely on that capability to isolate them |
| `src/bootstrap/wiring/app-binding-mode.ts` | New throwaway switch state | Active only after a binding is installed; switch-off startup remains normal |
| Save/Save As/Retry/autosave, disk merge/reload/history restore, imports, structure, marks/tags/status/media, comments | Unbound/isolated | No save destination; non-narration mutations refused, replacement refused, guarded readers cannot mutate. Clipboard text/Enter/undo are observed unbound, not translated as shared commands |
| Desktop drafts/IPC/tab restore, folder copying/relink, prompter launches, independent recovery | Isolated by host and fixture | Browser-only fresh file page, no desktop bridge or old completions. No claim about handoff from a running standalone document |

Raw `heldDocument()` remains an internal bootstrap escape hatch; the experiment does not expose it to the prototype. Read-only public access and blocked session mutations are tested, not a universal proof against arbitrary future bootstrap code. The projection stamp is intentionally privileged. Saving/export/recovery UI and state publication remain Stage 2 work.

## App behaviours absent from the copied slice

All observations below use app `f807ca39dcc5feb03f5746209cb806ee66dab3f8`.

| Behaviour | Observation | Conflict with M1/M2/M3 |
| --- | --- | --- |
| Undo owner's hold | Actual `Undo.hold()` prevents actual `Undo.undo()` in the positive control. The experiment's selective callback still undoes `the an` to `the then` with hold=1 under all three | Shared undo must deliberately honor or replace this gate. Current bypass fails the standalone hold behaviour equally; [history](histories/T03-app-undo-hold.md) |
| Composition mark / dropEmptySince | Actual owner instrumentation records 0 calls throughout Writer traces. Protocol events target the host, while `scriptCellOf` seeks a `.cell-editable` with row/field. Direct positive control increments both counters to 1 | No conflict or protection on this Writer route. The surface's composition buffer owns the batch. Split-view marks/cancellation are untested; do not claim the generic owner grouped these edits |
| Selection buffer | Holds numeric DOM offsets, including provisional composition position 3 while M2's session is `Zabc`. After commit the identity remap places caret 5 and refreshes the held range | All three require a retained paint base; M2 must not treat the held numeric range as a selection in the newer projection |
| Whole-beat reconciliation | Unbound real Writer: seed `abcd`, native `abxcd`, project remote `Zabc`, finish xy; session becomes `abxycd` | Conflicts with M2 if left unchanged; loses Z and restores deleted d. M1/M3 freeze E while dirty, but still need ingress control. Hooking before `cellTextCommand` solves these fixtures; [history](histories/T04-app-unbound-reconcile.md) |
| Writer host blur | Moving focus to the actual writer-title input causes protocol compositionend before focusout. The surface commits x, drains B, leaves session/DOM `Zabxc`, no DOM selection, held caret 4 | No lost provisional x under any mechanism. Blur sync must route through the same hook; heading finalization/removal is outside this beat-only experiment |
| Stamps and bypass writes | Normal command stamps/save stamps/identity stamps are blocked while bound; projection emits no source generation or undo entry. Direct reader writes and the three comment paths are refused | All mechanisms need this boundary. This experiment intentionally omits attribution/record/anchor derivation, rather than claiming such writes are shared-safe |

The standalone owner's one-second typing groups, 200-entry limit, redo parking and save-hold semantics are not implemented by the prototype's Yjs UndoManager. Its default capture interval is 500 ms; no 200-entry bound is added; only prescribed undo is bound, not redo. These are recorded shared-mode gaps, not a proposal to change the product rules. Saving is disabled here, so the hold probe is an explicit adversarial control. No native operating-system input method was used.

Autocorrect, drag/drop input, protected atoms, surrogate pairs/graphemes, editable headings and the Split/Visual surfaces were not exercised. The text fixtures use plain/bold text and beta. The binding does not translate Find replacement, structural commands, clipboard commands or formatting into shared operations.

`remote other beat preserves focused DOM` also changes R1 while R2 is focused: R2's element and text node remain identical, its raw sentinel remains, its caret stays 0, generation does not advance and no new A update is emitted. This establishes the tested INV-07/no-op behavior through this direct Writer projection seam. It does not establish INV-06's coalesced derivation budget: projection bypasses the session publisher and no large-script/performance gate was run.

## Retained evidence and reproduction

`app-binding/evidence.json` retains 9 input observations, all 72 forward/undo cases and 17 targeted probes, with raw target offsets, DOM selections, session snapshots, identity-creation bindings and queue histories. `app-binding/manifest.json` pins the app commit; evidence records the exact injected bundle's SHA-256. Histories above retain the two app-integration failures and the removed-hook control. They are checked against the evidence, not hand-updated to pass.

From this deliverable branch, install root and prototype dependencies. The runner archives the pinned throwaway commit into its own temporary folder, links the root build dependencies, builds the actual app there and removes it afterwards. No branch switch or uncommitted app patch is needed. If the commit is absent locally, fetch `origin/proto/collab-1a-app-binding-throwaway` first. The prototype bundle and expected results come from this deliverable.

```powershell
$env:TEMP = 'C:\Users\Gorbus\AppData\Local\Temp\splitpage-lanes\s1a-app-binding'
$env:TMP = $env:TEMP
& D:\vibecoding\Splitpage\tools\with-lock.ps1 -Lock smoke -Owner s1a-app-binding -Command 'node prototypes/collab/src/app-binding/run.ts'
node --test prototypes/collab/test/app-binding/evidence.test.ts
node prototypes/collab/src/app-binding/report.ts --check
```

The runner owns one temporary Edge profile, chooses a free debugging port and closes it in `finally`; no app server starts. Initial-load polling can fail startup but cannot establish a trace's pass. Delivery ordering is the deterministic queue; no sleep chooses an outcome. Optional `APP_BINDING_MECHANISM` / `APP_BINDING_TRACE` filters are for diagnosis; retained-evidence tests require the complete prescribed matrix.

Validation at delivery: 72/72 real-app cases; 87/87 new retained-evidence tests; 963/963 prototype tests. Root lint, typecheck, comment and dependency gates pass. The existing checker defect tests still reject lost remote characters, stale bases, duplicated identities, lost marks and omitted fields. No full app/unit/browser/desktop suites or performance comparison were run, per this lane's scope. Processes cleaned by the runner.
