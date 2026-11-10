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
