# Pinned and deferred defects

Every known defect that a test pins as it is, or that work up to and including
milestone 2 found and deferred, with its disposition. This is the fourth
commitment of the milestone 2 external review
([gate record](milestone-2-gate.md#external-review)). The rows cover:

- the issues the milestone 1 and 2 reviews filed;
- every "Found, not changed", "Found, not fixed" and "Left open" item in
  [milestone-2.md](milestone-2.md);
- the issues filed while fixing those on the closed 3.1.x branches.

Adam approved these dispositions and the milestone assignments on 2026-10-01.
He may change any of them later.

**How a fix lands.** Bug fixes go to `4.0-development` only. No 3.1.x release
is planned, and `3.1.x-development` takes no more fixes
([review.md §2](review.md#2-where-bugs-get-fixed)). Each fix is its own PR,
in the module that now owns the code, with a regression test written to fail
first. A test that pins the old behaviour changes in that PR, on purpose. A
golden that changes is regenerated in a dedicated commit on
`4.0-development` that changes nothing else
([milestone-2.md, Characterisation](milestone-2.md#characterisation-20)). The
closed 3.1.x branches hold fixes and fail-first tests to port from:
`fix/274-overlay-commands`, `fix/276-save-during-load`,
`fix/278-290-ids-and-nested-links`, `fix/280-282-anchor-tags-and-cue-retitle`
and `fix/281-283-md-null-href-and-person-merge`.

**Dispositions.**
- **Post-M2 queue:** fix after milestone 2, in its own PR.
- **Fixed by #N:** the PR merged into `4.0-development`. The issue may still show as open on GitHub, because the base is not the default branch and a merge there does not close it.
- **Milestone N:** fix there, for the reason given.
- **Won't fix:** by design, or not reachable, for the reason given. No issue is filed for these. The row records the behaviour so that a change is deliberate.
- **Needs Adam's decision:** a product decision comes first.

"Golden" in a row means the fix regenerates that golden. Where a row names
none, no golden is expected to change.

## Core text and undo

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| Unicode editing: positions count UTF-16 code units, so an edit inside a surrogate pair splits it into lone surrogates | #322 | Nothing asserts the split. `tests/core/text/edits.test.ts` ("split and join are inverses at every position, inside a surrogate pair too…") splits inside a pair, but checks only the join | `src/core/text/edits.ts` | Fixed by #341: no cell edit leaves half a surrogate pair. Names are still cut by UTF-16 unit, which #344 tracks |
| Undo key order: `applySteps` compares rows as JSON text. An inverse step that restores a removed field puts it last, so the inverse `deleteRow` is refused. No user effect today: `12a-undo.js` falls back to a copy | #323 | `tests/core/text/steps.test.ts` ("today the inverse of an insertRow is refused once a field removed from that row has been put back, last") | `src/core/text/steps.ts` | Milestone 3, because its undo adapter behind `DocumentSession` makes `applySteps` a path that undo depends on |
| A cue line split before its colon leaves neither half a cue, and joining does not restore the mark | none | `tests/core/text/cues.test.ts` ("a split before a cue's colon loses the cue on both sides…") | `src/core/text/cues.ts`, `edits.ts`, `runs.ts` (`settleCues`) | Won't fix, by design. Typing a line's colon, or an import, makes a cue. Normalising spreads a cue across a line that still reads as one and removes it from a line that does not, but never adds one, so a join that brings the words back makes no cue. Split after the colon, the cue survives |

## Core merge and migration

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| `mergeStates` writes into its own `mine` and `theirs`: merged comments share reply objects with the inputs, and `migrateRows` then writes into them | #303 | `tests/core/merge/rows.test.ts`, `tests/core/merge-states.test.ts`, `src/test/merge-states.test.mjs` (three tests: two have "pinned" in their names, and the third is the `tests/core/merge-states.test.ts` test "today's reply aliasing…") | `src/core/merge/rows.ts` (`mergeComments`) | Fixed by #335: a merge writes into none of its inputs. Every merge golden records `inputsUntouched: true` (its inputs are already migrated), so none changes. The plan's milestone 3 cached-results criterion then tests that no merge writes into its inputs |
| `mergeStates` throws a `TypeError` on an unmigrated side with a list that is not an array, or with items that are not objects | #304 | Nothing; the differential fuzz saw it | `src/core/merge/lists.ts`, `rows.ts`, `states.ts`; the caller `applyMerge` in `src/js/03-sync.js` | Fixed by #340: a list of the wrong shape is normalised instead of throwing. Milestone 3's validated document type then makes an unmigrated side a type error |
| Ids such as `__proto__` or `constructor` break the id maps in merge and migration. This includes the 2.3 finding: a row with such an id that one side lacks merges with an `undefined` status until `migrateRows` resets it | #278 | Goldens `merge-prototype-ids-*.json` (eight files); the "(#278)" tests in `tests/core/merge/rows.test.ts` and `lists.test.ts` | `src/core/merge/rows.ts` and `lists.ts` (`byId` and the id maps), `src/core/document/text-policy.ts` (`safeId`) | Fixed by #337, ported from `fix/278-290-ids-and-nested-links`. Golden: six of the eight merge prototype-id files changed (`rows-deleted-by-mine`, `rows-added-on-each-side`, `comments`, `people`, `tags` and `shots`). `rows-deleted-by-theirs` and `rows-edited-on-each-side` were already right |
| The same `{}` id maps outside merge: undo records deleting the scene `constructor` as a field change, and view modules key maps by ids | #311 | Nothing on 4.0 | `src/js/12a-undo.js` (`diffStates`, `applyStepsLive`, `changedBetween`) and the view modules the issue lists | Fixed by #349, after #278, using its prototype-less `idMap` and set of reserved ids. #354 tracks the gear quick add, which the PR leaves alone |
| Both sides adding the same person drops the owner of my items | #283 | Golden `merge-people-each-side.json` | `src/core/merge/lists.ts` (`mergePeople`) | Fixed by #339, ported from `fix/281-283-md-null-href-and-person-merge`. Golden: `merge-people-each-side.json`. #353 tracks two follow-ups |
| A `list-union-with-base` field with no `LIST_MERGERS` entry throws `TypeError: listMerger(...) is not a function`, not "no merge strategy" | none | Nothing | `src/core/merge/states.ts` | Won't fix. Only a developer adding a list field reaches it, and `src/test/state-fields.test.mjs` already fails for a list field with no merger |
| A field table without `productionTags` makes the merge throw | none | Nothing | `src/core/merge/states.ts` | Won't fix, by design. `productionTags` is a schema field every migrated document has. Only a hand-built table can leave it out |

## Production: tags and b-roll

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| B-roll anchor/comment loss: a b-roll key that a comment covers reads as a typed marker with no id, and anchoring replaces it with a fresh key, dropping the comment | #324 | `tests/core/production/broll.test.ts` ("a key carrying a comment reads as a typed marker, with no id"; "anchoring turns … a commented key into a fresh key") | `src/core/production/broll.ts` (the line readers, `anchorBrollCell`) | Fixed by #336: a key that only a comment covers reads as a key, and anchoring keeps its comment. No production golden holds a commented key, so only the two core tests changed. #348 tracks the forms it does not cover |
| Cue retitling pairs the cues that went and came by position, so deleting one cue and editing another renames the wrong item | #282 | Golden `production-cue-retitle.json` (`twoCuesInOneCell`); `tests/core/production/tags.test.ts` ("…(#282, kept as found)") | `src/core/production/tags.ts` (`planRegistryHealing`) | Fixed by #333, ported from `fix/280-282-anchor-tags-and-cue-retitle`. Golden: `production-cue-retitle.json` |
| After #282's fix, retitling still pairs by order when as many names went as came, so losing, gaining and editing cues in one go mispairs them | #294 | Nothing on 4.0 | `src/core/production/tags.ts` | Post-M2 queue: approved, fix pending. Adam approved the proposed fix on 2026-10-02. It stops find-and-replace across several cues in one cell from renaming their items |
| `registerProductionTag` accepts a blank tag name | #298 | Nothing | `src/core/production/tags.ts` (`newRegistryTag`), `src/js/07-production-tags.js` | Fixed by #338: core refuses a name that is empty, whitespace or only invisible characters. Callers could pass names of zero-width characters only, so the label composer, plain tag closer, auto-tag and bulk tag use the same test |
| Deleting a person leaves their id as the owner of their b-roll shots until the next load | #305 | Nothing | `src/js/07-production-tags.js` (`deletePerson`) | Fixed by #346: deleting a person clears them as the owner of their b-roll shots at once |
| After a heal, the cached core production index keeps the old ids, while `productionEntries()` shows the new ones. Nothing reads them yet | #326 | `src/test/production-shims.test.mjs` ("after a heal the cached core index keeps the ids it was derived with…") | `src/js/07-production-tags.js` (`healTagRegistry`, the index cache) | Milestone 3, under the plan's cached-results criterion: the index's owner keeps both views in step |
| Reads that repair: drawing the b-roll badge creates and renames shots, and every save heals the registry and repairs shots first | #325 | `src/test/production-shims.test.mjs`, `src/test/broll-id-sequence.test.mjs` (both fail if `brollEntries()` stops repairing) | `src/js/08c-broll.js` (the badge), `src/js/14-export.js` (`settleDerivedRecords`) | Milestone 6, because the plan removes render-time repair there. The repairs move to ingestion, milestone 3's commands and milestone 4's save coordinator |

## Rich text adapter

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| A span that is both a comment anchor and a tag loses its comment. The same golden case shows a span that is both a b-roll key and a comment anchor losing its comment too (comment on the issue) | #280 | Richtext golden, case "one span, two special classes" | `src/adapters/richtext/sanitize.ts` | Fixed by #330, ported from `fix/280-282-anchor-tags-and-cue-retitle`, both spans in one PR. Golden: `richtext-golden.json` |
| Markdown export writes `(null)` for a link with no `href` | #281 | Richtext golden, cases "links: other schemes" and "video card: unsafe href" (`markdownOfInput`) | `src/adapters/richtext/markdown.ts` | Fixed by #334, ported from `fix/281-283-md-null-href-and-person-merge`. Golden: `richtext-golden.json` |
| Sanitising is not a fixed point for nested links (INV-10) | #290 | Nothing; fuzzing found 58 of 111,800 cases | `src/adapters/richtext/sanitize.ts` | Fixed by #342, ported from `fix/278-290-ids-and-nested-links`: a link inside a link splits the outer link around it. Golden: `richtext-golden.json`, two new cases. #355 tracks the output size on deeply nested formatting |
| `storedHtmlFromDom` keeps an image attribute named `constructor` or `__proto__`. Neither can carry script, and sanitising drops both | #311 (comment) | Nothing | `src/adapters/richtext/richtext.ts` (`STORED_IMG_ATTRS`) | Fixed by #349, in #311's PR: `STORED_IMG_ATTRS` is a `Set` |
| Stored-form quirks. `storedHtmlFromDom` looks for `data-blob` case-sensitively before it parses. An `is` attribute that was removed from a picture comes back when the picture is serialised | none | Nothing | `src/adapters/richtext/richtext.ts` | Won't fix: no cell reaches them. Every caller passes a live cell's `innerHTML`, which writes attribute names in lower case, and the sanitiser builds fresh elements that have no `is` value |
| INV-10's check that no module outside `src/adapters/richtext/` builds cells from HTML is not written | #327 | Not applicable | `tools/dep-report.mjs` | Fixed by #347: the `html-cells` rule in `tools/dep-report.mjs` |

## Actions, desktop and Present

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| Desktop menu commands still act behind the writer, Present, the shot-list page and the tour | #274 | Nothing on 4.0; the fail-first suite is on `fix/274-overlay-commands` | `src/legacy/screen.ts` and the action definitions in `src/legacy/*-actions.ts` (availability) | Fixed by #343: ported into the registry's availability rules, as one "which overlay is on top" read model. #352 tracks the follow-ups |
| Save from its buttons or the desktop menu during load throws on a null document | #276 | `tests/legacy/while-loading.test.ts` ("while loading, Save is refused from every surface with the File menu's wording"); the `save` row of [actions.md](actions.md)'s kept differences, now removed | `src/legacy/file-actions.ts` (`save`) | Fixed by #332, ported from `fix/276-save-during-load`. The test and the actions.md row changed on purpose |
| The Production and Gear refusals read `Still loading...` with three full stops; every other refusal uses `…` | #295 | `tests/legacy/while-loading.test.ts` ("while loading, each panel button that waits refuses with the one wording and the B-roll button does not wait"); [actions.md](actions.md) | `src/legacy/view-actions.ts` | Fixed by #332, with #276: the same wording everywhere, guarded by `tests/legacy/still-loading-wording.test.ts` |
| Dialogs open under the tour, and a second dialog opens over an open one, from the desktop menu | #307 | Nothing | Registry availability, and the capture-phase listeners in `20c-help.js`, `20e-connect.js`, `20s-settings.js` and `20b-onboarding.js` | Fixed by #351, after #274, in the same availability rules |
| Refusal toasts are invisible in fullscreen Present, and repeated ones stack | #308 | Nothing | `src/js/12-dirty-toast.js` (`showToast`, `#toast-host`) | Milestone 6, because overlay and stacking ownership (INV-19) arrives there and decides where the toast host lives |
| Ctrl+F in Present flips the prompter: its letter shortcuts ignore modifiers | #309 | [actions.md](actions.md) records it as a kept overlap | `src/js/21-events.js` (Present's `keydown` listener) | Fixed by #331. The actions.md note records the fix. #350 tracks the Find bar opening invisibly behind the prompter |

## Tests and tooling

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| The `xlsx-export` same-bytes test flakes across a 2-second zip timestamp boundary | #297 | It is the flaky test: `src/test/xlsx-export.test.mjs` ("two exports of one script are the same bytes") | `src/test/xlsx-export.test.mjs`; the zip time in `src/js/14-export.js` | Fixed by #329: the test pins the clock |
| `24-history.txt`'s quota toast check races the toast's lifetime | #293 | Not applicable | The 3.1.x copy of the suite | Close: fixed on 4.0 by #292 (24-history). #292 ("run-tests.ps1 picks its lane count from the machine's logical processors") changed the check in `24-history.txt` (107665c): a `MutationObserver` on `#toast-host` records every warn toast, and the case expects exactly one. The same PR also changed `69-html-images.txt` (d1f0b4d), which waits for its pictures to reach IndexedDB before stashing; that is a different flake and not part of #293. The 3.1.x copy stays as it is, because 3.1.x takes no more fixes |
| A suite's static server sometimes fails to start, and the summary miscounts that suite | #299 | Nothing | `.claude/skills/run-splitpage-app/driver.ps1`, `tools/run-suites.mjs` | Fixed by #345: the start is retried, and a suite that could not start counts as a failed check |

## Performance

| Item | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| Image ingestion hashes each picture twice and may copy its bytes twice. The review's probe was slower on milestone 2, but it was not a controlled browser benchmark | #320 | Not applicable | `src/core/document/media.ts`, `src/legacy/document-ports.ts`, `src/js/02c-blobs.js` | Milestone 4, where the blob registry moves into a store adapter. Measure first, as the plan's milestone 4 criterion sets out |

## Filed during the queue

Defects found while fixing the rows above, each filed as its own issue:

- #344: tag and person names are cut by UTF-16 unit and can keep half an emoji.
- #348: b-roll keys still lose their comment: formatted keys, typed markers, and panel rename.
- #350: Ctrl+F in Present opens the Find bar invisibly behind the prompter.
- #352: overlay follow-ups: the tour starts over overlays, app data import and export, and manual dialog checks.
- #353: owner follow-ups: undo replay drops same-named people, and a deleted owner beats the other side's assignment.
- #354: Gear quick add ignores names like `constructor` and `__proto__`, and tag suggestions skip `__proto__`.
- #355: the sanitiser's output size blows up on deeply nested formatting around many inner links.

## Not in this table

- #302 is a test gap, not a defect: two b-roll id draws that no test pins. It stays in the post-M2 queue as a tests-only PR.
- The open product bugs #238, #239, #246, #258, #259 and #262 were not pinned or deferred by the refactor. They follow [review.md §2](review.md#2-where-bugs-get-fixed) like any other bug.
