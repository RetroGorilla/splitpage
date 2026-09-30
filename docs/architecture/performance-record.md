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
