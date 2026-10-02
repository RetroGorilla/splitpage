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
- **Milestone N:** fix there, for the reason given.
- **Won't fix:** by design, or not reachable, for the reason given. No issue is filed for these. The row records the behaviour so that a change is deliberate.
- **Needs Adam's decision:** a product decision comes first.

"Golden" in a row means the fix regenerates that golden. Where a row names
none, no golden is expected to change.

## Core text and undo

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| Unicode editing: positions count UTF-16 code units, so an edit inside a surrogate pair splits it into lone surrogates | #322 | Nothing asserts the split. `tests/core/text/edits.test.ts` ("split and join are inverses at every position, inside a surrogate pair too…") splits inside a pair, but checks only the join | `src/core/text/edits.ts` | Post-M2 queue. A core fix: a position inside a pair moves to a code-point boundary, or the edit is refused |
| Undo key order: `applySteps` compares rows as JSON text. An inverse step that restores a removed field puts it last, so the inverse `deleteRow` is refused. No user effect today: `12a-undo.js` falls back to a copy | #323 | `tests/core/text/steps.test.ts` ("today the inverse of an insertRow is refused once a field removed from that row has been put back, last") | `src/core/text/steps.ts` | Milestone 3, because its undo adapter behind `DocumentSession` makes `applySteps` a path that undo depends on |
| A cue line split before its colon leaves neither half a cue, and joining does not restore the mark | none | `tests/core/text/cues.test.ts` ("a split before a cue's colon loses the cue on both sides…") | `src/core/text/cues.ts`, `edits.ts`, `runs.ts` (`settleCues`) | Won't fix, by design. Typing a line's colon, or an import, makes a cue. Normalising spreads a cue across a line that still reads as one and removes it from a line that does not, but never adds one, so a join that brings the words back makes no cue. Split after the colon, the cue survives |

## Core merge and migration

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| `mergeStates` writes into its own `mine` and `theirs`: merged comments share reply objects with the inputs, and `migrateRows` then writes into them | #303 | `tests/core/merge/rows.test.ts`, `tests/core/merge-states.test.ts`, `src/test/merge-states.test.mjs` (three tests: two have "pinned" in their names, and the third is the `tests/core/merge-states.test.ts` test "today's reply aliasing…") | `src/core/merge/rows.ts` (`mergeComments`) | Post-M2 queue. Every merge golden records `inputsUntouched: true` (its inputs are already migrated), so none changes. The plan's milestone 3 cached-results criterion then tests that no merge writes into its inputs |
| `mergeStates` throws a `TypeError` on an unmigrated side with a list that is not an array, or with items that are not objects | #304 | Nothing; the differential fuzz saw it | `src/core/merge/lists.ts`, `rows.ts`, `states.ts`; the caller `applyMerge` in `src/js/03-sync.js` | Post-M2 queue. Milestone 3's validated document type then makes an unmigrated side a type error |
| Ids such as `__proto__` or `constructor` break the id maps in merge and migration. This includes the 2.3 finding: a row with such an id that one side lacks merges with an `undefined` status until `migrateRows` resets it | #278 | Goldens `merge-prototype-ids-*.json` (eight files); the "(#278)" tests in `tests/core/merge/rows.test.ts` and `lists.test.ts` | `src/core/merge/rows.ts` and `lists.ts` (`byId` and the id maps), `src/core/document/text-policy.ts` (`safeId`) | Post-M2 queue, ported from `fix/278-290-ids-and-nested-links`. Golden: the eight merge prototype-id files |
| The same `{}` id maps outside merge: undo records deleting the scene `constructor` as a field change, and view modules key maps by ids | #311 | Nothing on 4.0 | `src/js/12a-undo.js` (`diffStates`, `applyStepsLive`, `changedBetween`) and the view modules the issue lists | Post-M2 queue, after #278, using its set of reserved ids |
| Both sides adding the same person drops the owner of my items | #283 | Golden `merge-people-each-side.json` | `src/core/merge/lists.ts` (`mergePeople`) | Post-M2 queue, ported from `fix/281-283-md-null-href-and-person-merge`. Golden: `merge-people-each-side.json` |
| A `list-union-with-base` field with no `LIST_MERGERS` entry throws `TypeError: listMerger(...) is not a function`, not "no merge strategy" | none | Nothing | `src/core/merge/states.ts` | Won't fix. Only a developer adding a list field reaches it, and `src/test/state-fields.test.mjs` already fails for a list field with no merger |
| A field table without `productionTags` makes the merge throw | none | Nothing | `src/core/merge/states.ts` | Won't fix, by design. `productionTags` is a schema field every migrated document has. Only a hand-built table can leave it out |

