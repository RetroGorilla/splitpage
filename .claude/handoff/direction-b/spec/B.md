# Direction B — "Control Room"

## The idea (commit to it fully)

Scripts are **timed pieces of television**. Splitpage becomes a quiet broadcast
console: matte graphite surfaces, timecode set in a proper mono, and a **program
rundown strip** that shows the whole piece as blocks sized by read time, so you
can see its shape, see what is shot, and **back-time to a target length**.

Colour is signal, never decoration — exactly as in a gallery/control room:
- **Preview blue** = Visual. **Program amber** = Audio.
- **Tally red** appears ONLY when something is live: the Present button, recording,
  Follow My Voice listening.
- Scene status are **lamps**: To do = unlit outline, Ready = amber lamp, Shot = lit
  white with a check (done scenes quietly recede).

Dark-first (edit suites and studios are dark; the teleprompter is the flagship
surface), with a light mode shown on the identity sheet. Matte, not glossy: no glow,
no neon, no gradients, no glass. Warm-neutral graphite, never blue-black.

## Tokens (validated — use exactly)

Dark (primary):
- bg `#0F0E0C` · surface `#171614` · raised `#21201E` · hover `#2A2926` · line
  `#2E2E2B` · line-strong `#43423F`
- text `#ECEBE7` · text-dim `#B2B1AB` · text-faint `#94928D` (≥4.5:1 on bg,
  surface and raised) · Visual-column body text `#D6D5D0`
- Visual / preview `#80BDFB` · Audio / program `#F9B64F` · tally (text/lamp)
  `#F45246` · tally fill (with white text) `#D7352D` · focus ring `#80BDFB` 2px
- Tags (underline colour) / tint (fill behind the word; text stays `#ECEBE7`):
  Prop `#CBA1FA` / `#2D2437` · Cast `#F89DC9` / `#36222B` · Music/SFX `#EF958E` /
  `#382220` · VFX `#C8DE63` / `#272B17` · Gear `#90B888` / `#202D1D` · Location
  `#73D4AC` / `#172E25` · B-roll `#64D1D7`
- Selection `#2F4A66` · highlight (HL format) fill `#4A3F1C` with text `#ECEBE7`
- Radii: 6px controls, 8px menus/popovers/detail cards, 10px dialogs, 3px lamps
  and timeline blocks. Shadows only on floating layers: `0 24px 60px -20px
  rgba(0,0,0,.7)` + 1px `#43423F` border.

Light (identity sheet; shipped in phase 1 with derived tokens — see `src/app.css` `:root`): bg `#F1F0ED` · surface `#FCFCFA` · text `#171613` ·
text-dim `#4E4D48` · text-faint `#64635E` · Visual `#2863AB` · Audio `#9E5800` ·
Prop `#764AA2` · Cast `#A53C75` · Music/SFX `#AB413E` · VFX `#5E6C00` · Gear
`#44693C` · Location `#2A7449` · B-roll `#00717F`.

## Type

One link:
`https://fonts.googleapis.com/css2?family=Chivo:ital,wght@0,100..900;1,100..900&family=Chivo+Mono:wght@100..900&family=Atkinson+Hyperlegible+Next:ital,wght@0,200..800;1,200..800&display=swap`

- **Chivo** — interface (fallback `"Helvetica Neue", "Segoe UI", sans-serif`).
  UI 14px/20 450; small 13px; headings 600–700; wordmark 700 15px.
- **Chivo Mono** — every figure that is time or a count: timecode, durations,
  scene numbers, badges, keycaps (fallback `ui-monospace, "SF Mono", Consolas,
  monospace`). 500 weight. Timecode format `00:31`; durations `0:19`.
- **Atkinson Hyperlegible Next** — the script itself and the prompter: designed
  for legibility at distance and low vision (fallback `"Atkinson Hyperlegible",
  Verdana, sans-serif`). Visual text 15px/1.55 `#D6D5D0`; Audio text 18px/1.6
  `#ECEBE7`; prompter 600 at 60px/1.42.
- Sentence case. No uppercase labels except keycaps ("Esc", "Ctrl").

## Icons

1.75 stroke, 18–20px, `#B2B1AB` default, `#ECEBE7` on hover/active.

## The mark

> **Superseded.** The shipped mark is the tally monitor in `boards/B-Identity.dc.html`
> (already in the app since phase 1: `src/page.html` `.brand`, `icon.svg`). The
> description below is the first draft.


