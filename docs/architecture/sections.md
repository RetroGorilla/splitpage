# Scene headers

The document's optional `sections` list contains stable `id`, plain-text
`name`, and `firstSceneId` fields. A boundary covers its anchor and every
beat up to the next boundary. There are no synthetic beats or empty
scenes. Unsectioned scripts have no metadata key, including after the last
header is removed. Project Markdown's data block is authoritative; its legacy
human beat table stays unchanged. Plain Markdown exports can show headings.

The scene commands run inside the document session. Rename and removal
change only `sections`; a group move declares row order and scenes together.
Deleting or individually moving an anchor advances its header to the first
remaining beat in that group. An empty group loses its header. Inserting or
splitting a beat inherits membership from its position. Moving a header moves
every beat in its group. Removing it joins its beats to the preceding group,
or joins them to automatic, unnamed Scene A at the top.

Scene letters and beat numbers come from the derived numbering projection: beats before a stored header belong to automatic Scene A. No automatic header record is saved.

## Merge invariant

A scene keeps its stable identity across beat replacement and movement;
merge orders those identities separately from their beats, and anchors each
nonempty identity to its first resulting beat. Every beat retained by the
existing row-content merge occurs exactly once in that layout.

Three-way merge first reconciles scene existence and names by stable ID.
A one-sided change wins; competing names retain the incoming value. Deletion
beats an unchanged name, while a renamed record survives concurrent header
removal. `firstSceneId` is a derived anchor: an anchor-only change, including
one caused by deleting or moving its beat, never defeats header removal.
An empty resulting group has no header and cannot receive another removed
group's beats merely because its name survived.

Scene order is compared by scene IDs, even when none of a group's original
beats survives. Beat membership is compared independently against the base:
a changed side wins over an unchanged side, and competing assignments retain
the incoming assignment. Removing a header projects its membership onto the
nearest surviving predecessor in the base, or the unsectioned prefix. A
concurrent beat move still applies to that projected membership. A missing
header's transfer of original beats into its collapsed predecessor is treated
as header removal, not a competing beat assignment. This comparison does not
require either side's row list to equal the base.

The restored membership is only a comparison aid. If the reconciled identity
was removed, merge uses the side's observed destination before deciding which
groups are populated. For base `a | P: b | S: c`, removing `S` and deleting
`b` produces `a | P: c`; `P` stays present even though its original beat left.
The same rule applies when `b` moves into the prefix or `P` is also renamed.

A rename beats an absent header for that scene's original beats still
sitting in the collapsed predecessor. Explicit moves into another surviving
group still win. Merge uses only observable snapshots, never operation history.
For example, base `[a,b,c] A:b`, a rename on one side, and `[a,x,b,c]` with no
headers on the other could mean either Remove header plus insertion of `x`,
or individually moving `b` and `c` into the unsectioned prefix plus insertion.
Those snapshots are identical. The result preserves the renamed `A` on `b,c`
and leaves `a,x` unsectioned in both orientations.

Another known ambiguity is removing `S` and adding a new header `N` at its
boundary on one side while renaming `S` on the other. The snapshots assign
those beats to the new identity `N`; it survives, and the renamed `S` can
have no beats left. Merge cannot distinguish replacing a header from explicit
reassignment into the new scene. This does not override one-sided identity,
idempotence, or preservation of an unchanged populated header on both sides.

With no base, a side without scene metadata defers to the side that has it.
With a sectionless base, newly added boundaries are ordinary additions; two
different headers added at the same boundary retain the incoming assignment.

Within each resulting group, a one-sided beat reorder survives; competing
reorders retain incoming order. New beats keep their side's neighbouring
beats. The internal order of collapsed groups follows base group order, so a
scene move cannot masquerade as a competing beat reorder. A new boundary
inherits its original group's ordering rank, and its beats' order is compared
on both sides even before they belonged to that new identity. A new boundary
and a concurrent beat reassignment use the same membership conflict rule.
These layout rules apply only to documents with scenes. Sectionless merge
compares the order of base beats present on both sides: a local-only reorder
survives, while competing reorders or a missing base retain incoming order.
Content, deletion, conflicts and merge statistics are reconciled independently
of that order. Beats present only on the other side follow their nearest
surviving predecessor. Undo uses the existing document-field and row-order
steps; one command is one entry.

