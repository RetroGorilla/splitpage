# Milestones 4 to 7: re-scope for Adam's approval

Written under [plan §2 item 8](../IMPLEMENTATION-PLAN.md#branches-and-small-changes) (Adam, 2026-10-07). Every number was measured on `4.0-development` at `9dd5079` with `node tools/dep-report.mjs`, a line count per module and grep; the gate timings come from [milestone-2-gate.md](milestone-2-gate.md). The question for each milestone: does it make the next ordinary change easier to make and verify in isolation?

**Status: draft, not approved.** Once Adam decides, plan §5 is amended by PR and this file records the decision.

## Where the branch stands

| Metric | 4.0 start | Now |
| --- | --- | --- |
| Frontend modules (migrated) | 77 (0) | 148 (71) |
| Largest runtime cycle, modules / edges | 63 / 631 | 53 / 413 |
| `S` importers / writers / `S.state` assigners | 57 / 34 / 9 | 55 / 31 / 9 |
| Baseline exceptions | 857 | 637 |

The 77 numbered modules hold 39,336 lines; 53 of them form the one cycle. The bridge is 16 files under `src/legacy/`, imported from `src/js` by 50 statements, 22 of them for `richtext.ts`, 12 for `app-actions.ts` and 6 for `session-bridge.ts`. Only two baseline exceptions involve `src/legacy/` or `src/application/`.

## Milestone 4: keep, as written

Source: nine modules, 7,390 lines, six of them in the cycle, 26 counted writes under `S.state`. `13-hosted.js` alone is 2,479 lines and holds the Drive code as well. The dispatch from a save or export kind to its builder, `buildFileData`, lives in `18-local-files.js`, and the Markdown writers and the byte helpers live in `14-export.js`.

Does it make the next ordinary change easier? Yes. Today a change to saving, drafts or recovery crosses `13-hosted`, `18-local-files`, `14-export` and `20g-drafts`, and the race matrix in the plan's gate cannot be run in isolation because the destination, generation and connection are read from `S` at the moment of the write. Nine ledger rows target this milestone (INV-20, 29, 36, 39, 40, 41, 51, 52, 62), #320 has its acceptance criterion here, and the 14 `S.state` assignment sites that bypass the session close through its transition API. Gate: the full gate, as decided.

## Milestone 5: keep, sequenced around what milestone 4 needs

**Decided by Adam, 2026-10-07: the registry stays.** He expects to change how the exports work now and to keep adjusting them, and the registry is what makes a change to a format's options and variants one edit instead of three (the dialog, the dispatch table and the menus). The milestone keeps the plan's full scope; the proposal below only fixes the order, so that the part milestone 4 depends on lands first and the registry is built on the captured document rather than before it.

Source: eight modules, 5,125 lines, all eight in the cycle, 42 `S.state` reads and one write (in `11-import.js`). The writers take no document: `15-docx`, `16-csv`, `16b-xlsx` and `17-pdf` read `S.state` for the title, rows, comments and words per minute, directly or through `exportFacts` in `14b-export-kit.js`, and read the blob registry for pictures. They are in the cycle only because they import the byte helpers back from `14-export.js`. Coverage is already strong: 12 browser suites by name, 18 by content, 13 unit test files, and INV-60 pins that an export is the same bytes all day.

Does the milestone make the next ordinary change easier? For the content of a format, a change is already local to one writer file and verified by its goldens; what makes that change safe to check in isolation is the captured document, because a writer that takes a document as input can be run on a fixed script in Node and compared byte for byte. For a format's options, variants and limits, the change today touches `buildFileData`, `18c-export-dialog.js`, `20d-formats.js` and the menu items, and the dialog reads `S.state` in 15 places to decide what to show; the registry makes that one declaration that the dialog, the menus and the command palette are drawn from. Adam expects many such changes, so both halves pass the question.

What milestone 4 needs from this area comes first: a writer must not read live state after an `await`, because a save that captures bytes while the document changes is exactly the race milestone 4 exists to close. The order:

1. **Captured document** (Opus, because it touches `14-export.js`'s save path): one frozen `ExportDocument` built from the session's document and the export options, and `exportFacts`, the four writers and the Markdown writers taking it as their argument. Rendering a captured document leaves live content unchanged (INV-57 absorbed; the plan's gate sentence stays).
2. **Byte helpers** (Sonnet): `zipWrite`, `zipRead`, `strBytes`, `latin1Bytes`, `concatBytes`, `xmlEscape` and `htmlToRuns` out of `14-export.js` into `src/adapters/formats/`, which takes the four writers out of the cycle.
3. **Import adoption** (Sonnet): decoding stays in `11-import.js`, `15-docx.js` and `16-csv.js`; adoption of the decoded rows goes through milestone 4's transition API, not through `S.state` (the one write).
4. **Format registry** (Sonnet for the registry and its tests; Opus if the dialog PR touches the save coordinator): each format declares its stable id, label, supported operations and content, options, accepted input and outcome; `buildFileData`'s dispatch table becomes the registry lookup; `18c-export-dialog.js`, the menu items and the command palette consume the declaration. Per-format limits and warnings move into the declaration. The plan's gate sentence, "adding a small test exporter requires one provider and registration", is met and tested with a throwaway exporter in the test suite.

Nothing in this milestone stays legacy, so plan §7's checklist loses nothing here. **Gate:** the full Windows run and the dev smoke (the decided lighter gate); the goldens and INV-60 are the differential for the writers, and the dialog's browser suites (`98-export-dialog`, `17-formats`, `03-exports`, `41-export-polish`, `284-exports-from-a-fixture`) are the differential for the registry.

## Milestone 6: keep, as written

Source: the six named editing modules, 4,327 lines, all in the cycle, 20 counted writes under `S.state`; plus the 53 numbered modules no milestone names, 22,350 lines, 33 of them in the cycle, with 307 `S.state` references. Eighteen ledger rows target this milestone, the most of any, and #325, #308 and #350 are dispositioned here, with the media-cell typed HTML variant from milestone 3.

Does it make the next ordinary change easier? Yes, more than any other milestone. The post-milestone-2 queue was almost entirely editor, overlay, tag and b-roll bugs, which is the code this milestone gives owners. Keep it, feature by feature as the plan says, on the commands milestone 3 proved.

**Decided by Adam, 2026-10-07: the CSS split stays a firm deliverable.** He intends to keep improving the UI, and the split into tokens, base, layout, components and feature files is what makes a visual change local: a colour or spacing change becomes one token edit, and a feature's styles move with its folder when the feature does. The split changes no behaviour, so its evidence is the plan's representative visual checks under documented font and runtime conditions, plus the deterministic aggregation order the plan requires, and it lands feature by feature alongside each feature's migration rather than as one big move at the end.

## Milestone 7: keep the contract, drop the rewrite

Source: `_entry.js` is 144 lines: 70 `__init` imports called in numbered order, generated by `tools/modularize.mjs`, then `startActions` from `src/bootstrap/actions.ts` (52 lines), which is the composition root in embryo. `PAGE_SHELL` is captured in `00-prelude.js`'s init and consumed by `02-state.js`. `build.mjs` bundles that entry, stamps `sw.js` and hashes the app script into the CSP. One ledger row targets this milestone (INV-30) and no issue does.

Does the milestone as written make the next ordinary change easier? No. A new composition root, a switched build entry, removed `S` fields and retired bridges change where the same code is wired, and the plan's own gate for it is "remaining legacy exceptions are exact and visible", which the dependency gate already enforces. The 22 importers of `richtext.ts` and the 12 of `app-actions.ts` shrink only as milestone 6 migrates their importers, so retiring the bridge is a consequence of milestone 6, not a milestone of its own.

Two parts of milestone 7 are contracts that other milestones depend on, and they stay:

- **Resource release on document or tab replacement** (plan §6: closing or replacing an owner releases its resources; failed cleanup cannot leave callbacks on a replacement session). Milestone 4's transition API opens the new epoch, and milestone 6's mount and dispose tests cover each feature, so the test that a document or tab replacement leaves no handler, timer, observer, subscription or object URL behind goes in milestone 4's gate for the session and milestone 6's for each feature.
- **No new feature depends on numbered load order.** `_entry.js` becomes the named, documented legacy initializer shim the plan already allows, with an owner per remaining module in `dependencies.md`, and a test that nothing under `src/application`, `src/features` or `src/bootstrap` imports it or registers into it. One small PR, Sonnet.

Dropped to 4.x: the new composition root as the build entry, the removal of unused `S` fields, the retirement of bridges that still have importers. `PAGE_SHELL` capture, the `sw.js` stamp and the CSP hashes stay as they are, since nothing moves them.

**Lost from plan §7's checklist:** "completed areas contain no cycles, including cycles through bridges" stays true for completed areas; the checklist adds a line that names the shim, the count of numbered modules still in it and the bridge files that remain, so the remaining legacy is described, as §1 asks, rather than declared gone.

**The 4.0 release gate** keeps everything §7 lists: the Linux full run, the ARM64 packaged check, both Docker recipes, the portable package, the 3.1 server and project exchange checks, and the external review of milestones 5 and 7 together with 6's own.

## Summary for approval

| Milestone | Proposal | Gate |
| --- | --- | --- |
| 4 | Keep as written | Full gate |
| 5 | Keep in full (Adam, 2026-10-07), in this order: captured `ExportDocument` into the writers, byte helpers into an adapter, import adoption through the transition API, then the format registry with the dialog, menus and palette drawn from it | Windows run + dev smoke |
| 6 | Keep as written, the CSS split included (Adam, 2026-10-07), with each feature's styles moving alongside its migration | Windows run + dev smoke + external review |
| 7 | Keep the resource-release tests (in 4 and 6) and the named initializer shim with its test; drop the entry switch, `S` field removal and bridge retirement to 4.x | Windows run + dev smoke; the x64 packaged check only if the build entry changes, which this proposal avoids |

If approved: plan §5's milestone 5 section gains the order above, its milestone 6 section gains the CSS bound below, its milestone 7 section is rewritten to this, §7's checklist gains the milestone 7 "lost" line, and `actions.md`'s references to a milestone 7 bootstrap are updated (its milestone 5 registry references stand).

## The CSS bound in milestone 6

`src/app.css` is one file of 7,211 lines, substituted into the page by one marker in `build.mjs`. It already defines 174 custom properties and uses them 2,247 times; 239 hex and 37 rgba/hsl colour literals, 3,752 px literals and 65 media queries remain inline. The split in 4.0 is bounded to the part that pays for UI work:

- **Colour tokens finished:** the inline colour literals become existing or new tokens, in one PR checked with screenshots under the plan's documented font and runtime conditions. Spacing stays as px.
- **Deterministic aggregation:** `build.mjs` concatenates a declared list of files in a fixed order, added with the first feature that takes its styles.
- **Per-feature files for migrated features only:** a feature's rules move into its folder when the feature does. Rules of features that stay legacy stay in `app.css`.

Deferred to 4.x: sorting the remaining rules into base, layout and components, and spacing tokens. Both are reorganisation with the cascade-order risk (equal-weight rules resolve by file order) and no behaviour change.

## Updated spec for the rest of 4.0

This section is the spec Adam asked for on 2026-10-07, in one place. Rules that apply to every PR come from plan §2 and review.md and are repeated here only where the decisions of 2026-10-07 changed them.

**Rules.**
- Sonnet by default; Opus for PRs touching state ingress or serialization, durable storage, the preload/IPC boundary, close/quit code, the merge algorithms, or the editing hot path and the undo adapter. Every review is Opus, one independent review per PR. Each milestone doc marks its PRs.
- A fail-first regression test for every bug. Characterisation-only PRs for hot paths and multi-file moves; a small move carries its own characterisation tests in its first commit, with the base sha they passed on in the PR body.
- The dependency and comment gates, review.md §2 (where bugs get fixed) and §5 (extra verification by risk), the base-merge rule and the CHANGELOG-in-one-docs-PR rule are unchanged.
- Gates: milestones 3 and 4 full (two Windows runs, freeze off and on; dev smoke; x64 packaged check; external review). From milestone 5: the full Windows run (freeze off and on, since both take about 3 minutes) and the dev smoke; milestone 6 adds the external review; the x64 packaged check returns only if packaging inputs move. The 4.0 release gate is plan §7 in full.
- An as-built doc for each new owner lands as its own docs PR when the owner's first commands exist; the milestone's closing PR revises it.

**Milestone 3, remainder.** 3.12 typing (Opus, running), then 3.13 split/join and 3.14 cut/paste in parallel (Sonnet; a PR that must change the undo adapter becomes Opus), then 3.15 (Sonnet: revise `session.md`, this doc's as-built section with `--metrics` and `--prune`, ledger rows INV-02 part, 06, 07, 10, 17, 18, 53 and 55 with `HANDOFF.md` pointers, pinned-defects rows, the perf rerun, and the corrections to milestone-3.md that `session.md` and PR #423's review found). Then the gate as milestone-3.md states it, with its record as a separate docs PR.

**Milestone 4, as written, plus one test.** Per-destination confirmed generations and baselines; the operation context captured before serialization, blob transfer or any other await; writes serialized per destination with the transport instance owning the operation; one transition API for open, new, restore and publish adoption, which closes the nine modules that assign `S.state` outside the session; identity and fork rules preserved; collaboration behind application interfaces; recovery split into capture scheduling, store adapters, writer ownership and restore policy; the blob registry into a store adapter with byte ownership; #320 measured against `d18adde` and trimmed if over 10%. Added from milestone 7: the test that a document or tab replacement leaves no session-level handler, timer, observer, subscription or object URL behind. Gate: the full gate and the plan's race matrix. Mostly Opus by the rule.

**Milestone 5, in full, in this order.** (1) The captured `ExportDocument` into `exportFacts`, the four writers and the Markdown writers (Opus). (2) The byte helpers out of `14-export.js` into `src/adapters/formats/`, taking the four writers out of the cycle (Sonnet). (3) Import decoding unchanged, adoption of decoded rows through the transition API (Sonnet). (4) The format registry: stable id, label, supported operations and content, options, accepted input, outcome, limits and warnings per format; `buildFileData`'s table becomes the lookup; the export dialog, menus and command palette are drawn from it; a throwaway test exporter proves one provider and one registration suffice (Sonnet, Opus if the save coordinator is touched). Gate: Windows run and dev smoke; goldens and INV-60 are the writers' differential, the export suites the dialog's.

**Milestone 6, as written, with the CSS bound above.** One feature at a time through the commands, selectors and ports milestone 3 proved: the remaining editor paths in `05-render.js`, `05b`, `05c`, `06-rows.js` and `19-writer.js` (Opus, the hot path); `21-events.js` delegation moved only as each receiving owner exists, then deleted; tags and b-roll (`07`, `08`, `08c`, `08d`), comments (`10`), find (`09`), panels, settings, gallery and prompter views (Sonnet where the move is well specified). Render-time repair removed (#325), #308 and #350 fixed in their owners, the media-cell typed HTML variant resolved. Overlay and focus ownership. Each feature owns mount and dispose, with the per-feature resource-release test from milestone 7. CSS: colour tokens, aggregation, per-feature files for migrated features. Gate: Windows run, dev smoke, external review.

**Milestone 7, narrowed (Adam's confirmation pending).** `_entry.js` named as the documented legacy initializer shim with an owner per remaining module in `dependencies.md`, and a test that nothing under `src/application`, `src/features` or `src/bootstrap` imports or registers into it (one Sonnet PR). Plan §7's checklist gains the line naming the shim, the count of numbered modules in it and the bridge files that remain. No entry switch, no `S` field removal, no bridge retirement in 4.0.

**4.0 release gate.** Plan §7 in full: the Linux full run, the native ARM64 packaged check, both Docker recipes and the portable package, the 3.1 server and project exchange checks, the x64 packaged check, and the external review covering milestones 5 and 7 together with 6's own.

**4.x, in this order.** The composition root and build-entry switch as the first 4.x milestone, with the packaged check and an external review of its own; bridge retirement as importers disappear; unused `S` fields; CSS base, layout and components, then spacing tokens; server and desktop service extraction (plan §8); the parked enhancement issues, decided per issue by the integration owner.
