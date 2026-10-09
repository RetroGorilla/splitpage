# Performance record

Recorded 2026-09-30 by `node tools/perf-record.mjs`, once. The numbers describe this machine and browser; compare a later run only under the same conditions.

## Conditions (Linux)

- Machine: linux 6.18.44-fc-v50 x64, Intel(R) Xeon(R) Processor @ 2.80GHz x4, 15.7 GB, Node v22.22.2
- Browser: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36, headless, viewport 1400x900 at 1x
- Script font: `"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", Verdana, sans-serif`; Atkinson Hyperlegible Next is not installed, so a fallback family drew the text
- Fixtures: short is the seed script (2 scenes); long is the long demo (30 scenes)
- Typing: 55 characters, one real key event every 60 ms, into scene 2's audio cell; latency is key-down to the frame after it

## Input latency (Linux, ms)

| Case | Keys | p50 | p95 | Max | Long tasks | Long-task ms |
| --- | --- | --- | --- | --- | --- | --- |
| short typing | 56 | 10.7 | 17.8 | 36.8 | 0 | 0 |
| short new scene | 5 | 44.9 | 58.9 | 58.9 | 0 | 0 |
| short delete every scene | 1 | 21.3 | 21.3 | 21.3 | 0 | 0 |
| short undo the delete | 1 | 34.9 | 34.9 | 34.9 | 0 | 0 |
| long typing | 56 | 14.6 | 30.7 | 47.4 | 0 | 0 |
| long new scene | 5 | 125.1 | 181.5 | 181.5 | 5 | 440 |
| long delete every scene | 1 | 37.8 | 37.8 | 37.8 | 0 | 0 |
| long undo the delete | 1 | 92.2 | 92.2 | 92.2 | 1 | 69 |

## Export (Linux, median of 5 runs, ms)

| Fixture | .splitpage | .md project | Standalone HTML |
| --- | --- | --- | --- |
| short | 0.5 | 1.2 | 0.6 |
| long | 6.1 | 13.3 | 4 |

.docx, PDF, CSV and .xlsx have no page hook to time them by and are not measured.

## After milestone 2 (Windows)

Recorded 2026-10-01 by `node tools/perf-record.mjs`, once, on 4.0-development with milestone 2 merged (`m2/close`, built with `node build.mjs`). It is a different machine from the Linux record above, and there is no baseline on this machine, so the two are not comparable and nothing here says how much milestone 2 changed. The numbers show only what typing, row edits and exports cost on this machine after the milestone: no long task fired in any case. A comparison against the starting point needs a run on the starting commit under these same conditions.

### Conditions

- Machine: win32 10.0.26300 x64, AMD Ryzen 9 9950X3D2 16-Core Processor x32, 30.9 GB, Node v22.23.2; other sessions were running on it
- Browser: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0, headless, viewport 1400x900 at 1x
- Script font: `"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", Verdana, sans-serif`; Atkinson Hyperlegible Next is installed and used
- Fixtures: short is the seed script (2 scenes); long is the long demo (30 scenes)
- Typing: 55 characters, one real key event every 60 ms, into scene 2's audio cell; latency is key-down to the frame after it

### Input latency (ms)

| Case | Keys | p50 | p95 | Max | Long tasks | Long-task ms |
| --- | --- | --- | --- | --- | --- | --- |
| short typing | 56 | 3.6 | 19.3 | 26.2 | 0 | 0 |
| short new scene | 5 | 17.1 | 24.6 | 24.6 | 0 | 0 |
| short delete every scene | 1 | 8.9 | 8.9 | 8.9 | 0 | 0 |
| short undo the delete | 1 | 12.6 | 12.6 | 12.6 | 0 | 0 |
| long typing | 56 | 5.1 | 16.3 | 29.8 | 0 | 0 |
| long new scene | 5 | 35.2 | 42.8 | 42.8 | 0 | 0 |
| long delete every scene | 1 | 13.6 | 13.6 | 13.6 | 0 | 0 |
| long undo the delete | 1 | 31.5 | 31.5 | 31.5 | 0 | 0 |

### Export (median of 5 runs, ms)

