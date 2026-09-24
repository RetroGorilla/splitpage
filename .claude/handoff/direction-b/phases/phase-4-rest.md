# Ship Direction B — phase 4: start page, prompter, phone, gallery, menus (issue #169)

Phases 1 (tokens, type, logo, sentence case), 2 (editor, topbar, rundown
strip) and possibly 3 (side panels) are committed on this branch — read
`git log --stat -4`. This phase finishes the rest of the app in Direction B.

## Read first
- `HANDOFF.md` §1–§3, §5 invariants;
  `.claude/skills/run-splitpage-app/SKILL.md`.
- `.claude/handoff/direction-b/spec/B.md` (boards 3–7 specs) and `shared.md` §2.
- The approved boards in `.claude/handoff/direction-b/boards/` (open as HTML; they
  are the spec): `B-StartOnAir.dc.html`, `B-Prompter.dc.html`,
  `B-Phone.dc.html`, `B-Gallery.dc.html`, `B-GalleryDialog.dc.html`,
  `B-Command.dc.html`, `B-Identity.dc.html` (component language).

## Adam's review decisions (override anything older)
1. **Start page = "On air"** (`B-StartOnAir.dc.html`), in the New Tab page
   (`src/js/20j-newtab.js`, its markup/CSS). A band under the header: a big
   `00:00` clock in Chivo Mono with a tally lamp and "New script", then the
   most recent script drawn as a rundown (blocks sized by read time; shot =
   lit, ready = amber, to do = outlined; a playhead where it was left off)
   with an amber **Continue** button. Below: the starter cards in a row,
   Recent + Join side by side, a compact drop zone, help links. Use the
   real recents data the page already has (desktop recents, and whatever
   the browser build has); if the page doesn't know a recent script's
   scenes/statuses, read how it could (the recent file's metadata) and, if
   it can't without opening the file, draw the band without the rundown
   (title, time, Continue) and say so. **With no recent script at all**, the
   band shows only the clock, the lamp and "New script", and the starters
   move up. Keep every existing action, id and suite expectation (30, 36,
   38 cover this page).
2. **Teleprompter: nothing in the reading area but the words being read.**
   No scene numbers, no visual/shot lines, no icons between paragraphs — a
   plain gap marks a scene change. Status (scene n of N, elapsed/remaining,
   voice-following state) and controls stay, outside the text. (Stage
   directions will come later as their own feature — not now.) Apply B's
   prompter look: Atkinson 600, ~60px at default size, line-height 1.42,
   ~1040px measure, a reading band (see the board), the tally red only for
   live states. Keep mirror/flip/scene mode/Follow My Voice/speed/size and
   every suite (04, 32, 49, 58, 71, 72, 82, 83…).
3. **Phone** (`B-Phone.dc.html`, the app's narrow-screen CSS): content
   first; modes and panels in a bottom bar; a compact rundown strip at the
   top. Scene headers show only the scene number and status — **the start
   time and read time appear only on the scene you've tapped into** (the
   focused one). Suites 05, 38 and any mobile ones must pass.
4. **Gallery** (the Image section's mosaic in the Visual cell and the
   gallery dialog, `02d-gallery.js`, `05e-gallery-overlay.js`,
   `05-render.js`): match `B-Gallery.dc.html` / `B-GalleryDialog.dc.html`.
   In the dialog the preview is a **still** (a video's first frame) — no big
   centred play button: a small "▶ Video · first frame" pill and the length;
   the button that opens a video says what it does ("Open file" for a file,
   "Open link" for a URL) with a title saying where it opens. Numbered grid
   tiles, the selected one outlined in `--visual`, the "behind +N" divider
   (only when there are more than 4 items), the "+" add tile. Don't add
   in-app playback.
5. **Menus and dialogs**: File menu, command menu (`B-Command.dc.html`),
   Export dialog, the b-roll full page, connect/servers, help, tour card,
   toasts: B's floating layer (raised `--surface-2`, `--radius-md` for
   menus/popovers, `--radius` for dialogs, `--border-strong` + `--shadow`),
   keycaps in Chivo Mono 11.5px with a 1px `--border-strong` border and 4px
   radius, sentence case, 1.75-stroke icons. Card radii that are still 12px
   (Export, b-roll page, New Tab) → 8px.
6. Leftovers from phase 1: the Help page (`docs/help.md`) still calls the
   highlight "a yellow fill" — word it for both themes. PDF and .docx
   exports keep print colours on purpose, but their tag colours should be
   B's light values (they print on white).

## Rules
- Keep every behaviour, id and data-attribute the app and suites use;
  update a suite only when it asserted something this design deliberately
  changes, and say so. Nothing that changes what a user types.
- Match comment density and voice; cite #169.
- Verify, then commit and push this phase (one commit per phase, message
  "Direction B, phase N: … (#169)", body lists what was verified):
  build + `--check`, eslint 0, `npm test` all pass, then **every browser
  suite** (see "How to verify" in the handoff). Every suite that passed at
  the end of the previous phase must pass.
- Screenshots (dark + light, and the phone at 390px); compare with the boards.

At the end, update the handoff's status table: what was built, real
controls kept that the boards didn't show, suites updated and why,
decisions.
