# Dependency and comment gates

Two scripts hold the layer rules and the no-comment rule from
[the implementation plan](../IMPLEMENTATION-PLAN.md) (sections 2 and 3).
Both parse source with the TypeScript compiler, so strings, regular
expressions, template literals and URLs are never mistaken for imports or
comments.

| Command | What it checks | Baseline |
| --- | --- | --- |
| `npm run check:deps` (`tools/dep-report.mjs`) | Layer rules, platform imports and globals, unresolvable modules, computed dynamic loads, cycles through migrated folders, and the legacy debt: `S` importers, `S` writers and runtime cycle edges | `tools/dep-baseline.json` |
| `npm run check:comments` (`tools/comment-gate.mjs`) | Comments in authored JS/TS, CSS, HTML, shell, PowerShell and batch files, and in YAML (workflow `run:` scripts included), Dockerfiles and JSON | `tools/comment-baseline.json` |

Both fail on anything new and on anything the baseline lists that has gone.
`--prune` removes gone entries and refuses to add new ones. `--init` writes a
baseline only when none exists. `node tools/dep-report.mjs --metrics` prints the
informational numbers, which are not a pass/fail condition.

## Layers

`tools/dep-report.mjs` assigns every file a layer from its path and checks each
resolved edge (static imports, re-exports, literal `require`, literal dynamic
`import()` and `import("…")` type references).

| Layer | Path | May import |
| --- | --- | --- |
| `core/document` | `src/core/document/` | itself, `shared` |
| `core/text` | `src/core/text/` | itself, `core/document`, `shared` |
| `core/merge` | `src/core/merge/` | itself, `core/document`, `core/text`, `shared` |
| `core/production` | `src/core/production/` | itself, `core/document`, `core/text`, `shared` |
| `core` | any other `src/core/` folder | any core layer, `shared` |
| `contracts` | `src/contracts/` | itself, `shared` |
| `application` | `src/application/` | itself, core, `contracts`, `shared` |
| `adapters` | `src/adapters/` | itself, core, `application`, `contracts`, `shared` |
| `features/<name>` | `src/features/<name>/` | itself, core, `application`, `contracts`, `shared` |
| `legacy` | `src/legacy/` | itself, core, `legacy-js`, `application`, `contracts`, `adapters`, `shared` |
| `bootstrap` | `src/bootstrap/` | anything |
| `shared` | `shared/` | itself |
| `tests` | `src/test/`, `tests/`, `*.test.*` | anything |
| `legacy-js`, `server`, `desktop` | `src/js/`, `server/`, `desktop/` | anything except tests |

Core, `contracts`, `application`, `shared` and feature layers may not import a
Node built-in or a package (`platform-import`). Core, `contracts`,
`application` and `shared` may not use browser, Node, timer or network globals
(`platform-global`); CommonJS `require`, `module` and `exports` are allowed in
CommonJS files.

A name is a global only where no binding for it is in scope. The report walks
the lexical scopes of each file: module, function, block, loop head, `catch`
clause and class. `var` and function declarations are hoisted to their
function (a function declared inside a block stays in the block, as in strict
code); parameters, destructured names, imports and `catch` bindings are
bindings; a function or class expression's own name is visible only inside
it. So a
parameter named `fetch` in one function does not hide a global `fetch` in the
next, and a local declared later in the module still covers an earlier
function. Property names, method names and labels are not references; a
shorthand property (`{ performance }`) is. An ambient `declare const window`
describes the global and is not a local binding. A call to `require` is a load
only where `require` is not a binding in scope. The walker adds about 0.2 s to
a full run (from about 1.2 s to about 1.4 s on the Windows workstation).

A cycle containing any file in a migrated layer (`core`, `contracts`,
`application`, `adapters`, `features`, `bootstrap`, `legacy`) fails whether it
is a runtime cycle or only closes through `import type`, and whether or not it
passes through `src/js`. Such a cycle cannot be baselined.

## Legacy debt: `S` and runtime cycles

Three rules turn the coupling the plan measures in section 4 into exact
exception sets. Each entry is `{ rule, source, target }` like any other
exception, so a change that adds one entry and removes another fails twice:
the new entry is reported as new and the old one as resolved.

