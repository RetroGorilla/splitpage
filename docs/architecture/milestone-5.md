# Milestone 5: formats consume captured data and one registry

The working notes for milestone 5 of [the implementation plan](../IMPLEMENTATION-PLAN.md#5--make-formats-consume-captured-data-and-one-registry), as amended by the [external review of the plan](milestones-4-7-rescope.md#external-review-of-milestone-5-2026-10-14). This file records what each step built. The steps themselves, their models and the gate are in the plan.

## As built

### Step 1: the remaining writers take the captured document

Merged as PR #576. Described in [saving.md](saving.md) section 6.

### Step 2, helper-move PR (PR #577): the byte helpers

Step 2 stays open. The plan splits it into small PRs in this order: capture and projection changes, mechanical helper moves, registry integration. This is the helper-move PR. A follow-up step-2 PR owns the rest, listed at the end of this section.

`zipWrite`, `zipRead`, `strBytes`, `latin1Bytes`, `concatBytes`, `xmlEscape` and `htmlToRuns` left `14-export.js` for `src/adapters/formats/`, one file per concern:

| File | Exports |
| --- | --- |
| `bytes.ts` | `strBytes`, `latin1Bytes`, `concatBytes` |
| `zip.ts` | `zipWrite`, `zipRead` |
| `xml.ts` | `xmlEscape` |
| `html-runs.ts` | `htmlToRuns` |

Behaviour is unchanged. Four details differ from a plain copy:

- `htmlToRuns` takes the HTML parser as its second argument, because an adapter may not import the legacy rich-text bridge. Only tests call it; production code reads runs through `toDocxRuns`.
- `xmlEscape` builds its control-character pattern from character codes, so the lint suppression that sat on the old regex is gone and `tools/comment-baseline.json` drops that entry.
- `zipWrite` with no day still writes 1980-01-01 and never reads the clock.
- `zipRead().get` checks for an own entry name, so a name such as `toString` or `__proto__` returns `null` where it used to reach `Object.prototype` and throw.

Importers: `15-docx.js`, `16b-xlsx.js`, `17-pdf.js`, `18-local-files.js`, `20f-desktop.js` and seven test files. `14-export.js` keeps `htmlToPlainText`, `tagPrintColor` and `TAG_PRINT_COLORS`, which are the next cut.

#### Cycle result

`node tools/dep-report.mjs --metrics`, before (`3e37ede`) and after:

| | Before | After |
| --- | --- | --- |
| Frontend modules | 178 | 182 |
| Largest frontend runtime cycle | 53 | 53 |
| Runtime cycle edges | 413 | 413 |
| Baseline exceptions | 619 | 619 |

The helper move alone does not take any writer out of the cycle, and the plan says it would not be enough. Each writer's remaining path back to itself, by the shortest route through the cycle:

| Writer | Imports that keep it in the cycle | Shortest path back |
| --- | --- | --- |
| `14b-export-kit.js` | `01-scene-status`, `07-production-tags`, `08-production-panels`, `08c-broll`, `08d-broll-panel`, `10-comments`, `14-export` | through `08-production-panels` (which imports `14b`) |
| `15-docx.js` | `01-scene-status`, `14-export`, `14b-export-kit` | `14-export` then `18-local-files`; `14b` then `08d-broll-panel` then `18-local-files` |
| `16-csv.js` | `08-production-panels`, `10-comments`, `14b-export-kit` | `08-production-panels` imports `16-csv` back; `14b` imports `08-production-panels` |
| `16b-xlsx.js` | `08-production-panels`, `08d-broll-panel`, `14-export`, `14b-export-kit`, `16-csv` | `14-export` then `18-local-files`; `08d-broll-panel` then `18-local-files` |
| `17-pdf.js` | `05-render`, `07-production-tags`, `08d-broll-panel`, `10-comments`, `14-export`, `14b-export-kit`, `15-docx` | `14-export` then `18-local-files`; `05-render` then `03-sync` then `18-local-files` |

#### Still open in step 2

A follow-up step-2 PR (capture and projection cut, before the registry) owns:

- the production, comment and b-roll read models the writers import from `05`, `07`, `08`, `08c`, `08d` and `10` reaching them through the `ExportDocument` (the `14b-export-kit.js` projection cut);
- `htmlToPlainText`, `tagPrintColor` and `TAG_PRINT_COLORS` leaving `14-export.js` for a module outside the cycle;
- explicit inputs for the presentation helpers, preferences and asset access the writers still reach for, or permitted adapters.

Only the `14-export.js` imports of `18-local-files.js` and the hosted and desktop modules are left to step 4, when the registry owns dispatch. The follow-up PR records `--metrics` and each writer's remaining path again, and the four writers leaving the cycle is its acceptance result.
