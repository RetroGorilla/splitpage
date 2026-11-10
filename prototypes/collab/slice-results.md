# Browser editing slice results

Browser: **Edg/157.0.4341.42**; Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0. Protocol 1.3. One headless browser, local file page, no replica server or transport socket.

**M1, M2 and M3 each pass all 24 prescribed browser cases (72/72 overall), including selective undo.** None is excluded by these fixtures and none is selected. All three require paint-time identities and native target evidence. All three fail the additional identical-text replacement probe because of the shared buffer contract. All three require the active composition DOM to stay intact.

| Mechanism | What worked | What remains required or failed |
| --- | --- | --- |
| M1 | Dirty-buffer delivery deferred in one document; native composition preserved; mapped commit and queued delivery pass | Every ingress must use the deferral gate; provider bypass, queue bounds and persistence remain as recorded in buffer-results.md. Identical-text replacement fails |
| M2 | Remote updates integrated during composition while DOM stayed untouched; removed-target edit reached recovery; stale native input cancelled and repainted synchronously | Keep the original paint base until commit, preserve composition DOM, restore selection through identities, and handle replacement no-op intent. Identical-text replacement fails |
| M3 | Separate editor/network documents, held forwarding, duplicate/reversed delivery and late hydration pass | Both documents need persistence and coordinated ingress; these runs measure neither memory nor crash safety. Identical-text replacement fails |

## Input observations

Fixture: `<strong>the</strong> the`, UTF-16 offsets, including the repeated unmarked second word. Ranges below are captured synchronously in beforeinput and converted to beat offsets; raw start/end node paths and offsets are in slice-evidence.json. Every input event has empty target ranges. Key events are retained in their observed order. The table reports native defaults, before binding cancellation.

| Input | Observed order and inputType | beforeinput cancelable | beforeinput target ranges | Enough to identify affected painted content? |
| --- | --- | --- | --- | --- |
| typing one character | beforeinput(insertText) → input(insertText) | true | [[7,7]] | Yes for this fixture, with paint-time identities |
| Backspace collapsed | keydown → beforeinput(deleteContentBackward) → input(deleteContentBackward) → keyup | true | [[6,7]] | Yes for this fixture, with paint-time identities |
| Delete collapsed | keydown → beforeinput(deleteContentForward) → input(deleteContentForward) → keyup | true | [[4,5]] | Yes for this fixture, with paint-time identities |
| Backspace selection | keydown → beforeinput(deleteContentBackward) → input(deleteContentBackward) → keyup | true | [[4,7]] | Yes for this fixture, with paint-time identities |
| typing over selection | beforeinput(insertText) → input(insertText) | true | [[4,7]] | Yes for this fixture, with paint-time identities |
| paste over selection | keydown → paste → beforeinput(insertFromPaste) → input(insertFromPaste) → keyup | true | [[4,7]] | Yes for this fixture, with paint-time identities |
| cut | keydown → cut → beforeinput(deleteByCut) → input(deleteByCut) → keyup | true | [[4,7]] | Yes for this fixture, with paint-time identities |
| Ctrl+Backspace | keydown → beforeinput(deleteWordBackward) → input(deleteWordBackward) → keyup | true | [[4,7]] | Yes for this fixture, with paint-time identities |
| Enter | keydown → beforeinput(insertParagraph) → input(insertParagraph) → keyup | true | [[4,4]] | Gap only; structural command required |
| native undo Ctrl+Z | keydown → beforeinput(historyUndo) → input(historyUndo) → keyup | true | [[8,8]] | No: current caret only; requires operation history |
| composition at caret | compositionstart → compositionupdate → beforeinput(insertCompositionText) → input(insertCompositionText) → compositionupdate → beforeinput(insertCompositionText) → input(insertCompositionText) → compositionupdate → beforeinput(insertCompositionText) → input(insertCompositionText) → compositionend | false, false, false | [[4,4]] → [[4,5]] → [[4,6]] | Initial painted selection plus retained composition range; later ranges address provisional text |
| composition over selection | compositionstart → compositionupdate → beforeinput(insertCompositionText) → input(insertCompositionText) → compositionupdate → beforeinput(insertCompositionText) → input(insertCompositionText) → compositionupdate → beforeinput(insertCompositionText) → input(insertCompositionText) → compositionend | false, false, false | [[4,7]] → [[4,5]] → [[4,6]] | Initial painted selection plus retained composition range; later ranges address provisional text |

Composition is driven by imeSetComposition(x), imeSetComposition(xy), then insertText(xy) to finish. The finishing call repeats compositionupdate/beforeinput/input before compositionend. The original selected word is present in compositionstart.data for selection replacement. Composition input is noncancelable; an actual preventDefault attempt leaves defaultPrevented false and inserts x. This browser reports the finishing compositionend as isTrusted=false even though the driver dispatches no DOM events; other observed composition/input events are trusted. This evidence concerns protocol-driven composition only, with no operating-system input method tested.

