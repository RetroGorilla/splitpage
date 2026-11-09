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