## Production: tags and b-roll

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| B-roll anchor/comment loss: a b-roll key that a comment covers reads as a typed marker with no id, and anchoring replaces it with a fresh key, dropping the comment | #324 | `tests/core/production/broll.test.ts` ("a key carrying a comment reads as a typed marker, with no id"; "anchoring turns … a commented key into a fresh key") | `src/core/production/broll.ts` (the line readers, `anchorBrollCell`) | Post-M2 queue. No production golden holds a commented key, so only the two core tests change |
| Cue retitling pairs the cues that went and came by position, so deleting one cue and editing another renames the wrong item | #282 | Golden `production-cue-retitle.json` (`twoCuesInOneCell`); `tests/core/production/tags.test.ts` ("…(#282, kept as found)") | `src/core/production/tags.ts` (`planRegistryHealing`) | Post-M2 queue, ported from `fix/280-282-anchor-tags-and-cue-retitle`. Golden: `production-cue-retitle.json` |
| After #282's fix, retitling still pairs by order when as many names went as came, so losing, gaining and editing cues in one go mispairs them | #294 | Nothing on 4.0 | `src/core/production/tags.ts` | Needs Adam's decision. The proposed fix stops find-and-replace across several cues in one cell from renaming their items |
| `registerProductionTag` accepts a blank tag name | #298 | Nothing | `src/core/production/tags.ts` (`newRegistryTag`), `src/js/07-production-tags.js` | Post-M2 queue. First check whether any caller can pass a blank name, then refuse it in core |
| Deleting a person leaves their id as the owner of their b-roll shots until the next load | #305 | Nothing | `src/js/07-production-tags.js` (`deletePerson`) | Post-M2 queue |
| After a heal, the cached core production index keeps the old ids, while `productionEntries()` shows the new ones. Nothing reads them yet | #326 | `src/test/production-shims.test.mjs` ("after a heal the cached core index keeps the ids it was derived with…") | `src/js/07-production-tags.js` (`healTagRegistry`, the index cache) | Milestone 3, under the plan's cached-results criterion: the index's owner keeps both views in step |
| Reads that repair: drawing the b-roll badge creates and renames shots, and every save heals the registry and repairs shots first | #325 | `src/test/production-shims.test.mjs`, `src/test/broll-id-sequence.test.mjs` (both fail if `brollEntries()` stops repairing) | `src/js/08c-broll.js` (the badge), `src/js/14-export.js` (`settleDerivedRecords`) | Milestone 6, because the plan removes render-time repair there. The repairs move to ingestion, milestone 3's commands and milestone 4's save coordinator |

## Rich text adapter

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| A span that is both a comment anchor and a tag loses its comment. The same golden case shows a span that is both a b-roll key and a comment anchor losing its comment too (comment on the issue) | #280 | Richtext golden, case "one span, two special classes" | `src/adapters/richtext/sanitize.ts` | Post-M2 queue, ported from `fix/280-282-anchor-tags-and-cue-retitle`, both spans in one PR. Golden: `richtext-golden.json` |
| Markdown export writes `(null)` for a link with no `href` | #281 | Richtext golden, cases "links: other schemes" and "links: javascript" (`markdownOfInput`) | `src/adapters/richtext/markdown.ts` | Post-M2 queue, ported from `fix/281-283-md-null-href-and-person-merge`. Golden: `richtext-golden.json` |
| Sanitising is not a fixed point for nested links (INV-10) | #290 | Nothing; fuzzing found 58 of 111,800 cases | `src/adapters/richtext/sanitize.ts` | Post-M2 queue, ported from `fix/278-290-ids-and-nested-links`. Golden: `richtext-golden.json`, if any case changes |
| `storedHtmlFromDom` keeps an image attribute named `constructor` or `__proto__`. Neither can carry script, and sanitising drops both | #311 (comment) | Nothing | `src/adapters/richtext/richtext.ts` (`STORED_IMG_ATTRS`) | Post-M2 queue, in #311's PR: the same `{}`-map class |
| Stored-form quirks. `storedHtmlFromDom` looks for `data-blob` case-sensitively before it parses. An `is` attribute that was removed from a picture comes back when the picture is serialised | none | Nothing | `src/adapters/richtext/richtext.ts` | Won't fix: no cell reaches them. Every caller passes a live cell's `innerHTML`, which writes attribute names in lower case, and the sanitiser builds fresh elements that have no `is` value |
| INV-10's check that no module outside `src/adapters/richtext/` builds cells from HTML is not written | #327 | Not applicable | `tools/dep-report.mjs` | Post-M2 queue, after #321, which changed the same tool and has merged |