Native undo's collapsed target names no removed identity. It is intercepted into selective undo for the bound traces. Enter gives a gap but changes paragraph structure, sometimes creating another span with the same beat attributes; the single-beat string contract cannot decode it as a structural operation. The app already intercepts both operations. Paste supplies a range and clipboard data through dataTransfer; cut supplies a selected range. The clipboard fixture uses ordinary copy/paste shortcuts, not script-dispatched paste events.

## Prescribed trace matrix

Candidate A only: this lane tests the browser/buffer boundary, and the existing simulation exercises both candidates. Repeating the schema comparison would add no browser input kinds. No expected data is copied or changed: the page imports test/buffer-oracles.ts and checks every replica through the existing independent checker. The retained forward and undo models are checked again by browser-free unit tests against those same literal oracles, including identities, marks, carets, selection and recovery.

| Trace | M1 | M2 | M3 | Delivery orders |
| --- | --- | --- | --- | --- |
| T04 | PASS (3/3) | PASS (3/3) | PASS (3/3) | D3, dup, late-C |
| T04 removed | PASS (2/2) | PASS (2/2) | PASS (2/2) | D3, late-C |
| T01 | PASS (5/5) | PASS (5/5) | PASS (5/5) | D1, D3, dup, rev, late-C |
| T01 composition | PASS (5/5) | PASS (5/5) | PASS (5/5) | D1, D3, dup, rev, late-C |
| T02 | PASS (3/3) | PASS (3/3) | PASS (3/3) | D3, dup, late-C |
| T02 boundary | PASS (1/1) | PASS (1/1) | PASS (1/1) | D3 |
| T03 | PASS (2/2) | PASS (2/2) | PASS (2/2) | D1, D3 |
| T03 replace | PASS (3/3) | PASS (3/3) | PASS (3/3) | D1, D3, dup |

T04 and T01 composition commit synchronously in the real compositionend handler. Ordinary hazard fixtures deliberately hold commit after real input so the driver can deliver B between native input and commit, matching the simulated schedule; this is an instrumented delayed commit, not a claim that network delivery interleaves native mutation and input in one task. A separate probe commits a real selection replacement synchronously in input. T02 integrates X before native input while paint is held; its cancelable beforeinput performs the model edit and repaint, and no native input event follows. T02 boundary paints only R2; R1 is checked in the replicas. Each undo is driven by Ctrl+Z; the slice cancels historyUndo in beforeinput, whereas the app also handles the shortcut at keydown.

D1 keeps B's updates until after A commits. Other rows deliver B while the buffer is dirty, except T02's deliberate clean-but-unpainted integration. dup delivers every update twice; rev reverses messages; late-C hydrates from B's network document and receives undo through the same queue. M3 checks every E and N document, including C. Queue emptiness and released held bytes are checked after undo.

## Assumptions tested

| Assumption | Result | Observation |
| --- | --- | --- |
| Retain and match every painted identity after native edits | Holds for tested text edits, including identical replacement | Real target offsets disambiguate all T03 Backspaces. Replacing selected `the` with `the` now deletes s5/s6/s7 and inserts a1/a2/a3, caret after a3; undo selects s5*/s6*/s7* |
| beforeinput identifies selected painted content | Holds for tested native text/delete/paste/cut; conditional for composition; insufficient for undo | Initial composition selection addresses painted identities; later ranges refer to provisional text. historyUndo reports only the current caret. Enter needs structural intent |
| Insert replacement at painted gap before deleting selected identities | Holds for tested replacements | T01 composition produces aβXd under every listed order and all mechanisms; no delete-first implementation was introduced |
| Remote integration leaves native composition undisturbed | Holds only when DOM is preserved | T04 passes with immediate M2 integration and held M1/M3 delivery. Replacing the whole beat or the active text node starts a second composition on the next update and leaves the earlier x behind |
| Cancel stale beforeinput, repaint synchronously, restore selection | Holds for tested ordinary text inputs; fails as a composition strategy | T02 and stale Backspace/Delete/selected deletion/Ctrl+Backspace/paste/cut probes cancel successfully. Composition input cannot be cancelled. An unchanged-DOM repaint resets caret 4 to 0 (whole beat) or 3 (active text node); explicit restoration preserves a 4:7 selection |

A clean M2 remote bold update repaints `<strong>the</strong> the` before returning and restores caret 7. During composition, even restoring the numeric selection after DOM replacement does not restore the browser's composition range: the later update yields `the xxythe` instead of `the xythe`. A native commit can run synchronously in input: the probe ends with text `the a`, caret 5, dirty=false and commit source input. Composition commits finish in compositionend; they do not wait for a timer.

## Retained browser histories

- [T04 whole-beat repaint](histories/T04-browser-whole-repaint.md): composition interrupted, with and without selection restoration.
- [T04 active-text-node replacement](histories/T04-browser-text-replacement.md): same failure with a smaller DOM mutation.
- [T03 identical replacement](histories/T03-replace-browser-identical.md): PASS under all three mechanisms, including identity checks on every replica, synchronous input commit and selective undo. Previously all three stopped with 0 compatible minimal splices; the target-evidenced planner now preserves the replacement intent.
- [T02 selection repaint](histories/T02-browser-selection-repaint.md): automatic selection survival fails; explicit restoration succeeds.
- [T03 native undo range](histories/T03-browser-native-undo.md): affected identities cannot be recovered from the target range alone.
- [T02 boundary native Enter](histories/T02-boundary-browser-Enter.md): native default changes structure outside one beat's text.