| Rule | Source | Target | Recorded when |
| --- | --- | --- | --- |
| `state-import` | production module | `global:S` | it imports `S`, or re-exports it (a bridge) |
| `state-write` | production module | `global:S.<member>` or `global:S.<member>.*` | it writes a member of `S` (below) |
| `cycle-edge` | importing module | imported module | the runtime import has both ends in the same strongly connected component |

Production is every layer except `tests`, `tools` and `other`.
`src/js/_state.js`, which defines `S`, is neither an importer nor a writer.

### Importing `S`

A module imports `S` when it binds it from `src/js/_state.js`, or from a
module that re-exports it, by name (`import { S }`), alias (`import { S as
T }`), namespace (`import * as G`, then `G.S`), default, destructured literal
`await import()` or `require`, or when it loads such a module with a literal
`import()` or `require` whose result it does not bind (counted, since the
report cannot see what it does with it). `import type { S }` counts too. A
side-effect `import "./_state.js"` binds nothing and does not.

A module is a bridge when it re-exports `S`: `export { S } from`, `export *
from` or `export * as x from` a module that provides `S`, `export { S as T }`
or `export default S` of an imported `S`, or an exported alias of `S` or part
of it (`export const live = S.state`). Bridges are followed through any number
of hops, and a module importing from one is an `S` importer whose writes are
attributed as if it had imported `S` itself. A bridge is itself a
`state-import`; one in `src/legacy/` is allowed by the layer rules, and its
baseline entry carries a `reason` naming the migration that removes it. A
feature importing a bridge also breaks the layer rule.

### Writing `S`

The target names the top-level member of `S` and how it was written:

- `global:S.<member>`: the member is replaced. Assignment (`=`, compound and
  logical), `++`/`--`, `delete`, a destructuring-assignment target or a
  `for…in`/`for…of` head. `S["state"]` is `S.state`; a computed key is
  `global:S[?]`.
- `global:S.<member>.*`: something inside the member changes. An assignment,
  update or `delete` below it (`S.state.rows = []`,
  `S.state.rows.length = 0`, `S.state.rows[i].text = …`); `push`, `pop`,
  `splice`, `shift`, `unshift`, `sort`, `reverse`, `fill` or `copyWithin`
  called on a chain inside it; or the member as the first argument of
  `Object.assign`, `Object.defineProperty`, `Object.defineProperties`,
  `Object.setPrototypeOf`, `Reflect.set`, `Reflect.deleteProperty`,
  `Reflect.defineProperty` or `Reflect.setPrototypeOf`. `Object.assign(S, …)`
  is `global:S[?]`.

Writes through an alias count as writes to what it aliases: a `const`, or a
`let`/`var` that is never reassigned, initialised from a chain rooted at `S`
(`const st = S.state`, `var s = S`, `const { state } = S`); an alias of an
alias; a `for…of` binding over such a chain; and the element parameter of a
callback passed to `forEach`, `map`, `filter`, `some`, `every`, `find`,
`findIndex`, `findLast`, `findLastIndex` or `flatMap` (the second parameter
for `reduce` and `reduceRight`). Aliases are resolved with the same scope walk
as globals, so a parameter or local that shadows `S` or an alias is not
followed.

The key is per member because the members of `S` are separate pieces of
legacy state with different future owners: the document in `S.state` goes to
the session and its transactions, the prompter and voice fields to their
feature, the arming and drag flags to their views. A module that starts
writing a member it did not write before fails; a member whose writers shrink
to its new owner shows up as resolved entries. Replacing a member and changing
inside it are kept apart because they are different couplings: replacing
`S.state` swaps the object every other module holds (the session transitions
of milestone 4), changing inside it mutates shared data in place (the
document transactions of milestones 3 and 6). A module that only mutated
`S.state` in place and starts replacing it, or the reverse, fails.

### What write detection cannot see

`state-write` stops the writes it can see from spreading. It is a limited
count, as plan section 3 says of `S.state` writers, and cannot prove that a
module leaves `S` alone. It does not see:

- a value from `S` passed to a function that mutates it (`normalize(S.state)`,
  `sortRows(S.state.rows)`), returned, stored in another object or captured
  as `this`;
- a copy that shares its elements (`S.state.rows.slice()` then a write to an
  element of the copy);
- callbacks other than those listed, `Map`/`Set` and other methods not in the
  mutator list, `Function.prototype.call`/`apply` and iterator protocols;