A **tally monitor**: a 24×17 rounded rectangle (3px radius) split into two panes
with a 2px gap — left pane `#80BDFB`, right pane `#F9B64F` — and a 5px `#F45246`
dot sitting just above its top-right corner (the tally light). Wordmark "Splitpage"
in Chivo 700. App icon: `#0F0E0C` rounded square with the monitor mark centred
large.

## Boards (root `.claude/handoff/direction-b/boards`)

### 1. `project/B-Editor.dc.html` — Editor, 1440 × 900
- **Header** 52px, bg, 1px line bottom. Left (20px in): mark + "Splitpage";
  `File` menu button (Chivo 14 text-dim + chevron); 1px × 20px line divider; title
  "Three Lights for Under $200" (Chivo 600 15px text) and "Saved 2 min ago" (13px
  text-faint). **Centre** (absolutely centred): the **program clock** — "01:35"
  Chivo Mono 500 20px text, " / 02:00" Chivo Mono 14px text-faint, then a 13px
  text-dim readout "0:25 left" (values from the tweak). Right (20px in): panel
  toggles as icon + label + mono count buttons, 32px tall, text-dim, 6px radius,
  hover `#2A2926`: Production 10, Gear 2, B-roll 3, Comments 1; presence avatars
  (24px circles: S `#80BDFB` fill / P `#F9B64F` fill, `#0F0E0C` initials, ring
  2px bg); `Write` (ghost: 1px line-strong border, pen icon); **Present** (tally
  fill `#D7352D`, white Chivo 700 14px, a white 7px dot before the word, 34px tall).
- **Rundown strip** (y 52 → 124, surface, 1px line bottom), padding 0 20px:
  - Top 22px: time ruler — minor ticks every 5s (1px × 4px `#43423F`), labels every
    15s ("0:00", "0:15", …) Chivo Mono 11px text-faint.
  - Bottom 38px: scene **blocks**, each positioned by start time and sized by
    duration, 30px tall, 3px radius, 2px gap between: label "01" Chivo Mono 12px +
    "0:15" text-faint inside. States: Shot (01, 02) = `#2A2926` fill, text-dim
    labels, a tiny check; Ready (03) = `#F9B64F` at 22% over surface → use solid
    `#4A3A1C` fill with a 2px `#F9B64F` top edge and text labels; To do (04–06) =
    transparent with a 1px `#43423F` outline. B-roll shots show as 2px-wide
    `#64D1D7` ticks along a block's bottom edge where they occur (01, 03, 05).
  - **Playhead** at 0:31 (start of scene 03, the focused scene): 2px `#80BDFB`
    vertical line through ruler and blocks with a small downward triangle on top;
    block 03 gets a 1.5px `#80BDFB` outline.
  - **Target**: a dashed 1px `#ECEBE7` vertical line at the target time with a
    label above it "Target 2:00" (Chivo Mono 11px text); the span between the end
    of scene 06 and the target is filled with 45° hatching (1px `#43423F` lines,
    6px apart — use a `repeating-linear-gradient`; this is a pattern, not a wash)
    and labelled "0:25" in text-faint.
  - Scale: the strip's inner width maps 0 → (max(target, 1:35) + 10s). Positions
    computed in `renderVals()` from the tweak.
