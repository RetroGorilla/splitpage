# Ship Direction B — phase 2: the editor (issue #169)

Phase 1 (already committed on this branch) put B's colour tokens, fonts
(Chivo UI, Chivo Mono figures, Atkinson Hyperlegible Next script), the logo
and sentence case into the app. Read `git show --stat d72e47c` to see what it
changed. This phase restyles and restructures the **editor**:
the topbar, the script table, and adds the rundown strip. Later phases do the side panels, start page, prompter, phone and menus.

## Read first
- `HANDOFF.md` §1–§3, §3.14 (motion), §3.16 (render /
  renderRow), §5 invariants. `.claude/skills/run-splitpage-app/SKILL.md`.
- `.claude/handoff/direction-b/spec/B.md` §"Boards" 1 (the editor spec) and
  `.claude/handoff/direction-b/spec/shared.md` §2 (the nine problems every
  direction must fix).
- The approved boards (read-only, open them as HTML to read the exact
  markup/values): `.claude/handoff/direction-b/boards/B-Editor.dc.html` (the
  editor), `B-Gallery.dc.html` (the picture slot and mosaic in a Visual
  cell), `B-Tuned.dc.html` (same editor, palette tokens).

## What to build
1. **Topbar** (`src/page.html` header, `src/js/20i-topbar.js`, app.css):
   left: logo + wordmark, `File` menu button (quiet, chevron), a 1px divider,
   the document title, and **Save as a status** ("Saved · 2 min ago" /
   "Unsaved changes" / "Saving…", with the save action on click) instead of
   a bordered Save button. Right: the panel toggles (Production, Gear,
   B-roll, Comments) as quiet toggle buttons — icon + label + mono count, no
   border, `--hover` on hover, pressed = `--hover` fill + `--text` — then
   presence avatars (24px circles filled in each person's colour with dark
   initials), `Write` as a mode toggle (ghost, 1px `--border-strong`), and
   **Present** as the one primary action: `--tally-fill` with white text and
   a small white dot before the word. Replace emoji in the chrome (📄, 👁 …)
   with 1.75-stroke SVG icons from the existing sprite or new ones in the
   same style. Keep every existing element id, data-attribute and behaviour
   the JS and the suites use — restyle and rearrange, don't rewire. Where
   the app shows things the board doesn't (review chip, file chip, update
   notice, connection state…), keep them and style them quietly in the same
   language.
2. **Script table** (row rendering in `src/js/05-render.js` and friends):
   - Column heads: "Scene" (faint), "Visual" with an 8px `--visual` dot,
     "Audio" with an 8px `--audio` dot, "Read" right-aligned. Sentence case.
   - One calm writing surface: no tinted column backgrounds. Visual text
     `--text-visual` 15px/1.55, Audio text `--text` 18px/1.6, both
     `--font-script`.
   - **Gutter**: scene number (Chivo Mono 500 18px), start time (mono 12.5px
     faint), and the **status lamp** as a labelled control (10×10 lamp, 3px
     radius, + word): To do = 1.5px `--text-faint` outline; Ready = `--audio`
     fill; Shot = `--text` fill with a tiny dark check. Clicking cycles or
     opens the status choice exactly as the app does today (read how status
     changes now; keep the behaviour, change the look). Rail: read time, mono
     14px, right-aligned.
   - **Row actions**: the always-visible ↑ ↓ + × buttons go; a drag handle
     and a "⋯" menu (Move up, Move down, Insert scene, Delete) appear on row
     hover / focus-within. Keep every action reachable by keyboard and keep
     the existing keyboard shortcuts (HANDOFF lists them; suite
     47-move-scene-keys covers some). If suites click the old buttons by
     selector, update the suites to go through the new menu and say so.
   - Done scenes (Shot) recede: their text one step dimmer (`--text-dim`).
   - The focused row gets `--surface` background across the full row.
   - **Tags** in the script: tint fill, 2px bottom rule in the category
     colour, top corners 3px, text stays `--text` (see `.tg` classes on the
     board). **B-roll lines**: a small "B-roll" label (mono 11px, 1px
     `--broll` border, 3px radius, `--broll` text) then the text with a
     hanging indent. **Comment anchors**: 1.5px dotted `--audio` underline
     and a small numbered marker (see the board).
   - **Picture slot**: the "📎 IMAGE" label in every Visual cell goes; the
     "Add picture" slot appears on row hover (dashed), and a scene with
     pictures shows its mosaic (restyle the existing gallery mosaic from
     `02d-gallery.js`/`05-render.js` to match B-Gallery.dc.html: hatched
     placeholder frames aren't needed for real images, but the tile radius,
     borders, the "+N" tile, video badges and the link lines under the
     mosaic should match).
   - The format toolbar on selection: `--surface-2` (raised), 8px radius,
     floating shadow + border, 32px icon buttons.