- an alias that is reassigned anywhere in its scope (dropped, not guessed),
  and `module.exports` or computed re-exports as bridges;
- `eval`, `new Function`, and loads through a computed specifier (those are
  `unresolved-dynamic` exceptions instead).

### Runtime cycles

`cycle-edge` covers every runtime strongly connected component, legacy-only
ones included. Runtime edges are static imports, re-exports, literal
`require` and literal dynamic `import()`; `import type` is not one. A cycle
through a migrated folder also fails the migrated-cycle check above, which no
baseline entry can satisfy. An edge that closes a new loop, joins a module to
an existing one, or adds another link between two members of one is new. An
import that only points into a cycle is not part of it and passes. Removing an
edge that splits a component turns every edge no longer inside a cycle into a
resolved entry.

## Baseline workflow

- **Paying debt.** Make the change. `npm run check:deps` fails and lists the
  resolved entries; `node tools/dep-report.mjs --prune` removes them. Commit
  the smaller baseline with the change.
- **New debt.** `--prune` refuses it. The only expected additions are bridges
  and adapters in `src/legacy/`; add those entries to
  `tools/dep-baseline.json` by hand, each with a `reason`, and they are
  reviewed like any other exception.
- **Changing the rules.** Remove the baseline, run `--init`, and restore the
  `reason` fields from the previous version.

The file holds one exception per line, sorted by rule, source and target, so a
diff shows exactly which entries came and went. `--metrics` keeps the
informational numbers: `stateImporters`, `stateAssigners` (modules replacing
`S.state`) and `stateFieldWriters` (modules replacing any member) as before,
plus `runtimeCycleEdges`, `stateBridges` and `stateWriters`, the modules and
targets behind `state-write`.

## Recorded exceptions

The baseline is a list of `{ rule, source, target }`. An entry may carry a
`reason`; `--prune` keeps it. The legacy debt entries (`state-import`,
`state-write`, `cycle-edge`) carry none: they are the `src/js` modules as they
stood at the start of 4.0, and they only shrink. Every other entry, and any
bridge, is explained here.

- **`shared/video-embed.js` platform globals** (`URL`, `AbortController`,
  `setTimeout`, `clearTimeout`, `TextDecoder`). It fetches oEmbed data and
  thumbnails for the desktop shell. Moving the fetch behind an injected
  transport is 4.x desktop work (plan section 8).
- **`desktop/main.js` computed `require`** of `shared/doc-id-policy.js`,
  `history-policy.js`, `history-store.js` and `video-embed.js` through
  `SHARED_ROOT`. The packaged app and the checkout keep `shared/` in different
  places; the path is chosen at start-up.
- **`desktop/verify-dist-payload.mjs`** loads electron-builder's 7-Zip toolset
  through `require.resolve`, so the file is found in whichever copy of
  `app-builder-lib` is installed.
- **Test harnesses** (`desktop/test/verify-dist-payload.test.mjs`,
  `tools/test-run-suites.mjs`, `tools/test-update.mjs`) import the module under
  test by a computed file URL so the same file can be loaded from a temporary
  copy.

## Comment gate

Scanned: every tracked or untracked-but-not-ignored file of these kinds,
except `node_modules/`, `.claude/handoff/` and the generated `index.html`:

