# Splitpage identity overhaul — shared brief (read fully before writing)

You are drawing hi-fi, static product mockups ("artboards") for ONE of three
visual-identity directions for **Splitpage**, a real app. Each artboard is one
`.dc.html` file. The files land on a design canvas the user will compare side by
side, so every board must look like a real 1:1 screenshot of a finished, beautiful,
usable product — not a wireframe, not a moodboard.

## 1. What Splitpage is

A two-column A/V script editor for people who make video (YouTubers, small
production teams, corporate/documentary makers).

- **Visual** column (left): what the viewer sees — shot descriptions, on-screen
  graphics, b-roll lines.
- **Audio** column (right): what is said — narration, word for word. This column
  feeds the teleprompter and the read-time estimate (150 words/min).
- Each row is a **scene**: number, estimated read time, status (**To do / Ready /
  Shot**), reorder, add, delete, an optional picture.
- **Tags** turn words into a production breakdown. Six categories: **Prop**
  (typed `[softbox]`), **Location** (`{kitchen}`), **VFX** (`~lens flare~`),
  **Cast**, **Music/SFX**, **Gear** (`<lav mic>`). Each tagged item has a status
  **Needed / Sourcing / Have it / Returned**, an owner, notes.
- A Visual line starting `B-roll:` becomes a tracked **b-roll shot** (shot /
  unshot / flagged, location, owner, props, note).
- Side panels: **Production** (breakdown, grouped by Category / Person / Scene /
  Shoot, CSV export), **Gear** (equipment list + packing-list PDF), **B-roll**
  (shot list), **Comments** (threads anchored to words, assign, resolve, reply).
- Modes: **Write** (narration as one flowing document) and **Present** (full-screen
  teleprompter: play, speed, text size, mirror, flip, scene mode, Follow My Voice
  speech tracking, full screen).
- Chrome: **File** menu (save / autosave / open / import / share link / export /
  version history / find & replace / hide shot scenes / help / tour / about),
  **command menu** (Ctrl+K), **Export dialog** (PDF, Word, Markdown, CSV, standalone
  HTML, narration only, breakdown CSV, packing list), start page (**New tab**:
  blank + three starter scripts, recent files on desktop, drop zone, join a shared
  session), presence avatars in shared sessions, a formatting toolbar on text
  selection (Bold, Italic, Underline, Strike, Highlight, Link, Comment, Tag).
- Ships as a web app, a PWA and a Windows desktop app.

## 2. What is wrong with today's UI (every direction must fix these)

1. **Everything shouts.** Uppercase, letter-spaced monospace is used for buttons,
   column heads, labels, statuses and counts, so nothing has hierarchy. → Sentence
   case almost everywhere. A mono face only where figures must align (time, counts)
   if the direction uses one at all. At most one or two uppercase micro-labels per
   screen.
2. **Toolbar has no hierarchy.** File, four panel toggles, Write, Save and Present
   are all the same bordered box. → Panel toggles read as quiet tabs/toggles with
   counts; Write is a mode; Save becomes a status ("Saved · 2 min ago") with
   the action tucked into it; **Present is the one primary action**.
3. **Colour competes with the words.** Both script columns are tinted (green-grey
   and peach), tags add tints, highlight adds yellow. → The writing surface is one
   calm surface; column identity comes from the header + typography; colour is kept
   for meaning (tags, status, the two column accents).
4. **Row gutter noise.** ↑ ↓ + × are permanently drawn on every scene (× in red).
   → Gutter shows only scene number, time and status. Drag handle + "⋯" menu
   (Move up/down, Insert scene, Delete) appear on hover/focus — show ONE row in that
   hover state in the editor mockup.
5. **"📎 IMAGE" label in every visual cell.** → The picture slot appears on hover, or
   as a real thumbnail when a scene has one (draw a labelled placeholder frame —
   e.g. a 16:9 box with a shot-size label like "WS" — never a fake photo).