The seeded tests check complete order and membership and also enforce three
independent laws for every generated pair: merging either side with the base
reproduces that side exactly, merging a side with itself reproduces it, and a
header unchanged from base on both sides remains when one of its beats
survives. These laws compare rows and scene records directly; they do not
use the membership projection oracle.

“Unchanged” in the third law means the whole boundary record: ID, name and
anchor. An ID/name-only law cannot hold with nonempty, nonoverlapping groups:
base `S:[a,b]`, one side `S:[a] N:[b]`, and the other `S:[b]` after deleting
`a` leave only `b`. It cannot populate both `S` and `N`; the new-boundary
membership rule retains `N:b`.

## Older applications

Version 3.1 preserves the unknown `sections` key through load and save, but
drops it on any merge. If an older application deletes or replaces a scene-start
beat so its ID is absent, opening that file in the new application drops the
affected header during migration; its beats join the scene above, or the
unsectioned prefix. A move that preserves the anchor's ID instead moves the
header with that beat, because migration cannot identify the stale boundary.
These paths can lose or relocate headings, not beats, and do not crash.
Old scripts without scenes retain their byte-identical round trip.

## Boundary deletion decision

Adam chose this behavior on 2026-10-31. At a scene boundary, Backspace at
the start of the following beat first shows “Press Backspace again to remove
the scene header” beside the header and changes no document content.
The next Backspace within two seconds removes only the header. It does not
join beats; a further Backspace may join them normally. Delete at the end of
the preceding beat mirrors this, with Delete named in the hint. Any other
key, input, click, caret move or timeout cancels the pending state and hides
the hint. Undo restores the header and name in one step.

`createSectionBoundaryRemoval` owns this transient confirmation state and its
timer. Views cancel it on interruptions and disposal. The join command refuses
a cross-boundary join as a backstop. The editor integration is in stack layer 2.

Alt+Up/Down uses the same confirmation window when moving a scene's only
beat would empty it. The first press shows “Press again to remove the scene
header” without an edit. The next identical shortcut within two seconds moves
the beat and removes the header together. Interruptions cancel confirmation;
undo restores the order and header in one step.

Modifier-only keydowns do not cancel confirmation, including repeated Alt
keydown events on Windows. Alt+Shift+Up/Down receives the same protection;
confirmation requires the same chord twice. Moving into a folded scene
unfolds that destination before restoring the beat's caret. Find, Replace
and comment jumps use the same scene-aware reveal port.

One persistent live region announces boundary hints. Only the active view
shows the visual hint, so Writer and the underlying table do not announce
the same instruction twice. Scene names are level-two headings; Escape
closes an open scene menu and restores focus to its summary.

Folding is per-session view state, absent from saves, undo and running order.
Totals and exports include filmed and folded beats. Present's scene name is
a visual cue and never enters narration or voice matching.

Sectionless documents use the existing beat/shot projection in the table and
Writer without requesting fold state or calculating scene groups or totals.
Boundary input listeners are mounted only while the document has scenes;
adding the first header attaches them, and removing the last detaches them.
Reveal skips membership lookup when there are no folded scenes.

## Cues and outputs

Rundown labels sit above the beat blocks and follow the same rest and hover
lens coordinates. Their element/index mapping is cached; lens frames reuse
the block positions without another scene grouping pass or layout read.
Sectionless documents skip the scene-label query and painting work.

Present builds a separate beat-to-scene cue list from the whole document
before applying Skip filmed. The top-bar label reads that list; scene names
never enter the narration DOM, word cursor or voice matching vocabulary.

Full-script Word and readable Markdown exports retain scene headings and
totals from the captured document. Word uses a spanning table cell, which
reimport skips as a heading rather than turning it into a beat. Project
Markdown's human beat table remains unchanged; its data block preserves the
scene records. Narration Word keeps scene cues as metadata paragraphs
before the scene's first spoken beat; reimport excludes those cues from
the narration. Plain narration text and CSV/XLSX keep their existing form.

Reimporting readable Markdown retains the beats in order but drops scene
headers; it does not recreate scenes. The stacked reader skips the writer's
escaped heading and duration only before a beat heading, at the start or
after a beat divider. The table reader skips repeated export column headers.
Ordinary Markdown headings inside beat audio remain content. Use project
Markdown or `.splitpage` to preserve scene records through save and open.

Print and both PDF adapters use the captured script-print layout. Each
scene has a table with a heading spanning all four columns; the heading
and column labels repeat on continuation pages. The initial unsectioned
beats remain unheaded. Totals and beat rows include filmed and folded beats.
