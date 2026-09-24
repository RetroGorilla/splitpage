# Ship Direction B — phase 3: the side panels (issue #169)

Phases 1 (tokens, type, logo, sentence case) and 2 (editor, topbar, rundown
strip) are committed on this branch — read `git log --stat -3`. This phase
rebuilds the five side panels to match the boards Adam approved, including
the changes he asked for in review. Phase 4 (later) does the start
page, prompter, phone layout, gallery, menus and dialogs.

## Read first
- `HANDOFF.md` §1–§3 (esp. §3.4 tags, §3.5 comment
  boxes, §3.11 comment cards, §3.12 Gear), §5 invariants.
  `.claude/skills/run-splitpage-app/SKILL.md`.
- `.claude/handoff/direction-b/spec/B.md` (tokens, type) — the tokens are now in
  `src/app.css`; use the variables, not hex.
- **The approved boards** — open each as HTML and read the markup and values;
  they are the spec. In `.claude/handoff/direction-b/boards/`:
  - `B-BrollCalm.dc.html` — B-roll panel
  - `B-PanelProduction.dc.html` — Production breakdown
  - `B-PanelGear.dc.html` — Gear
  - `B-PanelComments.dc.html` — Comments
  - `B-PanelHistory.dc.html` — Version history
  Each board was drawn from the app's real source, so the controls on it
  exist in the app; the HTML comments in each board say which source facts
  it used.

## Adam's review decisions (these override anything older)
- **Nothing is cut off with "…"** — shot names, item names, notes and the
  "Cuts against" line wrap in full.
- **Fields and buttons must be easy to find**: editable fields show a 1px
  `--border-strong` border and chevron at rest (not only on hover); actions
  are real outlined buttons (Resolve, Assign, CSV, Packing list, ⋯).
- **Section titles look like titles**: 14px bold `--text`, the category's
  colour dot, the count in mono, and a 1px rule under the title.
- **Production rows are columns with labels**: a label row "Item · Status ·
  Scenes · Owner"; scenes as "03, 04, 05" (each a jump link); owner as a
  small avatar in the person's colour + first name ("—" when unassigned);
  status as a 12×6 bar lamp + word (Needed = unlit outline, Sourcing = half
  amber, Have it = lit `--text`, Returned = small return arrow) — the same
  lamps in Gear and anywhere else item status shows.
- **Comments: one card per thread**: header with the thread's number marker
  (the same amber marker as in the script), "Scene 03 · Audio" jump link
  with an arrow, the quoted words (italic, script face, amber dotted
  underline); then each comment with a 28px avatar in the person's colour
  (dark initial), bold name, "Role · time"; a 2px line joining a reply to
  the comment it answers; the reply box as a visible outlined field in line
  with the comments, "Your name", Cancel, and an amber "Post reply"; a
  footer bar with outlined Resolve (green tick… use `--ok`), Assign…, and ⋯
  (Delete). Filters: Open/Resolved/All text tabs, "Everyone" and "Script
  order" as outlined menu buttons. Adam said this one "looks great".
- **Version history**: grouped by day ("Today 24 Sep"), each row time (mono)
  + label + "N scenes"; the open snapshot shows a labelled table with a
  rule between rows — Saved (Today at 14:52), Saved by (avatar + name),
  Script at the time (6 scenes), Snapshot size (15 KB) — then "Restore this
  version" and the hint "Replaces what's on screen, which is saved here
  first." Use the real snapshot fields the app stores (read 03-sync.js
  historyCardHtml and the history store); show size only if the app has it.
- Person colours are the same everywhere (presence avatars in the topbar,
  comments, owners in Production/Gear/B-roll, history). Phase 2 set the
  presence palette in `src/js/13a-presence.js` — reuse one function for
  "the colour of this person" rather than a second table.
- Panels are flat: `--surface`, a 1px `--border` left edge, no shadow.
  Header 56px, title 18px 700.

## Scope and rules
- Source: `src/js/08-production-panels.js`, `07-production-tags.js`,
  `08c-broll.js`, `08d-broll-panel.js`, `10-comments.js`,
  `03-sync.js` (history cards), `03b-side-panels.js`, `src/page.html`
  panel markup, `src/app.css`.
- Restyle and restructure the markup the panels render; **keep every
  behaviour, id, data-attribute and handler** the app and suites rely on. If
  a suite selects an element you changed, update the suite and say why.
  Don't drop a real control because the board didn't draw it — style it in
  the same language.
- Don't touch the start page, prompter, phone layout, menus or dialogs
  (phase 4) or the editor/topbar/strip (phase 2, done).
- Match comment density and voice; cite #169.
- Verify, then commit and push this phase (one commit per phase, message
  "Direction B, phase N: … (#169)", body lists what was verified):
  build + `--check`, eslint 0, `npm test` all pass, then **every browser
  suite** (see "How to verify" in the handoff). Every suite that passed at
  the end of the previous phase must pass.
- Screenshot each panel in dark and light and compare with the boards.

At the end, update the handoff's status table: what was built, real
controls kept that the boards didn't show, suites updated and why,
decisions.
