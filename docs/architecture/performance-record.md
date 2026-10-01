# Performance record

Recorded 2026-09-30 by `node tools/perf-record.mjs`, once. The numbers describe this machine and browser; compare a later run only under the same conditions.

## Conditions

- Machine: linux 6.18.44-fc-v50 x64, Intel(R) Xeon(R) Processor @ 2.80GHz x4, 15.7 GB, Node v22.22.2
- Browser: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36, headless, viewport 1400x900 at 1x
- Script font: `"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", Verdana, sans-serif`; Atkinson Hyperlegible Next is not installed, so a fallback family drew the text
- Fixtures: short is the seed script (2 scenes); long is the long demo (30 scenes)
- Typing: 55 characters, one real key event every 60 ms, into scene 2's audio cell; latency is key-down to the frame after it

## Input latency (ms)

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

## Export (median of 5 runs, ms)

| Fixture | .splitpage | .md project | Standalone HTML |
| --- | --- | --- | --- |
| short | 0.5 | 1.2 | 0.6 |
| long | 6.1 | 13.3 | 4 |

.docx, PDF, CSV and .xlsx have no page hook to time them by and are not measured.

## After milestone 2 (Windows)

Recorded 2026-10-01 by `node tools/perf-record.mjs`, once, on 4.0-development with milestone 2 merged (`m2/close`, built with `node build.mjs`). It is a different machine from the record above, so the two are not comparable: the numbers below say whether milestone 2 left typing, row edits and exports within the same order of cost on a fast desktop, not how much each changed against the Linux container. A comparison against the starting point needs a run on the starting commit under these same conditions.

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

No long task fired in any case, so per-keystroke work stays bounded and coalesced on both fixtures.