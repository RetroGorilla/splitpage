**Yes.** The Node prototype completed all tested operations on a 15,036,020-byte shared document on a
Windows arm64 laptop with 16 GB RAM. The first local keystroke came closest to the proposed 1 ms layer
share, with a 0.734 ms median and a 0.963 ms maximum. Across all local keystrokes the median was 0.201 ms
against the app's 8 ms end-to-end ceiling. Cold load and catch-up from the initial script cost the most
time, at 1.59 s through the first full read and 1.81 s to apply the whole-history difference. Creating
the replica and applying the stored update took 1.50 s. Stage 0's historical join test for its 2 MiB
fixture targeted a maximum 1 s single task.

## Measurements

Node 24.22.1 and Yjs 13.6.33. Times and retained heap are medians with the observed min–max in brackets.
The baseline ran five rounds and the 15 MB fixture ran three. Each round timed 11 local and 11 remote
keystrokes in the middle audio cell, alternating remote then local. Exact byte and entry counts were
identical across rounds. The two GC-off byte counts each come from one replay.

| Measure | 0.5 MB baseline | 15 MB target |
| --- | ---: | ---: |
| Simulated editing days | 350 | 11,806 |
| Stored update / fresh join payload, bytes | 505,313 | 15,036,020 |
| Freshly loaded and re-encoded, bytes | 505,313 | 15,036,020 |
| GC off, bytes | 993,691 | 32,749,607 |
| Create replica and apply update, ms | 44.26 [32.66–58.64] | 1,497.00 [1,493.70–1,528.49] |
| First full read, ms | 11.33 [10.98–13.15] | 94.60 [88.57–95.26] |
| Load through first full read, ms | 55.59 [44.90–71.79] | 1,592.26 [1,582.28–1,623.09] |
| Heap retained after load and read, MiB | 15.22 [14.54–15.31] | 343.85 [343.84–347.66] |
| Heap retained after editing session with undo, MiB | 22.79 [22.55–22.89] | 351.55 [351.46–351.56] |
| Undo entries after 20,000 operations | 5,000 | 5,000 |
| Local keystroke and incremental read, ms | 0.089 [0.059–0.411] | 0.201 [0.132–0.963] |
| First local keystroke in each timed copy, ms | 0.224 [0.156–0.411] | 0.734 [0.671–0.963] |
| Remote keystroke and incremental read, ms | 0.076 [0.053–0.862] | 0.123 [0.096–1.99] |
| Split and read, ms | 11.53 [10.28–15.28] | 49.10 [44.67–49.41] |
| Format and read, ms | 0.141 [0.120–0.563] | 0.270 [0.262–0.620] |
| Reconnect 1 day · vector bytes / ms | 9 / 0.066 [0.065–0.241] | 10 / 0.078 [0.070–0.270] |
| Reconnect 1 day · update bytes / encode ms / apply ms | 15,579 / 4.91 [4.36–5.73] / 4.65 [3.82–5.57] | 20,341 / 16.23 [13.87–16.66] / 30.13 [28.28–32.13] |
| Reconnect 30 days · vector bytes / ms | 9 / 0.043 [0.035–0.062] | 10 / 0.052 [0.047–0.081] |
| Reconnect 30 days · update bytes / encode ms / apply ms | 65,155 / 3.07 [2.66–3.70] / 22.40 [21.00–23.60] | 73,693 / 16.43 [15.09–16.52] / 165.50 [161.17–189.66] |
| Reconnect whole history · vector bytes / ms | 5 / 0.022 [0.020–0.075] | 5 / 0.038 [0.027–0.042] |
| Reconnect whole history · update bytes / encode ms / apply ms | 458,923 / 7.17 [7.15–7.56] / 60.88 [56.36–62.26] | 14,990,327 / 214.23 [211.11–255.69] / 1,814.69 [1,804.90–2,156.40] |

At 15 MB, Yjs GC removes 54% of the bytes that would otherwise be stored. A one-day reconnect sends
20 KB and a 30-day reconnect sends 74 KB. Their median apply times still increase from 4.65 to 30.13 ms
and from 22.40 to 165.50 ms respectively compared with the baseline. At the same visible script length,
load through first read grows about 29×, compared with about 2.3× for the median local key.

## Years of use

