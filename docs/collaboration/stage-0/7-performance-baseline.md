# Stage 0 audit 7: performance baseline, tolerance and provisional limits

The standalone performance baseline that shared-mode results are judged against, with the tolerated regression, the noise treatment and the provisional limits fixed before any prototype number exists (plan [section 12](../../COLLABORATION-PLAN.md), item 7).

Audited against `main` at `0ca1929177ffc84bced412ad2be3aa99690761d0`. The recorder additions are in the same PR (`tools/perf-record.mjs`). The five full runs used branch commit `0ed0c19d772a36d3e30d6fb718b3cb4885015248`; the one re-measured row (section 4, heap) used the recorder as it stands in this PR, which differs from `0ed0c19d` only in reading free memory first and averaging an even sample count. `src/`, `build.mjs` and the driver are unchanged on `main` since the audited commit, so the build measured is the build on `main` today.

Every row below is tagged `PERF` plus the Stage 1 tags it bounds ("Serves"). Numbers are the **median of 5 runs, with the min-max range across the runs in brackets**. No single run is reported.

## 1. Conditions

| Item | Value |
| --- | --- |
| Date, time | 2026-11-09, five runs back to back 14:44 to 14:55 local, each about 2 min 20 s |
| Machine | AMD Ryzen 9 9950X3D2 16-Core, 32 threads, 30.9 GB RAM |
| OS | Windows 11 Pro 10.0.26300 x64 |
| Node | v24.22.1 (repository pin) |
| Browser | Microsoft Edge headless, `HeadlessChrome/157.0.0.0 ... Edg/157.0.0.0`, viewport 1400x900 at 1x, GPU disabled by the driver. Edge is not the browser of the older records in [performance-record.md](../../architecture/performance-record.md) (154 and 155), so compare with those only roughly |
| Browser flags | The driver's defaults. The three new fixtures (section 2) add `--enable-precise-memory-info --js-flags=--expose-gc`; the existing fixtures do not |
| Fonts | `"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", Verdana, sans-serif`; Atkinson Hyperlegible Next is installed and drew the text (checked by the recorder) |
| Build | `node build.mjs --test` (test hooks present), served by the driver's static server on ports 18990 and 19990 |
| Locks | `perf` and `smoke` held through `tools/with-lock.ps1` for every run, so no other lane's browser or suite ran during them |
| Free RAM before each run | 4.8, 5.5, 5.0, 5.0 and 5.1 GB for the five full runs, read by the run script just before each run (Windows free physical memory). The recorder's own "free memory" line in those five reports was read after the run, not before, so it is not quoted here; the recorder now reads it before any work. This is low for a 31 GB machine: Windows memory compression held about 3.7 GB, around 50 Firefox processes and 15 to 17 `node` processes of other lanes were alive, and Defender (`MsMpEng`) was resident. No `msedge` process existed before any run |
| CPU busy, second before / after each run | 15/6, 9/6, 7/19, 14/14 and 12/12 % |
| Other things running | Other agent sessions (15 to 17 Claude processes, node processes), a ChatGPT app, Firefox. Not a quiet machine, and not controlled beyond the locks |
| Fixture counts | Section 3 |

## 2. What the recorder measures now

| Item | Status | Serves |
| --- | --- | --- |
| Typing, open-tag typing, new scene, delete, undo, stamp, hide, display preference, three exports on `short` and `long`; image open, load and merge on `images` | Existing, unchanged (default run) | PERF, T02, T04, T05, T08, T12 |
| Initial load: navigation entry (dom interactive, DOMContentLoaded, load end), first and largest paint, whether a scene cell exists, five fresh navigations per run | New, fixture `footprint` | PERF |
| Open a script: `openFile` on a file built from the current script until the frame after it, three trials per script (`short`, `long`, `large`) | New, fixtures `footprint`, `footprint-long`, `large` | PERF, T13, T17 |
| JS heap after two forced collections: after load and after the typing case, for `short`, `long` and `large` | New | PERF, STORE |
| Script size and stored bytes: counts, text and HTML characters, `.splitpage`, `.md project`, state JSON bytes | New | PERF, STORE, T18 |
| Scale script: the long demo repeated 10 times with fresh ids, built in the page from the live state and opened with `openFile`; runs typing, new scene, delete, undo and the exports on it | New, fixture `large` | PERF, T13 |
| Free memory in the conditions list, read once before the build and every fixture | New line in the report | PERF |