| Files | Parser | What counts as a comment |
| --- | --- | --- |
| `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `eslint.config.mjs` included | TypeScript (`tools/source-scan.mjs`) | `//` and `/* */` outside strings, templates and regexes |
| `.css`, `.html` (inline `<style>` and script too) | `tools/source-scan.mjs` | `/* */`, `<!-- -->` |
| `.sh`, `.ps1`, `.bat`, `.cmd` | `tools/source-scan.mjs` | `#` at a word start outside quotes and heredocs, `<# #>`, `rem`/`::` |
| `.yml`, `.yaml` | the `yaml` package's CST (`tools/config-comments.mjs`) | every YAML comment token; `#` in a quoted scalar, a URL or a block scalar's content is not one |
| `run:` of a step in `.github/workflows/*.yml` or an `action.yml` | the shell rules above, in the step's `shell:`, else `defaults.run.shell`, else the runner's: `pwsh` when a `runs-on` label (a group's `labels:` included) names Windows, `bash` when one names Ubuntu, Linux or macOS. When none says (an expression such as `${{ matrix.os }}`, a group without labels, a self-hosted runner without an OS label), the step is read both ways; if the two readings differ the gate fails and asks for `shell:` | a `#` comment inside the script, whole-line or trailing; `$#`, `${#x}`, `'#'`, heredoc bodies and `<<<` here-strings are not; a `#!` line is, because the runner ignores it |
| `Dockerfile`, `Dockerfile.*`, `Dockerfile-*`, `Dockerfile_*`, `*.dockerfile` (any case; not `.md` or `.txt`) | `tools/config-comments.mjs` | whole-line `#` (inside a continuation too), a trailing shell comment in a shell-form `RUN`/`CMD`/`ENTRYPOINT`/`HEALTHCHECK CMD`, and comments in a `RUN` heredoc's script; a `COPY`/`ADD` heredoc is file content |
| `.json`, `.jsonc` (`tsconfig*.json` included) | TypeScript's scanner | `//` and `/* */` outside strings |

The baseline stores each file's comments as whitespace-normalised text, so a
comment may move but not change, be duplicated, or appear in a new file.
`src/core/`, `src/application/`, `src/contracts/`, `src/adapters/`,
`src/features/`, `src/bootstrap/`, `src/legacy/`, `tests/`, `.github/`, every
Dockerfile, every compose file (`docker-compose*.yml`, `compose*.yaml`),
`eslint.config.mjs` and every JSON file can never carry a baselined comment;
all of them have none. The Dockerfile and compose names come from one pair of
patterns in `tools/config-comments.mjs` (`DOCKERFILE_PATH`, `COMPOSE_PATH`),
used both to pick the parser and to mark the file comment-free. The one YAML file
still on the baseline is `desktop/electron-builder.yml` (66 comment lines at
the time the gate learned YAML), which is desktop packaging and moves to docs
when that file is next changed.

Not comments: an interpreter directive (`#!`) on the first line of a script,
and the build markers `/*{{APP_CSS}}*/` and `//{{APP_JS}}` in `src/page.html`,
which `build.mjs` replaces and which are allowed there exactly once each. A
Dockerfile parser directive (`# syntax=`, `# escape=`, `# check=` before
anything else in the file) is a comment unless `DIRECTIVES` in
`tools/comment-gate.mjs` lists that exact line for that file; none is listed
today. A file that does not parse (a broken YAML file) fails the gate, and so
does a workflow step whose shell cannot be told (above).

Not scanned yet, because no parser covers them: `.gitignore`,
`.gitattributes`, `.dockerignore`, `.npmrc`, `.env.example` and other
dotfiles, NSIS scripts (`desktop/build/installer.nsh`), and Markdown. Inside
workflows, JavaScript run through `shell: node {0}` or an
`actions/github-script` `script:` is not scanned as JavaScript, and a `run:`
given as a YAML alias (`run: *name`) is not read as a script unless its anchor
is itself a step's `run:`.

## Baseline at the start of 4.0

Measured on `4.0-development` after the forward merge of 30 September 2026:

| Measure | Value |
| --- | --- |
| Frontend modules (`src/`, excluding tests) | 77 |
| Largest frontend runtime import cycle | 63 modules (one cycle) |
| Production modules importing `S` | 57, no bridges |
| Modules assigning `S.state` | 9: `00-prelude`, `02b-doc-id`, `03-sync`, `13-hosted`, `18-local-files`, `18b-file-menu`, `20g-drafts`, `20j-newtab`, `21-events` |
| Modules replacing any `S` member | 27 |
| Modules writing `S` in any counted way | 34; 155 `state-write` entries over 53 members, 20 of them changing inside `S.state` |
| Runtime import edges inside cycles | 631, all within the 63-module cycle |
| Frontend unit-test files (`src/test/*.test.mjs`) | 63 |
| Browser suite files | 162 |
| Dependency exceptions | 857: 631 `cycle-edge`, 155 `state-write`, 57 `state-import`, 9 `unresolved-dynamic`, 5 `platform-global` |
| Baselined comments | 258 in 21 files, most in the PowerShell driver and `start.bat` |
| Inline `eslint-disable` directives | 16 (the two in `build.mjs` moved to `eslint.config.mjs`) |
