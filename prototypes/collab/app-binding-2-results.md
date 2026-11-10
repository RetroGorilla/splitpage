# Real Writer binding: structural changes, marks, load and re-entry

**The new cases distinguish the mechanisms. The earlier M2 recommendation does not establish that unchanged M2 is sufficient.** M1/M3 pass the split-before-composition case; M2 commits the text into the old beat. Native synchronous re-entry requires an earlier buffer hold under all mechanisms, and M2 additionally needs a DOM paint gate across the native input interval. Remote bold produces different marks on the composed letters. No product mark policy or final production mechanism is selected here.

All new results use Candidate A and throwaway app **[`935e618949a2e964198847daa2115d35e1da58ef`](https://github.com/RetroGorilla/splitpage/commit/935e618949a2e964198847daa2115d35e1da58ef)** on `proto/collab-1a-app-binding-throwaway`, never to merge. This extends the earlier app patch with a single-beat paste command seam and observation of actual `flow-surface.paint` boundaries. The deliverable changes only `prototypes/collab/`.

The [measured matrix and all nine timing rows](app-binding-2-measurements.md) are generated from [raw evidence](app-binding-2/evidence.json). Machine: **DESKTOP-NEFVS90**, AMD Ryzen 9 9950X3D2 16-Core Processor, Windows kernel 10.0.26300, Node 24.22.1, headless Edge 157.0.4341.42. Measurements below belong to this machine and pinned app, with one browser under the smoke lock.

## What is checked

There are **96 cases: 82 satisfy the stated invariants/literal oracle, and 14 retain failures**. D3, dup and late-C run for every new composition combination; T04 removed uses its prescribed D3 and late-C orders. Synchronous re-entry uses delivery inside the event/command call stack, with three explicit interventions. All replicas, including M3's E/N and late-C, are checked after delivery. Browser execution remains outside `npm test`.

Only the removed-target fixture exactly matches an existing combined row: its complete `test/buffer-oracles.ts` T04 removed forward and undo data are reused unchanged, including recovery, identities and actual DOM caret. It passes all six runs. T05/T06/T08/T11/T20/T21 describe related boundary, mark and recovery rules but do not specify these new composition combinations. Their existing literal tests are not replaced or narrowed, and no new combined visible-script oracle is invented.

For those combinations, the independent identity checker enforces the requested invariants: every required original/remote identity and value survives unless explicitly selected/deleted; no identity is duplicated; xy/Q commits once with new local identities at the captured painted neighbour or in recovery; remote marks and comment records survive; requested split boundaries and surviving seed membership persist; all replicas converge; actual DOM text and the final DOM caret agree with the committed local text. Input gestures, remote insert/delete/mark/split facts and identity-creation bindings are harness-owned inputs. No expected output comes from a replica. Mutating equally wrong replicas to lose a remote character, duplicate an identity, repeat local text, omit a replica or lose a mark/comment makes the checker fail.

The initial seeds are R1 `abcd` and R2 `ef`. The actual app places the input selection; subsequent selections are read from the DOM through the app mapper. Composition is `imeSetComposition(x)`, remote operations, `imeSetComposition(xy)`, then `insertText(xy)` to end it. No operating-system input method or script-dispatched composition event is used. Each pass commits in the real app handler before driver finish; final delivery cannot rescue a missing native commit.

## Remote structural changes during composition

All outcomes in this section are **observations checked by invariants**, except T04 removed. A requested structural change is performed by B's existing `SchemaReplica.split`, `join` or `remove`; the app's structural commands stay unbound.

| Case | Input and B action | M1 | M2 | M3 |
| --- | --- | --- | --- | --- |
| Split inside | Compose over original bc (1:3); split at b/c (2) | 3/3 satisfy invariants | 3/3 satisfy invariants | 3/3 satisfy invariants |
| Split before | Compose over original c (2:3); split at a/b (1) | 3/3 satisfy invariants | 0/3: local text lands in old R1 | 3/3 satisfy invariants |
| Split after | Compose over bc (1:3); split after d (4) | 3/3 satisfy invariants | 3/3 satisfy invariants | 3/3 satisfy invariants |
| Join previous | Compose xy at e/f in R2; B joins R2 into R1 | 3/3 satisfy invariants | 3/3 satisfy invariants; intermediate DOM selection cleared | 3/3 satisfy invariants |
| Removed | Compose xy after b; B removes R1 | 2/2 literal T04 removed + undo | 2/2 literal T04 removed + undo; intermediate DOM selection cleared | 2/2 literal T04 removed + undo |

In split-before, M1/M3 observe final R1 `a`, Rb `bxyd`, R2 `ef`; the actual caret is Rb offset 3. M2 observes R1 `axy`, Rb `bd`, R2 `ef`, with caret R1 offset 3. Its replicas agree and no character is lost, but the location invariant fails: the person typed after original b (s2), which now belongs to Rb. These strings are retained observations, not newly selected product oracles.

The cause is `EditableBeatBuffer.commit`: it finds insertion neighbours only among characters still assigned to the painted beat id, then calls `locate(painted.id)`. After immediate integration of a preceding split, original b has moved to Rb, so the search falls back to a in R1. M1/M3 commit before integrating the split and avoid this limitation. Supporting M2 requires a commit planner that follows the captured identities/relative insertion gap across structural membership changes. It does not need a new native DOM gesture hook, but it does need more than same-beat identity mapping. The failure is retained, not repaired here.

M2's join/removal also exposes a different app path: `flow-writer.repaint` calls `visual.refresh` even when the surface has deferred painting. `flow-visual-box.refresh` reads `surface.selection()`, whose `rangeExists` check sees that R2/R1 is absent from the current projection, calls `heldSelection.forget()` and `removeAllRanges()`. Node identity, content and composition range remain intact; the DOM selection reads null. The following protocol composition still commits once and restores the correct final caret (or recovery fallback). Preserving that intermediate selection would need composition-aware validation against the painted buffer, rather than only the current projection. M1/M3 retain the beat in E and do not hit this path during the hold.

[Structural and transient-selection history](histories/T04-app-structural-composition.md) contains every order and mechanism. The source paint observer plus independent node-reference comparisons establish that remote projection did not replace composing DOM nodes; they do not assume that selection survived.

## Remote marks during composition

B formats original b/c while A composes xy at their gap. A's original composing DOM stays untouched under all mechanisms. The original b/c retain B's bold on every replica, and local xy commits once with new identities. **The marks on those new identities differ:**

| Observed marks | M1 | M2 | M3 |
| --- | --- | --- | --- |
| Remote bold | New xy is bold; DOM `a<strong>bxyc</strong>d` | New xy is plain; DOM `a<strong>b</strong>xy<strong>c</strong>d` | New xy is bold; same DOM as M1 |
| Comment C1 and tag P on original b/c: raw stored marks on xy | c:C1 and t:oB present | Neither raw attribute present | c:C1 and t:oB present |
| Same comment/tag after the existing structural mark projection | C1/P cover xy | C1/P cover xy | C1/P cover xy |

These are **observations**, not a declaration that one result is correct. M1/M3's local transaction is concurrent with B's marks; M2 has already seen the format before inserting explicit empty attributes. T21's literal concurrent-format result does not specify the causal M2 combination in this experiment. The tag containment/comment-union projection subsequently covers the inserted gap even when M2's raw inserted attributes are empty.

All nine bold runs and all nine comment/tag runs satisfy the text/identity and remote-record invariants. Bold is actually rendered by the app. **Comment/tag narration projection remains unbound:** the old binding passes raw c:/t: attributes to the core HTML writer without mapping them to the app's cmt/tag representation or installing the comment/tag registries. The final app narration is plain `abxycd` under all three for the annotation case; this is not a successful app-level T11/T20/T21 mark binding.

The replica-level commands and `readStructure` still check C1, its active anchor and P under each mechanism while native DOM is preserved. Completing that binding requires the CRDT-to-app mark adapter, per-occurrence tag/registry mapping, comment records and anchor/recovery projection, then composition-aware paint and selection handling. Local mark/structure commands remain refused. [Mark history](histories/T04-app-remote-marks.md) retains raw and projected differences for every order.

## Long composition and many updates

Each run receives **240 remote updates before composition ends: 160 inserts and 80 deletes**, spread over the composing R1 and context R2. Forty B characters remain in each beat, so the check would detect losing remote text as well as simply draining a queue. Delivery is causal: the driver completes the first real composition input, performs the entire declared B workload and delivery, then finishes xy. No sleep selects the outcome.

All nine runs satisfy the invariants. M1 holds 240 messages / 2318 bytes in D3 and late-C; dup holds 480 / 4636. M3 holds 240 / 2318 under all three orders because duplicate updates produce no second N update to forward to E. M2 holds zero inbound editor messages/bytes. The harness transport has 240 original messages in every run; duplicates are delivery copies. All holds are empty after commit/delivery.

The [measurement table](app-binding-2-measurements.md#composition-end-timings) reports each measured composition-end commit/projection time and the first actual app DOM paint. Commit includes planning, the Yjs operation, held-update drain and session projection. Paint is instrumented inside `flow-surface.paint`, so an internally owed paint is counted even when it bypasses the public repaint bridge. There are no actual paints while composing; two actual reconciliations have occurred when compositionend returns (the owed paint and the prototype's subsequent repaint), and final driver verification requests a third. The later calls can be cache hits.

These are single instrumented samples on the named shared machine, at the browser clock's resolution. They are not raster/frame times, a production latency budget, memory measurements or a controlled A/B benchmark. No queue bound was exceeded (the existing 64 KiB limit remains). M2 moves work before compositionend; M1/M3 pay to release held updates at commit. [Load history](histories/T04-app-long-composition.md) retains bytes, message counts, phase times and actual paint boundaries.

## Synchronous re-entry between intent capture and commit

The ordinary typing and replacement listener is registered on the real Writer host **after the app's `onBeforeInput` and the original prototype bubble listener**. The original capture listener has already recorded real targets/selection. The app's beforeinput handler returns without cancelling these gestures; the late listener synchronously delivers B's `Z` at R1 offset 0, projects it and requests repaint before Chromium performs its native edit and fires input. The late listener is trusted, is not a synthetic event and records `defaultPrevented=false` before delivery.

The existing stale-input capture hook runs earlier and cannot see an update delivered later in this same event. Its inventory entry is now explicitly marked hooked/bypassed: `src/app-binding/page.ts` cancels known-stale input, commits and repaints, then the app returns on `defaultPrevented`. This synchronous re-entry tests the distinct interval after that hook.

Three interventions make the comparison concrete:

| Intervention | Typing / replacement: M1 | M2 | M3 | Paste: all mechanisms |
| --- | --- | --- | --- | --- |
| Previous behavior: no early hold | Fail | Fail | Fail | Fail: wrong observed characters replaced |
| Retain the native buffer at beforeinput / captured paste command range | Pass | Fail: immediate projection can repaint under native default | Pass | Pass |
| Same early hold plus a native DOM paint gate until input commits | Pass | Pass | Pass | Pass |

The early hold is a new prototype `retainBeforeInput` entry on the existing mechanism interface. It retains the actual observed selection/base before mutation. M1/M3 then defer B's update. M2 still integrates it, so its native interval additionally suppresses the remote repaint request. Its real input handler maps the observed splice against the retained base, allocates inserted identities if that stale dispatch commits immediately, projects and repaints before returning. Those changes are explicit additional hooks, not implicit passes credited to the original slice. Every passing ordinary gesture is checked before driver finish as well as after delivery.

**Paste has no native beforeinput/input interval in the app.** The real Ctrl+V paste event is cancelled by `onPaste`; `pasteData` captures a range and calls the model command. The nearest equivalent is the newly exposed optional `flow-writer.commit` override, entered after that range is captured and before the original FlowCommand is planned. It synchronously delivers/project/repaints B there. A narrow prototype adapter obtains Q from the actual clipboard event and translates only this observed single-beat plain-text paste into buffer intent; no rows, caret or character identities come from an oracle. The app's existing `apply` paints the resulting projection and mapped selection. Structure and mark commands remain unbound.

Without retaining that paste base, all three observe `ZQcd`: the adapter overwrites unselected a and retains selected c after repaint changed its coordinate basis. With the hold, all observe `ZaQd`, with the actual DOM caret after Q; M2 does not additionally need the native paint gate for this already-cancelled model-command route. These strings describe observations of the invariant failures/successes, not new prescribed script oracles. [Re-entry history](histories/T02-app-sync-reentry.md) keeps every variant and failure.

## What changes the mechanism comparison

M1/M3 currently succeed where unchanged M2 fails at a split preceding the composed range. M2 needs cross-boundary identity-gap mapping. For ordinary synchronous re-entry, all three need the dirty interval to start at beforeinput; M2 needs an additional native DOM paint guard and a commit/projection path for a stale base discovered at input. For joined/removed targets, M2 additionally exposes live-model selection validation during composition. The existing same-beat composition repaint guard alone does not cover these paths.

M1/M3 have deferral costs and still need every relevant ingress to respect their hold. M3 suppresses duplicate held updates in this run; it still owns a second document and its memory/persistence cost is unmeasured. M2 releases no inbound queue at compositionend but has more mapping/DOM obligations. Bold/raw annotation differences require an explicit mark policy; they cannot be converted into product pass/fail by this experiment. No broader schema, provider, storage or undo decision is made.

## Reproduction and validation

From the deliverable branch, root/prototype dependencies installed, Node 24.22.1:

```powershell
$env:TEMP = 'C:\Users\Gorbus\AppData\Local\Temp\splitpage-lanes\s1a-app-binding-2'
$env:TMP = $env:TEMP
& D:\vibecoding\Splitpage\tools\with-lock.ps1 -Lock smoke -Owner s1a-app-binding-2 -Command 'node prototypes/collab/src/app-binding-2/run.ts'
node --test prototypes/collab/test/app-binding-2/evidence.test.ts
node prototypes/collab/src/app-binding-2/report.ts --check
```

The runner archives/builds the pinned throwaway commit into a temporary folder, supplies a fresh instance docId and closes its one headless Edge/profile in `finally`. Switch-off startup is checked before enabling the binding. Browser runs are not part of `npm test`; that command only rechecks retained data. Diagnostic case/mechanism filters exist, but the retained-evidence gate requires all 96 cases. The original 72-case matrix was also rerun after extending the prototype and remains 72/72 at its historical pinned app commit; only its generated evidence/bundle hash was refreshed.

Validation: 110 focused evidence checks and 1123 prototype tests pass. Root lint, typecheck, dependency and comment gates, code-map generation, generated-history verification and diff whitespace checks pass. No full app/unit/browser/desktop suites or production performance gate were run. No app code enters this PR, no literal oracle was edited, no native input method was used, and nothing was merged by this lane.
