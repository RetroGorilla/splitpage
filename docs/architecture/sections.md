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

Three-way merge combines records by stable ID. A one-sided property change
wins; conflicting edits to the same property retain the incoming value.
Deletion beats an unchanged record, while an edited record survives deletion.
An anchor deleted in the merged scene set advances within its original group.
A one-sided reorder survives; competing reorders retain incoming order. These
order rules apply only to documents with sections. Undo uses the existing
document-field and row-order steps; one command is one entry.

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
