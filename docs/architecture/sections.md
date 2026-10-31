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
beats an unchanged record, while a renamed or reanchored record survives
concurrent header removal. An empty resulting group has no header.

Section order is compared by section IDs, even when none of a group's original
scenes survives. Scene membership is compared independently against the base:
a changed side wins over an unchanged side, and competing assignments retain
the incoming assignment. Removing a header projects its membership onto the
nearest surviving predecessor in the base, or the unsectioned prefix. A
concurrent scene move still applies to that projected membership. If an edited
header survives a removal that left scene order unchanged, that removal does
not erase its original membership.

Within each resulting group, a one-sided scene reorder survives; competing
reorders retain incoming order. New scenes keep their side's neighbouring
scenes. The internal order of collapsed groups follows base group order, so a
section move cannot masquerade as a competing scene reorder. A new boundary
and a concurrent scene reassignment use the same membership conflict rule.
These layout rules apply only to documents with sections. Sectionless merge
retains the existing row ordering. Undo uses the existing document-field and
row-order steps; one command is one entry.

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

Folding is per-session view state, absent from saves, undo and running order.
Totals and exports include shot and folded scenes. Present's section name is
a visual cue and never enters narration or voice matching.
