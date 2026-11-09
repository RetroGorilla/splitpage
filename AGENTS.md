# Working on Splitpage as an agent

Read this first. It is the short version of the rules; the linked documents hold the detail. Where this file and a linked document disagree, the document wins, and this file needs fixing.

## Setup

- Node 24.22.1 (`.nvmrc`). The test runner warns on other versions and refuses versions outside `package.json`'s `engines`: on 22.22.0 two PDF tests break for the runtime, not the code. Install the pinned version before anything else.
- `npm ci`, then the commands below.
- Branch from `main`, and open pull requests against `main`. It is the only long-lived branch; a release is a tag on it.

## Where code lives

| Folder | What it holds | May import |
| --- | --- | --- |
| `src/core/` | Pure document, text, merge and production logic. No DOM, no timers, no globals | core, `shared/` |
| `src/application/` | Owners: the one module that holds a piece of state and is the only way to change it (session, preferences, saving, undo) | core, `shared/` |
| `src/adapters/` | Files, storage, formats (DOCX, PDF, XLSX), desktop, transport | core, `application`, `shared/` |
| `src/features/<name>/` | One part of the screen. `ports.ts` lists what it needs, `actions.ts` its actions, `mount.ts` its DOM events | core, `application` (types and pure functions only), `features/common`, `shared/` |
| `src/features/common/` | Stateless DOM helpers shared by features | as features |
| `src/bootstrap/wiring/<name>.ts` | Builds one feature's ports from the real owners and mounts it | anything |
| `src/bootstrap/wiring/ports/` | Shared ports, one module per responsibility (document, editing, text, preferences, screen, effects...) | anything |
| `src/bootstrap/actions.ts` | The one ordered list of action registrations, pinned by `tests/bootstrap/action-order.test.ts`. The command menu applies its own display order; see [feature-ports.md, Rule 6](docs/architecture/feature-ports.md#rule-6-features-own-their-action-definitions-bootstrap-owns-their-order) | anything |
| `src/bootstrap/main.ts` | The composition root and build entry: wires the app, then mounts owners and features in a fixed order. `tests/bootstrap/composition-root.test.ts` pins the order | anything in `src/bootstrap/`; outside it, only its frozen set |
| `server/`, `desktop/`, `shared/` | Static file server for `start.mjs`, Electron shell, code shared by all three | see the layer table |

The layer table is enforced by `npm run check:deps`: [dependencies.md, Layers](docs/architecture/dependencies.md#layers).

Loading any module under `src/application/` defines functions, types, plain classes and frozen data, and nothing else: no call but `Object.freeze`, no `new`, no statement, no mutable binding except an empty `let x: T | null = null` slot that an explicit start fills from the wiring, and whose accessors throw while it is empty. `tests/application/owners-construct-nothing.test.ts` scans every module in the folder and checks each one's exports.

A feature never imports another feature. To reach one, it runs that feature's action, reads or subscribes to an owner, gets an output callback from the wiring, or shares a stateless helper in `features/common`: [feature-ports.md, Rule 5](docs/architecture/feature-ports.md#rule-5-features-reach-each-other-four-ways).

## Finding your way for a feature change

Start with the feature map: run `node tools/code-map.mjs` (or `node tools/code-map.mjs > /tmp/feature-map.md`) to see, for every feature folder, its files, its wiring, the shared ports that wiring uses, its actions and its tests. Then, for feature `X`, read in this order and stop when you have enough:

1. `src/features/X/` (logic, `ports.ts`, `actions.ts`, `mount.ts`) and its tests (`src/features/X/*.test.ts`, `tests/features/X/`).
2. `src/bootstrap/wiring/X.ts`: which real owner each port field comes from.
3. The port module or owner it names, under `src/bootstrap/wiring/ports/` or `src/application/`.

A moved feature file starts through `start<Name>(ports)`, such as `startFind` in `find.ts`. Changing logic inside a feature is normally one file. Giving a feature a new dependency means its `ports.ts`, its wiring file, its tests and the fake in `tests/features/fakes.ts`.

## Hard rules

These come from the maintainer. Each one has been broken by an agent before.

1. **No new comments, except reason comments.** A reason explains why, not what; review judges that. It is at most two consecutive comment lines of at most 120 characters each, beginning `// why: ...`, `# why: ...` in shell, PowerShell or YAML run blocks, or `/* why: ... */` in CSS. A second line is a plain continuation directly below. A `docs/<file>.md#<anchor>` link is optional, but its heading must exist. All other new comments fail; reasons never enter the baseline. See [plan section 2](docs/IMPLEMENTATION-PLAN.md#no-comments-in-authored-code).
2. **Never skip, disable or loosen a product test.** An assertion may be updated when the behaviour is meant to change, never weakened to get green. Tests for deleted tool code may be removed with it.
3. **Structural PRs change no behaviour.** A move says which responsibility moves where and which dependency it removes, in a "Structure" section of the PR body.
4. **No compatibility re-exports.** When something moves, update every importer. Do not leave a file that re-exports the old name. There are no exceptions: the composition root imports each mount from its own wiring module.
5. **Features take named ports.** Build ports from `src/bootstrap/wiring/ports/` and owner types narrowed with `Pick`; never copy a file's old import list into a port: [feature-ports.md, Rule 2](docs/architecture/feature-ports.md#rule-2-a-port-is-built-from-shared-ports-owner-types-and-the-features-own-needs).
6. **Stay in scope.** No features nobody asked for. Side fixes only for data loss, a crash, or something that blocks the task.
7. **One name per exported type.** Two modules may not export a type or interface with the same name. Import the existing one when it means the same thing, otherwise pick a name that says the difference. `tools/test-code-map.mjs` enforces this.
8. **Baselines never grow.** `tools/dep-baseline.json` and `tools/comment-baseline.json` may lose entries, never gain them. A resolved entry only warns; drop it with `--prune` when you see the warning.
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
node tools/code-map.mjs                   # prints the feature map; fails on duplicate type names
```

Before you push, run the full gate once: `npm run verify` (lint, types, both gates, app and preload builds, generated-file checks, every unit, desktop and tool test). The tests take about 10 minutes, so do not run the full suite after every edit.

Anything a person can see also needs its browser suites, which PR CI mostly does not run (the nightly run does): `node tools/run-suites.mjs <out-dir> '<regex over suite filenames>'`. Which suites go with which change: [testing.md, What to run for which change](docs/architecture/testing.md#what-to-run-for-which-change). The browser harness is described in [the run-splitpage-app skill](.claude/skills/run-splitpage-app/SKILL.md).

Typing, editing and undo changes also need a performance comparison (`tools/perf-ab.mjs`); see [performance-record.md](docs/architecture/performance-record.md).

## Documents

- [IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md): the completed implementation record and its standing rules.
- [docs/architecture/](docs/architecture/): current design. Start with [feature-ports.md](docs/architecture/feature-ports.md) (ports and wiring for features), [dependencies.md](docs/architecture/dependencies.md) (gates and layers), [saving.md](docs/architecture/saving.md), [session.md](docs/architecture/session.md) and [testing.md](docs/architecture/testing.md).
- [review.md](docs/architecture/review.md): what review checks before a merge.
- [ROADMAP.md](docs/ROADMAP.md): the current release, completed work and links to open work. Check GitHub before starting.
- [COLLABORATION-PLAN.md](docs/COLLABORATION-PLAN.md): the plan of record for collaboration. Nothing in it is built; do not start it without being asked.
- Finished milestone plans and gate records were removed from the tree. Read them in git history if you need the record, and do not treat them as current rules.
