# Working on Splitpage as an agent

Read this first. It is the short version of the rules; the linked documents hold the detail. Where this file and a linked document disagree, the document wins, and this file needs fixing.

## Setup

- Node 24.22.0 (`.nvmrc`). The test runner refuses older versions on purpose: on 22.22.0 two PDF tests break for the runtime, not the code. Install it before anything else.
- `npm ci`, then the commands below.
- Pull requests target `4.1-development`, not `main`.

## Where code lives

| Folder | What it holds | May import |
| --- | --- | --- |
| `src/core/` | Pure document, text, merge and production logic. No DOM, no timers, no globals | core, `shared/` |
| `src/application/` | Owners: the one module that holds a piece of state and is the only way to change it (session, preferences, saving, undo) | core, `contracts`, `shared/` |
| `src/adapters/` | Files, storage, formats (DOCX, PDF, XLSX), desktop, transport | core, `application`, `shared/` |
| `src/features/<name>/` | One part of the screen. `ports.ts` lists what it needs, `actions.ts` its actions, `mount.ts` its DOM events | core, `application` (types and pure functions only), `features/common`, `shared/` |
| `src/features/common/` | Stateless DOM helpers shared by features | as features |
| `src/bootstrap/wiring/<name>.ts` | Builds one feature's ports from the real owners and mounts it | anything |
| `src/bootstrap/wiring/ports/` | Shared ports, one module per responsibility (document, editing, text, preferences, screen, effects...) | anything |
| `src/bootstrap/actions.ts` | The one ordered list of actions. Order is what the command menu shows; `tests/bootstrap/action-order.test.ts` pins it | anything |
| `src/bootstrap/main.ts` | The composition root and build entry: wires the app, then mounts owners and features in a fixed order. `tests/bootstrap/composition-root.test.ts` pins the order | anything in `src/bootstrap/`; outside it, only its frozen set |
| `src/legacy/` | Retired; do not add files here | core, `application`, `adapters`, `shared/`; never features or bootstrap |
| `server/`, `desktop/`, `shared/` | Static file server for `start.mjs`, Electron shell, code shared by all three | see the layer table |

The layer table is enforced by `npm run check:deps`: [dependencies.md, Layers](docs/architecture/dependencies.md#layers).

A feature never imports another feature. To reach one, it runs that feature's action, reads or subscribes to an owner, gets an output callback from the wiring, or shares a stateless helper in `features/common`: [feature-ports.md, Rule 5](docs/architecture/feature-ports.md#rule-5-features-reach-each-other-four-ways).

## Finding your way for a feature change

Start with [feature-map.md](docs/architecture/feature-map.md). It lists, for every feature folder, its files, its wiring, the shared ports that wiring uses, its actions and its tests. Then, for feature `X`, read in this order and stop when you have enough:

1. `src/features/X/` (logic, `ports.ts`, `actions.ts`, `mount.ts`) and its tests (`src/features/X/*.test.ts`, `tests/features/X/`).
2. `src/bootstrap/wiring/X.ts`: which real owner each port field comes from.
3. The port module or owner it names, under `src/bootstrap/wiring/ports/` or `src/application/`.

A moved feature file starts through `start<Name>(ports)`, such as `startFind` in `find.js`. Changing logic inside a feature is normally one file. Giving a feature a new dependency means its `ports.ts`, its wiring file, its tests and the fake in `tests/features/fakes.ts`.

## Hard rules

These come from the maintainer. Each one has been broken by an agent before.

1. **No new comments, except reason comments.** `npm run check:comments` fails on any new comment in authored code, tests, CSS, HTML or config. The one exception is a single line in a script, at most 120 characters: `// why: docs/<file>.md#<heading-anchor> <optional short reason>`. The gate checks that the heading exists. Put the reasoning in the document and point at it from the code: [plan section 2](docs/IMPLEMENTATION-PLAN.md#no-comments-in-authored-code).
2. **Never skip, disable or loosen a test.** An assertion may be updated when the behaviour is meant to change, never weakened to get green.
3. **Structural PRs change no behaviour.** A move says which responsibility moves where and which dependency it removes, in a "Structure" section of the PR body.
4. **No compatibility re-exports.** When something moves, update every importer. Do not leave a file that re-exports the old name. There are no exceptions: the composition root imports each mount from its own wiring module.
5. **Features take named ports.** Build ports from `src/bootstrap/wiring/ports/` and owner types narrowed with `Pick`; never copy a file's old import list into a port: [feature-ports.md, Rule 2](docs/architecture/feature-ports.md#rule-2-a-port-is-built-from-shared-ports-owner-types-and-the-features-own-needs).
6. **Stay in scope.** No features nobody asked for. Side fixes only for data loss, a crash, or something that blocks the task.
7. **One name per exported type.** Two modules may not export a type or interface with the same name. Import the existing one when it means the same thing, otherwise pick a name that says the difference. `tools/test-code-map.mjs` enforces this.
8. **Baselines only shrink.** `tools/dep-baseline.json` and `tools/comment-baseline.json` may lose entries (`--prune`), never gain them.
9. **Read the invariants before touching saving, merging, history, undo or the document format.** [HANDOFF.md](docs/HANDOFF.md) and [invariants.md](docs/architecture/invariants.md). Several tests exist only to hold them in place.
10. **PR titles and bodies name no AI model or tool.**
11. **Convert a JS file to TypeScript before changing it substantially.** Before a substantial change (more than a small fix) to a `.js` file under `src/features/`, `src/application/` or `src/adapters/`, convert it to strict TypeScript in its own PR first: types only, no behaviour change, then the change on top. Files nobody is changing stay JavaScript. Files on the typing, undo or save path need the same review and performance check as any change there.

## Checking your work

While you work, run only what covers your change. It takes seconds:

```
npm test -- --only src/features/find      # a folder or file
npm run typecheck                         # about 30 s
npm run check:deps                        # about 7 s
npm run check:comments
npm run lint                              # about 45 s
node tools/code-map.mjs                   # feature map current, type names unique
```

When you add, move or delete a file under `src/features/`, a wiring file or an action, run `node tools/code-map.mjs --write` and commit the regenerated `docs/architecture/feature-map.md`.

Before you push, run the full gate once: `npm run verify` (lint, types, both gates, build, every unit test). The unit tests alone take about 10 minutes, so do not run the full suite after every edit.

Anything a person can see also needs its browser suites, which PR CI mostly does not run (the nightly run does): `node tools/run-suites.mjs <out-dir> '<regex over suite filenames>'`. Which suites go with which change: [testing.md, What to run for which change](docs/architecture/testing.md#what-to-run-for-which-change). The browser harness is described in [the run-splitpage-app skill](.claude/skills/run-splitpage-app/SKILL.md).

Typing, editing and undo changes also need a performance comparison (`tools/perf-ab.mjs`); see [performance-record.md](docs/architecture/performance-record.md).

## Documents

- [IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md): the plan and its standing rules.
- [docs/architecture/](docs/architecture/): current design. Start with [feature-ports.md](docs/architecture/feature-ports.md) (ports and wiring for features), [dependencies.md](docs/architecture/dependencies.md) (gates and layers), [saving.md](docs/architecture/saving.md), [session.md](docs/architecture/session.md) and [testing.md](docs/architecture/testing.md).
- [review.md](docs/architecture/review.md): what review checks before a merge.
- Finished milestone plans and gate records were removed from the tree. Read them in git history if you need the record, and do not treat them as current rules.
