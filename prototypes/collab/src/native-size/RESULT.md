**Yes.** The Node prototype completed all tested operations on a 15,036,020-byte shared document on a
Windows arm64 laptop with 16 GB RAM. In the evenly edited fixture, the first local keystroke came
closest to the proposed 1 ms layer share, with a 0.734 ms median and a 0.963 ms maximum. Across all
local keystrokes the median was 0.201 ms. A separate 15.68 MB probe with 140,001 entries in one cell
took 22.06 ms per key at the median, above both the layer share and the app's 8 ms end-to-end ceiling.
Cold load and catch-up from the initial script cost the most time in the main fixture, at 1.59 s through
the first full read and 1.81 s to apply the whole-history difference. Creating the replica and applying
the stored update took 1.50 s. Stage 0's historical join test for its 2 MiB fixture targeted a maximum
1 s single task.

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
| Local key and read in a concentrated audio cell, separate 15.68 MB probe, ms | — | 22.06 [4.97–50.76] |
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

### Where split time goes

The 49.10 ms split is dominated by the prototype reader. In five instrumented runs after a warm-up,
the split transaction, including its observers, took a median **0.25 ms** (0.19–0.27). The subsequent
`changes()` took **47.39 ms** (41.45–58.73), including **45.69 ms** in `project()`. That structural path
rebuilds all 300 existing rows and the new one. It makes 301 uncached `visualDelta()` calls, which read
every visual cell's `Y.Text.toDelta()` and follow its linked entries, including deleted ones. Those calls
took **37.11 ms** (30.60–44.97) at 15 MB and **1.28 ms** (1.19–1.51) at 0.5 MB. The rest of
`changes()` took **10.85 ms** (10.27–13.76) at 15 MB. It includes building row HTML and comparing
fields and runs via `JSON.stringify`, work that depends on beat count and visible formatting runs.
The independent review timed **0.5–1.1 ms** for the write, **31–36 ms** for `changes()` and
**20–25 ms** for the visual reads (**0.25 ms** at 0.5 MB). Both runs locate the cost in full projection.
For this split, a reader that rebuilt only the touched rows and cached unchanged cell deltas would
pay about the write plus reading one changed source cell, with additional row and order bookkeeping.
That cost is an estimate. [Visual read](../native/variant.ts#L563) ·
[Projection and comparisons](../native/variant.ts#L632-L690)

### Concentrated cell history

Counting the linked Yjs items in each of the 600 text cells after reload gave a median of **2,154**
and a maximum of **3,947**. The column medians were **3,441** for audio and **1,254** for visual.
The review reported a median of **1,386** and the same maximum. The median difference is unresolved.

The concentration probe starts from editing day 11,232 of the E8 fixture. It prepends a temporary
68,354-character paste to the middle audio cell, alternates underline on and off one character at a
time using a second client ID, then deletes the paste. The visible text checks passed after reload.
The resulting **15,680,416-byte** state has **140,001 entries** in that cell, 9.5% of the document.
Five fresh copies each took 11 local keys at positions across the cell through the same undo and
incremental read path. The **22.06 ms** median exceeds both the **1 ms** layer share and the **8 ms**
app ceiling. Separately timed medians were 16.31 ms for the write including its observers and
5.76 ms for the subsequent read.

A second pattern built up the cell with 75,776 seeded, equal-length replacements of 5–20 characters.
It reached 140,115 entries and took 23.49 ms median and 49.01 ms maximum on a 17.45 MB state.
The independent review's 140,000-entry cell took 1.7 ms median and 3.6 ms maximum. All three probes
exceed the layer share. The variation shows that entry count alone is insufficient to predict
hot-cell latency.

This walk also explains part of the cost of small reconnects. The timed apply includes observers that
read `YTextEvent.delta`, which traverses the full history of every touched text cell, including its
deleted entries. It can do substantial work for a small incoming update. The later correctness read
is outside the apply timer. [Text observers](../native/variant.ts#L187-L208)

## Years of use

At the one-writer plain-key rates measured in [E4](../format-keys/RESULT.md), **15 MB represents about
37.1 years of realistic editing or 6.80 years of heavy editing**, with 250 editing days per year. E4's
realistic fixture grew from 36,535 bytes on day 1 to 437,985 on day 250, or 0.403 MB per year at that rate.
The heavy fixture grew from 45,448 to 2,234,969 bytes, or 2.198 MB per year. The estimate extends each
day 1–250 slope from its day 1 starting size and assumes it stays constant. The E8 generator's 11,806
synthetic days use a simpler, fixed-length schedule with a different byte growth rate.

E4 divides a fixed amount of daily work among one, two or six writers. The estimate assumes one
writer's day of edits per editing day. If each of N writers does that much work, divide the estimate
by N, assuming the byte growth adds linearly. For six writers that is about 6 years at the realistic
rate or 1.1 years at the heavy rate. The independent review estimates that the chosen scheme, with
per-application production tag keys, adds about **9–10%** stored bytes over plain keys.

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
replica's stored shape. At **0.5 MB only**, the letter-by-letter replay of the same schedule, with a read
after each edit, matches the batched build's stored bytes and visible-text SHA-256. That comparison covers
the scripted replacements. Typos, caret jumps, interleaved writers and the 15 MB replay are outside this
cross-check. The independent review measured about **9.8 stored bytes per Yjs entry** for both batched
edits and typing with 6% typo-and-backspace in a separate comparison. Similar encoded sizes and entry
counts support carrying over the whole-document load, heap and whole-history reconnect results to
comparably shaped histories. Local typing, structural reading and short reconnects also depend on which
cells hold the history and which cells a command or update touches. Both builds independently record and check
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

In separate fresh processes, the bare `Y.Doc` held **306.66 MiB** at 15 MB. The loaded replica before
projection held **306.72 MiB**, and its first full read brought it to **308.21 MiB**, about **1.5 MiB**
above the bare document. These are medians of three runs per condition with the same post-GC method.
The bare document held **1,402,898 Yjs entries**, about **229 heap bytes per entry**. Of those entries,
**1,393,993 (99.4%)** were garbage-collected tombstones in text histories, which include deleted
formatting markers. The original benchmark's after-read heap was **31.6×** the encoded bytes at
0.5 MB and **24.0×** at 15 MB when both sides use bytes. The 15 MB figure is **22.9 MiB of heap per
decimal MB stored**. The earlier 343.85 MiB figure at 15 MB leaves about **36 MiB** unattributed by
the isolated breakdown.

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
- In the pinned provider, `HocuspocusProviderWebsocket` defaults `messageReconnectTimeout` to **30 s**
  and checks every 3 s. Its watchdog runs after the socket has received its first complete message.
  Each subsequent complete message, including a connection ping, resets it. A 15 MB first state sync
  takes about 30 s at **4 Mbit/s** before overhead. With automatic retry after a handshake, such a sync
  can repeatedly reconnect if it takes longer than the watchdog and no other complete message arrives in time.
  [Provider use](../service/instance/client.ts#L119) · [Pinned version](../../package-lock.json)
- [`service/instance/extension.ts`](../service/instance/extension.ts) caps the instance-management
  HTTP request body at **3 MiB**, including JSON and the base64 initial state. That leaves at most
  **2.25 MiB** of binary state before subtracting the envelope.
  [`service/images/service.ts`](../service/images/service.ts) caps both declared and streamed image
  uploads at **16 MiB**. [`service/images/store-worker.ts`](../service/images/store-worker.ts) repeats
  the same guard before storing a PNG. The [instance client](../service/instance/client.ts#L63)
  aborts the HTTP request after **15 s** via `AbortSignal.timeout(15000)`, including an upload and
  the wait for its reply.
- The current [`server/server.ts`](../../../../server/server.ts) handles static GET and HEAD requests.
  The former HTTP collaboration server (`server/server.js` in `309c15d9f^1`, removed in PR #849)
  capped JSON document create and save requests at **25 MiB** by default via `MAX_BODY_BYTES` and
  returned HTTP 413 for an oversized body. Its endpoints used **8 KiB** for small join and link
  requests, **512 KiB** for comment requests and **256 KiB** for missing-blob queries. The same server
  and its blob helper used **8 MiB** per blob, a **20 MiB** review blob budget and a **100 MiB**
  `LINK_EDIT_BLOB_BUDGET` for scoped edit links by default.
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
