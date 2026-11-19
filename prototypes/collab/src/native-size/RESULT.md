**Yes.** The Node prototype completed all tested operations on a 15,036,020-byte shared document on a
Windows arm64 laptop with 16 GB RAM. In the evenly edited fixture, the first local keystroke came
closest to the proposed 1 ms layer share, with a 0.734 ms median and a 0.963 ms maximum. Across all
local keystrokes the median was 0.201 ms. The original 15.68 MB probe with 140,001 entries in one cell
took 22.06 ms per key at the median. An instrumented replay of the same bytes took 3.23 ms. Both
exceed the layer share. The original run also exceeded the app's 8 ms end-to-end ceiling.
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
| Local key and read in a concentrated audio cell, original 15.68 MB probe, ms | — | 22.06 [4.97–50.76] |
| Same concentrated cell, instrumented replay at the same offsets, ms | — | 3.23 [2.30–6.39] |
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

#### What the probe builds

[`hot-cell.ts`](hot-cell.ts) starts from day 11,232 of E8. The middle audio cell has 54 visible
characters, 3,270 old tombstones, 13 live text entries and 10 live format markers. The original
probe prepends 68,354 `x` characters under one client ID. A second ID alternates underline on and
off letter by letter in one delta. One delete then removes the whole temporary span. The result is
the original **15,680,416-byte** state with **140,001 linked entries**, including **139,978 deleted**.
The new tombstones come from **68,354 text entries and 68,354 format markers**. GC erases that
distinction in the stored items. The 3,270 pre-existing tombstones have unknown provenance and the
10 live markers are unchanged.

The matched plain-text build interleaves one `y` from the second client ID after each `x`, then
deletes all 136,708 letters. It leaves **136,708 new text tombstones and zero new format tombstones**.
In both builds the two client IDs alternate along the linked list. Neighbours cannot merge across
client IDs, so the deleted-entry count equals the pre-delete text and marker count. The suffix versions
place the same additions after the visible text. They retain the same number of entries in roughly
15.34 MB. Every measured copy rechecks the visible-script signature and the cell composition.

#### Time per key at 140,001 entries

The first key is the first edit after load and projection. Start is offset 0, middle is offset 27 and
end is offset 54. The ten subsequent keys start immediately after the previous insertion. The original
probe's sweep instead walks through the original 54 characters in 11 roughly even steps, starting at
offset 4. Both use `UndoLayer.type()` and the immediate `changes()` read.

Each row below is a median in milliseconds. The instrumented replay takes five fresh copies for the
formatted-prefix rows and three per other row. Component columns show the ten warm keys per copy.
Insert times `Y.Text.insert()` inside the transaction before outer observers. Observer times the
target cell's `event.delta` getter. View includes the replica's cache checks and uncached cell read,
with its `toDelta()` time in parentheses. Caret is the relative-position lookup outside the view
timer. Other includes the remaining transaction handling, undo bookkeeping and row projection.
The component medians are computed independently.

| Hot history | Key position | First / warm total | Insert | Observer | View (toDelta) | Caret | Other |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| prefix formatted | sweep | 5.43 / 2.96 | 0.76 | 0.69 | 0.64 (0.63) | 0.54 | 0.21 |
| prefix formatted | start | 4.97 / 2.57 | 0.62 | 0.65 | 0.61 (0.61) | 0.47 | 0.13 |
| prefix formatted | middle | 6.42 / 2.65 | 0.66 | 0.67 | 0.62 (0.62) | 0.47 | 0.13 |
| prefix formatted | end | 4.90 / 2.81 | 0.72 | 0.69 | 0.63 (0.62) | 0.45 | 0.15 |
| prefix plain | start | 5.45 / 2.64 | 0.66 | 0.69 | 0.61 (0.60) | 0.42 | 0.12 |
| prefix plain | middle | 6.81 / 3.18 | 0.78 | 0.78 | 0.72 (0.71) | 0.50 | 0.21 |
| prefix plain | end | 4.92 / 2.83 | 0.72 | 0.74 | 0.65 (0.64) | 0.48 | 0.15 |
| suffix plain | start | 3.14 / 1.74 | 0.07 | 0.75 | 0.70 (0.69) | 0.04 | 0.13 |
| suffix plain | middle | 4.12 / 1.53 | 0.04 | 0.71 | 0.63 (0.63) | 0.02 | 0.10 |
| suffix plain | end | 6.10 / 2.75 | 0.69 | 0.72 | 0.64 (0.63) | 0.46 | 0.13 |
| suffix formatted | start | 3.25 / 1.75 | 0.05 | 0.76 | 0.71 (0.70) | 0.04 | 0.15 |
| suffix formatted | middle | 4.46 / 1.77 | 0.06 | 0.75 | 0.68 (0.68) | 0.04 | 0.15 |
| suffix formatted | end | 5.93 / 2.74 | 0.69 | 0.73 | 0.62 (0.62) | 0.47 | 0.13 |

The replay rebuilt the original bytes and entry counts. Its sweep median was **3.23 ms** (2.30–6.39),
compared with **22.06 ms** (4.97–50.76) in the original run. The review measured **1.7 ms** median and
**3.6 ms** maximum on its desktop case. On this laptop, a warm key before a deleted suffix reproduced
the roughly 2 ms result. That position avoids most of the history in the insert and caret lookup.
An end key meets the tombstones while looking for the insertion point, and a prefix puts them in the
path at all three positions. Plain and formatting-origin tombstones timed similarly at matching
positions. The observer and `toDelta()` still walk the whole cell in every case. These comparisons
isolate the cost of position and repeated reads. They leave the exact gap between the original run and
the desktop review unresolved.