- **Script table** (y 124 →), padding-inline 20px, grid columns
  `[112px gutter][visual 1fr][audio 1.25fr][80px rail]`, 32px column gap.
  - Column heads row 40px (bg, 1px line bottom): gutter "Scene" text-faint 13px;
    "Visual" with an 8px round `#80BDFB` lamp before it; "Audio" with an 8px
    `#F9B64F` lamp; rail head "Read" right-aligned. Chivo 600 13px text-dim.
  - Rows: 1px line between, padding 18px 0. **Gutter**: "03" Chivo Mono 500 18px
    text; "00:31" Chivo Mono 12.5px text-faint (start time); status lamp button
    (10×10 lamp, 3px radius + label Chivo 12.5px): To do = 1.5px `#94928D`
    outline, label text-faint; Ready = `#F9B64F` filled, label text; Shot =
    `#ECEBE7` filled with a tiny `#0F0E0C` check, label text-dim. **Rail**:
    "0:19" Chivo Mono 14px text, right-aligned.
  - Rows 01–02 (Shot): their Visual/Audio text drawn one step dimmer (`#B2B1AB`)
    — done scenes recede.
  - **Row 01** Visual shows a picture: a 16:9 placeholder 144px wide below the
    text — `#171614` fill, 1px `#43423F` border, 4px radius, faint 45° hatching,
    "MS" in Chivo Mono 11px text-faint centred.
  - **Row 03 is focused**: `#171614` background across the full row, the gutter
    shows a 6-dot grip and a "⋯" icon button (28px) above the numeral line.
    In its Audio cell the words "the brightest one" are selected (`#2F4A66`), and
    the **format toolbar** floats above them: `#21201E`, 8px radius, floating-layer
    shadow + border, 36px tall, 32px icon buttons in `#ECEBE7`: B, I, U, S |
    Highlight | Link | Comment | Tag with chevron (aria-labels on all).
    The words "a little above your eyes" carry a comment anchor: 1.5px dotted
    `#F9B64F` underline and a superscript speech-bubble marker "1" (16×14, amber
    outline, Chivo Mono 10px).
  - **Tags**: helmet classes — tint fill (the category tint), 2px bottom border in
    the category colour, 3px radius on top corners only, padding 0 2px; text stays
    `#ECEBE7`.
  - **B-roll lines**: a 18px-tall label "B-roll" (Chivo Mono 11px `#64D1D7`, 1px
    `#64D1D7` border, 3px radius, padding 0 5px) then the text; hanging indent.
  - Visible: rows 01, 02, 03 fully, 04 clipped at the bottom.
- **Tweak**: `target` enum ["1:30","2:00","3:00"], default "2:00". renderVals
  computes: scale, block left/width (px), tick list, the target line position,
  the clock readout (" / 02:00") and the delta text ("0:25 left" or "0:05 over"
  — over when 1:35 > target, in that case colour the delta `#F45246` and hatch the
  overrun part of block 06 instead).

### 2. `project/B-Broll.dc.html` — B-roll panel open, 1440 × 900
- Header and rundown strip as board 1 but the strip spans only the editor part
  (x 0 → 952) and "B-roll 3" is active (`#2A2926` fill, text colour).
- Script table in the remaining 952px (rows 01–03 visible, no toolbar, the b-roll
  label in row 03 outlined in `#80BDFB` to show it is the selected shot).
- **Panel** x 952 → 1440 (488 wide), y 52 → 900, surface, 1px line left border:
  - Header 56px: "B-roll" Chivo 700 18px; icon buttons "Open as a full page"
    (expand icon) and close.
  - Summary: "1" Chivo Mono 500 28px + " of 3 shot" 14px text-dim; a segmented
    progress bar (3 equal segments, 6px tall, 2px gaps, 3px radius): 1 `#64D1D7`, 2
    `#2E2E2B`.
  - Filter row: a segmented toggle "All 3 · To shoot 2 · Flagged 0 · Shot 1"
    (counts in mono; All selected = `#2A2926` + text) and at right "Group: Scene"
    as a `<select>` styled button.
  - Groups by scene. Group head 36px: "Scene 01" Chivo 600 13px text + "00:00"
    mono text-faint + an italic excerpt of that scene's Audio (text-faint 12.5px,
    one line, ellipsis) + "1/1" mono (in `#64D1D7` when complete) right.
  - Shot rows 56px: checkbox (20px, 1.5px `#94928D` border, 5px radius; checked =
    `#64D1D7` fill with `#0F0E0C` check), name (Chivo 14.5px text; a shot that is
    shot reads text-dim), meta line 12.5px text-faint: map-pin icon + location ·
    owner avatar 16px. Right: flag icon button (hover state only).
  - **Scene 03's shot is open**: its row on `#21201E`, followed by a detail block
    (raised `#21201E`, 8px radius, padding 16px, no border stripe) as a label/value
    grid (96px labels Chivo 13px text-faint, values 14px text): Status (lamp button
    "To shoot" + chevron), Scene ("03 · 00:31" link-styled, `#80BDFB`), Location
    (select showing "Choose a location"), Assigned (avatar S + "Sam" + chevron),
    Props (a chip "softbox" = prop tint `#2D2437` with a 6px `#CBA1FA` dot, and a
    ghost "+ Add prop" button), Cuts against (italic Atkinson 14px text-dim: "Step
    one is your key light — the brightest one, and the one that shapes your
    face…"), Note (a textarea, placeholder "Add a note"). Actions row: "Flag for
    reshoot" ghost button with flag icon, "Rename", "Delete" (text buttons,
    Delete in `#F45246`).
  - Scene 05 group with its one to-shoot row (props line shows "RGB tube light"
    chip).
  - Bottom (fixed to panel bottom, 88px, 1px line top): "Add a shot" input
    (surface-2 `#0F0E0C` fill, 1px line-strong, 40px) + "Add" button; hint
    below: "Or start a line with B-roll: in the Visual column." (13px text-faint,
    "B-roll:" in Chivo Mono `#64D1D7`).

