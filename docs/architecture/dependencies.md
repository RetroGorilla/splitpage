# Dependency and comment gates

Two scripts hold the layer rules and the no-comment rule from
[the implementation plan](../IMPLEMENTATION-PLAN.md) (sections 2 and 3).
Both parse source with the TypeScript compiler, so strings, regular
expressions, template literals and URLs are never mistaken for imports or
comments.

| Command | What it checks | Baseline |
| --- | --- | --- |
| `npm run check:deps` (`tools/dep-report.mjs`) | Layer rules, platform imports and globals, HTML parsed into cells outside the rich text adapter, unresolvable modules, computed dynamic loads, cycles through migrated folders, and the legacy debt: `S` importers, `S` writers and runtime cycle edges | `tools/dep-baseline.json` |
| `npm run check:comments` (`tools/comment-gate.mjs`) | Comments in authored JS/TS, CSS, HTML, shell, PowerShell and batch files, and in YAML (workflow `run:` scripts included), Dockerfiles and JSON | `tools/comment-baseline.json` |

Both fail on anything new and on anything the baseline lists that has gone.
`--prune` removes gone entries and refuses to add new ones. `--init` writes a
baseline only when none exists. `node tools/dep-report.mjs --accept "<reason>"`
records reviewed new dependency exceptions ([Baseline workflow](#baseline-workflow)).
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
| `contracts` | `src/contracts/` | itself, `shared` |
| `application` | `src/application/` | itself, core, `contracts`, `shared` |
| `adapters` | `src/adapters/` | itself, core, `application`, `contracts`, `shared` |
| `features/<name>` | `src/features/<name>/` | itself, `features/common`, core, `application`, `contracts`, `shared` |
| `features/common` | `src/features/common/` | DOM helpers used by more than one feature; same imports as `features/<name>`, imported by every feature |
| `legacy` | `src/legacy/` | itself, core, `legacy-js`, `application`, `contracts`, `adapters`, `shared` |
| `bootstrap` | `src/bootstrap/` | anything except `src/js/_state.js` |
| `shared` | `shared/` | itself |
| `tests` | `src/test/`, `tests/`, `*.test.*` | anything |
| `legacy-js`, `server`, `desktop` | `src/js/`, `server/`, `desktop/` | anything except tests |
| `src-unknown` | any other `src/` folder, or a file directly under `src/` | anything, but each file is an `unknown-layer` violation |

A script under `src/` outside the folders above is an `unknown-layer`
violation keyed by its top-level folder (`src/util/`, or `src/` for a file
directly under it): add the folder to the table (`layerOf`) or move the file.
Until then it counts as production for the `S` rules below, and core,
`contracts`, `application`, `adapters`, features, `legacy` and `shared` may
not import it.

Bootstrap imports of `src/js/_state.js` are `layer` violations, including side-effect imports, re-exports, dynamic imports and type imports. The wiring uses the live-document and save ports, the startup bridge (`src/legacy/startup-bridge.ts`), and the desktop bridge in `20f-desktop.js`. `tools/test-dep-report.mjs` has fail-first cases for this boundary and a positive case for a numbered module supplying a port.

Core, `contracts`, `application`, `shared` and feature layers may not import a
Node built-in or a package (`platform-import`). Core, `contracts`,
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
`tsconfig.core.json` (core, `contracts` and `application`) sets `lib` to
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

Core, `contracts`, `application` and `shared` may declare no ambient value at
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
bridge `src/legacy/richtext.ts` that does either of these:

- Imports, re-exports, `require`s or dynamically imports a file under
  `src/adapters/richtext/` (target: that file). `import type` is not a decoder
  and passes. Under `verbatimModuleSyntax` an `import { type X }` still loads
  the module, and the report counts it as a value import, so only a whole
  `import type` passes. The decoder is meant to be reached through the bridge.
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
round it on purpose. The tree has two
legacy findings, both baselined with a reason: `src/js/18-local-files.js`
parses a legacy `.html` export to read its `state-data` element, and
`src/legacy/document-ports.ts` builds its own `RichText` over each migration's
image ingestion.

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

Production is every layer except `tests`, `tools` and `other` (files outside
`src/`, `shared/`, `server/`, `desktop/` and `tools/`, such as `build.mjs`).
Every file under `src/` that is not a test is production, including one in an
unknown folder. `src/js/_state.js`, which defines `S`, is neither an importer
nor a writer.

### Importing `S`

A module imports `S` when it binds it from `src/js/_state.js`, or from a
module that re-exports it, by name (`import { S }`), alias (`import { S as
T }`), namespace (`import * as G`, then `G.S`), default, destructured literal
`await import()` or `require`, or when it loads such a module with a literal
`import()` or `require` whose result it does not bind (counted, since the
report cannot see what it does with it). `import type { S }` counts too, as
does the type-only re-export `export type { S } from`. A side-effect
`import "./_state.js"` binds nothing and does not.

A module is a bridge when it re-exports `S`: `export { S } from`, `export *
from` or `export * as x from` a module that provides `S`, `export { S as T }`
or `export default S` of an imported `S`, or an exported alias of `S` or part
of it (`export const live = S.state`). A module importing from a bridge is an
`S` importer whose writes are attributed as if it had imported `S` itself.
Bridges are followed until the export path from a module to `S`, or the
member path below `S` that an exported alias names, reaches six names (five
`export * as` hops, for example); the module where either would grow longer is
a `state-bridge-limit` violation, so the limit cannot hide an importer
silently. A bridge is itself a `state-import`; one in `src/legacy/`
is allowed by the layer rules, and its baseline entry carries a `reason`
naming the migration that removes it. A feature importing a bridge also
breaks the layer rule.

Only re-exports and exported aliases are bridges. A function, an object
literal, a class static, `module.exports`, or an existing legacy helper that
returns live state is an untracked facade: `adoptRestoredState` in
`src/js/02b-doc-id.js` replaces `S.state` and returns it, and a module that
calls it and writes to the result is not reported for that call or that
write. Features, `application`, `adapters`, `contracts` and core are still
protected, because the layer rules stop them importing `src/js` or
`src/legacy` at all. `src/js`, `src/legacy` and `src/bootstrap` may import
legacy modules, so there the only protection against a facade is review. A
keyed rule for every `src/legacy` → `src/js` edge, recorded like `cycle-edge`,
is a candidate for milestone 2.

One known false positive is accepted because it errs on the safe side: an
exported `const` snapshot of a primitive member (`export const wasDirty =
S.dirty`) is treated as a bridge, so its consumers count as `S` importers
although they only hold a copied value.

### Writing `S`

The target names the top-level member of `S` and how it was written:

- `global:S.<member>`: the member is replaced. Assignment (`=`, compound and
  logical), `++`/`--`, `delete`, a destructuring-assignment target or a
  `for…in`/`for…of` head. `S["state"]` is `S.state`; an assignment through a
  computed key (`S[key] = …`) replaces a member chosen at run time and is
  `global:S[?]`.
- `global:S.<member>.*`: something inside the member changes. An assignment,
  update or `delete` below it (`S.state.rows = []`,
  `S.state.rows.length = 0`, `S.state.rows[i].text = …`); `push`, `pop`,
  `splice`, `shift`, `unshift`, `sort`, `reverse`, `fill` or `copyWithin`
  called on a chain inside it; or the member as the first argument of
  `Object.assign`, `Object.defineProperty`, `Object.defineProperties`,
  `Object.setPrototypeOf`, `Reflect.set`, `Reflect.deleteProperty`,
  `Reflect.defineProperty` or `Reflect.setPrototypeOf`.
- `global:S.*`: `S` itself is the first argument of one of those functions
  (`Object.assign(S, …)`, `Reflect.set(S, …)`), so its members change in place
  without the report knowing which.

Each entry's detail says which: `replaces S.dirty`, `changes S.state in
place`, `changes members of S in place`.

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
  as `this`, and the untracked facades above;
- a named function passed as a callback (`S.state.rows.forEach(markDone)`,
  where `markDone` writes to its parameter); only inline function and arrow
  callbacks are followed;
- the result of a call, even when it is an element of `S`
  (`const row = S.state.rows.find(…); row.done = true`, or `filter(…)[0]`),
  and a copy that shares its elements (`S.state.rows.slice()` then a write to
  an element of the copy);
- `Map` and `Set` mutators (`set`, `add`, `delete`, `clear`) and any other
  method not in the mutator list;
- `Function.prototype.call` and `apply`
  (`Array.prototype.push.call(S.state.rows, x)`), and iterator protocols;
- a chain that passes through a comma expression (`(0, S.state).rows = []`);
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

## The legacy initializer shim

`src/js/_entry.js` is the legacy initializer shim, the build entry until plan §8's 4.x composition root replaces it. Since milestone 7's step 7.1 it does three things, in this order: it calls `wireApp` (`src/bootstrap/wiring.ts`) with the dependencies the numbered modules export, which builds the action and export registries, the document session, the save coordinator, the transitions, the draft recovery, the editor's owners and the preferences; it calls the 69 numbered modules' `__init` in numbered order; and it hands the wiring to `startAppWhenReady` (`src/bootstrap/app.ts`), which mounts the features and starts the actions on DOM ready. If `wireApp` throws, the shim reports the `WiringError` with `console.error` and calls no `__init` and no mount. Since 7.2 the session's effects come the same way: the shim imports `legacySessionEffects` (12), `getEditorName` (03), `runIdleRefresh` (07) and `derivedRecordsPlan` (08c) from modules already in its set and passes them to `wireApp`, and no numbered module configures a bridge while it loads (the load-order check in the same test file).

Its import specifiers are a frozen set of 72 (the 69 modules it starts, `14e-export-formats.js` for `registerBuiltInExporters`, `../bootstrap/wiring.ts` and `../bootstrap/app.ts`). `tests/bootstrap/legacy-shim.test.ts` fails if the shim imports anything outside that set, so the list can only shrink, and if any file under `src/application`, `src/features` or `src/bootstrap` imports the shim (resolved with this tool's resolver). `tools/modularize.mjs` generated the first version of the shim; rerunning it would overwrite the wiring call, so it is not rerun.

The modules it starts, the owner each is expected to move to in 4.x (a planning label: a feature folder, an adapter, or the composition root), and the bridges under `src/legacy/` each imports:

| Module | Owner it waits for in 4.x | Bridges it imports |
| --- | --- | --- |
| `00-prelude.js` | composition root | none |
| `00p-prefs.js` | features/settings | none |
| `01-scene-status.js` | features/rows | `preferences-bridge`, `session-bridge` |
| `01b-hide-shot.js` | features/rows | `preferences-bridge` |
| `02-state.js` | core document entry (composition root) | `document-ports` |
| `02b-doc-id.js` | composition root (initial load, identity) | `document-ports`, `transition-bridge` |
| `02c-blobs.js` | adapters/storage | none |
| `02d-gallery.js` | features/gallery | none |
| `03-sync.js` | composition root (destination, merge) | `document-ports`, `editor-bridge`, `preferences-bridge`, `recovery-bridge`, `richtext`, `save-bridge`, `session-bridge` |
| `03a-history-store.js` | features/history | `recovery-bridge`, `save-bridge`, `seed-check` |
| `03b-side-panels.js` | features/panels | `preferences-bridge` |
| `04-richtext.js` | adapters/richtext | `richtext` |
| `04a-row-motion.js` | features/rows | none |
| `04b-busy.js` | features/notices | none |
| `04c-doc-model.js` | adapters/richtext | `richtext` |
| `05-render.js` | features/rows | `editor-bridge`, `preferences-bridge`, `richtext`, `session-bridge` |
| `05b-cell-edit.js` | features/editing | `richtext`, `session-bridge` |
| `05c-clipboard.js` | features/clipboard | `richtext`, `session-bridge` |
| `05d-draft-edit.js` | features/editing | `richtext` |
| `05e-gallery-overlay.js` | features/overlay | `editor-bridge`, `session-bridge`, `transition-bridge` |
| `05f-rundown.js` | features/panels | `app-actions`, `cache-freeze`, `editor-bridge`, `richtext` |
| `05g-scene-clip.js` | features/clipboard | `richtext` |
| `05h-scene-select.js` | features/rows | `editor-bridge`, `preferences-bridge`, `review-wording`, `session-bridge` |
| `05p-rundown-presence.js` | features/panels | none |
| `05q-cell-reach.js` | features/editing | none |
| `05r-read-time.js` | features/rows | `session-bridge` |
| `05s-script-zoom.js` | features/settings | `app-actions`, `preferences-bridge` |
| `05t-target.js` | features/panels | none |
| `05v-video.js` | features/video | `transition-bridge` |
| `05w-annotate.js` | features/gallery | `transition-bridge` |
| `06-rows.js` | features/rows | `editor-bridge`, `review-wording`, `session-bridge`, `transition-bridge` |
| `07-production-tags.js` | features/tags | `cache-freeze`, `document-ports`, `editor-bridge`, `preferences-bridge`, `richtext`, `session-bridge` |
| `07b-plain-tags.js` | features/tags | `richtext` |
| `08-production-panels.js` | features/panels | none |
| `08c-broll.js` | features/broll | `plain-text`, `richtext`, `session-bridge` |
| `08d-broll-panel.js` | features/broll | `app-actions` |
| `09-find-replace.js` | features/find | `preferences-bridge`, `richtext` |
| `10-comments.js` | features/comments | `editor-bridge`, `preferences-bridge`, `transition-bridge` |
| `11-import.js` | features/imports | `session-bridge`, `transition-bridge` |
| `12-dirty-toast.js` | features/notices (session effects: composition root) | `save-bridge`, `session-bridge` |
| `12a-undo.js` | features/undo | `richtext` |
| `13-hosted.js` | adapters/transport | `recovery-bridge`, `review-wording`, `save-bridge`, `transition-bridge` |
| `13a-presence.js` | adapters/transport | `transition-bridge` |
| `13b-collaborate.js` | features/file-menu | `app-actions`, `preferences-bridge` |
| `14-export.js` | adapters/files (save writer) | `preferences-bridge`, `recovery-bridge`, `save-bridge` |
| `14b-export-kit.js` | adapters/formats | `cache-freeze`, `document-ports`, `plain-text`, `richtext`, `session-bridge` |
| `15-docx.js` | adapters/formats | `document-ports`, `plain-text`, `richtext` |
| `16-csv.js` | adapters/formats | `richtext` |
| `16b-xlsx.js` | adapters/formats | none |
| `17-pdf.js` | adapters/formats | none |
| `18-local-files.js` | adapters/files | `app-actions`, `export-formats`, `richtext`, `save-bridge`, `session-bridge`, `transition-bridge` |
| `18a-local-merge.js` | features/merge | `plain-text` |
| `18b-file-menu.js` | features/file-menu | `save-bridge`, `transition-bridge` |
| `18c-export-dialog.js` | features/file-menu | `export-formats`, `richtext` |
| `18d-command-menu.js` | features/shortcuts | `app-actions`, `editor-bridge`, `export-formats`, `screen` |
| `19-writer.js` | features/writer | `document-ports`, `editor-bridge`, `plain-text`, `preferences-bridge`, `review-wording`, `session-bridge` |
| `20-teleprompter.js` | features/prompter | `editor-bridge`, `preferences-bridge`, `richtext`, `startup-bridge` |
| `20a-update.js` | features/notices | none |
| `20b-onboarding.js` | composition root (onboarding) | `app-actions`, `preferences-bridge`, `recovery-bridge`, `seed-check` |
| `20c-help.js` | features/settings | `app-actions`, `preferences-bridge`, `tour-pause` |
| `20d-formats.js` | adapters/formats | `richtext`, `save-bridge` |
| `20e-connect.js` | adapters/transport | `app-actions`, `tour-pause` |
| `20f-desktop.js` | composition root (desktop host) | `recovery-bridge`, `save-bridge`, `startup-bridge` |
| `20g-drafts.js` | adapters/storage (draft recovery) | `recovery-bridge`, `save-bridge`, `transition-bridge` |
| `20h-appdata.js` | adapters/storage | `preferences-bridge` |
| `20i-topbar.js` | features/title | none |
| `20j-newtab.js` | composition root (desktop host) | `app-actions`, `document-ports`, `recovery-bridge`, `seed-check`, `startup-bridge`, `transition-bridge` |
| `20k-phone-bar.js` | features/notices | none |
| `20s-settings.js` | features/settings | `app-actions`, `preferences-bridge` |


## Baseline workflow

- **Paying debt.** Make the change. `npm run check:deps` fails and lists the
  resolved entries; `node tools/dep-report.mjs --prune` removes them. Commit
  the smaller baseline with the change.
- **Reviewed new debt.** `--prune` refuses new entries. When one is expected,
  such as a bridge in `src/legacy/` or a helper moved between two modules
  already in the cycle (which adds a `cycle-edge`), run
  `node tools/dep-report.mjs --accept "<reason>"`:
  - it adds exactly the current new violations, each with that reason, and
    lists them;
  - it refuses a missing or blank reason (exit 2), and refuses while a cycle
    runs through a migrated folder (exit 1, nothing written);
  - it does not prune: `--prune` removes the resolved entries afterwards and
    keeps every reason.

  The reason says why the entry is needed and what removes it; it is reviewed
  with the change like any other exception.
- **Changing the rules.** `--accept "<the rule change>"` records the entries a
  new rule finds, and `--prune` removes those it no longer finds. Removing the
  baseline and running `--init` records everything without review and drops
  every `reason`, so it is only for a repository with no baseline.

The file holds one exception per line, so a diff shows exactly which entries
came and went. Entries are sorted by rule, then source, then target, comparing
code points (UTF-8 bytes) rather than locale collation, so `--init`, `--prune`
and `--accept` write the same bytes on every machine. A check prints the size
of the baseline and the counts of new and resolved entries separately.

`--metrics` prints the informational numbers:
- `stateImporters` and `stateAssigners` (modules replacing `S.state`) keep
  their meaning;
- `stateFieldWriters` still lists the modules that replace any member, but its
  `reads` has changed: it counts every reference to `S` or an alias of it that
  is not a write, where it used to count only `S.<field>` reads;
- new: `runtimeCycleEdges`, `stateBridges` and `stateWriters` (the modules and
  targets behind `state-write`).

## Recorded exceptions

The baseline is a list of `{ rule, source, target }`. An entry may carry a
`reason`; `--prune` keeps it. The legacy debt entries (`state-import`,
`state-write`, `cycle-edge`) recorded at the start of 4.0 carry none: they are
the `src/js` modules as they stood then, and they only shrink. An entry added
later with `--accept` carries the reason given. Every other entry, and any
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

Scanned: every tracked or untracked-but-not-ignored file of these kinds,
except `node_modules/`, `.claude/handoff/` and the generated `index.html`:

| Files | Parser | What counts as a comment |
| --- | --- | --- |
| `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `eslint.config.mjs` included | TypeScript (`tools/source-scan.mjs`) | `//` and `/* */` outside strings, templates and regexes |
| `.css`, `.html` (inline `<style>` and script too) | `tools/source-scan.mjs` | `/* */`, `<!-- -->` |
| `.sh`, `.ps1`, `.bat`, `.cmd` | `tools/source-scan.mjs` | `#` at a word start (in PowerShell also straight after a `{` or `}`, but never inside a `${…}` variable or straight after one, which misses only `${a}#b` opening a statement) outside quotes (`$'…'` included), arithmetic (`$(( ))`, `(( ))`) and heredocs, `<# #>`, `rem`/`::`; a `<<` inside arithmetic or a `<<<` here-string starts no heredoc. As in bash, `((` is arithmetic only when its inner parenthesis closes straight into `))`; otherwise (`((cd a) | (wc))`) it is two subshells, read as shell. The scanner also requires that close on the same line, so a multi-line `(( ))` is read as shell, where a `#` in it would count |
| `.yml`, `.yaml` | the `yaml` package's CST (`tools/config-comments.mjs`) | every YAML comment token; `#` in a quoted scalar, a URL or a block scalar's content is not one |
| `run:` of a step in `.github/workflows/*.yml` or an `action.yml` | the shell rules above, in the step's `shell:`, else `defaults.run.shell`, else the runner's: `pwsh` when a `runs-on` label (a group's `labels:` included) names Windows, `bash` when one names Ubuntu, Linux or macOS. When none says (an expression such as `${{ matrix.os }}`, a group without labels, a self-hosted runner without an OS label), the step is read both ways; if the two readings differ the gate fails and asks for `shell:`. A `shell: node` step, and the `script:` input of an `actions/github-script` step, are read as JavaScript (TypeScript's parser, as above). A `run:`, `shell:`, `script:`, `defaults:` or `runs-on:` (or a label in it) given as a YAML alias is read from its anchor, wherever the anchor is | a `#` comment inside the script, whole-line or trailing, or `//` and `/* */` in JavaScript; `$#`, `${#x}`, `'#'`, heredoc bodies and `<<<` here-strings are not; a `#!` line is, because the runner ignores it. Each is reported at its own source line, folded (`>`) and quoted multi-line scalars included |
| `Dockerfile`, `Dockerfile.*`, `Dockerfile-*`, `Dockerfile_*`, `*.dockerfile` (any case; not `.md` or `.txt`) | `tools/config-comments.mjs` | whole-line `#` (inside a continuation too), a trailing shell comment in a shell-form `RUN`/`CMD`/`ENTRYPOINT`/`HEALTHCHECK CMD`, and comments in a `RUN` heredoc's script, all read in the dialect the last `SHELL` names (`pwsh`/`powershell`, `cmd`, `node` as JavaScript, anything else as sh); a `COPY`/`ADD` heredoc is file content |
| `.json`, `.jsonc` (`tsconfig*.json` included) | TypeScript's scanner | `//` and `/* */` outside strings |

The baseline stores each file's comments as whitespace-normalised text, so a
comment may move but not change, be duplicated, or appear in a new file.
`src/core/`, `src/application/`, `src/contracts/`, `src/adapters/`,
`src/features/`, `src/bootstrap/`, `src/legacy/`, `tests/`, `.github/`, every
Dockerfile, every compose file (`docker-compose*.yml`, `compose*.yaml`),
`eslint.config.mjs` and every JSON file can never carry a baselined comment;
all of them have none. The Dockerfile and compose names come from one pair of
patterns in `tools/config-comments.mjs` (`DOCKERFILE_PATH`, `COMPOSE_PATH`),
used both to pick the parser and to mark the file comment-free. No YAML file
is on the baseline: `desktop/electron-builder.yml` had 66 comment lines when
the gate learned YAML, and their rationale is now in
[desktop-build.md](desktop-build.md).

Not comments: an interpreter directive (`#!`) on the first line of a script,
and the build markers `/*{{APP_CSS}}*/` and `//{{APP_JS}}` in `src/page.html`,
which `build.mjs` replaces and which are allowed there exactly once each. A
Dockerfile parser directive (`# syntax=`, `# escape=`, `# check=` before
anything else in the file) is a comment unless `DIRECTIVES` in
`tools/comment-gate.mjs` lists that exact line for that file; none is listed
today. A file that does not parse (a broken YAML file) fails the gate, and so
does a workflow step whose shell cannot be told (above).

Not scanned yet, because no parser covers them: dotfiles, NSIS scripts and
Markdown. The configuration files among them that the no-comment rule covers,
with the comments each held on 30 September 2026:

| File | Comment lines |
| --- | --- |
| `.gitignore` | 31 |
| `.gitattributes` | 5 |
| `desktop/.npmrc` | 3 (why `arch=arm64` is pinned; [ci.md](ci.md) explains how CI overrides it) |
| `.env.example` | 85, five of them commented-out optional settings. These are setup instructions for the person filling in `.env` on the server, so moving them out of the file is the owner's decision, not a mechanical cleanup |
| `desktop/build/installer.nsh` | 178: 167 whole-line `;` comments and 11 trailing ones saying what each register saved by a `Push` holds |
| `.dockerignore`, `.editorconfig`, `.nvmrc`, `desktop/.gitignore` | none |

A workflow step run by another interpreter (`shell: python {0}`) is read with
the shell rules.

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