#### Entry counts and the typing targets

A single-beat control keeps the same 54 visible characters and prepends the two histories at increasing
entry counts. Each condition uses three fresh copies per position with one first key and ten warm keys
per copy. Cells show first / warm median milliseconds. The last column is the maximum key time across
both builds and all positions at that entry count.

| Entries | Plain start | Plain middle | Plain end | Formatted start | Formatted middle | Formatted end | Max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 501 | 0.32 / 0.11 | 0.32 / 0.11 | 0.22 / 0.09 | 0.25 / 0.10 | 0.20 / 0.09 | 0.21 / 0.08 | 0.93 |
| 1,501 | 0.43 / 0.11 | 0.38 / 0.15 | 0.38 / 0.16 | 0.48 / 0.09 | 0.46 / 0.12 | 0.39 / 0.10 | 0.51 |
| 4,001 | 0.76 / 0.15 | 0.52 / 0.14 | 0.48 / 0.16 | 0.68 / 0.16 | 0.43 / 0.16 | 0.35 / 0.15 | 0.88 |
| 8,001 | 1.05 / 0.24 | 1.01 / 0.22 | 0.97 / 0.24 | 0.99 / 0.24 | 1.06 / 0.24 | 1.02 / 0.25 | 1.81 |
| 16,001 | 1.73 / 0.45 | 1.41 / 0.42 | 1.63 / 0.41 | 1.93 / 0.44 | 1.46 / 0.41 | 1.45 / 0.41 | 2.21 |
| 24,001 | 2.20 / 0.71 | 2.30 / 0.66 | 2.00 / 0.68 | 2.27 / 0.70 | 2.10 / 0.66 | 1.99 / 0.66 | 3.85 |
| 32,001 | 2.78 / 1.09 | 2.74 / 0.98 | 2.88 / 1.06 | 2.75 / 0.99 | 2.33 / 0.88 | 2.58 / 0.94 | 3.41 |
| 64,001 | 4.35 / 2.84 | 4.59 / 2.67 | 4.86 / 2.71 | 4.68 / 2.81 | 4.68 / 2.64 | 4.81 / 2.84 | 5.00 |
| 96,001 | 5.69 / 4.11 | 5.69 / 4.18 | 5.68 / 4.26 | 5.79 / 4.56 | 5.81 / 4.11 | 5.66 / 4.28 | 6.82 |
| 140,001 | 29.73 / 23.84 | 23.68 / 19.90 | 22.42 / 18.06 | 22.40 / 20.34 | 28.83 / 23.92 | 20.27 / 16.04 | 39.63 |

In this control the plain middle key's insert, observer, view and caret medians were roughly
**0.03 / 0.03 / 0.02 / 0.02 ms** at 4,001 entries, **0.64 / 0.67 / 0.60 / 0.61 ms** at
64,001, and **4.97 / 4.23 / 5.10 / 4.74 ms** at 140,001. The remaining work stayed below 0.2 ms
at these points. The compact 140,001-entry fixture produced warm medians of 16–24 ms even though
the full E8 replay was much faster. Entry order, memory layout and run conditions can affect the
time per walk. These runs establish the number of walks and which ones depend on position.

**On this laptop, every sampled key was under 1 ms through about 4,000 entries and under 8 ms
through about 96,000 entries** in the single-beat prefix control. Warm medians stayed under
1 ms through about 24,000 entries at all positions. Some first-key medians crossed 1 ms by
8,000 entries, and some warm medians crossed it by 32,000. The 140,001-entry results span both
sides of 8 ms across fixtures and runs. These are observed bands for this reader and workload.

In the script's rewrite check, 1,000 complete plain rewrites of a 54-character beat leave 1,000
tombstones. Consecutive letters in each draft merge into one entry, and an unrelated cell edit between
drafts leaves a gap in their clocks. A separate check with 1,000 complete rewrites of a single cell
and no other edits merged the deleted drafts into **one tombstone**. In the script's fragmented
pattern, 1,000 staggered 5–20-character replacements revise 12,579 characters and leave 1,830
tombstones. At the script's observed rates, 4,000 / 24,000 / 96,000 tombstones represent about
**4,000 / 24,000 / 96,000 complete rewrites interleaved with other edits**, or **500 / 3,100 / 12,200
beat-lengths** of fragmented revisions. These are workload equivalents. Placement, formatting and
intervening edits can change how many entries survive.

Yjs performs the position search, insertion and linked-list walks. The prototype asks for two
whole-cell walks after a key, first by consuming the change event's delta and again by rebuilding
the cell to read its delta. The undo layer also asks Yjs for a relative caret position. A cheap raw
insert can therefore coexist with a slow key. When history precedes the edit, the insert and caret
lookups can also be expensive.

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

The focused hot-cell script emits one JSON object per condition. Prepare writes the day-11,232
reference state and its signature into scratch space. Matrix uses its own one-beat fixture.

```powershell
$hot = Join-Path $env:TEMP 'splitpage-e8-hot'
$hotRunner = 'prototypes/collab/src/native-size/hot-cell.ts'
node $hotRunner prepare $hot
node --expose-gc $hotRunner e8 $hot
node --expose-gc $hotRunner matrix
```