At the one-writer plain-key rates measured in [E4](../format-keys/RESULT.md), **15 MB represents about
37 years of realistic editing or 6.8 years of heavy editing**, with 250 editing days per year. E4's
realistic fixture grew from 36,535 bytes on day 1 to 437,985 on day 250, or 0.403 MB per year at that rate.
The heavy fixture grew from 45,448 to 2,234,969 bytes, or 2.198 MB per year. The estimate extends each
day 1–250 slope from its day 1 starting size and assumes it stays constant. The E8 generator's 11,806
synthetic days use a simpler, fixed-length schedule with a different byte growth rate.

## Fixture and measurement

The same synthetic 300-beat script starts with two columns, 20 headings and some bold text. The script keeps
22,651 visible UTF-16 code units including headings. A deterministic one-writer schedule works in five revision
rounds and five formatting rounds per editing day. It replaces about 1,000 characters in 5–40 character chunks,
applies 20 formatting commands drawn from the E4 mark kinds, and makes two formatted replacements. It targets
the E4 workload's scale and mark mix. It keeps replacement lengths fixed, uses a simpler preset mix of tags
and overlapping ranges, and omits comment resolution and immediate undo from the stored history. The existing
replica exposes the all-plain and all-per-action schemes. This run uses plain keys for the entire script.

The generator batches each replacement into one transaction and omits per-keystroke projection during the
build. The 15 MB build took 245 seconds. It uses public Yjs text and formatting operations on the native
replica's stored shape. The slow baseline replays the same replacements letter by letter and calls the
replica's reader after every edit. Its
stored bytes and visible-text SHA-256 agree with the batch build. Both builds independently record and check
the generated text in both columns and in headings. The measured replica and reconnect recipients are checked
against that record after loading or catching up. The target tolerance is ±5%, in decimal MB. The comparison
with garbage collection off replays the same seed and day count in a separate process.

The first full read uses `NativeReplica.rows()` and reads the heading blocks. Rows include the deltas, marks and
their rendered HTML. Each warm edit includes the prototype's normal `changes()` call. Local typing uses
`UndoLayer.type()`, remote typing applies a single update from another client, and format and split use
`UndoLayer.command()`. Reconnect computation uses a bare sender `Y.Doc` and a loaded receiver. Its apply time
includes the receiver's Yjs observers. The later correctness read is outside that timer. The whole-history
recipient starts with the initial script. The fresh joiner receives one raw full-state update before any
protocol framing.

Retained heap is the delta from the process's `heapUsed` with the encoded fixtures in memory and before any
measurement copy is loaded. Each snapshot follows two synchronous `global.gc()` calls under `--expose-gc`.
The load snapshot keeps one replica and its first-read caches. The session snapshot keeps one separately loaded
replica, its caches and the E6 undo manager after 20,000 local operations across the 300 beats, including typing,
deletion and formatting. The session refreshes the projection after each ten-operation burst. Its heap includes
retained deleted text to the extent it occupies the V8 heap. These values exclude the process's external
buffers and peak allocation during load, projection or encoding.

## Current and historical limits

- The [Stage 0 retained-state gate](../../../../docs/collaboration/stage-0/7-performance-baseline.md) used
  **2 MiB (2,097,152 bytes)**.
  [`perf/fixtures.ts`](../perf/fixtures.ts) chooses the largest imported fixture that fits both candidates.
  [`perf/report.ts`](../perf/report.ts) and [`perf/timing-report.ts`](../perf/timing-report.ts) compare encoded
  states against it alongside the 3× fresh-import and 10× retained-growth ratios.
  [`perf/lifetime/workload.ts`](../perf/lifetime/workload.ts),
  [`counts.ts`](../perf/lifetime/counts.ts), [`record.ts`](../perf/lifetime/record.ts),
  [`sensitivity.ts`](../perf/lifetime/sensitivity.ts) and [`report.ts`](../perf/lifetime/report.ts) set,
  detect, verify and report its first crossing. [`native/heavy.ts`](../native/heavy.ts) uses it as an
  experiment stopping point. The [collaboration plan](../../../../docs/COLLABORATION-PLAN.md) calls for
  a 2 MiB encoded-state fixture and a separate 2 MiB image fixture.
