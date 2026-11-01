# Section headers

The document's optional `sections` list contains stable `id`, plain-text
`name`, and `firstSceneId` fields. A boundary covers its anchor and every
scene up to the next boundary. There are no synthetic scenes or empty
sections. Unsectioned scripts have no metadata key, including after the last
header is removed. Project Markdown's data block is authoritative; its legacy
human scene table stays unchanged. Plain Markdown exports can show headings.

The section commands run inside the document session. Rename and removal
change only `sections`; a group move declares row order and sections together.
Deleting or individually moving an anchor advances its header to the first
remaining scene in that group. An empty group loses its header. Inserting or
splitting a scene inherits membership from its position. Moving a header moves
every scene in its group. Removing it joins its scenes to the preceding group,
or makes them unsectioned at the top.

## Merge invariant

A section keeps its stable identity across scene replacement and movement;
merge orders those identities separately from their scenes, and anchors each
nonempty identity to its first resulting scene. Every scene retained by the
existing row-content merge occurs exactly once in that layout.

Three-way merge first reconciles section existence and names by stable ID.
A one-sided change wins; competing names retain the incoming value. Deletion
beats an unchanged name, while a renamed record survives concurrent header
removal. `firstSceneId` is a derived anchor: an anchor-only change, including
one caused by deleting or moving its scene, never defeats header removal.
An empty resulting group has no header and cannot receive another removed
group's scenes merely because its name survived.

Section order is compared by section IDs, even when none of a group's original
scenes survives. Scene membership is compared independently against the base:
a changed side wins over an unchanged side, and competing assignments retain
the incoming assignment. Removing a header projects its membership onto the
nearest surviving predecessor in the base, or the unsectioned prefix. A
concurrent scene move still applies to that projected membership. A missing
header's transfer of original scenes into its collapsed predecessor is treated
as header removal, not a competing scene assignment. This comparison does not
require either side's row list to equal the base.

The restored membership is only a comparison aid. If the reconciled identity
was removed, merge uses the side's observed destination before deciding which
groups are populated. For base `a | P: b | S: c`, removing `S` and deleting
`b` produces `a | P: c`; `P` stays present even though its original scene left.
The same rule applies when `b` moves into the prefix or `P` is also renamed.

A rename beats an absent header for that section's original scenes still
sitting in the collapsed predecessor. Explicit moves into another surviving
group still win. Merge uses only observable snapshots, never operation history.
For example, base `[a,b,c] A:b`, a rename on one side, and `[a,x,b,c]` with no
headers on the other could mean either Remove header plus insertion of `x`,
or individually moving `b` and `c` into the unsectioned prefix plus insertion.
Those snapshots are identical. The result preserves the renamed `A` on `b,c`
and leaves `a,x` unsectioned in both orientations.

Another known ambiguity is removing `S` and adding a new header `N` at its
boundary on one side while renaming `S` on the other. The snapshots assign
those scenes to the new identity `N`; it survives, and the renamed `S` can
have no scenes left. Merge cannot distinguish replacing a header from explicit
reassignment into the new section. This does not override one-sided identity,
idempotence, or preservation of an unchanged populated header on both sides.

With no base, a side without section metadata defers to the side that has it.
With a sectionless base, newly added boundaries are ordinary additions; two
different headers added at the same boundary retain the incoming assignment.

Within each resulting group, a one-sided scene reorder survives; competing
reorders retain incoming order. New scenes keep their side's neighbouring
scenes. The internal order of collapsed groups follows base group order, so a
section move cannot masquerade as a competing scene reorder. A new boundary
inherits its original group's ordering rank, and its scenes' order is compared
on both sides even before they belonged to that new identity. A new boundary
and a concurrent scene reassignment use the same membership conflict rule.
These layout rules apply only to documents with sections. Sectionless merge
retains the existing row ordering. Undo uses the existing document-field and
row-order steps; one command is one entry.

