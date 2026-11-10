# Split reconciliation: a harness defect, not a new editor hook

**The original throw came from the prototype's own focusout bubble listener. One harness-only paint guard fixes T04 and removed-target with complete literal forward and undo checks under B/M1.** The app's existing painting suppression works in the captured cases; no additional production blur/leave hook is established. T01 and T01 composition also pass. Extending to T02 exposes a separate stale-cell binding error, so the path stops there without a second repair or a T03 claim.

This follows #1407 without changing its reviewed commit `335ab4d6`. The branch was rebased after #1407 merged. The parent review fix separately added lifecycle/sync-count assertions and corrected composition-end sync to **capture phase**; its mutation results remain in that PR.

Normal replay pins throwaway app **[`224b60c580dd03d2541f4edd58a9324b07ff389c`](https://github.com/RetroGorilla/splitpage/commit/224b60c580dd03d2541f4edd58a9324b07ff389c)**. Its `src` tree is `6de8ffb655129b7d6d5844ba6153d730795da5d5`, identical to #1407's app pin `c67139b8`. A source-level coordination draft was committed before the later steering, never exercised in a browser, and reverted. **The tested repair changes only the prototype; it does not add an app guard or change M1, B or any literal oracle.** No source patch is proposed for merging.

## Browser localization

[Raw localization](split-reconcile/localization.json) and the [minimized stack history](histories/T04-Split-repaint-localization.md) record actual browser stacks, listener function bodies read from the browser, native Node identities and entry/exit order. They are not stacks reconstructed from reading source. Diagnostic builds use archived source, unminified with observational function-entry probes; native `replaceChild`/`removeChild` wrappers forward the original arguments, return values and exceptions. The normal replay below separately reproduces the failure without those probes.

The observed T04 chain is:

```text
prototype compositionend capture -> cellEditing.sync -> M1 commit and drain
prototype generic compositionend bubble -> paint -> bridge.repaint
app render -> paintAll -> withRowMotion -> commitRows -> commitRowPatch
native replaceChild(fresh audio part, old audio part)
  native focusout
    prototype focusout capture: observation only
    app editorBlur -> leftEditable; blurredCell/sync skipped while painting
    prototype generic focusout bubble: repaintOwed is still true
      paint -> bridge.repaint -> render -> commitRows -> commitRowPatch
      native replaceChild(..., the SAME old Node) completes
outer native replaceChild resumes and throws NotFoundError
```

For the removed target, `commitRows` calls native `removeChild(R1)` instead. The same prototype focusout bubble listener enters `paint` recursively and removes the **same** R1 Node first; the outer `removeChild` then throws. WeakMap tokens in the browser observations establish Node identity, rather than comparing ids/classes alone. The nested native-write stack contains both the inner and outer native calls and the prototype listener's frames.

The handler which changes the DOM is therefore the prototype's generic bubble callback in the old `src/b-surfaces/split-page.ts`, through a second real renderer invocation. The app's `editorBlur` also runs `leftEditable` UI cleanup before its suppression check, but the probes show **no nested `blurredCell` or `syncShown`** and no session sync from that path during the failing native call. Attributing the original nested render to an unresolved app blur writer was too broad; the browser evidence narrows it to the harness listener.

The capture/bubble distinction matters. The prototype commits the final composition in capture, before the app composition owner's bubble `dropEmptySince`. The later generic bubble callback paints. While that paint is replacing the focused cell, its own focusout enters the same generic callback with `repaintOwed` still true. No remote arrival or network scheduling race is needed.

## Unpatched standalone controls

The same diagnostic observer runs on unpatched main source **`efcd94c21a12585d232e9012a603b92031ce0b21`**, without a collaboration binding. Initial R1/R2 narration is fixture input; no live document mutation is supplied as an expected outcome.

- Real protocol composition x/xy, explicit redraws, then ordinary focus to R2 completes. An ordinary non-rendering leave reaches `editorBlur → leftEditable → blurredCell → syncShown`, preserving the composed narration in the app model.
- The existing row-delete action is invoked twice programmatically while R1's cell stays focused. This deliberately avoids a pointer click moving focus to the button before deletion. The native removal raises focusout inside `commitRows → removeChild`; `editorBlur → leftEditable` runs, painting suppresses `blurredCell`/sync, and removal completes. It is an action-level control, not a claim about pointer-click ordering.

Thus native focusout during a standalone render **does exist and is harmless in this control**. The recursive renderer invocation does not exist there because the prototype bubble listener is absent. This is not evidence that every standalone path is re-entry-free, nor that cleanup before suppression can never matter; it establishes which path caused these throws.

## One tested repair and its removal control

`src/split-reconcile/page.ts` retains the original Split binding and adds a flag owned by its `paint()` operation. That flag covers reconciliation and selection placement. If the generic focusout callback requests another paint during that interval, the nested call returns; the outer call completes and clears `repaintOwed`. The flag is released in `finally`.

The app's real focusout handler still runs; its cleanup is neither stopped nor deferred. No app blur event is swallowed, no app leave callback is replayed, and no source-level reconciliation hook is required by this result. The new guard is correct harness bookkeeping, not an additional hook the real editor is shown to need. Existing experimental cell-sync interception, final composition binding, projection and selective-undo seams remain as described in #1407.

The guard leaves the order **native intent capture → one local commit → held-update drain → reconciliation** unchanged. Retained histories and tests check that order. Diagnostic guarded T04 and removed-target still show app blur cleanup under the outer native write, but no nested render, native replacement/removal or app sync. Normal minified runs show one suppressed nested paint by return from composition end, an attached real DOM caret and complete literal forward/undo results.

`coordinatePaint(false)` removes only that guard in the same bundle and app. All **five controls reproduce the original throw**: T04 D3/dup/late-C, removed D3/late-C. Their incomplete pipeline is kept as a failure; no pass is credited for partial recovery or text alone. This control tests necessity in the harness without inventing a production requirement.

## Split narration under B with M1

| Trace | Delivery | Result after the guard |
| --- | --- | --- |
| T04 | D3, dup, late-C | **3/3 PASS**, complete literal forward and undo |
| T04 removed | D3, late-C | **2/2 PASS**, complete recovery, identities, fallback caret and undo |
| T01 | D1, D3, dup, rev, late-C | **5/5 PASS**, complete literal forward and undo |
| T01 composition | D1, D3, dup, rev, late-C | **5/5 PASS**, complete literal forward and undo |
| T02 | D3, dup, late-C | **0/3**, `Native selection outside painted text` |
| T02 boundary | D3 | Not extended after T02 failure |
| T03 / T03 replace | Their prescribed orders | Not extended after T02 failure |

The same hand-written `test/buffer-oracles.ts` data and identity checker are used unchanged. Tests require A/B and late-C where prescribed, real DOM text/selection, composition lifecycle counts, exact sync counts and no held bytes after passing undo. Split selective undo now has end-to-end evidence **for the fifteen passing cases**; that does not establish the complete standalone undo policy, typing groups, holds, redo or persistence.

### Remaining T02 failure: stop, no second repair

[T02 history](histories/T02-Split-stale-cell.md) retains all three failures. T02 begins with painted `ab`, actual DOM caret 2. The Split adapter's existing remote path projects and unconditionally invokes the whole rows renderer even for this declared stale/unpainted case. The real DOM becomes `Xab`, caret 3, while the editing buffer still retains `ab` as its base. The subsequent stale-beforeinput path tries to begin at observed position 3 against that length-2 base and throws. The native input is cancelled and c is not committed.

There are zero suppressed nested paints in these cases; this is a different base/repaint mismatch, not the original recursive-render failure and not evidence of an M1 or B schema failure. The binding must honor its focused stale-paint contract—coordinate projection/painting with retained base and selection—before this extension can pass. That change was **not attempted**. No additional real-app hook is shown necessary by this failed adapter, and no further traces were extended.

## Reproduction and validation

Set `SPLITPAGE_WORKSPACE` to the workspace containing the lock wrapper, install root/prototype dependencies and use Node 24.22.1:

```powershell
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp/splitpage-lanes/s1a-split-reconcile'
$env:TMP = $env:TEMP
$lockWrapper = Join-Path $env:SPLITPAGE_WORKSPACE 'tools/with-lock.ps1'
& $lockWrapper -Lock smoke -Owner s1a-split-reconcile -Command 'node prototypes/collab/src/split-reconcile/localize.ts'
& $lockWrapper -Lock smoke -Owner s1a-split-reconcile -Command 'node prototypes/collab/src/split-reconcile/run.ts'
node prototypes/collab/src/split-reconcile/report.ts --write
node --test prototypes/collab/test/split-reconcile/evidence.test.ts
```

Retained counts: **six diagnostic scenarios** (broken/guarded T04 and removed, plus two standalone controls), **five guard-removal failures**, and **18 guarded trace cases** (15 complete passes, three T02 failures). Browser runs are outside `npm test`, one headless Edge through the smoke lock. Each case navigates freshly; the runner closes browser/profile/build folders in `finally`. Diagnostic standalone unload dialogs are accepted only for these disposable fixture pages.

The focused retained-data suite has **31 passing tests**, and all **1555 prototype tests** pass. It independently checks the full literal forward/undo data, exact coverage and bundle, same native target in nested writes, runtime handler attribution, absence of nested app sync, source-tree equality and histories. Deliberately removing the nested native writer or changing its Node token makes the stack checker fail. Root lint, typecheck, dependency and comment gates, code-map generation, histories, whitespace and the public-evidence scan pass. No timing claims, changed oracle, second repair or merge by this lane.
