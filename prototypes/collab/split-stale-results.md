# Split stale-base contract: preserve the deliberately unpainted cell

**The prototype adapter issued the T02 repaint; no autonomous Split repaint is observed on this projection path. One binding repair preserves the genuinely stale DOM and passes T02 and T02 boundary, complete forward and undo, under B/M1.** T03 then exposes a different raw-native-whitespace mapping error, before remote formatting. The path stops there with no second repair; T03 replace is not run.

The branch starts on reviewed #1410 head `f4730c6c`, which is not rewritten, and includes its later counter-coverage review fix. Every app result pins unchanged throwaway **[`224b60c580dd03d2541f4edd58a9324b07ff389c`](https://github.com/RetroGorilla/splitpage/commit/224b60c580dd03d2541f4edd58a9324b07ff389c)**. The repair is entirely under `prototypes/collab/`; no app source, buffer mechanism, schema or literal expected result changes.

## Which side broke the contract

[Browser observations and stacks](split-stale/localization.json), minimized in [T02 history](histories/T02-Split-stale-contract.md), compare the parent Split binding, the passing B/M1 Writer binding and repaired Split. All three paint `ab` initially and perform the same declared B insertion of X before native c. Diagnostic builds are unminified with an observational app-render probe, native Node wrappers and wrappers around the binding's projection/repaint ports. The wrappers call the original functions with their original arguments; they do not choose a target, caret or output.

The parent Split remote step records:

```text
binding.project:before -> binding.project:after
binding.requestRepaint
  prototype Object.remote -> context.bridge.repaint -> Split test bridge.render
    app render -> paintAll -> commitRows -> commitRowPatch -> native replaceChild
```

That call stack comes from the running browser. It attributes the actual cell replacement to an explicit prototype repaint request. The passing Writer step records only projection before/after, with no repaint request or app rows-render entry. Repaired Split records the same projection-only sequence. These observations establish an adapter defect on the tested route, rather than a new independent Split surface paint source. Other publication, render/cleanup paths, pointer ordering and input sources are not shown.

| State at the real native beforeinput capture | Parent Split | Writer B/M1 | Repaired Split |
| --- | --- | --- | --- |
| Actual DOM / caret | `Xab`, 3 | `ab`, 2 | `ab`, 2 |
| Retained painted base / identities | `ab`, s1 s2 | `ab`, s1 s2 | `ab`, s1 s2 |
| Replica A | `Xab`, b1 s1 s2 | `Xab`, b1 s1 s2 | `Xab`, b1 s1 s2 |
| paintHeld / version differs | true / true | true / true | true / true |
| Actual target range | 3:3 | 2:2 | 2:2 |
| Input result | Selection outside captured base | Complete T02 forward check | Complete T02 forward check |

The pre-input observer is a window capture listener, ahead of the binding's host capture handler. Its input is trusted protocol `insertText`, data c, before default cancellation. DOM positions and target ranges use the real app mapper. No expected caret is supplied to the code under test. The comparison is causal: B's operation and deterministic delivery complete before the driver requests the native input; no sleep selects the result.

## One repair, with the stale condition preserved

The new `src/split-stale/page.ts` keeps #1410's in-flight paint guard. Its sole repair is to skip the adapter's remote `bridge.repaint()` while the buffer declares `paintHeld`. Projection still advances the session and replica. The experiment withholds that whole rows-repaint request; it does not establish a production invalidation policy for other cells.

Refreshing identities after an actual paint is still required in general. It would not be a valid way to discharge this particular T02 fixture by painting the remote change before input. Here the remote X **remains unpainted at native input**: the observed DOM is ab, painted identities are s1/s2, while replica A already contains b1 X followed by s1/s2. The normal minified replay verifies that condition in D3, dup and late-C, not just in the diagnostic comparison.

The existing stale-beforeinput handler cancels native default, maps c through the retained identities, commits once and repaints Xabc with actual caret 4. Real selective Ctrl+Z returns Xab with actual caret 3 while preserving remote X. The entire original hand-written forward/undo oracle, every required replica, identities, marks and selection are checked. No stale-base condition or expected result was removed to get green.