The seeded tests check complete order and membership and also enforce three
independent laws for every generated pair: merging either side with the base
reproduces that side exactly, merging a side with itself reproduces it, and a
header unchanged from base on both sides remains when one of its scenes
survives. These laws compare rows and section records directly; they do not
use the membership projection oracle.

“Unchanged” in the third law means the whole boundary record: ID, name and
anchor. An ID/name-only law cannot hold with nonempty, nonoverlapping groups:
base `S:[a,b]`, one side `S:[a] N:[b]`, and the other `S:[b]` after deleting
`a` leave only `b`. It cannot populate both `S` and `N`; the new-boundary
membership rule retains `N:b`.

## Older applications

Version 3.1 preserves the unknown `sections` key through load and save, but
drops it on any merge. If an older application deletes or replaces a section-start
scene so its ID is absent, opening that file in the new application drops the
affected header during migration; its scenes join the section above, or the
unsectioned prefix. A move that preserves the anchor's ID instead moves the
header with that scene, because migration cannot identify the stale boundary.
These paths can lose or relocate headings, not scenes, and do not crash.
Old scripts without sections retain their byte-identical round trip.

## Boundary deletion decision

Adam chose this behavior on 2026-10-31. At a section boundary, Backspace at
the start of the following scene first shows “Press Backspace again to remove
the section header” beside the header and changes no document content.
The next Backspace within two seconds removes only the header. It does not
join scenes; a further Backspace may join them normally. Delete at the end of
the preceding scene mirrors this, with Delete named in the hint. Any other
key, input, click, caret move or timeout cancels the pending state and hides
the hint. Undo restores the header and name in one step.

`createSectionBoundaryRemoval` owns this transient confirmation state and its
timer. Views cancel it on interruptions and disposal. The join command refuses
a cross-boundary join as a backstop. The editor integration is in stack layer 2.

Alt+Up/Down uses the same confirmation window when moving a section's only
scene would empty it. The first press shows “Press again to remove the section
header” without an edit. The next identical shortcut within two seconds moves
the scene and removes the header together. Interruptions cancel confirmation;
undo restores the order and header in one step.

Modifier-only keydowns do not cancel confirmation, including repeated Alt
keydown events on Windows. Alt+Shift+Up/Down receives the same protection;
confirmation requires the same chord twice. Moving into a folded section
unfolds that destination before restoring the scene's caret. Find, Replace
and comment jumps use the same section-aware reveal port.

One persistent live region announces boundary hints. Only the active view
shows the visual hint, so Writer and the underlying table do not announce
the same instruction twice. Section names are level-two headings; Escape
closes an open section menu and restores focus to its summary.

Folding is per-session view state, absent from saves, undo and running order.
Totals and exports include shot and folded scenes. Present's section name is
a visual cue and never enters narration or voice matching.

Sectionless documents use the existing scene/shot projection in the table and
Writer without requesting fold state or calculating section groups or totals.
Boundary input listeners are mounted only while the document has sections;
adding the first header attaches them, and removing the last detaches them.
Reveal skips membership lookup when there are no folded sections.

## Cues and outputs

Rundown labels sit above the scene blocks and follow the same rest and hover
lens coordinates. Their element/index mapping is cached; lens frames reuse
the block positions without another section grouping pass or layout read.
Sectionless documents skip the section-label query and painting work.

Present builds a separate scene-to-section cue list from the whole document
before applying Skip shot. The top-bar label reads that list; section names
never enter the narration DOM, word cursor or voice matching vocabulary.

Full-script Word and readable Markdown exports retain section headings and
totals from the captured document. Word uses a spanning table cell, which
reimport skips as a heading rather than turning it into a scene. Project
Markdown's human scene table remains unchanged; its data block preserves the
section records. Narration Word keeps section cues as metadata paragraphs
before the section's first spoken scene; reimport excludes those cues from
the narration. Plain narration text and CSV/XLSX keep their existing form.

Print and both PDF adapters use the captured script-print layout. Each
section has a table with a heading spanning all four columns; the heading
and column labels repeat on continuation pages. The initial unsectioned
scenes remain unheaded. Totals and scene rows include shot and folded scenes.
