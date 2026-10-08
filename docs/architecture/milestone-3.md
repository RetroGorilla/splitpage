# Milestone 3: session, commands and text editing through one owner

The working plan for milestone 3 of [the implementation plan](../IMPLEMENTATION-PLAN.md#3--deliver-one-sessioncommand-vertical-slice). It was approved by Adam on 2026-10-02, derived from `4.0-development` at `29714e8` and revised at `b1fde0f` (#364, #365 and #367 on top). It names functions, not lines. Adam's answers to the first draft are under [Decisions](#decisions). Calls that are still open are under [Questions for Adam](#questions-for-adam).

Status (2026-10-08): steps 3.0 to 3.14 are merged. [As built](#as-built) says what they delivered and where the build differs from this plan; the plan's own text below is left as written, with a correction note where a sentence turned out to be wrong. [session.md](session.md) describes the session, the scheduler and the commands. The gate is recorded separately, after its runs.

## Goal

Introduce `DocumentSession` as the first owner of the live document. Prove the boundary with scene length, then scene status. Then move typing, split, join and cut-paste into session commands, so that milestone 3 meets INV-06, INV-18 and INV-53 itself.

A command does five things:
- it checks capability;
- it applies one transaction, which includes its anchor reconciliation;
- it advances the edit generation once;
- it records undo under today's grouping;
- it publishes a change set.

A coalescing effect scheduler runs dirty, save, draft, history and refresh. The command does not. Alongside this, land the three criteria the milestone 2 external review moved here (validated document types, test-only frozen caches with merge-input ownership, and #323), plus #326 and #353.

## Decisions

Adam's answers to the first draft (relayed by the coordinator):

| # | Question | Decision | Where it lands |
| --- | --- | --- | --- |
| D1 | Slice scope | Add text-command PRs after the status command, so M3 meets INV-06, INV-18 and INV-53. Length, then status, stays first as the boundary proof | 3.11–3.14 |
| D2 | Freezing in production | Tests only. Production builds don't freeze, and keep `readonly` types | 3.5 |
| D3 | The freeze switch | A page query flag that works in any build, like `?teleprompter=1`; `SPLITPAGE_FREEZE_CACHES=1` makes the harness add it | 3.5 |
| D4 | Gate runs | Both full Windows runs: freeze off and freeze on | Gate |
| D5 | #353 | In M3, in the PR that owns each path, each part with a test that fails first. Part 1 (undo replay) lands in the undo adapter, as its own PR right after it (review.md §1 keeps a fix separate from an extraction). Part 2 (a deleted owner's id wins in the merge) goes in `core/merge/lists.ts` | 3.7, 3.4 |
| D6 | Status in review mode | Refuse with a toast, not silently. The wording is Adam's | 3.9; wording in Q1 |
| D7 | External gate reviewer | Codex again | Gate |
| D8 | Status toast wording | "This is a review copy — comment on a scene instead of changing its status." (`warn`) | 3.9 |
| D9 | `setSceneLength` in review mode | Matches status: refuses with "This is a review copy — comment on a scene instead of changing its length." (`warn`), in the same form as D8 | 3.8 |
| D10 | Scene cut-paste | Out of M3. M3 takes cell-level cut-paste only for INV-18; moving whole scenes goes with the later bulk commands | 3.14 |
| D11 | Lane models (2026-10-07) | The plan's rule in [§2](../IMPLEMENTATION-PLAN.md#lane-models-and-characterisation): Sonnet by default, Opus for the editing hot path and the undo adapter among others. 3.12 stays Opus; 3.13, 3.14 and 3.15 are Sonnet. Reviews stay Opus | 3.12–3.15 |
| D12 | As-built doc (2026-10-07) | `session.md` describes the session, the effect scheduler and the command shape as built after 3.9, as its own docs PR before 3.12 merges. 3.15 revises it | 3.15 |

## Exit criteria (plan §5, milestone 3)

| # | Criterion | Shown by |
| --- | --- | --- |
| E1 | Scene length and status behave as at the base, apart from D6's toast | Suites 173, 174, 271, 3.0's status suite, 06, 28, 43, 67, 73, 185, 187, 282, 311 |
| E2 | An accepted command makes one generation transition, one undo entry (or one coalesced typing group) and one effect pass | Application tests over the real session with fake ports (INV-53) |
| E3 | A no-op, rejected or failed command has no effects | The same tests: generation, dirty state, save schedule and undo stack unchanged |
| E4 | User edits, server updates and recovery adoption are distinct kinds; adoption opens a new epoch, even for the same document id | Application tests (INV-53: "a merge, a reload or a recovery adoption adds none") |
| E5 | Views never mutate live state; no migrated view imports `S` or a concrete adapter | Dependency gate and `--metrics` |
| E6 | Validated document type | The four tests the plan lists under "Validated documents" |
| E7 | Cached results are owned and, under test, frozen; a merge writes into no input and shares nothing with it | The plan's "Cached results" tests, including the freeze-on full run |
| E8 | INV-06: no document-wide work per keystroke | Fake-clock application test (a burst of typing change sets runs each derivation once per window); `67-render-perf.txt` |
| E9 | INV-18: split, join and cut-paste reconcile anchors in the transaction | Application test: commands that never call `syncCommentAnchors` leave each comment's `rowId`/`field` equal to what reconciliation computes, in one undo entry; `comment-anchors.test.mjs` stays |
| E10 | #323, #326 and #353 fixed | Fail-first tests; the pinned tests flip on purpose |
| E11 | Gate | [The gate](#the-gate) |

## Where M3 starts (measured)

`node tools/dep-report.mjs --metrics` on a `git archive` of `b1fde0f`:
- 137 frontend modules, 60 migrated;
- one runtime cycle of 53 modules and 415 edges;
- `S`: 56 importers, 33 writers, 26 field writers, 9 `S.state` assigners.

The baseline holds 641 entries. There are 188 browser suites; #367 added `361-pin-prompt-to-servers.txt`. No other figure changed from `29714e8`.

The slice today:
- **Scene length.** `setSceneLength` (`05r-read-time.js`, outside the cycle) is the only writer of `lengthSeconds`. It refuses silently in review mode and on a no-op, then fans out by hand: stamp, `markDirty`, render, stats, production and b-roll refresh, autosave. Suite 271 characterises it.
- **Scene status.** `cycleRowStatus` (`01-scene-status.js`) has no review-mode guard of its own; review mode hides the button (`43-review-mode.txt`). It arms or clears the hide-shot grace.
- **Undo.** `12a-undo.js` records by diffing. `markDirty` → `noteEdit` → a microtask `flushEdits` → `diffStates`. It coalesces one-cell typing within 1,000 ms and keeps 200 entries. Undo applies through its own key-order-blind `applyStepsLive`. Core's `applySteps` only moves `base`, with a `clone` fallback, so #323 has no user effect today. `applyStepsLive` merges `people`, `productionTags` and `brollShots` without re-pointing owners (#353 part 1).
- **Typing.** `syncFieldFromDom` (`05-render.js`, in the cycle) stores each keystroke as HTML. A cell with no media goes through `toHtml(fromHtml(...))`; a cell holding media goes through `sanitizeHtml`. It writes `S.state.rows[i][field]`, stamps, and calls `markDirty`. `editCell` (`05b-cell-edit.js`) runs model edits on the DOM cell.
- **Split.** `splitRowFieldCore` (`06-rows.js`) splits the cell, splices a new row and calls `syncCommentAnchors(S.state)`.
- **Join.** This exists only in the Writer. `mergeWriterRows` (`19-writer.js`) uses `joinCells`, merges status by rank and calls `syncCommentAnchors`.
- **Cut and paste.** `copyFromCell(…, cut)` and `pasteIntoCell` (`05c-clipboard.js`) freshen b-roll ids, attach gallery media, record pasted shots (`08c`) and call `syncCommentAnchors`.
- **IME.** Only `81-draft-edit.txt`, for comment drafts, drives composition. No suite composes in a script cell.
- **Caches.** `contentMemo` and the production readers return the cached value. The cell reader returns its cached `Run[]`. 07's index has two views, and a heal patches only one (#326).
- **Types.** `checkJs` is off, so the brand constrains `.ts` callers only. Tests call the ten guarded functions at 76 sites.

## Target layout

- `src/application/session/`:
  - `document-session.ts`: the document, epoch, generation, transaction kinds, capability, change sets, selectors, and reconciliation inside the transaction;
  - `ports.ts`: `UndoPort`, `EffectPort`, `CapabilityPort`, with `Clock`/`IdSource` reused;
  - `effects.ts`: the scheduler;
  - `change-set.ts`.
- [`session.md`](session.md): the session, effect scheduler and command shape as built after 3.9.
- `src/application/commands/`: `scene-length.ts`, `scene-status.ts`, `cell-text.ts`, `split-join.ts`, `clipboard.ts`.
- `src/legacy/session-bridge.ts`: implements the ports over legacy code. Legacy modules in the cycle hand their effect functions to it at `__init`, as `configureUndo` already takes hooks, so the bridge never joins the cycle. The gate refuses a cycle through a migrated folder.
- `src/legacy/undo-adapter.ts`: an `UndoPort` over 12a's history, diff and inversion, kept as they are.
- `05r`, the status button, `syncFieldFromDom`, `06-rows.js`, `19-writer.js` and `05c-clipboard.js` stay where they are, as views calling commands. Feature folders come in milestone 6.

## PRs, in order

```
3.0 ─┬─ 3.1 type ──┬─────────────── 3.5 caches + freeze flag ─────────────────────────────┐
     ├─ 3.2 #323 ──┤                 (3.5 also needs 3.3)                                 │
     ├─ 3.3 #326 ──┤                                                                      │
     ├─ 3.4 #353b ─┴─ 3.6 session ─┬─ 3.7 #353a ─┐                                        │
     │      (needs 3.1, 3.2, 3.4)   └─ 3.8 length ┴─ 3.9 status ─ 3.12 typing ─┬─ 3.13 split/join ─┼─ 3.15 close
     │                                3.10 fuzz (after 3.6) ───────────────────┤                   │
     └─ 3.11 text characterisation (any time after 3.0; before 3.12) ──────────┴─ 3.14 cut/paste ──┘
```

| PR | Ownership boundary | Depends on | Parallel with | Model |
| --- | --- | --- | --- | --- |
| 3.0 | Slice characterisation: tests, one browser suite, perf record. No source change | — | — | opus |
| 3.1 | Core signatures: the validated brand and the rule refusing a cast to it | 3.0 | 3.2–3.4, 3.11 | opus |
| 3.2 | `core/text/steps.ts`: #323 | 3.0 | 3.1, 3.3, 3.4, 3.11 | opus |
| 3.3 | 07's index cache: #326 | 3.0 | 3.1, 3.2, 3.4, 3.11 | opus |
| 3.4 | `core/merge/lists.ts`: #353 part 2 | 3.0 | 3.1–3.3, 3.11 | opus |
| 3.5 | Cache ownership: readonly returns, the freeze flag, the merge-input test | 3.1, 3.3 | 3.6–3.10 | opus |
| 3.6 | Session, undo adapter, effect scheduler, bridge | 3.1, 3.2, 3.4 | 3.5, 3.11 | opus |
| 3.7 | Undo adapter: #353 part 1 | 3.6 | 3.8, 3.10 | opus |
| 3.8 | Scene length command | 3.6 | 3.7, 3.10 | opus |
| 3.9 | Scene status command, with the review-mode toast | 3.8 | 3.10 | opus |
| 3.10 | Tests only: raw-input fuzz through the session's entry points | 3.6 | 3.7–3.9 | opus |
| 3.11 | Text characterisation: tests and suites only | 3.0 | 3.1–3.10 | opus |
| 3.12 | Typing command (`cell-text.ts`; `syncFieldFromDom` as a view) | 3.9, 3.7, 3.11 | — | opus (D11: the hot path) |
| 3.13 | Split and join commands (`06-rows.js` split, `19-writer.js` split/join) | 3.12 | 3.14 | sonnet (D11) |
| 3.14 | Cut-paste command (`05c-clipboard.js`) | 3.12 | 3.13 | sonnet (D11) |
| 3.15 | Docs: revise `session.md`, ledger rows, `HANDOFF.md` pointers, metrics, perf record | all | — | sonnet (D11) |

The busiest point is 3.1 to 3.4 with 3.11: five lanes, within the budget of about six test-running agents (check RAM first). After that, at most three run at once. Each PR runs `npm run verify` and its suites, and lanes run `--prune` after merging the base. Reviews use opus. 3.12 waits for 3.7 because typing goes through the same undo adapter path. 3.0 to 3.11 ran on opus before D11; the rows above keep that record.

## Per PR

**3.0 Slice characterisation.** A new browser suite, `2xx-scene-status-effects.txt`, modelled on 271:
- one click is one undo step;
- the document is unsaved and autosaves;
- one row repaints (`__renderTest`);
- the hide-shot grace is armed;
- undo restores the status and stamps the row.

Recording stubs pin the fan-out order for both commands. 3.0 also characterises the 14 `S.state` assignment sites: is each one a `migrateRows` fixed point? It runs `node tools/perf-record.mjs` once on Windows as the M3 start. No goldens or metrics change.

**3.1 Validated type.**
- Own `src/core/migrate.ts` (the only producer) and the plan's ten signatures. Add a rule in `dep-report.mjs` or `eslint.config.mjs` refusing a cast to the brand, and its `tools/test-*.mjs`.
- Bytes are unchanged. (Reworded from the build: the unminified bundle is byte for byte the base's. In the minified `index.html` only esbuild's identifier naming differs, because it ranks short names by the character frequency of its input, which includes the erased type text, and the CSP script hash changes with it. #378 measured both.)
- Tests:
  - TypeScript compiler API fixtures: an object literal and a `JSON.parse` result are each a type error, for each function;
  - the rule fails first on a planted cast;
  - the migrate golden and the fixed-point test pass unchanged.
- Tests get branded documents through `migrateRows` with fake ports, which touches up to 76 call sites. Mutation testing on the rule. Metrics: no import change.

**3.2 #323.**
- `applySteps` compares rows independently of key order, as the plan's acceptance asks. Restoring the field in place would change the bytes saved after an undo, so it is not taken.
- The pinned `steps.test.ts` test flips and is renamed.
- Seeded fuzz of `applySteps(invertSteps(...))` with field removal and restore, and mutation testing. No golden changes and no CHANGELOG line.

**3.3 #326.** One owner function re-derives or patches both index views after a heal. The pinned `production-shims.test.mjs` test flips. Suites from the production and tags family (testing.md table), including `219-sound-cues.txt`. No CHANGELOG line.

**3.4 #353 part 2.**
- Own `src/core/merge/lists.ts`. An owner id that did not survive the merge gives way to the other side's live owner (the proposal Adam approved for the queue).
- Fail-first core test from the issue's repro. The differential test against the base on seeded inputs is mandatory for merge algorithms (review.md §5); the only differences allowed are the repaired cases.
- A merge golden that changes is regenerated in a dedicated commit. Suggested CHANGELOG line required.
- Note: pinned-defects.md's #353 row once named `src/core/merge/tags.ts` and `broll.ts`, which do not exist. It names `src/core/merge/lists.ts`, where the fix landed (#375).

**3.5 Cache ownership (D2, D3).**
- Own: the return types in `memo.ts`, `readers.ts` and `production/tags.ts`; `decode.ts` (`CellReader` becomes `readonly`); 07's index views; `run-tests.ps1`, `driver.ps1` and `tools/run-suites.mjs`.
- A query flag, for example `?freeze-caches=1`, read once at start makes every cache deep-freeze what it hands out. `SPLITPAGE_FREEZE_CACHES=1` makes the harness add the flag. Without the flag, any build behaves as today.
- Tests:
  - a write into each cache's value throws `TypeError`;
  - deep-frozen `base`, `mine` and `theirs` through all 58 merge golden cases and a seeded corpus, with no throw and nothing in `merged` reachable from an input.
- 07's index writers that freezing meets (from 3.3): entries handed out before a heal take the new ids in place, which `production-index.test.mjs:31` and 3.3's shims tests ("…a fresh derivation of the healed document…", "a name the registry refuses…") pin and which flip; the heal reassigns `core.unregistered` and `core.tagSig`; the heal writes ids into core entries (no test requires it in place, so a copy is fine); `productionIndexFresh` writes `core.rowSig` on every prose edit (older than 3.3, and it would throw on each edit under freeze).
- The harness change means a full run before merge (review.md §3). This PR runs two, off and on. Every legacy writer that freeze-on exposes is fixed here or named in `docs/architecture/` with a test. Metrics: none expected.

**3.6 Session, undo adapter, effects.**
- Own: `src/application/session/`, the two `src/legacy/` files, and the `__init` hooks in `12a-undo.js`, `12-dirty-toast.js` and `03-sync.js` (`noteRemoteChange`). Adoption hooks in at `render()`'s `trackDocument()`, and the reload at `18-local-files.js`'s `absorbRemoteChange()`.
- Adoption brands through `migrateRows`, timed with `perf-record` on the long demo.
- Reconciliation runs inside any transaction whose change set moves runs between cells or rows, or inserts or removes rows. A one-cell edit cannot change an anchor's `rowId`/`field`, so it skips the document-wide `syncCommentAnchors` (INV-06). A seeded property test proves that claim. (Correction from the build: the property test showed the claim holds only while the cell's comment ids are unchanged. The session reconciles a one-cell edit that adds or drops a comment id. See [session.md](session.md#when-reconciliation-runs).)
- Preserve 12a's diffing, coalescing, `forget` and `foldIntoEdit`, draft undo (INV-55), the 180 ms idle refresh, every autosave debounce, and one `S.editSeq` increment per accepted edit.
- Tests: application tests for E2 to E4 with fake ports; the INV-06 fake-clock test; a differential of the adapter against 12a over seeded edit sequences, comparing stacks and states; mutation testing on the session.
- Suites: 73, 84, 185–187, 28, 19, 20, 67, 260–264, 265.
- Desktop smoke groups: `open/save`, `save-in-place`, `duplicate document id`, `draft:`, `history:`.
- Metrics: new modules only; the cycle must not change.

**3.7 #353 part 1.** In the undo adapter's replay path, a list merge re-points owners with `personIdRemap` and `repointOwners` from `core/merge/lists.ts`. Fail-first test from the issue's repro. Suites 73 and 267. Suggested CHANGELOG line required.

**Every command (3.8–3.14).** Its tests run it through `runConfined` from `tests/application/session-fakes.ts`, which fails when a command writes anything its change set does not declare, stamps and comments included. The session rolls a throwing command back only over what its change set declares (3.6).

**3.8 Scene length.**
- `commands/scene-length.ts`; 05r reads through selectors. Preserve 271 exactly, plus the toasts, focus return and Ctrl+Z on the button. Stamping goes through the `Clock` and editor ports.
- Expected: `S` importers 56 → 55 and writers 33 → 32 (05r's only `S` uses), with the cycle unchanged.
- Suites: 173, 174, 271, 140–142, 185, 73, 67, 43. Desktop groups `open/save` and `draft:`.

**3.9 Scene status (D6).**
- `commands/scene-status.ts`. In review mode, refuse with Adam's toast (Q1) and no other effect. The grace becomes an effect.
- Expected: `S` writers 32 → 31. Cycle edges 415 → 412, because 01's imports of `03-sync.js`, `12-dirty-toast.js` and `14-export.js` are used only in `cycleRowStatus` (counted by grep). Confirm with `--prune`.
- Suites: 3.0's suite, 06, 28, 43 (plus a toast case), 67, 73, 185, 187, 282, 311. Suggested CHANGELOG line for the toast.

**3.10 Entry-point fuzz.** Seeded raw inputs, #304's table included, through adoption, remote merge and reload. Each one ends in a valid document or a typed failure. A failing seed becomes a permanent case.

**3.11 Text characterisation.** Tests and suites only:
- a new suite composing in a script cell through CDP IME (`Input.imeSetComposition`/`insertText`) in the grid and the Writer;
- application-level recordings of typing undo groups (the 1,000 ms window, word starts, a cosmetic-only change recorded as nothing);
- the effect fan-out of split, join, cut and paste;
- each comment's anchor after split, join and cut-paste.

These pin today's behaviour for 3.12–3.14.

**3.12 Typing command.**
- `cell-text.ts` takes normalised runs (INV-10) for `(rowId, field)`. `syncFieldFromDom` decodes through the adapter and calls it.
- A cell holding media cannot be expressed as runs today. Its sanitised stored HTML goes through the same command as a named, typed variant, recorded in INV-10's row until milestone 6.
- Preserve the `​` strip, the `undoApplying`/`cellRepainting` guards, `noteFieldPainted`, the caret, composition and coalescing.
- Acceptance: INV-06's test over typing change sets; INV-53 (one coalesced entry per word group, as in 3.11); typing during composition makes no command until the composition ends, if 3.11 shows that today.
- Suites: 75, 76, 77, 81, 84, 86, 67, 73, 185, 3.11's IME suite, 52-csp. Metrics: measured, not estimated; 05-render keeps other `S` writes.

**3.13 Split and join.**
- `split-join.ts` covers `splitRowFieldCore` and the media split, and the Writer's `splitWriterRow`/`mergeWriterRows`, including the status merge by rank and the "Both scenes have a visual" refusal. The explicit `syncCommentAnchors` calls go; the transaction reconciles.
- Acceptance: E9 for split and join, one undo entry each.
- Suites: 78, 06, 20, 246, 262, 267, 73, 84. Metrics measured before and after.

**3.14 Cut-paste.**
- `clipboard.ts` covers `copyFromCell` with cut, and `pasteIntoCell`: b-roll id freshening, gallery attachments and pasted shots as the command's record effects. The explicit `syncCommentAnchors` goes.
- Acceptance: E9 for cut-then-paste, one entry each.
- Suites: 77, 80, 86, 92, 160, 65, 68, 69, 20.
- Seeded fuzz over paste HTML, because it is a transformation (review.md §5).

**3.15 Close.**
- Revise `docs/architecture/session.md` (D12) for what 3.12 to 3.14 changed in the command shape, and add this doc's as-built section with `--metrics` before and after, and `--prune`.
- Ledger rows INV-02 (part), 06, 07 (change sets), 10, 17, 18, 53 and 55, with `HANDOFF.md` pointers for the rows absorbed.
- The perf record rerun under 3.0's conditions.
- pinned-defects.md updates.
- The gate record is a separate docs PR after the runs.

## Pinned defects in M3

| Defect | Fixed in | Pinned test that flips |
| --- | --- | --- |
| #323 undo key order | 3.2 (#374) | `tests/core/text/steps.test.ts` ("today the inverse of an insertRow is refused…") |
| #326 index views disagree after a heal | 3.3 (#376) | `src/test/production-shims.test.mjs` ("after a heal the cached core index keeps the ids…") |
| #353 part 2, a deleted owner beats an assignment | 3.4 (#375) | new fail-first test; any golden that changes, in a dedicated commit |
| #353 part 1, undo replay drops same-named people | 3.7 (#402); #391 is the part it left | new fail-first test |
| #304 (fixed by #340) becomes a type error | 3.1 (#378), 3.10 (#404). A type error for `.ts` callers only; since #417 `applyMerge` also migrates `theirs` at run time (Part of #415) | — |
| #303 (fixed by #335) is tested for every cache | 3.5 (#385) | — |
| #325 reads that repair | stays at milestone 6; the scheduler still calls the repairing b-roll refresh | — |

## As built

### The PRs

| Step | PR | Merged as | What it delivered |
| --- | --- | --- | --- |
| 3.0 | #373 | `d51cb25` | Characterisation, no source change: ordering recordings for status and length, undo grouping, the 14 `S.state` assignment sites characterised one by one, suite 288, the M3-start perf record |
| 3.1 | #378 | `141c4d4` | `ValidatedDocument` (`core/document/validated.ts`), produced only by `core/migrate.ts`; `tools/brand-casts.mjs`, run by `npm run typecheck`, refuses a cast to it; four type-aware lint rules; `JSON.parse` returns `unknown` |
| 3.2 | #374 | `4ad4688` | `applySteps` compares values regardless of key order (#323) |
| 3.3 | #376 | `94ff983` | One owner function keeps both views of 07's index in step after a heal (#326) |
| 3.4 | #375 | `f3306b7` | A deleted owner gives way to the other side's live owner in `core/merge/lists.ts` (#353 part 2) |
| 3.5 | #385 | `2a0a505` | `Frozen<T>` returns, the `?freeze-caches=1` flag (`deepLock`), `SPLITPAGE_FREEZE_CACHES=1` in the harness, suite 380, the merge-input test; the four index writers freezing met are fixed |
| 3.6 | #384 | `6c78cf2` | `DocumentSession`, the effect scheduler, the undo adapter and the bridge |
| 3.7 | #402 | `4a233b8` | Undo replay re-points owners of folded people (#353 part 1); #391 left open |
| 3.8 | #405 | `9d88ab7` | `scene-length.ts`, with D9's review-mode toast |
| 3.9 | #414 | `d1b84cd` | `scene-status.ts`, with D8's toast; the hide-shot grace stays view state |
| 3.10 | #404 | `1ffa325` | Seeded entry-point fuzz through the session (tests only); it found #406 to #412 |
| 3.11 | #379 | `928e340` | Text characterisation: `text-editing-app.test.mjs`, suite 289, the driver's `ime` verb |
| 3.12 | #427 | `6a360fe` | `cell-text.ts`, `syncFieldFromDom` as a view; #380 and the undo changes under it (Opus) |
| 3.13 | #447 | `26a1b01` | `split-join.ts`: `splitSceneCommand` and `joinScenesCommand` |
| 3.14 | #455 | `c91bc4f` | `clipboard.ts`: `pasteCommand` and `cutCommand` |
| 3.15 | this PR | | The docs, the metrics and the perf record |

Merged after 3.14 and before this PR: #448 (`391bda6`), the composition undo fix for #436 and #446.

The plan and the as-built doc came first: #372 (the plan), #422 (scope decisions of 2026-10-07: D11 and D12) and #423 (`session.md`). Fixes found on the way merged beside the steps and are not steps: #403 (#377), #413 (#355), #416 (#411), #417 (#406 to #410, #412), #435 (#344, #419), #437 (#433), #440 (#418) and #449 (#434, #445). [pinned-defects.md](pinned-defects.md) has each.

### Exit criteria

| # | As built |
| --- | --- |
| E1 | Held. 3.8 and 3.9 ran the listed suites; D6's toast is the one difference, and suite 43 has a case for it |
| E2 | Held for all seven commands. Each has an "E2" application test over the real session with fake ports, in `scene-length`, `scene-status`, `cell-text`, `split-join` and `clipboard` under `tests/application/` |
| E3 | Held. The "E3" tests run no-ops, refusals and throwing stamp ports through `runConfined`, which also catches an incomplete rollback |
| E4 | Held (`document-session.test.ts`, `entry-fuzz.test.ts`). Recovery that enters by assignment is published as `adopt`, not `recovery` (session.md §2) |
| E5 | Held for the commands: no command or session module imports `S` or a concrete adapter. The views of the seven commands no longer write the document. Every other view still does, so `S` has 54 importers (below) |
| E6 | Held (#378): compiler-API fixtures for the guarded functions, the cast rule with its self-tests |
| E7 | Held (#385, #376): readonly returns, the freeze flag and `src/test/merge-inputs.test.mjs`. The freeze-on full run belongs to the gate |
| E8 | Held. `tests/application/cell-text.test.ts` ("INV-06: a burst of keystrokes…") runs 6 keys 100 ms apart as one refresh 180 ms after the last, and 25 keys 60 ms apart as one refresh at the 1,000 ms cap and one after the last key. `67-render-perf.txt` passes |
| E9 | Held for split, join and cut then paste. `split-join.test.ts` has a seeded check (300 seeds of 8 steps) that a later `syncCommentAnchors` moves nothing and that each command is one undo record; `clipboard.test.ts` has the cut-then-paste case. `comment-anchors.test.mjs` stays |
| E10 | Held. #323 by #374, #326 by #376, #353 by #375 and #402. #391 is the piece of #353 that stays open |
| E11 | Not in this PR. The gate record follows the runs |

### Measured

`node tools/dep-report.mjs --metrics`, at `b1fde0f` (where the plan was last revised) and at `391bda6` (3.14 and #448 merged; #448 changed no figure, so they are the same at `c91bc4f`):

| | Start | End |
| --- | --- | --- |
| Frontend modules | 137 | 152 |
| Migrated modules | 60 | 75 |
| Runtime cycles, largest (modules), edges | 1, 53, 415 | 1, 53, 411 |
| `S` importers | 56 | 54 |
| `S` writers | 33 | 31 |
| `S` field writers | 26 | 26 |
| `S.state` assigners | 9 | 9 |
| Dependency baseline entries | 641 | 631 |
| Browser suites | 188 | 191 (288, 289 and 380 are new) |

The steps, in merge order:
- `S` importers fell 56 to 55 at 3.8 (05r's only `S` use) and 55 to 54 at 3.14 (05c); `S` writers fell 33 to 32 at 3.8 and 32 to 31 at 3.9.
- Cycle edges went 415 to 413 at 3.9, were 412 on the base 3.13 was cut from (#430 removed the 20b → 20c edge, 413 to 412), and fell to 411 at 3.14. 3.12 and 3.13 removed no edge. The plan expected 412 at 3.9; the build has 413, because 01 still imports `12-dirty-toast.js` for the toast.
- Baseline entries the text commands resolved: 3.12 took 05-render's `state-write` entry (635 to 634, after #416 and #430 had each taken one), 3.13 took 19-writer's (634 to 633), and 3.14 took two (05c's imports of `12-dirty-toast.js` and `S`).
- `node tools/dep-report.mjs` on `391bda6` reports 631 exceptions, 0 new and 0 resolved, so `--prune` has nothing to remove.

### Where the build differs from the plan

- **Effects arrive at module evaluation, not `__init`.** Unit tests import `12-dirty-toast.js` and `07-production-tags.js` alone, and `markDirty` must still mark the document dirty. Adoption also hooks 12a's `restart()`, not only `render()`'s `trackDocument()`.
- **`EffectPort` has four members** (`dirty`, `draft`, `save`, `refresh`), not five. Undo is recorded through the `UndoPort`, so there is no history effect. There is no toast port: a view shows its toast after a command answers `rejected` with `REVIEW_ONLY`. The selector functions live in the command modules, and the session offers `read(select)`.
- **`plan` and `read(select)` get the live document typed `DocumentView`.** Only the compiler and `runConfined` stop a write inside `plan`.
- **The hide-shot grace is view state**, driven by the applied outcome (3.9).
- **A one-cell edit can move an anchor** when its comment ids change (3.6). The typing command and the paste command set `runsMoved` for it.
- **Undo and redo replay writes `S.state` outside the session** and reaches it only afterwards, through `afterUndoApplied`'s `markDirty`. The M4 to M7 re-scope (#426, Adam, 2026-10-07) gives milestone 6 the "undo/redo through the mutation boundary" criterion.
- **Recovery by assignment is published as `adopt`.** Labelling a draft restore, a history restore or a file import `recovery` would route it through `noteRemoteChange`, which keeps the undo stack, and 12a clears it today (INV-53, E4).
- **3.9's review-mode refusal has two forms.** The status lamp refuses through the command's `REVIEW_ONLY`, and the length editor from the view's `reviewMode()` check, because opening it is not a command. The click guard and `REVIEW_SAFE_ACTIONS` are unchanged (Adam's decisions on #414).
- **3.12 is not quite what 3.12 says.**
  - `S.cellRepainting` was dead (nothing set it) and is gone; the `undoApplying` guard stays.
  - A composition still stores each update at once, as 3.11 recorded, so there is no "no command until the composition ends" (Adam, #380).
  - The command is `needs: "nothing"`, because a reviewer's comment anchor is stored through it.
  - A media cell goes through the typed `SanitisedMediaHtml` variant, recorded in INV-10's row until milestone 6.
  - It changed undo on purpose, on Adam's decisions: a typing group that ends where it began is dropped, a cancelled composition leaves no step however slow it was, the redo that typing cleared comes back, and in a just-opened Writer the first Ctrl+Z closes it.
- **3.13 and 3.14 left four things alone and filed them.**
  - The Writer has no review-mode guard, so the Writer's split and join stay `needs: "nothing"` (#450).
  - A Writer split or join requests no production or b-roll refresh (#451).
  - `editCell` (05b) still writes the cell and calls `markDirty`; routing it through `cellTextCommand` would change paste's counts (#452).
  - The scene paste in `05g-scene-clip.js` still uses `recordPastedBroll` (D10).
- **3.14 changed three small things on purpose.** A paste is one accepted edit, not two (`S.editSeq` and the generation rise by one). A paste or cut whose stamp throws is atomic. Pasting a video file with no name no longer marks the script as unsaved. Its capability is `needs: "edit"`, unlike split and join.
- **Follow-ups from the three text PRs.** #436 (a slow cancelled composition over a selection) and #446 (an undo during a composition that is then cancelled) were found by 3.12's reviews and are fixed by #448, merged after 3.14 (`391bda6`); that PR records #459 as the limitation it leaves. Open: #450, #451, #452, #459 and #460 (cut, undo, paste leaves an anchor in two scenes).

### The text-command suite set

The browser suites that pin the text commands are the union of what 3.12 (#427), 3.13 (#447) and 3.14 (#455) ran, plus 186 (`186-autosave-panel-edits.txt`), which testing.md selects for a picture-or-video paste's dirty marking. That is 40 suites, matching `^(02|06|09|19|20|28|43|45|46|52|65|67|68|69|73|75|76|77|78|80|81|84|86|91|92|155|160|185|186|187|190|241|245|246|262|267|288|289|322)-`:

| Command | Suites |
| --- | --- |
| Typing (3.12) | 06, 20, 43, 52, 67, 73, 75, 76, 77, 78, 81, 84, 86, 185, 187, 289 |
| Split and join (3.13) | 06, 19, 20, 28, 43, 67, 73, 75, 76, 77, 78, 81, 84, 86, 185, 187, 246, 262 (both), 267 |
| Cut and paste (3.14) | 02, 09, 20, 43, 45, 46, 65, 67, 68, 69, 73, 75, 76, 77, 80, 81, 84, 86, 91, 92, 155, 160, 185, 186, 187, 190, 241, 245, 288, 289, 322 |

The scene commands' set is E1's. The gate runs all 191 suites, plain and frozen; this set is what a change to a text command runs while it is being written (testing.md).

### Performance

The record is the "Milestone 3 close (Windows)" section of [performance-record.md](performance-record.md), run under 3.0's conditions (same machine, browser and font) with `b1fde0f` and `391bda6` (3.14 and #448 merged) run alternately, three times each. Typing p50 and p95 differ by under 1 ms from the base (short typing p50 4 then 4.6 ms, p95 16 then 15.7; long typing p50 6.7 then 6.1, p95 16.1 then 16.9), inside the spread between runs of one build. An earlier set with the head at `c91bc4f` read the same way. No long task fired in any case in any of the six runs. 3.12 and 3.14 each measured their own change against their base as well (typing, paste and cut within the spread); 3.13 measured split and join in a 300-scene script and found no regression.

## Risks

- **Two owners during transition.** There are 14 `S.state` assignments, and every unmigrated writer bypasses the session. Adoption by identity at `render()` misses a write that lands before the render. Milestone 4's transition API closes this; 3.0 and 3.6 test each site.
- **Typing is the hot path.** A per-keystroke command adds adapter decode, a transaction and a change set. Compare `perf-record`'s typing case at 3.0 and 3.12; a material regression is investigated before merge (plan §2). Freezing is test-only (D2), so it adds no production cost.
- **Reconciliation cost against correctness.** Skipping reconciliation for one-cell edits rests on a property test. If that test fails, reconciliation runs on every edit and INV-06 needs a narrower trigger.
- **Media cells.** The typed HTML variant is a named exception to "commands accept runs", tracked to milestone 6.
- **IME and composition.** No script-cell IME suite exists until 3.11. If CDP's IME events don't reproduce a real composition, that is recorded as a platform gap, not passed.
- **Double effects.** A command plus a leftover `markDirty` would double `S.editSeq` or the autosave. (Correction from the build: suites 185 and 187 only check that each edit autosaves. `S.editSeq` is counted by `src/test/session-bridge-app.test.mjs`, `scene-effects-app.test.mjs` and the text commands' booted tests.)
- **The bridge joining the cycle.** Effects come in by injection; the gate refuses anything else.
- **Freeze-on writers.** Their number is unknown until 3.5. Each one is fixed or named, never silenced.
- **Brand churn.** Up to 76 test call sites change. Reviewers check that no assertion was weakened.
- **Lane contention.** 3.12–3.14 all reach `S.state.rows` writes and the undo adapter. 3.13 and 3.14 own disjoint files; command registration stays with the integration owner.

## The gate

On the exact merged tree, recorded in `milestone-3-gate.md`:
- **Full Windows browser run, twice (D4).** `run-tests.ps1` with 18 lanes over every suite (188 at `b1fde0f`), once plain and once with `SPLITPAGE_FREEZE_CACHES=1`. Milestone 2's single run took about 3 minutes for 181 suites ([gate record](milestone-2-gate.md)).
- **Electron smoke**, dev target. Milestone 2: 806 checks, 234 s.
- **Windows x64 packaged check**: stage, `electron-builder --win --x64`, `verify-dist.mjs --arch x64` and the packaged-x64 smoke, with `npm_config_arch=x64`. Milestone 2: build 69 s, verify 6/6, smoke 227 s.
- **External review by Codex (D7)**, stating its kind under review.md §8, of the integrated milestone, and including the text commands' undo and anchor behaviour.
- Linux full run and native ARM64 wait for the 4.0 release gate.

## Questions for Adam

None open. D8–D10 answered the last three.
