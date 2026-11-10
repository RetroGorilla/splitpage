# Candidate B and M1 on the editing surfaces

**Writer and the page slice pass; Split narration fails final reconciliation. Stage 1a's two-surface T04 gate remains unmet.** B with M1 passes the original 24 literal cases on each of Writer and page, including forward, recovery and undo. Writer's positive follow-up cases also pass. Split preserves the native composition while remote updates are held and commits through M1, but its final full-row repaint throws during a focusout callback. That binding path was stopped without adding a repair or extending T01–T03.

The [per-surface counts](b-surfaces-counts.md) are generated from the retained [Writer](b-surfaces/writer.json), [page](b-surfaces/slice.json) and [Split](b-surfaces/split.json) observations. All app results pin **[`c67139b8806d04231d2f2c5bb89814370bab8ef6`](https://github.com/RetroGorilla/splitpage/commit/c67139b8806d04231d2f2c5bb89814370bab8ef6)** on `proto/collab-1a-app-binding-throwaway`, never to merge. The deliverable changes only `prototypes/collab/`.

The environment record includes CPU model, OS, Node version, installed memory and Edge version. This run was made while the machine was in use: **counts and pass/fail only, no timing or performance claims**. Retention omits inherited timing samples and absolute local paths. The app's paint instrumentation remains in the pinned throwaway build; its recorded phase order is not a duration measurement here.

## 1. B in the real Writer

The complete original matrix is **72/72**, comprising the same 24 cases under each of M1, M2 and M3. M1 was required; the other mechanisms use the identical B binding and cost no additional hook implementation. These are complete unchanged literal forward/undo checks from `test/buffer-oracles.ts`, including identities, marks, carets, selections, recovery and separators. The focused retained-evidence tests independently reapply the same checker to every replica and the real DOM selection/text. They also reject equally wrong B replicas with a remote character removed or an identity duplicated.

| Trace | Delivery orders | B/M1 Writer | B/M1 page | B/M1 Split narration |
| --- | --- | --- | --- | --- |
| T04 | D3, dup, late-C | 3/3 PASS | 3/3 PASS | 0/3; final repaint throws |
| T04 removed | D3, late-C | 2/2 PASS + undo | 2/2 PASS + undo | 0/2; final removal paint throws |
| T01 | D1, D3, dup, rev, late-C | 5/5 PASS | 5/5 PASS | Not extended after T04 failure |
| T01 composition | D1, D3, dup, rev, late-C | 5/5 PASS | 5/5 PASS | Not extended after T04 failure |
| T02 | D3, dup, late-C | 3/3 PASS | 3/3 PASS | Not extended after T04 failure |
| T02 boundary | D3 | 1/1 PASS; real run-on sentinel | 1/1 PASS; slice has no sentinel | Not extended after T04 failure |
| T03 | D1, D3 | 2/2 PASS | 2/2 PASS | Not extended after T04 failure |
| T03 replace | D1, D3, dup | 3/3 PASS | 3/3 PASS | Not extended after T04 failure |

Ordinary typing still commits synchronously in the app. As in the original experiment, ordinary D3 rows deliberately hold the sync to exercise the buffered interval; they do not establish an asynchronous production typing window. Real protocol composition spans callbacks/tasks and commits through the Writer's own `syncComposition → syncBeatEl → syncBeat` route before driver finish. Input comes from CDP input/composition commands, not dispatched synthetic DOM events or an operating-system input method. Carets and selections are read back through the app's real mapper.

### What B changes in this binding

The new `src/b-surfaces/writer-page.ts` and `followup-page.ts` retain the earlier experiment's hooks and checker, select `new BufferHarness("B", ...)`, and pass B to `readReplica`/`readStructure`. The A experiment files and their literal oracles are untouched. No mechanism-specific B mapper was added. `schema-observation.ts` records the actual candidate, absence of a `flow` root, segment heads, inner boundaries and character membership, rather than inferring B from the result strings.

`SchemaReplica.locate` returns a beat's start/end in its segment's Y.Text, and `EditableBeatBuffer.snapshot` retains identities and relative positions in that text. A split inserts an inner boundary in the source segment: Rb remains inside `seg-R1`, rather than becoming a new `seg-Rb`. The follow-up evidence checks that layout under all mechanisms, including an empty Rb after the split-after case. The binding must preserve those segment-relative positions and inner-beat bounds; it must not assume one text object per displayed beat. The existing schema/buffer already support them, so changing the candidate and reader arguments sufficed for M1 in these cases.

This is not an identity-capture performance result. `SchemaReplica.characters()` still walks ordered segments, and the prototype projection/reader still traverses more than the edited beat. Segment representation does not by itself prove beat-local capture or satisfy the separate PERF gate.

### Writer follow-up

The same **96 combinations** from #1399 run on B. M1 has 23/23 positive composition cases, six passing re-entry interventions and three deliberately failing baseline re-entry controls: 29 scoped passes / 32 cases. The generated table separates these controls from ordinary correctness cases. All E/N replicas required by each mechanism and late-C converge in the passing cases.

| Follow-up on B/M1 | Result |
| --- | --- |
| Split inside / before / after the composing range | 3/3 each, D3/dup/late-C |
| Join composing beat with its previous neighbour | 3/3, D3/dup/late-C |
| Removed target | 2/2, D3/late-C; complete unchanged T04 removed forward and undo oracle |
| Remote bold overlapping composition | 3/3; new xy bold, as T21 requires |
| Remote comment and tag | 3/3 replica/text/record checks; app annotation rendering remains unbound |
| Long composition | 3/3; 240 declared remote updates: 160 inserts and 80 deletes across both beats, 40 live remote characters remain in each |
| Deliberate synchronous re-entry: typing, replacement, paste | Baseline fails each; early hold passes each; early hold + native gate passes each |

The independent follow-up checker and its scope are unchanged. New combined scripts are not invented literal oracles. Split placement is a policy-bearing invariant from identity-preserving splitting and artifact 8 section 2's painted-left-neighbour rule; there is no exact combined split-before oracle. Mark policy is not open for bold: T21 requires inserted xy inside the concurrent bold range to be bold. The added retained-data assertions check new xy as well as the original characters.

The non-selected B mechanisms reproduce the material A differences. M2 fails split-before in all three orders because this mapper filters insertion neighbours to `painted.id`; this is not shown inherent to immediate integration. An all-live-identity search, surviving neighbour's current destination beat, recovery choice and caret handling remain an untested fix. M2's new xy is plain in three bold cases, a T21 mismatch outside the narrower checker, which checks remote bold only on original b/c. M1/M3 make it bold. Join/removal transient selection loss is still observed under M2, while final output/caret succeeds.

Raw comment/tag attributes on new xy differ under M2 versus M1/M3; canonical structural projection covers xy in all. Comment records and anchors survive at replica level. The app still receives raw `c:` and `t:` marks without its cmt/tag/registry adapter, so the annotation narration displays plain text under all mechanisms. These are not full app-level T11/T20/T21 annotation passes.

Re-entry still means deliberate synchronous `inject` in the late beforeinput listener or captured paste-command override. Ordinary typing/replacement cannot receive a network task between synchronous beforeinput/default/input steps. A projecting microtask would need a real callback that schedules it; none is demonstrated. Neither early hold nor the native paint gate is a production guard in the throwaway patch. For native re-entry M1/M3 pass with early hold; M2 additionally needs the harness paint gate. Real paste is cancelled and follows a model command, so early hold suffices for all three. These controls establish no further production ingress requirement.

[B Writer difference history](histories/T04-B-writer-differences.md) retains every checker failure, the T21 mismatch, raw mark differences, transient-selection observations and the load outcomes. No timing comparison is made.

## 2. B in the page slice

`COLLAB_SLICE_CANDIDATE=B npm run slice` selects the new `src/b-surfaces/slice-page.ts` through the existing slice CLI. The A default path is unchanged. This B page differs only in schema construction, B reader arguments and candidate/segment observation; its event binding is the original page slice. All **72/72** cases pass, 24/24 per mechanism, including the complete literal forward/undo checks. This is a real contenteditable with real protocol input, not the app; its lack of the Writer's run-on sentinel remains a stated difference.

## 3. B with M1 in Split narration: retained failure

All five T04 cases start on a freshly navigated app so one failed renderer cannot contaminate the next. T04 fails D3/dup/late-C; removed-target fails D3/late-C. The native composing cell and its child nodes survive the remote delivery/repaint while M1 holds the updates. At composition end, xy is committed exactly once through `cellEditing.sync`, M1 drains its inbound queue, and the session is projected. Final full-row rendering then throws `replaceChild` for T04 or `removeChild` for the removed target, with a synchronous focusout observed inside that paint.

The observed final A cell reads `Zabxyc`, caret 5, for T04, and `ef`, caret 0, for the removed target. Buffered xy is visible in A's retained recovery for removal. These are partial observations, **not passes**: the repaint exception prevents the normal finish path, complete all-replica literal check and undo check. The retained tests explicitly require the failure and reject crediting the incomplete pipeline as a full literal pass.

[Minimized Split history](histories/T04-B-split-repaint.md) contains the actual native event order, the captured base, remote-held state, commit, replica/recovery identities and exception for every prescribed order. This is a **binding/reconciliation failure**: the composition commits through the same B/M1 buffer that passes Writer and page, but the new Split projection/repaint seam has not isolated the app's synchronous blur/leave work. It does not demonstrate a failure inherent to M1 or candidate B. The exact nested DOM writer is not independently localized here; the trace establishes focusout during reconciliation and the thrown removal/replacement. No repair or new hook was added after this failure, and T01–T03 were not extended on Split.

### Second-surface seams

| File and function | Split binding / difference from Writer |
| --- | --- |
| `src/application/editing/cell-editing.ts`, `syncShown`; `src/bootstrap/wiring/editor.ts`, `mountCellEditingFeature` | New optional `syncOverride` before whole-field `cellTextCommand`, behind the same app-binding switch. Writer already had `syncBeatOverride`; Split calls the generic cell owner. |
| `src/b-surfaces/split-page.ts`, input capture and installed sync callback | Retains native beforeinput targets/selection and initial composition base. Split normally syncs each provisional composition input; the prototype intercepts those calls without publishing provisional text. |
| `src/b-surfaces/split-page.ts`, compositionend bubble listener | Calls the app's `cellEditing.sync` once at final compositionend and commits there. Writer already has its own `syncComposition`; Split's existing composition owner only marks/groups undo and does not provide that final buffer commit. |
| `src/bootstrap/wiring/editor.ts`, undo routing | New optional Split selective-undo route through the existing document gesture handler. Not reached/validated end-to-end after the failed final paint; ordinary app snapshot undo remains outside the shared experiment. |
| `src/features/editing/composition.ts`, `mountComposition` | Retained app lifecycle: `compositionMark` and `dropEmptySince` run on Split. This does not establish full shared typing grouping or save-hold behavior. Writer did not call these on its tested route. |
| `src/features/rows/render.ts`, `render`; `src/features/editing/focus.ts`, `editorBlur`; editor wiring `leftEditable` / `blurredCell` | Real full-row reconciliation and real blur paths retained. `editorBlur` calls `leftEditable` before checking blur suppression. Focusout occurs during the failing final paint; blur/leave/reconciliation coordination is an unresolved additional Split binding obligation. No suppress-blur fix is claimed tested. |
| `src/features/common/cell-selection.ts`, `cellSelection` / `setCellSelection` | Actual Split selection mapper/placement. Writer used its Flow selection owner; neither caret nor selection is supplied by an oracle. |

Projection still uses the privileged experiment stamp and bypasses normal publication, generation, derivation, saving and snapshot history, as in the earlier binding. The session write/refusal boundary and disabled save/stash/resume/structure/mark/comment paths remain in force. Source additions are only the optional generic sync seam, Split test bridge and undo routing on the never-merged throwaway branch; no application implementation enters this PR. Unbound visuals, headings, clipboard/structure/mark commands and broader shared undo remain outside this result.

## Reproduction and checks

Use Node 24.22.1 and installed root/prototype dependencies. Set `SPLITPAGE_WORKSPACE` to the workspace containing the lock wrapper; it is not a committed machine path.

```powershell
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp/splitpage-lanes/s1a-b-surfaces'
$env:TMP = $env:TEMP
$lockWrapper = Join-Path $env:SPLITPAGE_WORKSPACE 'tools/with-lock.ps1'
& $lockWrapper -Lock smoke -Owner s1a-b-surfaces -Command 'node prototypes/collab/src/b-surfaces/run.ts writer'
$env:COLLAB_SLICE_CANDIDATE = 'B'
& $lockWrapper -Lock smoke -Owner s1a-b-surfaces -Command 'npm run slice --prefix prototypes/collab'
& $lockWrapper -Lock smoke -Owner s1a-b-surfaces -Command 'node prototypes/collab/src/b-surfaces/run.ts split'
node prototypes/collab/src/b-surfaces/report.ts --write
node --test prototypes/collab/test/b-surfaces/evidence.test.ts
```

Browser runs are outside `npm test`, one headless Edge through the smoke lock at a time. The runner archives/builds the exact pinned app commit, checks switch-off startup, uses no server/socket/storage replication, and closes its browser/profile/build directory in `finally`. Replica B uses the existing schema commands and deterministic delivery queue. Retained artifacts carry the bundle hash; evidence tests rebuild it and require exact coverage before endorsing a count.

The run retains **245 browser cases**: 72 Writer, 96 Writer follow-up, 72 page and five failed Split cases. The focused evidence suite has **256 passing tests**, including the retained failures as negative results; all **1475 prototype tests** pass. Root lint, typecheck, dependency and comment gates, code-map generation, generated-artifact verification, diff whitespace and the public-evidence scan pass. No expected result changed, no new product oracle was invented, and nothing was merged by this lane. Stage 1a still needs a passing Split T04 binding; this result does not waive that gate.