The browser-specific part of artifact 8 §4's T03/M2 ambiguity prediction is refuted for these Backspace/replacement fixtures with retained targets, as it was conditionally in simulation. It remains true without target evidence. The removed-target row is confirmed as a recovery requirement, with T04 removed passing through retained removed content. Provider bypass, long queues, memory/performance and STORE predictions are not rerun here. No literal expected result is disputed or altered.

## Differences from the app and required hooks

The inspected path is src/features/writer/flow-surface.ts: beatHtml, paint, repaint, range0, syncBeatEl, onBeforeInput, onInput and composition start/end. The copied shape is an editable root → div.wr-par → span.wr-beat with data-id/data-field and whole-beat innerHTML replacement. Tested bold runs use strong, matching core/text/html.ts. The small renderer also spells the basic mark tags and empty/trailing-break sentinel; only plain and bold ASCII plus β are exercised by the prescribed traces.

Differences are deliberate and bound this evidence:

1. Only one narration beat is painted; other beats, removed content and B/C exist in replicas. No Split-view cell, visual field, heading, cross-beat DOM selection or full Writer surface is bound.
2. No app code is imported. The renderer copies the tested basic DOM shape and mark tags; tags, comments, links, direction/cue wrappers, protected atoms, images, decoration, beat numbering, paragraph grouping and app CSS are absent. Spellcheck is disabled. No claim covers those nodes, graphemes or surrogate pairs.
3. The page binds Yjs directly through BufferHarness and EditableBeatBuffer. There is no session owner, document projection, capability/epoch replacement, attribution, registry repair, save state, persistence, transport provider, draft system, recovery panel or app undo owner. Recovery is checked as data, not displayed.
4. The app's syncBeatEl reads the whole beat's HTML into runs and uses rendered as a paint cache; this slice preserves paint-time identities and captures native targets, checks actual DOM against the buffer, and commits only those identities. A snapshot of strings alone is not the binding contract.
5. The shared buffer exposes synthetic dispatch methods. The binding calls them only from real browser event observations; ordinary inserted text is measured from DOM against the captured target and composition input.data is checked against actual DOM. Its plan() derives replacements from retained origins when targets exist, including identical or nonminimal replacements; without targets the minimal-string-diff ambiguity guard remains.
6. Normal trace commits are deliberately delayed to test D3; composition and stale guards commit in their event handlers. The synchronous input probe covers an ordinary replacement. The slice intercepts undo in beforeinput; the app also catches Ctrl+Z on keydown. The app routes Enter, paste and cut to explicit commands; this page observes their native defaults separately and maps only ordinary single-beat paste/cut probes.
7. A textarea exists solely as a real clipboard fixture. The driver selects beats with keyboard movement/Shift; script sets selection only after paint, as the binding must. Reset removes native Enter's extra DOM. The page is bundled into a temporary local HTML file using a prototype-only build dependency; no automation or WebSocket dependency was added.

All mechanisms need a paint snapshot with epoch, beat version, identities/runs and identity-relative selection; beforeinput targets retained before mutation; input/composition synchronization that never re-captures the base from live state; insertion-before-deletion; removed-target recovery; and selective undo with selection restoration. The prototype now demonstrates target-evidenced identical replacement intent without relying exclusively on minimal string differences.

M1 additionally needs every provider/hydration/recovery ingress behind one bounded hold gate. M2 needs immediate integration with synchronous clean-beat projection and a stale-beforeinput guard, while composition suppresses all writes to its DOM nodes. M3 needs origin-filtered E↔N forwarding with a dirty-buffer hold and coordinated durable ownership of both documents. Existing buffer-results.md remains the evidence for queue-bound/provider behavior. Binding the app's real editor is the later lane, not part of this prototype.

## Reproduction

Install with npm ci in prototypes/collab using Node 24.22.1. Set TEMP and TMP to the lane's temporary folder. From the repository root, invoke `& D:\vibecoding\Splitpage\tools\with-lock.ps1 -Lock smoke -Owner s1a-browser-slice -Command 'npm run slice --prefix prototypes/collab'`. Edge chooses a free debugging port, uses a temporary profile with msImplicitSignin disabled, and is closed in finally. Set SLICE_EDGE only to use another Edge executable.

`npm run slice` records slice-evidence.json and generates this report and histories. `node src/slice/report.ts --check` checks generated artifacts without a browser. `npm test` rechecks retained models and asserted failure evidence without launching a browser. The evidence contains raw events, node ranges, creation-time identity bindings, forward/undo models and the browser version. No app/browser suites, native OS input method, server, mechanism choice or performance claim is included.