- [`service/server-process.ts`](../service/server-process.ts) checks incoming SyncStep2 and Update
  payloads before journaling. It rejects a payload over **2 MiB** or one that fails to decode.
  [`service/refusal/boundary.ts`](../service/refusal/boundary.ts) caps both the incoming raw update and
  the merged candidate's re-encoded document at **2 MiB**. A small update may hit the second check. The
  [refusal test](../../test/service/refusal/refusal.test.ts), [state-limit probe](../../test/service/refusal/state-limit.ts)
  and [harness](../../test/service/refusal/harness.ts) exercise and check both cases. The journal tests
  use the same update limit in [`review.test.ts`](../../test/service/review.test.ts),
  [`observations.ts`](../../test/service/observations.ts) and [`ordering.test.ts`](../../test/service/ordering.test.ts).
- [`service/server-process.ts`](../service/server-process.ts) gives refusal-policy sockets a **4 MiB**
  WebSocket payload limit before the sync hooks. The `MAX_PAYLOAD` override replaces it. The
  [socket review tests](../../test/service/review.test.ts) set the override to **2 MiB** for close-1009
  cases. With neither option set, the pinned Node WebSocket server dependency defaults to **100 MiB**.
  These are receive-side message limits, including sync envelope bytes. The
  [pinned collaboration server](../../package-lock.json) also defaults to **5 MiB** of queued messages per
  connection before authentication and a **1 MiB** outgoing update-batch flush threshold.
  [`service/instance/loading-probe.ts`](../service/instance/loading-probe.ts) sets the latter to one byte
  to test that loading stays quiet.
- [`service/instance/extension.ts`](../service/instance/extension.ts) caps the instance-management
  HTTP request body at **3 MiB**, including JSON and the base64 initial state. That leaves at most
  **2.25 MiB** of binary state before subtracting the envelope.
  [`service/images/service.ts`](../service/images/service.ts) caps both declared and streamed image
  uploads at **16 MiB**. [`service/images/store-worker.ts`](../service/images/store-worker.ts) repeats
  the same guard before storing a PNG.
- The current [`server/server.ts`](../../../../server/server.ts) handles static GET and HEAD requests.
  The former HTTP collaboration server (`server/server.js` in `309c15d9f^1`, removed in PR #849)
  capped JSON document create and save requests at **25 MiB** by default via `MAX_BODY_BYTES` and
  returned HTTP 413 for an oversized body. Its endpoints used **8 KiB** for small join and link
  requests, **512 KiB** for comment requests and **256 KiB** for missing-blob queries. The same server
  and its blob helper used **8 MiB** per blob and a **20 MiB** review blob budget by default.
- The [E6 undo results](../native-undo/RESULTS.md) propose rebuilding an editing copy after it deletes
  **1,000,000 local characters**. That proposed trigger addresses undo retention in one editing copy.

## Coverage and uncertainty

The Node measurement excludes browser heap limits, renderer and editor work, phone-class machines, real
network transfer, and a deployed server's message limit or persistence cost. The largest uncertainty is how
history concentrates in the busiest real cell. The synthetic edits are distributed across 300 beats. A
writer who revises a small set of cells repeatedly can leave longer histories on those cells at the same
total size. The measurements also leave open how often a real team accumulates years of edits at E4's rates
and how the chosen per-application production tag keys affect long-lived histories.

## Regenerate

Use Node 24.22.1. From the repository root, run `npm ci` and `npm ci --prefix prototypes/collab`.
Run each command to completion before starting the next. The build writes the encoded fixtures and their
manifest to a scratch directory. The measurement and replay commands emit JSON to standard output.

```powershell
$small = Join-Path $env:TEMP 'splitpage-e8-small'
$large = Join-Path $env:TEMP 'splitpage-e8-large'
$runner = 'prototypes/collab/src/native-size/run.ts'

node $runner build 0.5 $small
node --expose-gc $runner measure $small 5
$smallDays = (Get-Content (Join-Path $small 'fixture.json') | ConvertFrom-Json).days
node $runner gc-off 0.5 $smallDays
node $runner faithful 0.5 $smallDays

node $runner build 15 $large
node --expose-gc $runner measure $large 3
$largeDays = (Get-Content (Join-Path $large 'fixture.json') | ConvertFrom-Json).days
node $runner gc-off 15 $largeDays
```