## Actions, desktop and Present

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| Desktop menu commands still act behind the writer, Present, the shot-list page and the tour | #274 | Nothing on 4.0; the fail-first suite is on `fix/274-overlay-commands` | `src/legacy/screen.ts` and the action definitions in `src/legacy/*-actions.ts` (availability) | Post-M2 queue. Ported into the registry's availability rules, as one "which overlay is on top" read model |
| Save from its buttons or the desktop menu during load throws on a null document | #276 | `tests/legacy/while-loading.test.ts` ("while loading, Save from its buttons and the desktop menu runs, and only Ctrl+S waits, as in 3.1"); the `save` row of [actions.md](actions.md)'s kept differences | `src/legacy/file-actions.ts` (`save`) | Post-M2 queue, ported from `fix/276-save-during-load`. The test and the actions.md row change on purpose |
| The Production and Gear refusals read `Still loading...` with three full stops; every other refusal uses `…` | #295 | `tests/legacy/while-loading.test.ts` ("while loading, each panel button answers as its own 3.1 handler did"); [actions.md](actions.md) | `src/legacy/view-actions.ts` | Post-M2 queue, with #276: one string for every "still loading" refusal |
| Dialogs open under the tour, and a second dialog opens over an open one, from the desktop menu | #307 | Nothing | Registry availability, and the capture-phase listeners in `20c-help.js`, `20e-connect.js`, `20s-settings.js` and `20b-onboarding.js` | Post-M2 queue, after #274, in the same availability rules |
| Refusal toasts are invisible in fullscreen Present, and repeated ones stack | #308 | Nothing | `src/js/12-dirty-toast.js` (`showToast`, `#toast-host`) | Milestone 6, because overlay and stacking ownership (INV-19) arrives there and decides where the toast host lives |
| Ctrl+F in Present flips the prompter: its letter shortcuts ignore modifiers | #309 | [actions.md](actions.md) records it as a kept overlap | `src/js/21-events.js` (Present's `keydown` listener) | Post-M2 queue. The actions.md note changes with the fix |

## Tests and tooling

| Defect | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| The `xlsx-export` same-bytes test flakes across a 2-second zip timestamp boundary | #297 | It is the flaky test: `src/test/xlsx-export.test.mjs` ("two exports of one script are the same bytes") | `src/test/xlsx-export.test.mjs`; the zip time in `src/js/14-export.js` | Post-M2 queue: the test pins the clock |
| `24-history.txt`'s quota toast check races the toast's lifetime | #293 | Not applicable | The 3.1.x copy of the suite | Close: fixed on 4.0 by #292 (24-history). #292 ("run-tests.ps1 picks its lane count from the machine's logical processors") changed the check in `24-history.txt` (107665c): a `MutationObserver` on `#toast-host` records every warn toast, and the case expects exactly one. The same PR also changed `69-html-images.txt` (d1f0b4d), which waits for its pictures to reach IndexedDB before stashing; that is a different flake and not part of #293. The 3.1.x copy stays as it is, because 3.1.x takes no more fixes |
| A suite's static server sometimes fails to start, and the summary miscounts that suite | #299 | Nothing | `.claude/skills/run-splitpage-app/driver.ps1`, `tools/run-suites.mjs` | Post-M2 queue. Retry the start, and count a suite that could not start |

## Performance

| Item | Issue | Pinned by | Owner on 4.0 | Disposition |
| --- | --- | --- | --- | --- |
| Image ingestion hashes each picture twice and may copy its bytes twice. The review's probe was slower on milestone 2, but it was not a controlled browser benchmark | #320 | Not applicable | `src/core/document/media.ts`, `src/legacy/document-ports.ts`, `src/js/02c-blobs.js` | Milestone 4, where the blob registry moves into a store adapter. Measure first, as the plan's milestone 4 criterion sets out |

## Not in this table

- #302 is a test gap, not a defect: two b-roll id draws that no test pins. It stays in the post-M2 queue as a tests-only PR.
- The open product bugs #238, #239, #246, #258, #259 and #262 were not pinned or deferred by the refactor. They follow [review.md §2](review.md#2-where-bugs-get-fixed) like any other bug.
