# Dependency and comment gates

Two scripts hold the layer rules and the no-comment rule from
[the implementation plan](../IMPLEMENTATION-PLAN.md) (sections 2 and 3).
Both parse source with the TypeScript compiler, so strings, regular
expressions, template literals and URLs are never mistaken for imports or
comments.

| Command | What it checks | Baseline |
| --- | --- | --- |
| `npm run check:deps` (`tools/dep-report.mjs`) | Layer rules, platform imports and globals, HTML parsed into cells outside the rich text adapter, unresolvable modules, computed dynamic loads, runtime cycle edges and cycles through migrated folders | `tools/dep-baseline.json` |
| `npm run check:comments` (`tools/comment-gate.mjs`) | Comments in authored JS/TS, CSS, HTML, shell, PowerShell and batch files, and in YAML (workflow `run:` scripts included) and JSON; short reason comments are allowed as described below | `tools/comment-baseline.json` |

Both fail on anything new. An entry the baseline lists that has gone only
warns, naming the entry and the `--prune` command, and the check still passes.
`--prune` removes gone entries and refuses to add new ones. `--init` writes a
baseline only when none exists. Neither tool has a flag that records a new
entry ([Baseline workflow](#baseline-workflow)).
`node tools/dep-report.mjs --metrics` prints the informational numbers, which
are not a pass/fail condition.

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
| `application` | `src/application/` | itself, core, `shared` |
| `adapters` | `src/adapters/` | itself, core, `application`, `shared` |
| `features/<name>` | `src/features/<name>/` | itself, `features/common`, core, `application`, `shared` |
| `features/common` | `src/features/common/` | DOM helpers used by more than one feature; same imports as `features/<name>`, imported by every feature |
| `bootstrap` | `src/bootstrap/` | anything |
| `starters` | `src/starters/` | itself |
| `shared` | `shared/` | itself |
| `tests` | `src/test/`, `tests/`, `*.test.*` | anything |
| `tools` | `tools/` | anything |
| `server`, `desktop` | `server/`, `desktop/` | anything except tests |
| `src-unknown` | any other `src/` folder, or a file directly under `src/` | anything, but each file is an `unknown-layer` violation |

A script under `src/` outside the folders above is an `unknown-layer`
violation keyed by its top-level folder (`src/util/`, or `src/` for a file
directly under it): add the folder to the table (`layerOf`) or move the file.
Until then it counts as production, and core, `application`, `adapters`,
features, starters and `shared` may not import it.


Core, `application`, `shared` and feature layers may not import a
Node built-in or a package (`platform-import`). Core,
`application` and `shared` may not use browser, Node, timer or network globals
(`platform-global`); CommonJS `require`, `module` and `exports` are allowed in
CommonJS files. The banned set includes the DOM: `DOMParser`, `XMLSerializer`,
the node and element classes (`Node`, `Element`, `HTMLElement`, `Text`,
`DocumentFragment`, `HTMLCanvasElement`, `OffscreenCanvas`, `Option`, `Audio`),
selection and style (`Range`, `Selection`, `getSelection`, `getComputedStyle`,
`CSS`, `matchMedia`), observers (`MutationObserver`, `ResizeObserver`,
`IntersectionObserver`), events (`Event`, `CustomEvent`, `EventTarget`,
`KeyboardEvent`, `MouseEvent`, `addEventListener`, `removeEventListener`,
`dispatchEvent`, `postMessage`), dialogs and windows (`alert`, `confirm`,
`prompt`, `open`) and the platform-supplied helpers `atob`, `btoa`,
`createImageBitmap` and `structuredClone` (ES2023 does not define them; the
host does), beside `window`, `document`, `TextEncoder`, `TextDecoder` and the
timers. A type reference to a listed global that no local type, class or import
supplies is reported too. `eval` (any reference, so `(0, eval)("x")` counts) and
`Function` as a value (`new Function("…")`, `Function("…")`, `const F =
Function`, `Function.prototype`) are reported as code-from-text globals; the
`Function` type in a type position, `typeof Function` in a type query and
`instanceof Function` are not, because the analyzer tells value use from type
use by where the identifier sits.

The list is a second line of defence. The first is the typecheck:
`tsconfig.core.json` (core and `application`) sets `lib` to
`ES2023` only and `types` to `[]`, so a DOM name nobody declared (`FormData`,
`Headers`, `HTMLInputElement`) fails `tsc` as an undefined name.
`tools/test-dep-report.mjs` checks that the config carries no DOM, WebWorker or
ScriptHost lib and no `@types`, and that it rejects an undeclared
`FormData`, `DOMParser` and `document`. `shared` is plain JavaScript that is not
typechecked, so only the list covers it. The two layers meet at the ambient
declaration: an author can silence the typecheck for any name by declaring it,
so the report forbids the declaration itself (next paragraphs), whatever the
name.

Those layers may not read the clock or draw random numbers either; time and
randomness reach them through ports (`Clock`, `IdSource`). Both are reported
under `platform-global`:

- `global:Date`: `Date.now`, `Date()`, `new Date` with no argument (or only a
  spread), any member of `Date` but `parse` and `UTC`, and `Date` used as a
  value (`const D = Date`, `f(Date)`), which could reach the clock.
  `Date.parse`, `Date.UTC`, `new Date(x)`, `instanceof Date` and `Date` as a
  type read no clock and pass.
- `global:Math.random`: `Math.random`, and `Math` reached any way but through
  a named member other than `random` (`Math["random"]`, `Math[key]`,
  `const M = Math`).

A name is a global only where no binding for it is in scope. The report walks
the lexical scopes of each file: module, function parameters, function body,
block, loop head, `catch` clause and class. `var` and function declarations
are hoisted to their function body (a function declared inside a block stays
in the block, as in strict code); parameters, destructured names, imports and
`catch` bindings are bindings; a parameter's default value sees the other
parameters and the enclosing scopes but not the body's declarations
(`function f(a = fetch) { var fetch }` uses the global); a function or class
expression's own name is visible only inside it. So a parameter named `fetch`
in one function does not hide a global `fetch` in the next, and a local
declared later in the module still covers an earlier function. Property names,
method names and labels are not references; a shorthand property
(`{ performance }`) is. An ambient `declare const window` describes the global
and is not a local binding, so it does not hide a use of the global. A call to
`require` is a load only where `require` is not a binding in scope.

Core, `application` and `shared` may declare no ambient value at
all (`platform-global`, target `ambient:<name>`), whatever its name: core must
not claim a platform global exists, and an ambient declaration is how a name
the typecheck would reject gets past it. These forms are reported, even when
nothing uses them:

- `declare const`, `declare let` and `declare var`, with every declarator
  (`declare const a: number, DOMParser: unknown`) and every destructured name
  (`declare const { DOMParser }: any`, renamed, nested, rest and array
  patterns);
- `declare function` (its overloads are one finding), `declare class`,
  `declare abstract class`, `declare enum` and `declare const enum`;
- `declare namespace` (a dotted name reports its root) and `declare module`,
  with an identifier or a string name (`declare module "x"`);
- the value members of `declare global { … }` (`var`, `let`, `const`,
  `function`, `class`, `enum`, `namespace`);
- `export declare` of any of the above;
- `/// <reference lib="…" />`, `types="…"` and `path="…"` directives, which
  bring ambient declarations in without writing one.

Ambient types and interfaces (`declare interface`, `declare type`, `interface`
and `type` members of `declare global`) carry no value and are allowed. They do
not hide a free type reference, though: a listed name used as a type after
`declare interface Text { … }` is still reported as `global:Text`, and an
unlisted name is left to the typecheck, which reports it unless something
declared it. The real tree declares no ambient value under `src/` or `shared/`,
so the rule adds no baseline entry.

Types and values are separate names. A type parameter, type alias, interface
or `import type` does not hide a global value (`function f<URL>() { return new
URL(…) }` uses the global `URL`), and a local value does not hide a global
type in a type annotation. Classes, enums, namespaces and ordinary imports are
both. `typeof x` and the left side of a qualified name look up values, then
type-only imports. The walker adds about 0.2 s to a full run (from about 1.2 s
to about 1.4 s on the Windows workstation).

## HTML into cells (INV-10)

[INV-10](invariants.md) lets content reach a script cell only through the rich
text adapter. The `html-cells` rule reports a production module (every layer
but `tests`, `tools` and `other`) outside `src/adapters/richtext/` and its
shared reader `src/bootstrap/richtext.ts` that does either of these:

- Imports, re-exports, `require`s or dynamically imports a file under
  `src/adapters/richtext/` (target: that file). `import type` is not a decoder
  and passes. Under `verbatimModuleSyntax` an `import { type X }` still loads
  the module, and the report counts it as a value import, so only a whole
  `import type` passes. The decoder is meant to be reached through the shared reader.
- Calls a method that parses an HTML string into a document (target:
  `html-parse:<method>`): `parseFromString` unless its second argument is a
  literal `application/xml`, `text/xml`, `image/svg+xml` or
  `application/xhtml+xml`, so `text/html`, a computed type and a missing type
  all count; and `createContextualFragment`, `parseHTMLUnsafe`, `setHTMLUnsafe`
  and `setHTML`. The method is matched by name on any receiver, through an
  element access, an optional call or parentheses.

Writing `innerHTML` or `outerHTML` and calling `insertAdjacentHTML` are not
reported. They render a cell into the page, the opposite direction, and the
tree has more than a hundred of them in UI code that no syntax tells apart from
a parse into a scratch element. A module that parses by assigning `innerHTML`
to a detached element and reading it back is therefore not caught; reading the
same markup through `parseFromString` or a fragment is. The parse methods are
matched by a literal name at the call, so a computed bracket name,
destructuring the method off the parser, `.call`, `.bind` and `Reflect.apply`
get past the rule. That is acceptable for a tripwire: it stops a module from
adding a parse by accident, and a review reads the diff of anyone who goes
round it on purpose. The baseline includes `src/bootstrap/document-ports.ts`,
which builds its own `RichText` over each migration's image ingestion.

## Runtime cycles

`cycle-edge` covers every runtime strongly connected component. Static imports,
re-exports, literal `require` and literal dynamic `import()` are runtime edges;
`import type` is not. A cycle containing a file in core, application, adapters,
features or bootstrap fails for both runtime and type-inclusive graphs and cannot
be baselined. An edge closing or joining a cycle is reported; an edge merely
pointing into one is not. Removing an edge that splits a component resolves its
former cycle edges.

## The composition root

`src/bootstrap/main.ts` is the composition root and the build entry (`build.mjs` bundles it). It replaced the legacy initializer shim `src/js/_entry.js` (plan section 8, item 1) and does what the shim did, in the same order: it calls `wireLegacyApp` (`src/bootstrap/wiring.ts`) with the document entry (`migrateRows` from `src/bootstrap/document-ports.ts`), the derived-records plan and the draft recovery ports, which builds the action and export registries, the document session, the save coordinator, the transitions, the draft recovery, the editor's owners, the preferences and the document location; it mounts the page entry, the owners and the features in a fixed order, starting the blob and gallery stores between the identity owner and the session-merge owner; and it hands the wiring to `startAppWhenReady` (`src/bootstrap/app.ts`), which mounts the views and starts the actions on DOM ready. If the wiring throws, it reports the `WiringError` with `console.error` and mounts nothing. Nothing configures a bridge while it loads (the load-order check, `tests/bootstrap/module-load.test.ts`).

It is TypeScript, so the type check covers the wiring from the root down. It was JavaScript until the draft recovery's `merge` port and `applyMerge` agreed on a type: the merge outcome is now `MergeOutcome<D>` (`src/application/session/apply-merge.ts`), whose `state` is the held document, the incoming `theirs` or the merged document, and the stash merge (`src/application/recovery/stashed-work.ts`) answers `D | null` (tracker I-27).

It imports each mount from the wiring module that defines it. `tests/bootstrap/composition-root.test.ts` pins the mount order, checks that `build.mjs` bundles it, that outside `src/bootstrap/` it imports only a frozen set (`02c-blobs.js` and `02d-gallery.js`, which may only shrink), that no production module imports it, and that `src/js/` stays empty. `src/bootstrap/document-ports.ts` binds `migrateRows` to the blob store and the rich-text reader; `bootstrap/startup/document-entry.js`, several wiring modules and many tests import it.

L4a PR 3 moves row reconciliation animation from `04a-row-motion.js` to `src/features/rows/row-motion.js`, the delayed busy indicator from `04b-busy.js` to `src/features/notices/busy.js`, cell press targeting from `05q-cell-reach.ts` to `src/features/editing/cell-reach.ts`, header labels and condensing from `20i-topbar.js` to `src/features/title/topbar.ts`, and phone navigation and badge mirroring from `20k-phone-bar.js` to `src/features/notices/phone-bar.ts`.

Bootstrap owns the disposable topbar, cell-reach and phone-bar mounts through `mountTopbarFeature`, `mountCellReachFeature` and `mountPhoneBarFeature` in `src/bootstrap/wiring/views.ts`, called by `startApp` in `src/bootstrap/app.ts`. Each mount uses `replaceViewMount`, and app stop disposes its owner. The topbar owner registers and releases its label, resize and passive scroll handlers, disconnects its observer and cancels pending animation frames, animations and timers; a subsequent app start creates a fresh owner. Row motion and busy have no startup work, so their empty initializers are removed. The header and row motion share the CSS duration reader in `src/features/common/css-duration.ts`, without a feature-to-feature dependency outside common. All five modules remain free of legacy state and legacy imports; their presentation behavior and mount lifetimes can be exercised independently of the initializer shim. Rendering, hosted operations and local-file operations now import the owning feature helpers directly.

The numbered modules the shim started are gone: each moved into a feature folder, an owner in `src/application/` or an adapter, or was removed with the server and collaboration features, and `src/js/` is deleted. The bridges they imported from `src/legacy/` were retired as the wiring took the owners from ports; the last, `app-actions.ts`, went in #906, and `src/legacy/` is gone.

## Baseline workflow

- **Paying debt.** Make the change. `npm run check:deps` passes and warns
  about each resolved entry; `node tools/dep-report.mjs --prune` removes them.
  Commit the smaller baseline with the change. The comment gate works the same
  way with `node tools/comment-gate.mjs --prune`. Baselines never grow.
- **New violations.** `--prune` refuses while any new violation exists (exit 1,
  "baselines only shrink; fix the violation", nothing written). There is no
  flag that records one: fix the violation.
- **Changing the rules.** Removing the baseline and running `--init` records
  everything without review and drops every `reason`, so it is only for a
  repository with no baseline.

The file holds one exception per line, so a diff shows exactly which entries
came and went. Entries are sorted by rule, then source, then target, comparing
code points (UTF-8 bytes) rather than locale collation, so `--init` and
`--prune` write the same bytes on every machine. A check prints the size
of the baseline and the counts of new and resolved entries separately.

`--metrics` reports frontend and migrated module counts, frontend runtime
cycles, and runtime cycle edges.

## Recorded exceptions

The baseline is a list of `{ rule, source, target }`. An entry may carry a
`reason`; `--prune` keeps it. Every recorded exception is explained below.

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
- **`src/core/document/validated.ts` ambient `validated`**. The gate reads any
  `declare` in core as a platform declaration. This one is the module-scoped
  `unique symbol` that brands `ValidatedDocument`
  ([testing.md](testing.md#the-validated-document-brand)); it is used only in a
  type and never read at run time.
- **Test harnesses** (`desktop/test/verify-dist-payload.test.mjs`,
  `tools/test-run-suites.mjs`, `tools/test-update.mjs`) import the module under
  test by a computed file URL so the same file can be loaded from a temporary
  copy.

## Comment gate

A reason comment explains why, not what; review judges the explanation. It has
one or two consecutive comment lines, each at most 120 characters. The first
begins `// why: ...` in scripts, `# why: ...` in shell, PowerShell or YAML run
blocks, or `/* why: ... */` in CSS. A second line is a plain continuation
directly below. A `docs/<file>.md#<anchor>` link is optional, and the gate
checks any such heading or `<a id>` exists. Reasons never enter the baseline.
Narration, commented-out code, TODOs, banners and every other new comment fail.

Scanned: every tracked or untracked-but-not-ignored file of these kinds,
except `node_modules/`, `.claude/handoff/` and the generated `index.html`:

| Files | Parser | What counts as a comment |
| --- | --- | --- |
| `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `eslint.config.mjs` included | TypeScript (`tools/source-scan.mjs`) | `//` and `/* */` outside strings, templates and regexes |
| `.css`, `.html` (inline `<style>` and script too) | `tools/source-scan.mjs` | `/* */`, `<!-- -->` |
| `.sh`, `.ps1`, `.bat`, `.cmd` | `tools/source-scan.mjs` | `#` at a word start (in PowerShell also straight after a `{` or `}`, but never inside a `${…}` variable or straight after one, which misses only `${a}#b` opening a statement) outside quotes (`$'…'` included), arithmetic (`$(( ))`, `(( ))`) and heredocs, `<# #>`, `rem`/`::`; a `<<` inside arithmetic or a `<<<` here-string starts no heredoc. As in bash, `((` is arithmetic only when its inner parenthesis closes straight into `))`; otherwise (`((cd a) | (wc))`) it is two subshells, read as shell. The scanner also requires that close on the same line, so a multi-line `(( ))` is read as shell, where a `#` in it would count |
| `.yml`, `.yaml` | the `yaml` package's CST (`tools/config-comments.mjs`) | every YAML comment token; `#` in a quoted scalar, a URL or a block scalar's content is not one |
| `run:` of a step in `.github/workflows/*.yml` or an `action.yml` | the shell rules above, in the step's `shell:`, else `defaults.run.shell`, else the runner's: `pwsh` when a `runs-on` label (a group's `labels:` included) names Windows, `bash` when one names Ubuntu, Linux or macOS. When none says (an expression such as `${{ matrix.os }}`, a group without labels, a self-hosted runner without an OS label), the step is read both ways; if the two readings differ the gate fails and asks for `shell:`. A `shell: node` step, and the `script:` input of an `actions/github-script` step, are read as JavaScript (TypeScript's parser, as above). A `run:`, `shell:`, `script:`, `defaults:` or `runs-on:` (or a label in it) given as a YAML alias is read from its anchor, wherever the anchor is | a `#` comment inside the script, whole-line or trailing, or `//` and `/* */` in JavaScript; `$#`, `${#x}`, `'#'`, heredoc bodies and `<<<` here-strings are not; a `#!` line is, because the runner ignores it. Each is reported at its own source line, folded (`>`) and quoted multi-line scalars included |
| `.json`, `.jsonc` (`tsconfig*.json` included) | TypeScript's scanner | `//` and `/* */` outside strings |

The baseline stores each file's comments as whitespace-normalised text, so a
comment may move but not change, be duplicated, or appear in a new file.
`src/core/`, `src/application/`, `src/adapters/`,
`src/features/`, `src/bootstrap/`, `tests/`, `.github/`,
`eslint.config.mjs` and every JSON file can never carry a baselined comment;
all of them have none. No YAML file
is on the baseline: `desktop/electron-builder.yml` had 66 comment lines when
the gate learned YAML, and their rationale is now in
[desktop-build.md](desktop-build.md).

Not comments: an interpreter directive (`#!`) on the first line of a script,
and the build markers `/*{{APP_CSS}}*/` and `//{{APP_JS}}` in `src/page.html`,
which `build.mjs` replaces and which are allowed there exactly once each. A file that does not parse (a broken YAML file) fails the gate, and so
does a workflow step whose shell cannot be told (above).

Not scanned yet, because no parser covers them: dotfiles, NSIS scripts and
Markdown. The configuration files among them that the no-comment rule covers,
with the comments each held on 30 September 2026:

| File | Comment lines |
| --- | --- |
| `.gitignore` | 31 |
| `.gitattributes` | 5 |
| `desktop/build/installer.nsh` | 178: 167 whole-line `;` comments and 11 trailing ones saying what each register saved by a `Push` holds |
| `.editorconfig`, `.nvmrc`, `desktop/.gitignore` | none |

`desktop/.npmrc` was removed. Architecture selection now belongs to
`desktop/electron-arch.mjs`, invoked by `npm run fetch-electron` after
`npm ci`; dependency installation no longer carries the ARM64 pin.

A workflow step run by another interpreter (`shell: python {0}`) is read with
the shell rules.