`preserveStalePaint(false)` removes only the repair in the same app and bundle. All three T02 orders then reproduce the old `Native selection outside painted text` error: DOM/caret advance to Xab/3, retained base stays ab, and local c never commits. The in-flight repaint guard remains enabled in these controls, separating this failure from #1410's recursive-render defect.

## Split narration under B with M1

| Trace | Orders | Result |
| --- | --- | --- |
| T02 | D3, dup, late-C | **3/3 PASS**, complete literal forward and undo, genuinely stale at input |
| T02 boundary | D3 | **1/1 PASS**, complete literal forward and undo |
| T03 | D1, D3 | **0/2**, raw-native whitespace mapping error before remote formatting |
| T03 replace | D1, D3, dup | Not extended after T03 failure |

Selective undo has end-to-end evidence for the four passing runs. This does not establish the complete standalone undo contract, redo, grouping, holds or other input sources. Split boundary uses its real narration cells; it does not claim the Writer's run-on sentinel layout.

### T03 stop result

[Native whitespace history](histories/T03-Split-native-whitespace.md) retains both failures, including raw text code units, actual target ranges and input order. Starting with `the the`, the first two Backspaces leave `the th` and `the t`. The third captured deletion range is 4:5, but the resulting real DOM is `the\u00a0`: the trailing ordinary space outside that range becomes U+00A0. The adapter's raw splice validation rejects the change outside the captured target. The fourth Backspace then encounters the already-misaligned provisional buffer and further errors.

The errors are already present in the after-input observation, before B's formatting operation is delivered. There is no local commit and no complete forward/undo pass. This is a native-DOM/binding mapping limit, not evidence of an M1 or B schema failure. A future binding would have to reconcile browser-generated whitespace changes with target-evidenced intent and retained identities; its canonical rule and implementation are untested here. No whitespace repair or second attempt was made.

## Counter coverage and validation

Every normal replay case and every recorded stage has a literal expectation for compositionMark, dropEmptySince, hold, sync-call count, all commits, composition-end commits, suppressed nested paints and generation. Nine explicit case keys cover **40 stages / eight counters**, including the three removal controls, passing ordinary input and failed T03. Phase names/order are literal too. The tests reuse the strict #1410 stage-counter assertion; new cases, missing/extra stages or missing counter fields fail coverage. Changing sync or lifecycle counts is rejected.

The native-state checker also rejects an alleged pass that repaints/rebases away the stale condition, or omits the remote X. Completed forward/undo paints must leave the buffer's painted text and identity list aligned with the DOM and current replica, with no version gap. Tests independently reapply the complete unchanged `test/buffer-oracles.ts` oracle and identity checker to forward and undo observations, with required A/B/late-C coverage and actual DOM selections. No model decoder produces an expected result.

Reproduce with Node 24.22.1 and installed root/prototype dependencies. `SPLITPAGE_WORKSPACE` points to the workspace containing the lock wrapper:

```powershell
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp/splitpage-lanes/s1a-split-stale'
$env:TMP = $env:TEMP
$lockWrapper = Join-Path $env:SPLITPAGE_WORKSPACE 'tools/with-lock.ps1'
& $lockWrapper -Lock smoke -Owner s1a-split-stale -Command 'node prototypes/collab/src/split-stale/localize.ts'
& $lockWrapper -Lock smoke -Owner s1a-split-stale -Command 'node prototypes/collab/src/split-stale/run.ts'
node prototypes/collab/src/split-stale/report.ts --write
node --test prototypes/collab/test/split-stale/evidence.test.ts
```

Retained counts: **three diagnostic comparisons and nine normal replay cases**—four complete passes, two T03 failures, three repair-removal controls. Browser tests remain outside `npm test`; one headless Edge runs through the smoke lock and is closed with its temporary profile/build in `finally`. No timing claims or identifying metadata are retained. The focused suite has **16 passing tests**, and all **1577 prototype tests** pass. Root lint/typecheck/dependency/comment gates, code-map generation, histories, whitespace and the public-evidence scan pass. No full app suites, changed oracle or merge by this lane.
