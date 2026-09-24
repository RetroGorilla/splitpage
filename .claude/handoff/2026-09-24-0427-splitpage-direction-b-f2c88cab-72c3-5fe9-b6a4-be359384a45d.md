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
| 2. Editor, topbar, rundown strip | done | `8fb43e2` | Windows 11 x64, real fonts: all 94 browser suites (4911/4911), 574/574 unit tests, eslint 0; desktop smoke dev 808/808 (the first run since phase 1). See "What phase 2 did" |
| 3. Side panels | done | `82f1645` | Shared panel shell + four parallel lanes. Windows 11 x64, real fonts: all 94 browser suites (4929/4929), 574/574 unit tests, eslint 0. Adam's calls during the phase: every panel defaults to 488px (the boards' width); B-roll's Status field toggles in one click; Comments' ⋯ opens a menu holding Delete; the Older history Restore is a small outlined button; no comment roles. Suites 07, 50, 61, 77, 78, 89, 93, 94, 95 updated for design changes (see the commit body) |
| 4. Start page, prompter, phone, gallery, menus | done | `9a35f77` | Five parallel lanes. Windows 11 x64, real fonts: all 94 browser suites (4974/4974), 574/574 unit tests, eslint 0; desktop/ untouched, so no smoke rerun. Adam's calls: start page shows the recent script as title, time and Continue (no rundown, no file read); the prompter's reading line stays in the middle; "Follow My Voice" keeps its name; phones open the prompter at 36px; export category colours are #171. Kept beyond the boards: Gear as a sixth phone tab, the phone's second header line, Skip shot and scene mode's stepper in the prompter. Suites 05, 30, 36, 60, 96, 99 and the palette test updated (see the commit body) |
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

## What phase 2 did (so you don't redo it)
Run locally on Windows 11 (the session had the real fonts; Node from
`Splitpage x64 Testing\tools\node`, nothing is on PATH there).

- **Test drivers pin the light theme.** `driver.ps1` and `driver.mjs` send
  `Emulation.setEmulatedMedia prefers-color-scheme: light` on connect. This
  Windows machine is in dark mode, so headless Edge drew the dark palette
  and suites 12, 94 and 96 (which read colours back) failed against light
  values. 96 and 97 set `data-theme` themselves when they want dark.
- **Topbar** (`src/page.html`, app.css "header (#169)"): one 52px row in a
  three-column grid. Left: mark, File (`.btn-quiet` + chevron),
  `.topbar-rule`, title, then Save as a status. `#btn-save` draws its
  status from `data-status` via `::before` (written by `updateSaveStatus`,
  12-dirty-toast.js, including "Saved 2 min ago"), and its own text stays
  "Save" / "Save •" for the writer mirror and the suites. `#save-status`
  is visually hidden but still the live region. Then presence avatars,
  then `.doc-meta` (review chip, file chip, shot count, identity), which
  only takes the room left over. Centre: the program clock, which is still
  `#runtime-chip` (click = reading speed). Right: the panel toggles
  (`.panel-toggle`, `aria-pressed` kept in `syncPanelClass`, 03-sync.js),
  Write (`.btn-mode`), and Present (`.tally-dot`).
- **Header condensing** (20i-topbar.js) now sheds the rundown's ruler.
  The header row never moves. Suite 61 was updated to match (brand, title
  and toolbar assertions became ruler and track ones).
- **Script table:** `--row-cols` on `#root` is 112px / 1fr / 1.25fr / 80px.
  Rows, column heads and header are full-bleed (`margin: 0 -20px`) inside
  `#root`'s new 20px padding.
  - The gutter (`rowGutterHtml`, 05-render.js) holds the number and start
    time, then the status lamp and word (`.status-dot` keeps
    `is-open` / `is-half`), then `.row-tools`: a grip and a "⋯" menu.
  - The menu holds the same four `.gutter-btn` buttons with the same
    data-actions. Its open/close and keyboard handling is in 06-rows.js
    (`toggleRowMenu`, `rowMenuKeydown`). Delete's armed label comes from
    `armDeleteButton` / `disarmDeleteButton`.
  - Start times and the rail's read time are written by `paintRowTimes()`
    (text only, no repaint, so suite 67 still sees no row painted while
    typing), called from `updateScriptStats` and `renderRow`.
  - Media sits under the Visual text now. The empty slot is a hover-only
    dashed "Add picture". The mosaic is 360×162 (suite 91's height range
    was updated).
  - Comment markers are CSS counters (`#rows .cmt-anchor:not(.resolved)::after`),
    numbered in document order. **Phase 3's comment cards should number
    threads by the DOM order of `#rows .cmt-anchor` so the two agree.**
- **Rundown strip:** `src/js/05f-rundown.js`, skeleton in page.html inside
  the header, tested by `src/test/rundown.test.mjs`. The playhead follows
  focusin and selectionchange. Clicking a block reveals the scene, centres
  it and focuses its Audio. The blocks use a roving tabindex with arrow keys.
  It is hidden at ≤760px, and the writer and prompter cover it (the writer
  has its own runtime; a strip moving with every sentence there adds nothing).
- **#170 hooks:** `rundownScale(total, extra, width)`,
  `setRundownExtraSeconds(sec)`, `#rundown-overlay`, `rundownX(sec)`,
  `onRundownPaint(fn)`, and `#program-clock-slot`. Open question for #170:
  a click on the clock opens the reading-speed box today.
- **Also:**
  - The tagging reference no longer opens itself on every visit (it's in
    File, Help, the start page and the tour).
  - The update and desktop-app notices are one slim line.
  - Presence colours are B's (`personColor(name)`, exported from
    13a-presence.js — **phase 3 should use this for every person**).
  - Menu and command-menu keycaps are Chivo Mono.
  - Panel toggle icons are hidden ≤760px (they overflowed a 375px phone).
- **Known deviations from B-Editor:**
  - The b-roll label shows the typed keyword ("B-roll:"), because it is
    document text. There is no hanging indent, because a cell's lines
    aren't blocks.
  - The row menu has no shortcut chips; the shortcuts are in each item's
    title instead.
  - The status button still cycles (no chevron), as the brief asked.

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