| Fixture | .splitpage | .md project | Standalone HTML |
| --- | --- | --- | --- |
| short | 0.4 | 0.7 | 0.3 |
| long | 1.6 | 4.7 | 2.9 |

No long task fired in any case on either fixture.

## Milestone 3 start (Windows)

Recorded 2026-10-03 by `node tools/perf-record.mjs`, once, on 4.0-development at `b1fde0f` (built with `node build.mjs`), as milestone 3's starting point (PR 3.0). It ran on the same machine, browser and font as the milestone 2 record above, with other sessions running on it. Milestone 3 compares its typing case after the typing command (3.12) and its close (3.15) with this run, under these same conditions.

### Conditions

- Machine: win32 10.0.26300 x64, AMD Ryzen 9 9950X3D2 16-Core Processor x32, 30.9 GB, Node v22.23.2; other sessions were running on it
- Browser: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0, headless, viewport 1400x900 at 1x
- Script font: `"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", Verdana, sans-serif`; Atkinson Hyperlegible Next is installed and used
- Fixtures: short is the seed script (2 scenes); long is the long demo (30 scenes)
- Typing: 55 characters, one real key event every 60 ms, into scene 2's audio cell; latency is key-down to the frame after it

### Input latency (ms)

| Case | Keys | p50 | p95 | Max | Long tasks | Long-task ms |
| --- | --- | --- | --- | --- | --- | --- |
| short typing | 56 | 3.9 | 14.5 | 16.9 | 0 | 0 |
| short new scene | 5 | 20.2 | 26.1 | 26.1 | 0 | 0 |
| short delete every scene | 1 | 10.6 | 10.6 | 10.6 | 0 | 0 |
| short undo the delete | 1 | 14.1 | 14.1 | 14.1 | 0 | 0 |
| long typing | 56 | 5.3 | 16.9 | 18 | 0 | 0 |
| long new scene | 5 | 40.7 | 45.3 | 45.3 | 0 | 0 |
| long delete every scene | 1 | 15.7 | 15.7 | 15.7 | 0 | 0 |
| long undo the delete | 1 | 37.7 | 37.7 | 37.7 | 0 | 0 |

### Export (median of 5 runs, ms)

| Fixture | .splitpage | .md project | Standalone HTML |
| --- | --- | --- | --- |
| short | 0.4 | 0.7 | 0.4 |
| long | 1.6 | 4.5 | 2.6 |

No long task fired in any case on either fixture.

Against the milestone 2 record on this machine, the p95 values moved by up to about 5 ms, in both directions (short typing 19.3 then 14.5, long typing 16.3 then 16.9, long new scene 42.8 then 45.3), while typing's p50 moved by under 1 ms (3.6 then 3.9, 5.1 then 5.3). The post-milestone-2 queue changed code between the two runs, but a band like that in both directions is what single runs show here. A later comparison, 3.12's typing case first, should compare p50, or run three times and compare the medians, before calling a p95 difference of that size a change.

## Milestone 3 close (Windows)

