# Collaboration feasibility workspace

Stage 1 prototypes live here: code in `src/`, tests in `test/`, and minimized failing histories in `histories/`. Nothing in this folder ships.

With Node 24.22.1, install and test from this folder:

```sh
npm ci
npm test
```

Tests run directly from strict TypeScript with Node's built-in type stripping and `node --test`. Root lint, typecheck, comment and dependency gates cover this workspace; its tests run separately from `npm run verify`.

Pinned versions: `yjs` 13.6.33, `y-protocols` 1.0.7, `@hocuspocus/server` and `@hocuspocus/provider` 4.8.0, TypeScript 6.0.3 and `@types/node` 24.19.2.

The prototype may read app code from `src/core/` and `shared/` only. Nothing outside `prototypes/` may import it.

See the [Stage 1 experiments](../../docs/collaboration/stage-0/9-stage-1-experiments.md).

## Identity harness

`src/model.ts` owns the independent character representation and first-difference checker. It imports no Yjs or app module. Each character has its raw `{client, clock}`, fixture notation, value, marks and beat. Literal oracles in `test/oracles.ts` name identities as artifact 8 does. An append-only creation ledger binds those names to raw identities once, when a fixture operation creates an item; it never derives an expected string, mark, caret or recovery result. A copy gets a new identity, even when its value is unchanged. Undo restores use names such as `s2*` with their new raw identity.

`src/reader.ts` independently walks `flow` (A), or `order`, segment heads and segment text (B), using `toDelta` and public relative-position APIs. It reads beat metadata, retained soft removals and joins. It does not call the candidate's character scanner or a production decoder. The compatibility reading of a single `cmt` attribute exists only to expose the lost-overlap defect as a missing comment identity.

`src/delivery.ts` retains individual update bytes until explicitly delivered. `D1` exchanges after concurrent actions; a `D2` runner delivers the first action before the second acts; a `D3` runner delivers Bob's change between buffer start and commit. `dup` delivers each update twice; `rev` reverses messages, including same-client dependencies; `late-C` hydrates Carol from one replica's full state, then attaches her to the same queue. No clocks or random scheduling drive delivery.

The six deliberate defects run against literal oracles under both layouts. Their minimized histories live in `histories/`. T06 and T11 here are narrowly labeled defect probes, not endorsements of their full structural fixtures. T05 runs end to end, including selective undo and carets, under D1, dup, rev and late-C, and again with Alice and Bob's client IDs swapped. The client-ID-dependent side of a split matches the predicted product limitation; neither candidate is selected.

## Simulated editable beat

`src/editing-buffer.ts` retains each paint's text, identities, marks, epoch, beat version and selection positions. Synthetic composition events and native edit ranges mutate a separate string. Commit derives the replacement from retained character origins when target evidence exists, including identical or nonminimal replacements; without that evidence it requires an unambiguous minimal difference. It maps deletions by identity and inserts replacements before deleting their selected content. A removed beat's retained text is the explicit recovery destination. Undo reanchors both ends of a selection to the new restored identities before those positions are shared with other replicas.

M1 holds inbound bytes while dirty. M2 integrates them immediately, repaints clean buffers synchronously and cancels a stale `beforeinput` into a model edit. M3 has separate network and editor documents with origin-filtered forwarding. All run under A and B; these are simulations of the binding contract, not real editor integration or a mechanism selection.

Read [buffer-results.md](buffer-results.md) for the measured matrix, failure probes and remaining limits. `npm run experiments` reproduces it; `node src/buffer-report.ts --write` refreshes the generated report and histories after an intentional experiment change. The tests require those artifacts to match the experiment exactly. Literal expected states remain in `test/buffer-oracles.ts` and `test/buffer-replacements.ts`; regenerating evidence does not alter them.

## Browser beat slice

Read [slice-results.md](slice-results.md) for real browser input observations, the 72-case trace matrix, retained histories and the differences from the app. This is an isolated one-beat page, not the app's editor binding. Candidate A runs under all three mechanisms with the existing literal buffer oracles. Target-evidenced identical-text replacement now passes commit and undo under every mechanism; repainting active composition still exposes a limitation.

`npm run slice` builds `slice.html` into a temporary local file, drives one headless Edge through its debugging protocol, and records `slice-evidence.json`, the generated report and histories. Run it through the smoke-lock wrapper described in the report; set the lane's TEMP/TMP first. The browser chooses a free port and temporary profile and is closed in finally. `SLICE_EDGE` can override its executable path. The prototype-only `esbuild` 0.28.2 dev dependency bundles the TypeScript page and Yjs; the protocol client uses Node's built-in WebSocket.

Browser execution is separate from `npm test`. Browser-free tests recheck retained forward/undo models through the independent checker, assert the failure evidence and require generated report/history consistency. `node src/slice/report.ts --check` checks just those generated artifacts; `--write` regenerates them from retained raw evidence without launching a browser.

## Structural traces

[structure-results.md](structure-results.md) records the beat and movement matrix. `node src/structure-report.ts` reruns it; `--write` refreshes the report and native-undo failure histories. `test/structure.test.ts` checks every required delivery order, specified undo checkpoint and retained artifact. Full T06 includes visual identities, folded gallery links, unchanged stored gallery items, statuses, both join undos and the earlier bold step. Its narration-only deliberate-defect probe remains separately named.

`src/structure-reader.ts` independently scans candidate state, including headings, removed identities, visual components and gallery items. The model checks those fields against literal data. Join retirement and top-item-only undo are explicit prototype mechanisms with their storage and reader costs listed in the report. Nothing here selects a schema or changes app code.

## Marks and scalar traces

[mark-results.md](mark-results.md) records full T11, all T20/T21 rows, status mechanism probes and a fully-deleted-comment limitation. `node src/marks/report.ts` reproduces it; `--write` refreshes the generated report and retained histories. `test/marks/marks.test.ts` checks the literal oracles and generated artifacts. T11's overlap-only deliberate-defect oracle remains separately named; its full oracle now includes R2, replies, the split/removal, recovery, carets and undo.

`src/marks/` holds the prototype commands, reader rules and evidence generation. Every replica now declares its root types before hydration, including late join and reload. The retained failure comes from deliberately bypassing initialization of A's root `flow`: later promotion to `Y.Text` resets its formatting flag. B's nested text has no equivalent exposure in these probes. No undo-retention dependency is claimed. `node src/marks/mutation-audit.ts --write` checks the report's mechanisms in an isolated copy and refreshes `mark-mutations.json`; the report identifies surviving mutations and withdrawn claims. Full PROJ belongs to a separate lane; the omitted-field defect stays active.
