# Handoff — f2c88cab-72c3-5fe9-b6a4-be359384a45d
2026-09-24 04:27 UTC · RetroGorilla/splitpage · branch `claude/optimistic-edison-dj8md4` · issue #169

Shipping the **Direction B ("Control Room")** visual identity Adam approved on
the design canvas. Phase 1 of 4 is done and pushed. Adam asked for the rest to
be run from a local session, from this file.

## Start here
1. `git fetch origin && git checkout claude/optimistic-edison-dj8md4 && git pull`
2. `npm install && node build.mjs`
3. Read this file to the end, then `HANDOFF.md` §1–§3, §5 and §9, then
   `.claude/skills/run-splitpage-app/SKILL.md`.
4. Run the phases **in order**. Each phase has a full brief in
   `.claude/handoff/direction-b/phases/`. Every phase ends the same way:
   verify (below), commit, push, then update the status table here and
   commit that too.

Everything the briefs point at is in `.claude/handoff/direction-b/`:

| Path | What it is |
| --- | --- |
| `phases/phase-2-editor.md` | Brief: topbar, script table, scene gutter, tags, picture slot, rundown strip, program clock |
| `phases/phase-3-panels.md` | Brief: B-roll, Production, Gear, Comments, Version history |
| `phases/phase-4-rest.md` | Brief: start page (On air), teleprompter, phone, gallery, menus and dialogs |
| `spec/B.md` | Direction B's tokens, type rules and first-draft board specs |
| `spec/shared.md` | The product, the real demo content, and the nine UI problems every screen must fix |
| `boards/*.dc.html` | The approved boards (the spec, see below) |
| `run-all-suites.mjs` | Runs all browser suites in parallel on Linux/macOS (Windows has `run-tests.ps1`) |

**About the boards.** They come from Adam's design canvas at
https://claude.ai/artifact/LYHYyt6gMbXmnXxWwrCzKe (private to Adam; a session
with the Artifact tool can read it, and it renders them). The copies here are
there so this works offline. A `.dc.html` needs the design runtime to render,
so read it as markup: each is a fixed 1440×900 (phone 390×844) artboard with
inline styles, and those values are the spec. The panel boards carry HTML
comments naming the app source they were drawn from.

## Status

| Phase | State | Commit | Notes |
| --- | --- | --- | --- |
| 1. Tokens, type, logo, sentence case | done | `d72e47c` | 94/94 browser suites, 563/563 unit tests, eslint 0 |
| 2. Editor, topbar, rundown strip | **next**, not started | | A run was started and stopped before it edited anything |
| 3. Side panels | pending | | |
| 4. Start page, prompter, phone, gallery, menus | pending | | |
| PR into `main` | not opened | | Ask Adam first; he hasn't asked for one yet |

## Adam's decisions from the design review (all of them; the briefs repeat the relevant ones)
- **Direction B**, palette **Neutral · Standard** (the dark tokens now in
  `src/app.css`). Light mode stays, using B's light values.
- **Logo colours are identical in every theme.** The mark is the tally monitor:
  a graphite body with blue and amber panes and a red tally dot. Done in phase 1.
- **Start page is "On air":** `boards/B-StartOnAir.dc.html` (phase 4). With no
  recent script, the band shows only the clock, the lamp and "New script".
- **B-roll panel is the calmer version** (`boards/B-BrollCalm.dc.html`). Shot
  names and "Cuts against" **wrap in full**; nothing ends in "…" (phase 3).
- **Teleprompter shows only the words being read:** no scene numbers, no
  visual/shot lines between paragraphs, just a gap between scenes. Status and
  controls stay outside the text. Stage directions will be a separate feature
  later (phase 4).
- **Phone: a scene's start time and length show only on the scene you've
  tapped into** (phase 4).
- **Production panel:** a labelled column row (Item · Status · Scenes ·
  Owner), scenes as "03, 04, 05", owner as avatar + name. Section titles look
  like titles: 14px bold, category dot, count, rule underneath. Fields and
  buttons are visible, with borders at rest (phase 3).
- **Comments panel:** one card per thread with a numbered marker, a jump link
  and the quote. Avatars are in each person's colour, a line joins a reply to
  its comment, the reply box is visible, and the actions are outlined buttons.
  Adam: "looks great" (phase 3).
- **Version history:** the open snapshot's fields are a labelled table, rows
  say "N scenes", and the Restore hint says what restoring does (phase 3).