The three new fixtures run only when named (`--only footprint,footprint-long,large`), so the default run and `tools/perf-ab.mjs` are unchanged. Each starts its own browser: a navigation after the typing case timed out in the driver in a first attempt (the likely cause is the unsaved-work prompt, not confirmed). Nothing large is committed; the scale script is generated in the page.

Not measured, needs:

| Item | Needs | Serves |
| --- | --- | --- |
| Bytes a draft adds | A desktop run: drafts are files owned by the Electron main process, and `electron` is not installed in this worktree. From the payload shape (`draftPayloadFor` in `src/application/recovery/draft-origin.ts`) a draft holds `stateJson`, and `baseJson` as well when the base is sent, so it adds 1x to 2x the state JSON in section 4. Derived, not observed | PERF, STORE |
| Bytes a history snapshot adds, with its index row | A way to make the browser history store take a snapshot from the harness. `openFile` of a changed script did not (the store stayed empty after 3 s). The snapshot body is `stateJson` (`historyIdbInspection` in `src/adapters/storage/history-inspection-testing.ts`), so the body bytes in section 4 are exact; the index row is not measured | PERF, STORE |
| Desktop startup, desktop heap | A desktop run (the only desktop number so far is the launch-time record in [performance-record.md](../../architecture/performance-record.md)) | PERF |
| A script of 2 MiB | The plan's capacity row asks for a 2 MiB encoded-state fixture. The `large` script is 0.33 MB (`LARGE_COPIES` is 10); about 55 copies reach 2 MiB. One constant, not run: the scale rows below are enough to size the projection budget, and a 2 MiB standalone number has no shared-mode counterpart until a prototype exists | PERF, T18 |
| `tools/perf-ab.mjs` for the new fixtures | `perf-ab.mjs` accepts only `short,long,images` (its `--only` check), and this PR may not touch it. Until it is widened, A/B on load, heap, bytes and `large` is two separate recorder runs under the section 6 rules | PERF |

## 3. Fixtures

The recorder and the long-demo wording call a row a "scene"; the glossary calls it a **beat**. Below, beats are rows. No fixture stores a scene header (`state` has no header field in any of them), so each is one automatic Scene A.

| Fixture | Beats | Scene headers | Comments | People | Production tags | Text characters | HTML characters | `.splitpage` bytes | `.md project` bytes | State JSON bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| short (seed script) | 2 | 0 | 1 | 0 | 0 | 461 | 618 | 1,734 | 2,702 | 1,419 |
| long (long demo) | 30 | 0 | 4 | 2 | 31 | 10,449 | 17,988 | 38,432 | 52,927 | 32,847 |
| large (long demo x10) | 300 | 0 | 40 | 2 | 31 | 104,490 | 180,114 | 334,208 | 459,699 | 295,548 |
| images (seed + 10 comments with a 1 MiB PNG each) | 2 | 0 | 11 | 0 | 0 | n/a | n/a | about 14 MB as written by the fixture | n/a | n/a |

Text characters are plain text of both text cells of each beat; HTML characters include tag markup. Counts and bytes were identical in all 5 runs. In `large`, people and production tags are kept once, comments, shots and beats are copied with fresh ids, and each copy's `data-cmt` and `data-broll-id` markup points at the copy.

## 4. Baseline results (PERF)

### Input latency, ms: median [min-max] over 5 runs of each run's p50 and p95

Typing is 55 characters, one real key event every 60 ms, into beat 2's audio cell; latency is key-down to the frame after it. The cases with one key (delete, undo) have p50 and p95 equal. The p95 values sit on the 60 Hz frame quantum (16.7 ms), which is why they move in steps.