### 3. `project/B-Command.dc.html` — Command menu (Ctrl+K), 1440 × 900
- Board 1 underneath (no toolbar), scrim `rgba(8,8,7,.62)`.
- Palette: 640 wide, top at y 132, centred; raised `#21201E`, 10px radius,
  floating shadow + border.
  - Input row 56px: search icon, the typed text "exp" (Chivo 17px text) with a
    1px `#ECEBE7` caret, placeholder style n/a, right a keycap "Esc".
  - List (max 8 rows visible), groups with heads (Chivo 600 12.5px text-faint,
    padding 12px 16px 4px): **Export** — "Export…" (Ctrl E) **selected** (row
    `#2F2E2B`, text, icon `#ECEBE7`), "Export again as PDF", "Narration only
    (.docx)", "Breakdown (.csv)", "Gear packing list (.pdf)"; **File** — "Export
    app data…"; **Share** — "Publish & copy a link" with a second line
    "No server connected — set one up first" (12.5px text-faint). Each row 40px (52
    with a second line), 18px icon, label Chivo 14.5px with the matched letters
    "Exp"/"exp" in 700 text and the rest text-dim; keycaps right: Chivo Mono 11.5px,
    1px `#43423F`, 4px radius, 20px tall, 6px padding.
  - Footer 40px, 1px line top: "↑ ↓ to move", "Enter to run", "Esc to close" with
    keycaps, 12.5px text-faint, 16px gaps.

### 4. `project/B-Prompter.dc.html` — Teleprompter, 1440 × 900 (the flagship)
- Ground `#0A0A09`.
- **Top bar** 60px: left "03 / 06" Chivo Mono 16px text + scene start "00:31"
  text-faint; centre: elapsed "00:38" Chivo Mono 500 30px `#ECEBE7` + " −00:57"
  Chivo Mono 16px text-faint (remaining); right: a **Listening** indicator — an
  8px `#F45246` lamp + "Follow my voice" 14px text + "Listening" text-faint.
