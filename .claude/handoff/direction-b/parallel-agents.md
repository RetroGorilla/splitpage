# Direction B (#169) — rules every parallel agent follows

Give this file to every lane agent in phases 3 and 4, along with its lane
from the handoff
(`.claude/handoff/2026-09-24-0539-direction-b-phases-3-4-8d326eb5-5ba1-4b4d-8759-20638d702fee.md`).
It was written for the Windows machine at `D:\vibecoding\Splitpage x64 Testing`.

You are one of several agents building part of Splitpage's Direction B
redesign at the same time, each in **its own git worktree** of
RetroGorilla/splitpage, on disjoint parts of the app. The coordinator merges
everyone's changes. So:

## Where you work
- Your worktree path is given in your task. Work ONLY there (absolute paths).
  Never touch `D:\vibecoding\Splitpage x64 Testing\repo` or another worktree.
- Node is not on PATH. PowerShell: `$env:Path = "D:\vibecoding\Splitpage x64 Testing\tools\node;$env:Path"`.
  Bash: `export PATH="/d/vibecoding/Splitpage x64 Testing/tools/node:$PATH"`.
  The coordinator has already made `node_modules` in your worktree (a
  junction to the coordinator's). Build with `node build.mjs`
  from your worktree root after every `src/` change; `node build.mjs --check`
  says whether it is current.
- **No mutating git at all**: no commit, add, stash, checkout, reset, rebase,
  push, branch. Leave your changes uncommitted; the coordinator collects them
  with `git diff`. Reading git (`git diff`, `git log`, `git show`) is fine.

## Read first
- `HANDOFF.md` §1–§3 (skim §3 for the parts you touch) and §5 (invariants).
- `.claude/handoff/2026-09-24-0427-splitpage-direction-b-f2c88cab-72c3-5fe9-b6a4-be359384a45d.md`
  — Adam's design decisions (all binding) and "What phase 2 did".
- Your phase brief in `.claude/handoff/direction-b/phases/` and your
  board(s) in `.claude/handoff/direction-b/boards/`. A board is a fixed
  1440×900 (phone 390×844) static mockup with inline styles; **its values
  are the spec** (sizes, colours → map hex to the tokens in `src/app.css`
  `:root` / dark blocks; never hard-code a hex that has a token).
  `spec/B.md` has the tokens and type rules.
- `.claude/skills/run-splitpage-app/SKILL.md` "Gotchas" before testing.

## Rules
- Edit `src/` (and tests/docs you are told to), never `index.html`.
- **Edit tool, one site at a time.** Never sed -i / perl -pi / scripted
  rewrites of source files.
- Restyle and restructure the markup your area renders; **keep every id,
  class the JS reads, data-attribute, data-action and handler** the app and
  the suites rely on (grep `src/js` and `.claude/skills/run-splitpage-app/tests`
  before renaming anything). Don't drop a real control because the board
  didn't draw it — style it in the same language. Don't change behaviour
  beyond what the design needs, and **nothing that changes what the user
  types** (syntax, shortcuts). If a board and the app's real behaviour
  disagree in a way your brief doesn't settle, stop that item and report it.
- Comments explain why, at the density of the code around them, citing #169.
  Sentence case everywhere. Chivo Mono only for figures, file names, URLs,
  keycaps. 1.75-stroke icons: use the sprite (`<svg><use href="#i-…"/></svg>`,
  symbols at the top of `src/page.html`); if you need a new icon, write it
  inline in your own markup/JS rather than adding to the sprite (another agent
  may be adding there too).
- **Stay in your lane in shared files.** `src/app.css` and `src/page.html`
  are edited by several agents at once in separate worktrees and merged by
  git afterwards, so: change only the sections named in your task; don't
  reformat, move or re-indent anything else; put new rules inside your own
  section. Phone-width rules for your area go in an `@media (max-width: 760px)`
  block **inside your own section**, not in the shared responsive block
  (the phone agent owns that one).
- Shared building blocks already exist (app.css "side panel parts (#169)"
  and "header"/"rows"): `.panel-tabbar` / `.panel-tabs` / `.panel-tab`
  (text tabs with a 2px underline when `aria-checked="true"` or
  `.is-active`), `.btn-outline` (+ `.is-small`), `.ev-field` (a field with
  its border visible at rest), `.item-lamp` (12×6 bar: `.is-needed`,
  `.is-sourcing`, `.is-have`, `.is-returned`), `.person-avatar`
  (`style="--presence:<colour>"`, dark initials), `.jump-link`. A person's
  colour is `personColor(name)` from `src/js/13a-presence.js` — use it, don't
  invent another palette. Use these rather than restyling your own copies.

## Verify before you report
- `node build.mjs`, `npx eslint .` (0 problems), `npm test` (all pass).
- Browser suites: run only the ones that touch your area, two lanes, e.g.
  `powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/run-tests.ps1 -Only 10 -Parallel 2`
  (one `-Only` per call; the prefix matches filenames). Other agents are
  running suites on the same machine: if a suite fails with an aborted
  socket or a timeout on its first command, rerun it alone before treating
  it as real. You may update a suite **only** where it asserted something
  the design deliberately changes (a colour, a radius, a label the board
  renames) — say which assertion and why in your report.
- Screenshots: write a driver script (see SKILL.md "Ad-hoc driving"; `shot`
  saves a PNG) and run it with
  `powershell -NoProfile -ExecutionPolicy Bypass -File <worktree>\.claude\skills\run-splitpage-app\driver.ps1 -Script <file> -Port <free port 8900-8999> -CdpPort <free 9400-9499> -Root <worktree> -ShotDir <folder outside the repo>`.
  The driver pins the light theme; set `document.documentElement.setAttribute('data-theme','dark')`
  for dark. The boards' content is the To-camera starter: load it with
  `eval (async function(){ var s = await (await fetch('/src/starters/to-camera.json')).json(); await window.__splitpageFormats.openFile(new File([JSON.stringify(s)], 'three-lights.splitpage')); return true; })()`.
  Take dark and light shots, look at them against your board, and fix what
  differs. The driver's `caret` takes a selector only (no offset).

## Report (your final message)
- Files changed, and in `app.css` / `page.html` which sections.
- What you built, against the board, and what differs from it and why.
- Real controls you kept that the board didn't draw, and how you styled them.
- Suites run with results; suites changed, which assertion, and why.
- Screenshot paths.
- Anything you stopped on (a question for Adam), and anything left undone.