| Case | p50 | p95 | Long tasks (every run) | Serves |
| --- | --- | --- | --- | --- |
| short typing | 2.5 [2.1-2.6] | 14.1 [12.6-16] | 0 | PERF, T02, T04 |
| long typing | 2.8 [2.1-3.1] | 14.8 [14.4-16.5] | 0 | PERF, T02, T04 |
| large typing | 5.3 [3.9-5.4] | 22.6 [17.6-25.4] | 0 | PERF, T02, T04 |
| short footprint typing (heap-measured browser) | 2.4 [2-2.9] | 15.6 [14.6-16.5] | 0 | PERF |
| long footprint typing (heap-measured browser) | 2.7 [2.3-3] | 16.1 [14.7-17.1] | 0 | PERF |
| short split open tag spaces | 9.6 [7.4-10.9] | 17.8 [15.8-27.9] | 0 | PERF, T04 |
| short split open tag name | 4.5 [2-7.4] | 18 [17-19.8] | 0 | PERF, T04 |
| short writer open tag spaces | 8.8 [7.3-11.1] | 21 [18.1-25.7] | 0 | PERF, T04 |
| short writer open tag name | 2.8 [2.6-4.6] | 14.7 [7.7-16.7] | 0 | PERF, T04 |
| long split open tag spaces | 3.3 [2.5-3.7] | 15.3 [10.4-17.5] | 0 | PERF, T04 |
| long split open tag name | 3.1 [2.8-6.1] | 10.6 [5-17.2] | 0 | PERF, T04 |
| long writer open tag spaces | 7.3 [4-10.6] | 21 [14.9-31.9] | 0 | PERF, T04 |
| long writer open tag name | 3.7 [2.8-4.1] | 16.7 [5.2-18.4] | 0 | PERF, T04 |
| short new scene (5 splits) | 21.6 [16.3-26.5] | 30.6 [29.7-43.9] | 0 | PERF, T05, T08 |
| long new scene (5 splits) | 27.9 [26.2-32] | 30.9 [27-36.2] | 0 | PERF, T05, T08 |
| large new scene (5 splits) | 194.6 [158.6-235.6] | 224.3 [163.4-247.4] | 5 per run, 492 to 707 ms in all | PERF, T05, T08 |
| short delete every scene | 7.6 [7.3-7.8] | same | 0 | PERF, T10 |
| long delete every scene | 10.5 [9.4-13.2] | same | 0 | PERF, T10 |
| large delete every scene | 31.8 [28.4-34.4] | same | 0 | PERF, T10 |
| short undo the delete | 10.5 [10.2-12.6] | same | 0 | PERF, T10, T12 |
| long undo the delete | 28.6 [26.4-35.5] | same | 0 | PERF, T10, T12 |
| large undo the delete | 177.9 [148.8-240.8] | same | 1 or 2 per run, 122 to 236 ms | PERF, T10, T12 |
| long stamp a scene | 7.7 [6.9-8.5] | 9.6 [9.3-10.2] | 0 | PERF |
| long hide shot scenes | 16.9 [15.9-18] | 19.8 [16.9-25.1] | 0 | PERF |
| long display preference | 18.1 [16-20.7] | 21.3 [17.7-22.1] | 0 | PERF |

`Range.getClientRects` calls: 0 for typing, new scene, delete and undo; 80 per run for the spaces cases and 40 for the name cases, in every run. No long task fired in any `short` or `long` case in any run.

### Exports, ms: median [min-max] over 5 runs of each run's median of 5

| Script | `.splitpage` | `.md project` | Standalone HTML | Serves |
| --- | --- | --- | --- | --- |
| short | 0.5 [0.4-0.7] | 0.9 [0.7-1.2] | 0.4 [0.3-0.5] | PERF |
| long | 5.3 [4.5-6.1] | 6.5 [4.6-7.3] | 2.6 [2-2.8] | PERF |
| large | 27.5 [21.8-35.5] | 35.6 [30-50.8] | 15.3 [11.3-20.2] | PERF, T13 |

### Initial load and open, ms

Load is a fresh `goto /index.html` on the seed script, five per run, each probed 1.6 s later; each run contributes its median of 5. Editable was true in all 25 navigations (a scene cell existed in the page). The page has no early mark for "editable", so load end and largest paint bound it: both are reported. Open is `openFile` on a file built from the open script: reading, parsing, migrating and drawing every beat, until the frame after it. The first trial of a run is much slower than the next two (cold code and caches), so both are given; a join is a first open.