6. **Onboarding stacks above the work.** Desktop-app banner + a large tagging
   cheat-sheet push the script below the fold (on phone the first scene starts at
   ~800px). → The script starts immediately. Tips live on the start page, in Help,
   or in one slim, dismissible line.
7. **Side panels use left-border-stripe cards,** nested boxes and pill badges. →
   Panels are lists/tables with clear row rhythm; no stripe cards.
8. **Status is cryptic** (empty/half/full circles). → Status is a labelled control
   (glyph + word), and changing it is obvious.
9. **Phone layout** stacks two rows of buttons + banners before any content. →
   Content first; modes/panels in a bottom bar.

## 3. Content to use (real data from the app's "To-camera video" starter)

Script title: **Three Lights for Under $200**. Words/min 150. People in the shared
session: **Sam** (the host, avatar initial S) and **Priya** (reviewer, avatar initial P).

Scene | status | read time | starts at | Visual | Audio
--- | --- | --- | --- | --- | ---
01 | Shot | 0:15 | 0:00 | Cold open. Host at the desk in the {home office}(Location), lit flat by the ceiling light — then all three lights snap on in one cut. / **B-roll:** hand hits the wall switch, the lights pop on one by one | This is what my desk looked like on camera a year ago. And this is it now. Same room, same camera — three lights that cost less than one decent lens. Let me show you exactly how.
02 | Shot | 0:16 | 0:15 | Medium shot, host to camera, <lav mic>(Gear) clipped out of sight. ~Title card~(VFX) animates in over the first line, with the (intro sting)(Music/SFX) under it. | Hi, I'm Sam, and on this channel I make videos about making videos. If you film yourself at home and it always looks a bit flat, this one's for you. We'll build it in three steps: **key**, **fill** and **background**.
03 | Ready | 0:19 | 0:31 | Wide: the [softbox](Prop) on a <light stand>(Gear), 45° off to camera left, just above eye line. / ~Lower third~(VFX): "Key light — $65" / **B-roll:** close-up of the key light going up, diffusion sock pulled on | Step one is your key light — the brightest one, and the one that shapes your face. A cheap one is fine. Put it off to one side and a little above your eyes, and angle it so it skims across you instead of hitting you head-on.
04 | To do | 0:14 | 0:50 | Same framing, key light only — then a sheet of [white foam board](Prop) slides in on camera right and the shadow side lifts. / ~Lower third~(VFX): "Fill — $8" | Step two: fill. You don't need a second light for this. Foam board on the other side bounces the key back into the shadows. Move it closer for a softer look, further away for more contrast.
05 | To do | 0:14 | 1:04 | Over-the-shoulder toward the back wall: the [RGB tube light](Prop) on the shelf, washing the wall in amber. / ~Lower third~(VFX): "Background — $120" / **B-roll:** slow push-in on the tube light fading from blue to amber | Step three is what makes it look expensive: separation. A little colour on the wall behind you pulls you off the background. One RGB tube, set warm, pointed at the wall — never at you.
06 | To do | 0:17 | 1:18 | Back to the medium shot. ~End screen~(VFX) for the last 20 seconds: next video on the left, subscribe on the right. | That's the whole setup — key, fill and background, for under two hundred dollars. Everything I used is linked in the description. And if you want to hear how I set up the audio side of this desk, that video's up next.

Total read time **1:35**; **2 of 6** scenes shot. ("/" above = a line break inside
the cell. Use the typographic quotes and em dashes exactly as written.)

Production breakdown (10 items; Production badge 10 counts all, Gear badge 2):
- Props & set dressing (3): **RGB tube light** — Needed — scene 05 — note "Any RGB
  tube with a warm preset. Around $120." · **softbox** — Have it — 03 · **white
  foam board** — Sourcing — 04 — owner Sam
- Locations (1): **home office** — Have it — 01
- VFX & graphics (3): **Lower third** — Needed — 03, 04, 05 (3 mentions) — owner
  Priya · **End screen** — Needed — 06 · **Title card** — Have it — 02
- Music & SFX (1): **intro sting** — Have it — 02
- Gear (2): **lav mic** — Have it — 02 · **light stand** — Have it — 03
- Cast: none yet.