Recorded 2026-10-08 by `node tools/perf-record.mjs`, on 4.0-development at `391bda6` (3.14 and #448 merged, built with `node build.mjs`), as milestone 3's close (PR 3.15). It ran on the same machine, browser and font as the two Windows records above. The start record above is one run, and single runs here moved by several milliseconds in both directions, so this comparison is of medians: `b1fde0f` (the plan's last revision, a `git archive` built with `node build.mjs` and run with its own `perf-record.mjs`) and `391bda6` ran alternately, base then head, three times each, and the tables give each case's median of the three. Nothing else of this lane ran during them; other sessions on the machine were not controlled. An earlier set of the same kind, with the head at `c91bc4f` (3.14 alone), is summarised below.

### Conditions

- Machine: win32 10.0.26300 x64, AMD Ryzen 9 9950X3D2 16-Core Processor x32, 30.9 GB, Node v22.23.2
- Browser: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0, headless, viewport 1400x900 at 1x
- Script font: `"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", Verdana, sans-serif`; Atkinson Hyperlegible Next is installed and used
- Fixtures: short is the seed script (2 scenes); long is the long demo (30 scenes)
- Typing: 55 characters, one real key event every 60 ms, into scene 2's audio cell; latency is key-down to the frame after it

### Input latency, median of 3 runs each (ms)

| Case | Keys | p50 `b1fde0f` | p50 `391bda6` | p95 `b1fde0f` | p95 `391bda6` |
| --- | --- | --- | --- | --- | --- |
| short typing | 56 | 4 | 4.6 | 16 | 15.7 |
| short new scene | 5 | 19.1 | 14.7 | 27.5 | 23.4 |
| short delete every scene | 1 | 10.1 | 10.2 | 10.1 | 10.2 |
| short undo the delete | 1 | 15.6 | 12.7 | 15.6 | 12.7 |
| long typing | 56 | 6.7 | 6.1 | 16.1 | 16.9 |
| long new scene | 5 | 37.6 | 36.2 | 42.4 | 41 |
| long delete every scene | 1 | 13.4 | 13.6 | 13.4 | 13.6 |
| long undo the delete | 1 | 47.1 | 39.1 | 47.1 | 39.1 |

The runs behind the typing medians (p50, then p95): short typing `b1fde0f` 4, 4, 4.6 and 16, 15.3, 16.9; `391bda6` 4.8, 4.6, 4.2 and 17.6, 12.5, 15.7. Long typing `b1fde0f` 6.7, 6.9, 5.5 and 18.1, 16.1, 15.7; `391bda6` 4.8, 6.8, 6.1 and 16.1, 16.9, 19.8. No long task fired in any of the 6 runs, in any case. The cases with one key (delete, undo) have p50, p95 and max equal, so each is one sample per run.

### Export, median of 3 runs each (ms, median of 5 within a run)

| Fixture | .splitpage `b1fde0f` | .splitpage `391bda6` | .md project `b1fde0f` | .md project `391bda6` | Standalone HTML `b1fde0f` | Standalone HTML `391bda6` |
| --- | --- | --- | --- | --- | --- | --- |
| short | 0.3 | 0.3 | 0.6 | 0.5 | 0.2 | 0.7 |
| long | 2.2 | 1.5 | 5.2 | 4.4 | 2.5 | 2.3 |

### Reading it

Typing, which 3.12 put through the session, moved by +0.6 ms (short) and -0.6 ms (long) at p50 and by -0.3 and +0.8 ms at p95, inside the spread between runs of one build (short typing p50 alone ran from 4 to 4.6 on the base, and long typing p95 from 15.7 to 18.1). The earlier set with the head at `c91bc4f` read the same way: short typing p50 3.4 then 4.3 ms and p95 15.2 then 15.7, long typing p50 5.9 then 6.1 and p95 15.9 then 15.6. The 3.12 PR measured the same case in its own interleaved comparison and found its p50 medians within 0.3 ms. The cases that are not typing, none of which goes through a command, differ by amounts in both directions that the runs themselves show (long undo the delete on the base ran from 31.3 to 54 ms). The milestone 3 start record above, a single run, reads 3.9 and 14.5 ms for short typing and 5.3 and 16.9 ms for long typing; the medians here sit beside it. Export is a few milliseconds at most in every case, and the one value that rose (short standalone HTML, 0.2 then 0.7 ms) is a sub-millisecond reading that moved from 0.3 to 0.7 within the head's own runs.

Three earlier runs of the head alone, made before these, read higher on two long cases than the interleaved medians (long new scene p50 46.9, 49.9 and 50.3 ms; long undo the delete 39.3, 48 and 48.8 ms), and the cause was not found. That is why this section compares the base and the head run alternately in one sitting, and why a p95, or a case of one key, should be repeated before it is called a change.

## Milestone 4 start: the render and typing base for 4.21 (Windows)

Recorded 2026-10-08 by `node tools/perf-record.mjs`, three runs one after another, on 4.0-development at `1aa1eed` (built with `node build.mjs`; this PR changes no app source), as the base that the atomic render (4.21, #463) compares its typing and render medians with. The tables give each case's median of the three runs. The 4.21 comparison must run base and head alternately in one sitting, as the milestone 3 close did, because single runs here move by several milliseconds in both directions.

### Conditions

- Machine: win32 10.0.26300 x64, AMD Ryzen 9 9950X3D2 16-Core Processor x32, 30.9 GB, Node v22.23.2; other sessions were running on it (processor load 7% just before the first run, 15.6 GB of memory free)
- Browser: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0, headless, viewport 1400x900 at 1x. It is one major version newer than the three Windows records above (154), so a comparison with them is indicative only
- Script font: `"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", Verdana, sans-serif`; Atkinson Hyperlegible Next is installed and used
- Fixtures: short is the seed script (2 scenes); long is the long demo (30 scenes)
- Typing: 55 characters, one real key event every 60 ms, into scene 2's audio cell; latency is key-down to the frame after it
- Render: no case times `render()` alone. The cases that draw the whole script are "new scene" (five Ctrl+Enter presses, each re-rendering) and "undo the delete" (one undo that redraws every scene), so those two are the render medians

### Input latency, median of 3 runs (ms)

| Case | Keys | p50 | p95 |
| --- | --- | --- | --- |
| short typing | 56 | 3.8 | 16.2 |
| short new scene | 5 | 22.4 | 27.3 |
| short delete every scene | 1 | 8.9 | 8.9 |
| short undo the delete | 1 | 11.2 | 11.2 |
| long typing | 56 | 5.3 | 16.9 |
| long new scene | 5 | 32.5 | 35.4 |
| long delete every scene | 1 | 12.7 | 12.7 |
| long undo the delete | 1 | 30.8 | 30.8 |

The runs behind them (p50, then p95): short typing 3.3, 3.8, 3.8 and 16.2, 17, 14.5; long typing 5.1, 5.3, 5.8 and 17, 16.9, 14.6; long new scene 32.7, 31.1, 32.5 and 34.5, 40.6, 35.4; long undo the delete 28.6, 33.3, 30.8; short new scene 22.4, 13.5, 22.7 and 27.3, 24.5, 28. No long task fired in any case, on either fixture, in any of the 3 runs. The cases with one key (delete, undo) have p50, p95 and max equal, so each is one sample per run.

### Export, median of 3 runs each (ms, median of 5 within a run)

| Fixture | .splitpage | .md project | Standalone HTML |
| --- | --- | --- | --- |
| short | 0.3 | 0.5 | 0.6 |
| long | 1.4 | 3.5 | 2.1 |

## Image-heavy load and merge, #320 (Windows)

Recorded 2026-10-08 by `node tools/perf-record.mjs --only images` (PR 4.5), before the blob registry moves (D8). The case opens a document whose ten comments each hold a fresh 1 MiB picture, reads the same pictures back from IndexedDB on a fresh page, and merges two sides that each add ten. The same file ran, unchanged, on builds of `d18adde` (where milestone 2 started) and `c4d5944` (milestone 2's final tree): a `git worktree add --detach` checkout of each, `node_modules` junctioned to the lane's, `node build.mjs`, and `tools/perf-record.mjs` copied in (the tool measures the build of the repo it sits in). One run is three trials, each on ten pictures that no earlier trial used and that were not in the registry when its timer started (the tool checks the second and refuses the run otherwise); the tables give each run's median trial, and the per-trial times are listed under the results.

The runs used the tool as committed at `8ed2dc7` (PR 4.5's second round). They went in two sets, one run at a time on one machine, browser and font setup, in this order: `d18adde`, `c4d5944`, `d18adde`, `c4d5944`, `1aa1eed` (the base of PR 4.5, with no app source changed since), `d18adde`, `c4d5944`, `1aa1eed`. The first set's `c4d5944` merge runs spread by 13.9%, over the 10% line, so the set was rerun once in full (set 2); that set had one disturbed `c4d5944` run of its own, so the headline numbers are the medians over both sets (6 runs of `d18adde` and `c4d5944`, 4 of `1aa1eed`). An earlier set at tool `8f62a25` is superseded: its open file went through the app's migration while it was built, so its pictures were already in the registry when the timer started (it read +33.9% open and +33.7% merge for `c4d5944`). Milestone 4's closing tree (4.22) runs the same command under these conditions.

### Conditions

- Machine: win32 10.0.26300 x64, AMD Ryzen 9 9950X3D2 16-Core Processor x32, 30.9 GB, Node v22.23.2
- Browser: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0, headless, viewport 1400x900 at 1x. The same browser ran every build.
- Script font: `"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", Verdana, sans-serif`; Atkinson Hyperlegible Next is installed and used
- Load at the time: not quiet. Other lanes of this milestone (agents running tests and reviews) shared the PC, 3 to 35 node processes at the start of a run and no other browser. The system CPU read, just before each run, ranged from 1% to 85%; the tool's own reads in the second before and after each run ranged from 4% to 96% and are in the tables below. A game was not running. Free RAM was 11 GB at the start. Runs that overlapped a burst of other work are visible in the trial lists (set 1 run 4's merge, set 1 run 5, set 2 run 2) and are named under Reading it.
- Fixture: the seed script (2 scenes) with ten comments added, each holding one picture. A picture is a valid PNG of exactly 1 MiB (a 1x1 image plus a private chunk of random bytes with correct checksums), so no two share a hash and the browser decodes each
- Open: `openFile` on a .splitpage that is plain JSON (the file is not run through the app's migration when it is built), whose comment bodies hold the pictures as data URLs, until the frame after it. None of the ten is in the registry at the start (checked by hash). The timed work is reading and parsing the 14 MB file, migrating it (each picture decoded, hashed and put in the registry), and the redraw; storing the pictures in IndexedDB is queued by the migration on a timer and is not waited for inside the time
- Load from IndexedDB: `ensureBytes` for the ten pictures of an earlier open, after a reload of the page, so the registry reads them back from the store (`loadBlob`, then `intern`). This is the third hash and copy that the milestone 4 plan names; the tool checks that none of the ten was in memory before the call
- Merge: a hosted pull (`noteRev`, with `fetch` stubbed to answer from memory) of a document that added ten pictures as data URLs, into a document that added ten others, until the frame after it. My side's pictures were already in the registry, as in a live session, so the timed ingestion is theirs, and none of theirs is in the registry at the start (checked by hash); the JSON parse of a server answer is not in the time

### Results, median over all runs (ms; each run is the median of its 3 trials)

| Case | `d18adde` (6 runs) | `c4d5944` (6 runs) | `1aa1eed` (4 runs) |
| --- | --- | --- | --- |
| open, 10 pictures | 284.05 | 382.75 | 384.05 |
| load from IndexedDB, 10 pictures | 104.25 | 108 | 104.65 |
| merge, 10 + 10 pictures | 298.2 | 394.4 | 392.25 |

A median of six is the mean of the middle two runs. Slowdown against `d18adde`:

| Case | `c4d5944` | `1aa1eed` |
| --- | --- | --- |
| open | +34.7% | +35.2% |
| load from IndexedDB | +3.6% | +0.4% |
| merge | +32.3% | +31.5% |

Each set alone, `c4d5944` against `d18adde`: set 1 open +35.7% (284.2 against 385.6), merge +31.1% (299.7 against 392.9); set 2 open +33.7% (280.8 against 375.3), merge +33.4% (296.7 against 395.9).

### Every run and trial (ms)

Busy is the tool's read of the CPU in the second before and the second after the run; system is the instantaneous read just before it. The trial lists are in the order they ran.

Set 1:

| Run | Build | Busy before / after | System | open trials | load trials | merge trials |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `d18adde` | 21% / 11% | 46% | 304.4, 292.1, 288.7 | 104.3, 105.8, 103.8 | 313.3, 299.7, 291.6 |
| 2 | `c4d5944` | 15% / 8% | 7% | 386.4, 378.3, 379.9 | 105.5, 102.6, 102.7 | 390.7, 392.9, 396.3 |
| 3 | `d18adde` | 8% / 4% | 5% | 288.6, 283.9, 283.6 | 103.8, 105.9, 105 | 309, 293.4, 306.9 |
| 4 | `c4d5944` | 7% / 87% | 1% | 398.7, 385.6, 383.8 | 108.5, 109.9, 105 | 389.2, 445.2, 506.7 |
| 5 | `1aa1eed` | 96% / 10% | 85% | 521.6, 510.3, 507 | 122.2, 111.4, 109.1 | 402.7, 415, 398.3 |
| 6 | `d18adde` | 9% / 54% | 15% | 284.2, 275.5, 288.8 | 104, 104.2, 104.4 | 293.6, 293.2, 288.9 |
| 7 | `c4d5944` | 45% / 14% | 79% | 394.2, 385.5, 386.9 | 107.5, 113.7, 103.3 | 390.4, 395, 382.8 |
| 8 | `1aa1eed` | 10% / 18% | 1% | 383.1, 383.8, 379.1 | 104.7, 103.2, 105.2 | 390.1, 388, 390.4 |

Set 2:

| Run | Build | Busy before / after | System | open trials | load trials | merge trials |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `d18adde` | 10% / 10% | 8% | 284.4, 280.8, 279.7 | 102.8, 102.9, 103.6 | 304.2, 310.3, 298.7 |
| 2 | `c4d5944` | 26% / 15% | 7% | 491.8, 499.9, 472.9 | 122.1, 122.6, 121.8 | 531.8, 522.4, 419.5 |
| 3 | `d18adde` | 14% / 4% | 29% | 290.5, 295.8, 292.8 | 105.7, 105.9, 104.2 | 288.7, 286.5, 287.5 |
| 4 | `c4d5944` | 5% / 4% | 1% | 370.4, 363.5, 369.4 | 122.7, 125.7, 108.4 | 411.3, 395.9, 389.5 |
| 5 | `1aa1eed` | 5% / 9% | 1% | 377.3, 367.4, 375 | 104.6, 103.9, 105.1 | 390.9, 389.2, 395.7 |
| 6 | `d18adde` | 4% / 4% | 3% | 280.1, 271.8, 272.8 | 102.4, 103.1, 102.2 | 296.7, 283.7, 298.7 |
| 7 | `c4d5944` | 4% / 16% | 1% | 376.8, 375.3, 367.4 | 102.8, 103.2, 102.8 | 382.9, 387.5, 410.7 |
| 8 | `1aa1eed` | 12% / 8% | 12% | 394.4, 381.8, 385 | 103.5, 104.6, 104.6 | 393.6, 380.9, 394.7 |

### Reading it

This machine was shared with other lanes throughout, and it shows. `d18adde`'s six runs spread by 7% (open 272.8 to 292.8) and 6.5% (merge 287.5 to 306.9), within the 10% line. `c4d5944`'s spread by 32% (open) and 34% (merge), over it, because of two runs that overlapped bursts of other work: set 1 run 4 (87% busy after it; its merge trials 389, 445, 507) and set 2 run 2 (every case 19 to 33% up). The rest of `c4d5944`'s runs sit tight: open 369.4 to 386.9 (4.6%) in five runs, merge 387.5 to 395.9 (2.1%) in four. `1aa1eed`'s set 1 run was taken under 96% busy (open 510) and the other three agree within 2.6% (open) and 3.2% (merge, all four). The spread rule asked for one rerun of the pair, which is set 2; the medians over both sets are used because a second set did not make the disturbance go away, and a median of six does not move for two bad runs.

The two cases that ingest ten new pictures, open and merge, are about a third slower on `c4d5944` than on `d18adde` (about 99 and 96 ms), and `1aa1eed` reads the same. Each set alone gives the same answer (+35.7% and +31.1%, then +33.7% and +33.4%), so the slowdown is far outside the spread. The cost came in between `d18adde` and `c4d5944`, and the commits since have not moved it. The size matches the extra hash of ten 1 MiB pictures that the PR review measured in Node (96 to 100 ms).

The load from IndexedDB was 102 to 106 ms on every `d18adde` run and 102.7 to 108.5 on four of `c4d5944`'s six; the other two (set 2 runs 2 and 4) read 122 ms, and the second of them was taken with the CPU quiet, so the +3.6% of the median over all runs is not explained by load alone. The code is the same on both builds (`loadBlob` calls `intern` on `d18adde` too, so its extra hash and copy is not new), `1aa1eed` reads 104.6, and the four ordinary `c4d5944` runs equal `d18adde`'s, so I read the 122 ms runs as store timing noise, but this data cannot prove it. A trim of the ingestion port leaves the load path as it is. Whether the 10% line named in E14 calls for the trim is for 4.19; both ingesting cases are above it by a factor of three.