| Case | Value | Serves |
| --- | --- | --- |
| Load, dom interactive | 49.7 [37.6-53.7] | PERF |
| Load, DOMContentLoaded | 65.9 [52.1-72.4] | PERF |
| Load, load end | 70.3 [54.1-74.4] | PERF |
| Load, first paint | 36 [32-40] | PERF |
| Load, largest paint | 88 [68-96] | PERF |
| Open short (2 beats), first trial / median of 3 | 6.4 [5.3-18.8] / 11 [8-15.6] | PERF |
| Open long (30 beats), first trial / median of 3 | 15.3 [12.3-17.4] / 10.6 [9-14.7] | PERF |
| Open large (300 beats), first trial / median of 3 | 204.2 [191.8-215.7] / 48.9 [47.5-52] | PERF, T17 |
| Images: open 10 pictures, median trial | 315.8 [268.3-324.1] | PERF, T16 |
| Images: load 10 pictures from IndexedDB | 109.2 [103-116.5] | PERF, T16, T17 |
| Images: merge 10 + 10 pictures | 326.1 [281.1-370] | PERF, T16 |

The first trial of short is 5.3 to 18.8 ms across runs: at this size the number is timer noise, not cost.

### JS heap after two forced collections, MiB

| Case | MiB | Serves |
| --- | --- | --- |
| short after load (6 samples a run: 5 navigations and the footprint page; mean of the middle pair) | 6.45 [6.45-6.45], re-measured, see below | PERF, STORE |
| short after typing | 7.46 [7.46-7.47] | PERF, STORE |
| long after load | 7.13 [7.13-7.13] | PERF, STORE |
| long after typing | 8.58 [8.57-8.58] | PERF, STORE |
| large after load | 14.96 [14.95-14.97] | PERF, STORE |
| large after typing | 15.66 [15.66-15.67] | PERF, STORE |

With a forced collection and precise sampling the heap is nearly deterministic: every range is under 0.05 MiB.

The short-after-load row was first recorded as 6.45 [6.45-7.51]. That was a recorder fault: six samples made an even count and the report took the upper middle one, so two runs showed a high sample (about 7.5 MiB) as the median. The recorder now averages the middle pair for an even count (new fixtures only; every existing case has an odd count). The raw samples of the first five runs were not kept, so the `footprint` fixture was run again five times (15:21 to 15:24, the corrected recorder, same build, same machine and locks). One of those runs began with 2.8 GB free, under the 3 GB void line of section 6, and was replaced by a sixth run (4.8 GB free). The five valid runs read 6.45 in each. Their other rows (load end 54.8 to 76.2 ms, typing p50 2.4 to 3.3 ms, `short open file` median trial 6.3 to 11.3 ms) are in line with the first five runs and were not substituted for them: only this row comes from the rerun. Free RAM before the five valid reruns, by the recorder: 4.2, 5.1, 5.0, 4.9 and 4.8 GB.

### Storage growth (bytes; counts in section 3)

| Item | short | long | large | Serves |
| --- | --- | --- | --- | --- |
| `.splitpage` file | 1,734 | 38,432 | 334,208 | PERF, STORE |
| State JSON = one history snapshot body (index row not measured) | 1,419 | 32,847 | 295,548 | PERF, STORE |
| One draft, derived: `stateJson`, plus `baseJson` when the base is sent | 1,419 to 2,838 | 32,847 to 65,694 | 295,548 to 591,096 | PERF, STORE |
| `.md project` | 2,702 | 52,927 | 459,699 | PERF |
| `.splitpage` bytes per beat | 867 | 1,281 | 1,114 | PERF, STORE |

The state JSON is 82 to 88 % of the `.splitpage` file. Bytes are exact and identical across runs.

### Scale: long to large (10x the beats)

| Case | long | large | Ratio |
| --- | --- | --- | --- |
| `.splitpage` bytes | 38,432 | 334,208 | 8.7x |
| Open, first trial | 15.3 ms | 204.2 ms | 13x |
| Open, median of 3 | 10.6 ms | 48.9 ms | 4.6x |
| New scene p50 | 27.9 ms | 194.6 ms | 7.0x |
| Undo the delete | 28.6 ms | 177.9 ms | 6.2x |
| Delete every scene | 10.5 ms | 31.8 ms | 3.0x |
| Export `.splitpage` | 5.3 ms | 27.5 ms | 5.2x |
| Typing p50 | 2.8 ms | 5.3 ms | 1.9x |
| Heap after load | 7.13 MiB | 14.96 MiB | 2.1x |