B-roll (3 shots, "1 of 3 shot"): **hand hits the wall switch, the lights pop on one
by one** — Shot — scene 01 — location home office · **close-up of the key light
going up, diffusion sock pulled on** — To shoot — scene 03 — owner Sam · **slow
push-in on the tube light fading from blue to amber** — To shoot — scene 05 —
props: RGB tube light.

One open comment (use where the direction calls for it): **Priya**, 2 h ago, on
the words "a little above your eyes" (scene 03, Audio): "Could we show this? A
quick overhead diagram of where the key sits would help people copy the setup."
One reply from **Sam**, 1 h ago: "Yes — I'll sketch it as a lower third."

Starter scripts on the start page: **Blank script** (One empty scene, and nothing
else.) · **To-camera video** (Hook, intro, sections, call to action. 6 scenes ·
1:35, scene times 15/16/19/14/14/17s) · **Interview** (Questions on the right, cutaways on the left. "Meet the
Baker — Crumb & Co." 6 scenes · 0:55, scene times 7/9/10/7/9/13s) · **30-second spot** (Six timed beats with a packshot.
"Keepwarm Travel Mug — 30s" 6 scenes · 0:32, scene times 8/6/7/5/4/2s). Recent files (desktop): three-lights.splitpage (2
hours ago), crumb-and-co-interview.splitpage (yesterday), keepwarm-30s.md (12 Sep).

Do not invent other data, stats or marketing copy. Where a direction needs a
label the app does not have, keep it short and literal.

## 4. Quality bar

- 1:1 desktop boards are **1440 × 900** (a real laptop window, no browser chrome,
  no OS chrome). Phone boards are **390 × 844** — NO fake status bar, no fake
  keyboard, no device frame.
- 4px spacing grid; consistent radii; real alignment. Tabular figures
  (`font-variant-numeric: tabular-nums`) for every time/count.
- Real elements: `<button>`, `<a href>`, `<input>` + `<label>`, `<select>`;
  `aria-label` on icon-only buttons. Nothing interactive as a div.
- Contrast ≥ 4.5:1 for text (3:1 at ≥ 24px). Use the direction's validated hexes.
- Hit targets ≥ 44px on the phone board; desktop controls ≥ 32px tall.
- Icons: inline stroke SVG only (24-unit viewBox, `fill="none"`,
  `stroke="currentColor"`, round caps/joins, stroke-width per the direction).
  Never emoji, never icon fonts. Reuse these paths from the app's own set:
  - file `M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5`
  - folder `M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z`
  - search: circle cx11 cy11 r7 + `M20 20l-4-4`
  - share: circles (18,5.5) (6,12) (18,18.5) r2.5 + `M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1`
  - export `M12 14V3 M7.5 7.5L12 3l4.5 4.5 M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3`
  - import `M12 3v11 M7.5 9.5L12 14l4.5-4.5 M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3`
  - history `M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5 M3.5 3.5v5h5 M12 7.5V12l3 2`
  - present: rect x3 y4 w18 h13 rx2 + `M8 21h8M12 17v4 M10.5 8.3v5.4l4.3-2.7z`
  - mic: rect x9 y3 w6 h11 rx3 + `M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21`
  - tag `M3.5 12V4.5a1 1 0 0 1 1-1H12l8.5 8.5-8.5 8.5z` + circle (8,8) r1.5
  - box `M20.5 7.5L12 3 3.5 7.5v9L12 21l8.5-4.5z M3.5 7.5L12 12l8.5-4.5M12 12v9`
  - pen `M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L8 18.5z M13.5 7l3 3`
  - play `M7 4.5v15l12-7.5z` · chevron `M9.5 6l6 6-6 6` · clock: circle r9 + `M12 7v5l3 2`
  - Draw the rest simply (plus, ⋯ more, 6-dot grip, check, close ×, flag, map pin,
    image, speech bubble, camera, people, eye, mirror, flip, fullscreen, minus).
