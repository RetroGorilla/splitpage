# Roadmap

Checked against GitHub and `origin/main` at `1abdeb32` on 2026-11-09 UTC, after the November 8 batch. GitHub issues hold the current backlog. Recheck them before starting work.

## Current release

Splitpage **0.4.1** was released on **2026-11-02**, tagged [v0.4.1](https://github.com/RetroGorilla/splitpage/releases/tag/v0.4.1). `VERSION` and `desktop/package.json` still say `0.4.1`. Changes merged after that tag are development work; they are not in the published release.

The old plans used “3.x”, “4.0” and “4.1” as milestone names. The remote tags now use `v0.3.*` and `v0.4.*`. Use the remote tags and [releases](https://github.com/RetroGorilla/splitpage/releases), rather than old plan headings, for shipped versions. No next release number or date is set here.

## Done

| Work | Evidence |
| --- | --- |
| Architecture milestones 0–7 and the later legacy reduction. The build starts at `src/bootstrap/main.ts`; `src/js/` and `src/legacy/` are gone. Server and collaboration features were removed. | #906, #905; [implementation record](IMPLEMENTATION-PLAN.md) |
| Queue AQ-1–AQ-46 completed or closed. AQ-29 was replaced by AQ-32. Desktop voice extraction AQ-37 is merged, not waiting. | #1037 (closed summary); #982, #1016 |
| Shipped source converted to strict TypeScript. Generated JavaScript and `sw.js` remain. | #1042–#1079, #1082–#1118; [performance record](architecture/performance-record.md#typescript-conversion-e44e1d03-to-fd29b083) |
| Print-based PDF output and automatic layout checks replaced the old PDF generator. | #994, #998, #1015, #1000, #1004, #1024 |
| Scene headers, first-save title/version naming, and open tags. | #1028, #1029, #1031, #1027, #1026 |
| The default performance run reaches its images fixture again. | #1039, fixed by #1121 |
| Flow Writer replaced the old Writer. | #264, #1238; [design and measured results](WRITER-FLOW-PLAN.md) |
| Attach files, copy local files beside the script, and carry bundled files on Save As. | #1277, #1267, #1281 |
| Export with files and confirmed Replace. Attach offers Copy / Move / Leave. Create bundle gathers outside files. | #260 items 1–3; #1294, #1310, #1311, #1319 |
| Scene header styling and in-place naming. | #1168 via #1313; #1166 via #1318 |
| B-roll and Comments group by scene (#1170 part a). | #1317 |
| Open-tag highlight, keyword suggestions, video-merge review, save/undo ownership, and thumbnail-merge fixes. | #1303, #1308, #1309, #1312, #1314 |
| Browser target activation and stale browser-suite selectors fixed. | #1304, #1315, #1316 |

Scene descriptions (#1171) were closed as not planned. They are not queued work.

## Next

- [#1170](https://github.com/RetroGorilla/splitpage/issues/1170): part b, Production and Gear grouping by scene. Part a is done.
- [#1167](https://github.com/RetroGorilla/splitpage/issues/1167): the shared top-bar audit leaves the save control unresolved. File menu placement belongs to [#1163](https://github.com/RetroGorilla/splitpage/issues/1163).
- #260 item 4: the Export dialog sentence, Help and CHANGELOG updates remain under Adam's November 8 decision. The issue itself is closed; confirm its tracking with Adam before starting. A separate docs PR owns Help and CHANGELOG.

Other work, including parked print spacing [#1023](https://github.com/RetroGorilla/splitpage/issues/1023), stays in the [open issues](https://github.com/RetroGorilla/splitpage/issues?q=is%3Aissue%20state%3Aopen). This page does not assign it to a release or set its order.

## Before starting

Read `AGENTS.md`, the issue and its latest owner decisions. The [old queue](AGENT-QUEUE.md) is finished. Historical plans and test records do not authorize new work. Use [RELEASING.md](RELEASING.md) when Adam calls a release.