- **Text**: Atkinson Hyperlegible Next 600, 60px/1.42, measure 1040px centred.
  Already-read text above the reading line `#5F5E5A`; upcoming text `#F2F1ED`.
  Content: the end of scene 02 above, then scene 03's Audio, then the start of
  scene 04 — each scene preceded by a quiet cue line: camera icon + the scene's
  Visual text in Chivo italic 18px `#80BDFB` at 70% ("Wide: the softbox on a light
  stand, 45° off to camera left, just above eye line.") and "03" Chivo Mono 14px
  text-faint.
- **Reading line** at y ≈ 360: the line of text on it sits on a full-width band
  `#161614` (height = one line), with a 26px amber `#F9B64F` right-pointing
  triangle at x = 150 and a 1px `#F9B64F` rule at 35% opacity across the band's
  bottom.
- **Bottom**: a 28px mini rundown across the width (padding 0 40px): scene blocks
  sized by duration, 6px tall, played portion `#ECEBE7`, rest `#2E2E2B`, scene
  gaps 3px, amber playhead dot at 0:38. Below it the **control row** 72px: Play/
  Pause as a 52px circle `#F9B64F` with a `#0F0E0C` pause icon (it is playing);
  "Speed" stepper (− "1.2×" +); "Size" stepper (− "60" +); "Scene mode" toggle;
  "Follow my voice" toggle ON (tally lamp + label); "Mirror"; "Flip"; "Full
  screen"; far right "Close" + "Esc" keycap. Ghost buttons: 40px, 8px radius, 1px
  `#2E2E2B` border, Chivo 14px text, icons 18px.

### 5. `project/B-Start.dc.html` — Start page, 1440 × 900
- bg page. Header 56px: mark + "Splitpage"; right: "Join a shared session"
  (ghost, people icon) and "Open a file…" (raised `#21201E`, 1px line-strong,
  folder icon, text).
- Two columns inside 1200px centred, top y 112: **left** (736): "New script"
  Chivo 700 34px text; "Pick a layout, or carry on where you left off." 15px
  text-dim. A 2×2 grid of starter buttons (each 356 × 164, surface `#171614`, 1px
  line, 10px radius, padding 20px; hover raised): name Chivo 600 16px, description
  13.5px text-dim, and at the bottom a **mini rundown** (the starter's scenes as
  blocks sized by time, 10px tall, `#2E2E2B` with 1px gaps; the To-camera one shows
  its real 15/16/19/14/14/17 split) with the runtime in Chivo Mono 12.5px text
  right ("1:35"; Interview "0:55" with scenes 7/9/10/7/9/13s; 30-second spot "0:32" with 8/6/7/5/4/2s; Blank = a dashed
  1px `#43423F` border card with a plus icon and "One empty scene, and nothing
  else.", no rundown). **Right** (416): "Recent" Chivo 600 14px text-dim; rows
  64px (1px line between): file icon, title Chivo 600 14.5px, meta line Chivo Mono
  12px text-faint ("three-lights.splitpage · 1:35 · 2/6 shot"), time right
  ("2 h ago", "Yesterday", "12 Sep"). Below the list, a "Join a shared session"
  block (surface, 10px radius, padding 20px): heading 15px 600, text "Open the link
  you were sent, or connect to a server with its PIN." 13.5px text-dim, button
  "Connect…".
- Bottom band (y ≈ 760): a dashed 1px `#43423F` drop zone (full 1200 width, 72px):
  import icon + "Drop a script here" 15px 600 + ".md, .splitpage, .docx, .txt or
  .csv — or paste one · import a Google Doc link" (links `#80BDFB`). Under it
  text links: "Take the tour" · "Tagging cheat sheet" · "Look at the example
  script".

### 6. `project/B-Phone.dc.html` — Phone editor, 390 × 844
- bg. Top bar 56px: File icon button (40px), title (Chivo 600 15px, ellipsis),
  the clock chip "01:35" (Chivo Mono 13px on raised, 6px radius, 28px tall), and a
  Present icon button (40px, tally fill, white present icon).
- Rundown strip 52px (surface): scene blocks across 358px, 22px tall, same states
  as desktop, playhead on 03, labels "01"… Chivo Mono 10.5px inside.
- Scenes stacked (padding 16px): header row 44px: "03" Chivo Mono 16px text +
  "00:31" faint + "0:19" + status lamp button right; Visual text 14.5px `#D6D5D0`
  (with a tiny `#80BDFB` lamp + "Visual" 12px label first); Audio 17px/1.55 text
  (tiny amber lamp + "Audio" label). Tags as desktop. Show scene 03 (focused,
  surface background) and scene 04 until clipped; scene 02's last lines at top.
- Bottom bar 72px (surface, 1px line top): Script (active: text + 2px `#80BDFB`
  bar above), Write, Production "10", B-roll "3", Comments "1" — icon 22px + label
  11.5px, each ≥ 64px wide.

### 7. `project/B-Identity.dc.html` — Identity sheet, 1440 × 1400
Dark sheet; sections with Chivo 700 22px heads and 1px line rules:
1. **Mark**: the tally-monitor mark at 96px + wordmark 64px; small lockup; app
   icon 128/64/32/16; mark on light `#F1F0ED`.
2. **Colour**: graphite scale (bg, surface, raised, hover, line, line-strong) as a
   row of tall swatches with names + hex (Chivo Mono 12px); text scale (text,
   dim, faint) on bg; **Signal**: Preview / Visual `#80BDFB`, Program / Audio
   `#F9B64F`, Tally `#F45246` — big swatches with a one-word role; **Tags**: each
   category as its real in-script mark on a sample word (tint + underline) + name +
   both hexes; B-roll label.
3. **Type**: Chivo specimen (UI), Chivo Mono specimen ("00:31  0:19  01:35 /
   02:00  2/6"), Atkinson Hyperlegible Next specimen: the scene 03 Audio text at
   18px and one prompter line at 60px 600.
4. **Components**: Present (tally), raised secondary, ghost, icon button; status
   lamps (To do / Ready / Shot) and item statuses (Needed / Sourcing / Have it /
   Returned as lamps: outline / amber half / text-filled / faint with return
   arrow); rundown blocks in each state (Shot, Ready, To do, Focused, Over target
   hatched in tally red lines); segmented control; input with label; menu row
   with keycaps; toast ("Saved to three-lights.splitpage"); one-line notice.
5. **Light mode**: a 1344 × 240 strip on `#F1F0ED` showing the header + one row
   (scene 03) in the light tokens.