- No gradient washes, no glassmorphism/backdrop blur, no neon glow, no left-border
  accent cards, no emoji, no Inter/Roboto/Arial/Space Grotesk/DM Sans/Fraunces/
  Playfair, no bento grids, no "AI sparkle" icons. Shadows only where the
  direction's spec says.
- No explanatory text, rationale, annotations or labels ABOUT the design inside
  the artboards — each board is purely the product screen (the identity sheet is the
  one exception: it is a brand/system sheet, and its section headings may name
  what they show, e.g. "Colour", "Type", "Components").

## 5. The file format (.dc.html) — rules that fail silently if broken

Each artboard is ONE self-contained file:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Editor — Shooting Script</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap">
<style>
body{margin:0;background:#E8E7E2}
a{color:#2B519C}a:hover{color:#1B1B19}
</style>
</helmet>
<div style="width: 1440px; height: 900px; overflow: hidden; position: relative; ...">
  ... the whole screen ...
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":1440,"height":900}}'>
class Component extends DCLogic {
  renderVals() { return {}; }
}
</script>
</body>
</html>
```

- Keep `<script src="./support.js"></script>` in `<head>` EXACTLY as written.
- Close every non-void element; quote every attribute value.
- The root element (first element after `<helmet>`) has a FIXED `width`/`height`
  equal to the board size, `overflow: hidden`, and `$preview` in `data-props` has
  the same numbers.
- Styling is inline `style="…"` (that is what the editor's properties panel
  edits). `<helmet><style>` holds: body reset, `a`/`a:hover` colours, and at most
  ~12 small classes for repeated inline marks (e.g. the tag marks, keycaps,
  `::selection`, `:focus-visible`). No `@import`, no other external CSS/JS.
- Fonts: ONE Google Fonts `css2` `<link>` inside `<helmet>` (several families in
  one URL is fine). Always give a system fallback stack after the family.
- Lay out sibling groups with flex or grid + `gap`, not whitespace or margins.
- `{{hole}}` = a dotted lookup into `renderVals()` only — never an expression. Use
  holes only for the direction's declared tweak prop(s) (and values computed from
  them); everything else is literal markup so it paints while streaming.
- `data-props` is single-quoted JSON inside an HTML attribute: write `&amp;` for &,
  `&#39;` for a single quote, `\"` for a double quote inside strings.
- Tweak props: `{"revision":{"editor":"enum","options":["Blue","Pink"],"default":"Blue"}}`
  and in `renderVals()` read `this.props.revision ?? 'Blue'`. A colour value bound
  into an inline style: `style="background: {{band}}"` is fine for a tweak.
- Repeats: `<sc-for list="{{ticks}}" as="t" hint-placeholder-count="12">…{{t.label}}…</sc-for>`;
  conditionals: `<sc-if value="{{isDark}}" hint-placeholder-val="{{ true }}">…</sc-if>`.
  Precompute everything in `renderVals()` (holes cannot do `a + b` or `!x`).
- No `<iframe>`, `<object>`, `<embed>`, no `innerHTML`, no DOM-building scripts,
  no global keydown handlers, no network besides the fonts link. No `<img>` unless
  it's an inline `<svg>` (there are no uploaded images; draw placeholders).
- Inline SVG is fine anywhere (icons, logo, diagrams).
- Text the user would retype stays literal in the markup.

## 6. Process rules

- Write ONLY the files named in your direction brief, at exactly the paths given.
  Do not publish anything, do not call any Artifact tool, do not open a browser,
  do not render or screenshot, do not install anything, do not touch the git repo.
- Take care: after writing each file, re-read it once yourself for unclosed tags,
  unquoted attributes, holes that are expressions, and text overflowing its box at
  the stated sizes (estimate line lengths: ~0.5em per character for these faces).
  Content that would realistically run past the window bottom is fine (the root
  clips it, like a real scrolled window) — content spilling sideways or overlapping
  is not.
- When done, reply with: the list of files written, and for each board 1–2 lines on
  anything you had to decide that the brief did not specify.