Typing stays under the existing 8 ms limit even at 300 beats. The structural cases redraw the whole script and grow with beats: they are the standalone number a later shared projection of a structural change is compared with.

## 5. Per-run values behind the medians (p50 ms, runs 1 to 5 in order)

| Case | Runs |
| --- | --- |
| short typing | 2.5, 2.1, 2.6, 2.3, 2.6 |
| long typing | 2.8, 2.1, 3.1, 3, 2.8 |
| large typing | 3.9, 5.3, 5.4, 5.2, 5.3 |
| short new scene | 21.6, 16.3, 19.6, 26.5, 24 |
| long new scene | 26.6, 26.2, 27.9, 31.1, 32 |
| large new scene | 158.6, 201.9, 172.4, 194.6, 235.6 |
| short delete every scene | 7.4, 7.3, 7.6, 7.6, 7.8 |
| long delete every scene | 13.2, 9.4, 9.9, 10.8, 10.5 |
| large delete every scene | 28.4, 34.4, 30.2, 33.8, 31.8 |
| short undo the delete | 10.2, 10.2, 12.6, 10.5, 11.8 |
| long undo the delete | 27.1, 26.4, 28.6, 35.5, 30.2 |
| large undo the delete | 148.8, 240.8, 177.9, 179.4, 166.7 |
| long stamp a scene | 7.1, 6.9, 8.5, 7.7, 8.3 |
| Load end | 58.2, 54.1, 74.4, 70.3, 72.3 |
| Export `.splitpage`, long | 4.6, 4.5, 6.1, 5.3, 5.3 |
| Export `.splitpage`, large | 21.8, 24.1, 27.5, 35.5, 31.3 |
| Heap after typing, large (MiB) | 15.67, 15.66, 15.66, 15.66, 15.67 |

The typing p95 per run: short 15.6, 16, 12.6, 13.1, 14.1; long 15.4, 14.7, 14.8, 14.4, 16.5; large 17.7, 17.6, 24.3, 22.6, 25.4.

## 6. Rules, fixed before any prototype result

### Noise treatment

| Item | Rule |
| --- | --- |
| Runs | 5 base and 5 head, never fewer. Each run is the whole recorder fixture set under comparison. A single run is never a result |
| Alternation | Base then head, one browser at a time, five rounds, in one sitting: `node tools/perf-ab.mjs <base> <head> --only short,long --rounds 5`. Both builds use the head's recorder and the same browser binary, built with `node build.mjs --test`. Fixtures `footprint`, `footprint-long` and `large` are outside `perf-ab` until it is widened: run the recorder on a base checkout and on the head, alternating, five times each, by hand |
| What is compared | For each case, the **median of the five per-run p50s** (typing cases also the median of the five p95s). Never pooled keystrokes and never a mean. Bytes are compared exactly |
| Outliers | Never dropped. The baseline's own min-max range is the noise estimate, so an outlier widens the tolerance instead |
| Locks | `perf` and `smoke` held for each run through `tools/with-lock.ps1`; no other browser, suite or desktop smoke on the machine |
| Voids a run | CPU busy over 35 % in the second before or after it (the recorder reads this); free RAM under 3 GB at the start, as the recorder reads it before it does any work; any `msedge` process alive before it starts; a different Node or browser version inside one set; a recorder exit other than 0 or a case count other than expected; a game or `pc-hold` active. A void run is replaced and the replacement is noted in the PR, never silently dropped |
| Where it holds | Only the same machine and browser build. A baseline from another PC, or from this one after a browser update, is re-recorded first |

### Tolerated regression for standalone A/B (shared code present but unused must not slow standalone)

A case fails when