3. **Rundown strip** (new, under the topbar, above the column heads): the
   script as blocks sized by read time on a time ruler (ticks every 5s,
   labels every 15s, mono 11px faint), each block labelled with its number
   and duration; Shot = `--hover` fill + dim label + tiny check, Ready =
   dark amber fill with a 2px `--audio` top edge, To do = 1px
   `--border-strong` outline. B-roll shots as 2px `--broll` ticks along the
   bottom edge of their scene's block. A playhead (2px `--visual` line +
   small triangle) at the start of the focused scene, whose block gets a
   `--visual` outline. Clicking a block scrolls to / focuses that scene.
   **No target line** — a target length per script is issue #170, built
   in parallel by another session that will add the target line, the
   hatching and the "0:25 left / 0:05 over" readout on top of your strip and
   clock. Make that easy: compute the strip's scale in one pure function
   (e.g. `rundownScale(totalSeconds, extraSeconds)` → px per second, today
   mapping 0 → total + 10s), give the strip an overlay layer where a line
   can be positioned by time, and give the clock a slot after the total for
   a readout. Name these clearly and say where they are in your report.
   Also add the **program clock** to the topbar, centred: the script's total
   read time as `01:35` in Chivo Mono 500 20px `--text` (B-Editor.dc.html
   shows it with " / 02:00" and "0:25 left" — leave those out; #170 adds
   them). The strip reads
   `state.rows` and the same read-time function the rail uses; keep
   `render()` synchronous (§3.14) and update the strip from the same places
   that update read times. It must cope with 1 scene and with 60 scenes
   (blocks too narrow for a label show no label; keep ≥ 2px). Hide it in
   Write mode if the writer has no use for it — decide and say why. On
   narrow screens (phone), hide it (phase 4 does the phone layout).
   Add a `node --test` unit suite for the pure part (block positions from
   read times) if you factor one out.

## Rules
- Edit `src/`, never `index.html`. Match comment density and voice (cite
  #169). Keep ids/classes the JS or suites depend on; if you rename one,
  update every reference and every suite.
- No behaviour changes beyond what the design needs; nothing that changes
  what the user types (HANDOFF §9).
- Verify, then commit and push this phase (one commit per phase, message
  "Direction B, phase N: … (#169)", body lists what was verified):
  build + `--check`, eslint 0, `npm test` all pass, then **every browser
  suite** (see "How to verify" in the handoff). Every suite that passed at
  the end of the previous phase must pass.
- Screenshots of the editor (dark and light, a row hovered, a row
  focused, a scene with a picture) into a folder outside the repo; compare
  them with `boards/B-Editor.dc.html` and fix what differs.

At the end, update the handoff's status table: what was built, suites
updated and why, decisions, anything left for later phases.

## Notes handed over from phase 1 (this phase unless marked)
- `src/js/01-scene-status.js` still draws Ready in Visual blue and Shot in
  `--ok`. B: Ready = amber lamp, Shot = lit `--text` lamp with a dark check,
  To do = unlit outline.
- `PRESENCE_COLORS` in `src/js/13a-presence.js` is the old palette with white
  initials. B: filled circles in B colours with dark (`#0F0E0C`) initials —
  first two people blue `#80BDFB` and amber `#F9B64F`; pick further colours
  from the tag palette so each person stays distinct.
- Header counts are still pills; B draws them as mono text after the label.
  Keycaps in menus and the command menu still use the body face → Chivo Mono.
- Present still reads "▶ Present"; B uses a small white dot before the word.
- The B-roll marker in the script is not yet the bordered label.
- The "Tagging quick reference" box and the desktop-app banner stack above
  the script (shared.md §2 problem 6: the script must start immediately).
  Make the desktop banner one slim dismissible line and move the tagging
  reference out of the way of the script (Help and File ▸ Tagging reference
  already bring it back — check); keep what suites 13/15 expect or update
  them.
- Phase 3 (later): side panels still carry `--shadow`; they should be
  flat with a 1px line. Phase 4 (later): prompter reading band, card
  radii on Export / b-roll page / New Tab, PDF/.docx export colours, Help
  wording for the highlight.
- Phase 1 was built in a cloud container where Google Fonts could not load,
  so its screenshots used fallback fonts. On your machine the real Chivo /
  Atkinson load — look at the letterforms and the widths (suites 05 and 08
  measure widths) with them.

At the end of phase 1 (commit `d72e47c`) all 94 browser suites passed. One suite, 95-broll-props, failed once under load
in phase 1 and passed on rerun; if it fails for you, rerun it alone before
treating it as real.