- **Gallery:** there is no in-app playback. The dialog preview is a still (a
  video's first frame) with a small "Video · first frame" pill. The button
  says "Open file" or "Open link". The scene-5 "behind +N" explainer strip was
  cut because it confused him. The real "behind +N" divider inside a
  5+-item scene's dialog stays (phase 4).
- **Target length (back-timing) is its own feature, #170.** See "Parallel
  work".

## Parallel work: #170 target length
A separate task was queued for Adam ("Build per-script target length and
back-timing"). If he started it, that session:
- branches from this branch;
- builds the data field, the helpers, the popover and the command-menu entry
  first;
- waits for phase 2's rundown strip and program clock before drawing the
  target line, the hatching and the "0:25 left / 0:05 over" readout;
- opens a PR into this branch.

**Phase 2 must leave clean hooks** (the brief says so): one pure scale
function for the strip (e.g. `rundownScale(total, extra)`), an overlay layer
where a line can be placed by time, and a slot after the clock's total.
Before committing phase 2, check for a #170 branch or PR
(`git branch -r | grep -i target`, or the PR list) and write the hook names in
the phase 2 commit message and in #170.

## What phase 1 did (so you don't redo it)
- **Tokens.** Every old token name was kept. New ones:
  - `--hover`, `--border-strong`, `--text-visual`
  - `--tally` (live text and lamp) and `--tally-fill` (fill with white text), for things that are live only
  - `--selection`, `--highlight` / `--highlight-text`
  - `--radius-md` (8px, menus and popovers) and `--radius-lamp` (3px)
  - `--shadow` is now the floating-layer shadow

  Other rules:
  - `--accent` is amber: dark `#F9B64F` with dark text; light `#9E5800` with light text.
  - `--ok` is the b-roll cyan (B's "done" colour).
  - The two dark blocks must stay identical, and `.prompter-line` shares the dark block.
  - `src/test/palette.test.mjs` enforces the contrast and hue rules. Don't loosen it.
- **Type.** Chivo for the UI (14px/20, weight 450); Chivo Mono only for
  figures, file names, URLs and keycaps; `--font-script` (Atkinson
  Hyperlegible Next) for the script cells, the writer and the prompter.
  Sentence case everywhere.
- **Suites changed.** `click text*=PRODUCTION` and similar became
  `#btn-production`, `#btn-comments` and `#btn-present`, because the driver's
  `text=` match is case-sensitive. Also updated:
  - suite 12: the gear rule colour
  - suite 36: font names
  - suites 94 and 96: RGB values
  - suite 60: menu radius, 8px
  - suites 98 and 99: dialog radius, 10px
- **Icon.** `tools/make-icon.mjs` now draws circles. Run it after any
  `icon.svg` change; it regenerates `desktop/build/icon.ico`.
- **Desktop.** `desktop/main.js` got two colour strings (window background
  and title-bar overlay). **The Electron smoke suite was not run.** Run it on
  Windows (`docs/WINDOWS-CHECKS.md`).
- **Not seen with real fonts.** The cloud container couldn't load Google
  Fonts, so every check used fallback fonts. On your machine, look at the
  editor, the prompter and the New Tab with the real Chivo and Atkinson, and
  re-run suites 05 and 08 (they measure widths).
- **Leftovers already assigned to later phases** (listed in the phase briefs):
  - scene status colours in `01-scene-status.js` and the presence palette in `13a-presence.js` (phase 2)
  - panel shadows (phase 3)
  - card radii, the PDF/.docx tag colours and the Help wording for the highlight (phase 4)

## How to verify (every phase)
```
node build.mjs && node build.mjs --check
npx eslint .                         # 0 problems
npm test                             # all pass (563 at phase 1)
# all browser suites — must stay at 94/94 (plus any new ones):
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/skills/run-splitpage-app/run-tests.ps1   # Windows
node .claude/handoff/direction-b/run-all-suites.mjs ../splitpage-runs/pN                            # Linux/macOS
```
- `95-broll-props` failed once under load in phase 1 and passed on every
  rerun. If it fails, rerun it alone before treating it as real.
- The browser driver prints `RESULT: n/m`. `run-tests.ps1` ends with `ALL PASS`.
- A suite may be updated only when it asserted something the design
  deliberately changes (a colour, a radius, uppercase text). Say which suite
  and why in the commit.
- Take screenshots with the driver (dark, light, and the phone at 390px) and
  compare them with the boards before committing.

## Conventions (from HANDOFF.md, and how phase 1 was done)
- Edit `src/`, never `index.html` (it's generated and ignored).
- Keep every id, data-attribute and handler the JS and suites use.
  Restructure the markup, don't rewire behaviour. Nothing may change what the
  user types (HANDOFF §9).
- Comments explain why, at the density of the surrounding code, and cite #169.
- One commit per phase: "Direction B, phase N: … (#169)", with a body listing
  what changed and what was verified. End with the attribution lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (plus a
  `Claude-Session:` line if your session provides one).
- If you use subagents: give each one a phase brief, keep them on disjoint
  files, have them run no mutating git, and verify their work yourself
  before committing (the workflow in the 2026-09-22 handoff).
- Close #169 when phase 4 lands and the PR merges. Open a PR only when Adam
  asks.