> head median > base median + T, where T = the larger of (the base runs' max minus min), 15 % of the base median, and the floor.

| Measure | Floor |
| --- | --- |
| p50 of any latency, export or open case | 0.5 ms (open: 5 ms) |
| p95 of the three typing cases | 3 ms (about a fifth of a 60 Hz frame) |
| Load (load end, largest paint) | 5 ms |
| JS heap | 3 % and 0.25 MiB in place of 15 % and 0.5 ms |
| Stored bytes (`.splitpage`, state JSON, `.md project`) | 0: any difference for an unchanged script fails, unless the PR states a format change |

Handling a fail: rerun the A/B once with 5 more rounds (10 in all) and recompute with the 10-run medians and the 10-run base range. A second fail is a fail. Passing a case is the head being inside T; a head faster than the base by more than T is reported and checked for a measurement fault, not counted as a gain. The existing absolute limits in `tools/perf-ab.mjs` stay in force (8 ms typing p50, 65 ms new scene, 45 and 70 ms undo).

The rule is derived from the noise of section 4 (the range term) with 15 % and the floors as the minimum worth acting on. It was tried on an A/A pair before being fixed: `node tools/perf-ab.mjs 0ca19291 0ed0c19d --only short,long --rounds 5` (same `src/`, so every difference is noise), run right after the record. The rule flagged 0 of 19 latency cases at p50 and 0 of the 2 typing cases `perf-ab` runs at p95. The largest A/A move was short writer open tag spaces, p50 4.1 to 7.2 ms, whose base runs span 3.6 to 9.6 ms. The rule has not been tried against a real regression of known size; the first Stage 2 PR that adds shared code reports its result next to this table, and a change to the rule is an explicit decision.

### Tolerance per case (this baseline; recomputed from each A/B's own base runs)

T for p50, "limit" is baseline median + T. Cases whose T exceeds 50 % of the median are **wide**: a standalone slowdown smaller than T is invisible there, so they are reported and gated by the rule but cannot catch small regressions.

| Case | Baseline median | Range | T (ms) | Limit | T as % | Wide | Serves |
| --- | --- | --- | --- | --- | --- | --- | --- |
| short typing p50 | 2.5 | 2.1-2.6 | 0.5 | 3.0 | 20 % | | PERF, T02, T04 |
| long typing p50 | 2.8 | 2.1-3.1 | 1.0 | 3.8 | 36 % | | PERF, T02, T04 |
| large typing p50 | 5.3 | 3.9-5.4 | 1.5 | 6.8 | 28 % | | PERF, T02 |
| short typing p95 | 14.1 | 12.6-16 | 3.4 | 17.5 | 24 % | | PERF, T02 |
| long typing p95 | 14.8 | 14.4-16.5 | 3.0 | 17.8 | 20 % | | PERF, T02 |
| large typing p95 | 22.6 | 17.6-25.4 | 7.8 | 30.4 | 35 % | | PERF, T02 |
| short new scene | 21.6 | 16.3-26.5 | 10.2 | 31.8 | 47 % | | PERF, T05, T08 |
| long new scene | 27.9 | 26.2-32 | 5.8 | 33.7 | 21 % | | PERF, T05, T08 |
| large new scene | 194.6 | 158.6-235.6 | 77 | 271.6 | 40 % | | PERF, T05, T08 |
| short delete every scene | 7.6 | 7.3-7.8 | 1.1 | 8.7 | 15 % | | PERF, T10 |
| long delete every scene | 10.5 | 9.4-13.2 | 3.8 | 14.3 | 36 % | | PERF, T10 |
| large delete every scene | 31.8 | 28.4-34.4 | 6.0 | 37.8 | 19 % | | PERF, T10 |
| short undo the delete | 10.5 | 10.2-12.6 | 2.4 | 12.9 | 23 % | | PERF, T12 |
| long undo the delete | 28.6 | 26.4-35.5 | 9.1 | 37.7 | 32 % | | PERF, T12 |
| large undo the delete | 177.9 | 148.8-240.8 | 92 | 269.9 | 52 % | yes | PERF, T12 |
| long stamp a scene | 7.7 | 6.9-8.5 | 1.6 | 9.3 | 21 % | | PERF |
| long hide shot scenes | 16.9 | 15.9-18 | 2.5 | 19.4 | 15 % | | PERF |
| long display preference | 18.1 | 16-20.7 | 4.7 | 22.8 | 26 % | | PERF |
| short split open tag spaces | 9.6 | 7.4-10.9 | 3.5 | 13.1 | 36 % | | PERF, T04 |
| short split open tag name | 4.5 | 2-7.4 | 5.4 | 9.9 | 120 % | yes | PERF, T04 |
| short writer open tag spaces | 8.8 | 7.3-11.1 | 3.8 | 12.6 | 43 % | | PERF, T04 |
| short writer open tag name | 2.8 | 2.6-4.6 | 2.0 | 4.8 | 71 % | yes | PERF, T04 |
| long split open tag spaces | 3.3 | 2.5-3.7 | 1.2 | 4.5 | 36 % | | PERF, T04 |
| long split open tag name | 3.1 | 2.8-6.1 | 3.3 | 6.4 | 106 % | yes | PERF, T04 |
| long writer open tag spaces | 7.3 | 4-10.6 | 6.6 | 13.9 | 90 % | yes | PERF, T04 |
| long writer open tag name | 3.7 | 2.8-4.1 | 1.3 | 5.0 | 35 % | | PERF, T04 |
| Export `.splitpage`, short / long / large | 0.5 / 5.3 / 27.5 | 0.4-0.7 / 4.5-6.1 / 21.8-35.5 | 0.5 / 1.6 / 13.7 | 1.0 / 6.9 / 41.2 | 100 / 30 / 50 % | short | PERF |
| Load end | 70.3 | 54.1-74.4 | 20.3 | 90.6 | 29 % | | PERF |
| Open large, first trial | 204.2 | 191.8-215.7 | 30.6 | 234.8 | 15 % | | PERF, T17 |
| Open large, median of 3 | 48.9 | 47.5-52 | 7.3 | 56.2 | 15 % | | PERF, T17 |
| Open long, first trial | 15.3 | 12.3-17.4 | 5.1 | 20.4 | 33 % | | PERF |
| Heap after typing, short / long / large (MiB) | 7.46 / 8.58 / 15.66 | under 0.02 | 0.25 / 0.26 / 0.47 | 7.71 / 8.84 / 16.13 | 3 % | | PERF, STORE |
| Heap after load, long / large (MiB) | 7.13 / 14.96 | under 0.02 | 0.25 / 0.45 | 7.38 / 15.41 | 3 to 4 % | | PERF, STORE |
| Bytes, every script | table in section 4 | none | 0 | exact | 0 % | | PERF, STORE |

Heap after load, short: 6.45 MiB, range 0, so T is the 0.25 MiB floor and the limit is 6.70 MiB (PERF, STORE). Short open is not gated: it is timer noise at 3 to 19 ms.

## 7. Provisional limits where no standalone baseline can exist

Each is **provisional; changing it is an explicit decision**, never a retroactive acceptance of what a prototype showed. Measured on this PC or one stated as equivalent, with the server on the local network, by five runs each judged by the median unless a worst case is named. Standalone figures are from section 4.

| Limit | Number | Reasoning | Serves |
| --- | --- | --- | --- |
| Shared-session input latency, a local writer typing with a second client connected and one remote edit per second landing in another beat | p50 at most standalone p50 + 3 ms and never above 8 ms; p95 at most 25 ms on short and long, 40 ms on large; no long task over 50 ms during typing | Standalone p50 is 2.5 to 2.8 ms and p95 sits at one frame (14 to 15 ms). 8 ms is the existing perf-ab limit. 25 ms is 1.5 frames, so a keystroke is still painted within two frames; large's standalone p95 of 22.6 ms gets the same proportional headroom | PERF, T02, T04, T09 |
| Projection time after a remote update, message applied to the frame that paints it | One remote character in a visible beat: p50 at most 30 ms and p95 at most 50 ms on long and large. A remote structural change (split, new beat, delete): at most 1.5x the standalone new-scene p50, so 45 ms on long and 300 ms on large | A remote character should cost no more than two frames (33 ms), and a local one costs 2.5 ms. A structural change redraws everything today (27.9 ms long, 194.6 ms large), so 1.5x is the room for the shared projection itself. A smaller large budget would need an incremental render, a Stage 2 choice | PERF, T02, T05, T08, T12 |
| Initial join load, 2 MiB encoded state, provider connect to editable and first frame drawn | p50 at most 3 s and worst of five at most 5 s; no single task over 1 s | Large (0.33 MB, 300 beats) opens in 0.2 s cold. 2 MiB is about 6x the bytes, so linear cost is about 1.2 s; 3 s leaves 2.5x headroom for decoding the CRDT state, which standalone does not do | PERF, T13, T17 |
| Reconnect to synced, network restored to "connected, nothing pending", with up to 100 offline edits on a 2 MiB state | p95 at most 5 s; to the status "Your changes saved to server" at most 10 s | 5 s is the 2 s store debounce plus about 3 s to connect and exchange state. 10 s is the plan's upper bound for a store under continuous updates; backoff settings are a Stage 1b output and may move this | PERF, T16, T17, T19 |
| Receipt delay, last local edit to a covering receipt, on the local network | Journaling inside `beforeSync` (no debounce): p95 at most 1 s. Barrier design with the debounced store: p50 at most 3 s, p95 at most 5 s when idle, and at most 10 s under continuous typing | The plan's facts: the store hook is debounced at 2 s with a 10 s maximum, and a journal commit per update has no debounce. 1 s is a disk commit plus a round trip; the barrier numbers are the debounce plus slack | PERF, T14, T15 |
| Retained-state growth, encoded CRDT state against the plain document | A fresh import is at most 3x the plain `.splitpage` bytes (section 4). After a heavily edited run (the long demo with 10,000 character inserts and deletes and 200 structural edits and undos) at most 10x the plain size at that point, and never above the 2 MiB document bound | A CRDT keeps per-character identities (3x allows them on text-dense scripts) and deletion tombstones (10x bounds a long editing history). The plain size is `.splitpage` 38,432 bytes for the long demo. No standalone retained state exists to measure | PERF, STORE, T10, T18 |
| JS heap in a shared session, after load | At most standalone + 10 MiB on long (17.1 MiB) and at most 2x standalone on large (29.9 MiB) | Standalone is 7.13 and 14.96 MiB. The replica keeps a second copy of the document; the encoded state of large is under 1 MiB, so 10 MiB is wide enough for structs and the index without admitting a leak | PERF, STORE |

The measurement for each uses the cases of section 4 on the same PC and the same rules of section 6: the typing, new-scene, delete and undo cases with two real clients, and the open and load cases for a join. Shared-session cases need two driver processes or new commands (plan section 13), which is Stage 1b work.

## Open questions

| Question | Experiment |
| --- | --- |
| Is load end a fair stand-in for "navigation to editable"? The page has no early mark; editable was true at the probe in all 25 loads and largest paint (88 ms) is about 18 ms after load end | Add an app-side `performance.mark` when the first scene cell is editable (an app change, so Stage 2), or keep the pair as the definition |
| Does a join resemble a first open (cold, 204 ms for large) or a warm one (49 ms)? The limits assume cold | The T17 and T13 prototypes report both |
| Real history-store bytes, including the index row, and draft bytes on desktop | A harness path that takes a snapshot, and a desktop run; both listed in section 2 |
| The tolerance rule has no power check against a real regression | First Stage 2 A/B, or a deliberate delay of known size in an A/B built for the purpose |
| A 2 MiB standalone script has not been measured | `LARGE_COPIES` set to about 55 and one `large` run; the projection budget does not need it |

## Decisions for Adam

None blocking. Assumed meanwhile: the provisional limits in section 7 stand as written. The two a person will feel are the join time (3 s) and the time to "Your changes saved to server" (about 5 s idle, up to 10 s while typing), so those are the ones to adjust if they seem wrong.

## Doc mismatches

| Document | Says | Code says |
| --- | --- | --- |
| [performance-record.md](../../architecture/performance-record.md), "Comparing two commits" | `--only` accepts the recorder's fixtures | `tools/perf-ab.mjs` accepts only `short,long,images`; the recorder now also has `footprint`, `footprint-long` and `large`, which `perf-ab` refuses |
| `tools/perf-record.mjs` and the long demo's own wording | "scenes" for the 30 rows of the long demo | The glossary calls them beats; the new-tab link says "30 beats". The recorder's `scenes` field is rows |
| [COLLABORATION-PLAN.md](../../COLLABORATION-PLAN.md) section 12 item 7 | The recorder measures input latency and structural edits | It had no load, heap or storage case before this PR, and still has none for projection or reconnect |
