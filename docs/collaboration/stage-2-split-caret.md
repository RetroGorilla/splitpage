# Split selection after a shared repaint (rule 89)

This cut follows rule 89 on #1414. It also carries the review correction from
#1570 in a separate commit: discarding an empty-name hold clears the pending
clipboard description before the next typing edit.

## Observed before this cut

The observations below were made on the real Split rows renderer and shared
binding, with no typing in progress, on the main tree that includes #1570.
Offsets count UTF-16 units. Both narration and visual cells gave the same
answers. `abcdef` was selected before another copy's operation was delivered.
Selections show anchor then head, so the last row preserves its direction.

| Remote change | Opening selection | Observed selection |
| --- | --- | --- |
| Insert `X` before the text | 3, 3 | 4, 4 |
| Insert `X` after the text | 3, 3 | 3, 3 |
| Insert `X` at offset 3 | 3, 3 | 3, 3 |
| Delete offsets 1 through 5 | 3, 3 | 1, 1 |
| Bold offsets 1 through 5 | 3, 3 | 3, 3 |
| Insert `X` before the text | 2, 5 | 3, 6 |
| Insert `X` before the text | 5, 2 | 6, 3 |

In an already joined row, inserting `X` before `abcdef` also moved offset 3 to
4 in both columns. These unambiguous examples hid the defect: in `aaaaaa`,
inserting another `a` before the text left offset 2 at 2. It should move to 3,
after the same shared character. The renderer's text comparison cannot tell
equal letters apart. The new literal tests repeat the table in joined rows
and include repeated text, selection direction, removal of a whole joined
member, and movement into the new cell after a split.

## One selection mapping

`followPaintedCaret` is the existing name-box policy extracted into a pure
application helper. Each endpoint stays after its preceding shared unit. If
that unit was deleted, the helper searches backwards for the nearest surviving
unit; if none survives in the field, it uses offset zero. An insertion at the
caret therefore leaves the caret before the new text, as in the name boxes.
The helper indexes the new units once instead of rescanning them for every
deleted old unit. The long-deletion test pins a linear bound on identity reads.

The Split binding uses the selection snapshot that the rows renderer already
captures before replacing DOM. It resolves both endpoints against the old and
new painted bases, then restores them after the renderer's ordinary selection
restoration. It retains the direction. The existing painted character anchors
already retain their identity through a split. Other cells are read only when a followed unit has
left the opening cell. Disposal invalidates queued restoration, and moving
focus outside Split prevents it from taking focus back.

Joined narration already has a composite painted base. Joined visuals use a
selection-only reading of the existing joined layout and validated, ranked
visual records, with the same projected line breaks. This does not make a
joined visual editable: its operation base and existing refusal stay unchanged.
The reader normalizes malformed string units as encoding does; seeded records
with wrong shapes, rank ties and dangling owners agree with an encoded late
joiner. The ordinary buffer and operations retain their existing addresses.

If a split leaves the endpoints in different cells, each mapped endpoint is
placed in its own cell, retaining selection direction. Complete disappearance
retains the existing renderer fallback when there is no visible mapped field.

## Trailing space: native Edge recording

Recorded on 2026-11-14 in native Edge 157, using the repository's browser driver
and the actual application styles. In each Split column the script focused a
cell containing `Word`, sent the native Space key through the driver, and
measured a DOM Range over the last character. It then repainted the same plain
string and measured again. Finally it called the production
`paintTrailingCellSpaces` helper, bundled directly from source, and repeated
the measurement. These measurements concern DOM paint; the shared binding
literal separately proves that the stored character stays U+0020.

| Column | Native typed space | Plain space after repaint | Shared paint |
| --- | --- | --- | --- |
| Narration | U+00A0, 5.0625 px | U+0020, 0 px | U+00A0, 5.0625 px |
| Visual | U+00A0, 4.21875 px | U+0020, 0 px | U+00A0, 4.21875 px |

The native typing sequence is keydown, keypress, beforeinput (`insertText`,
data ` `), input (`insertText`, data ` `), keyup. The fixture uses that sequence,
including the native nonbreaking DOM space. The binding folds it to plain
space under rule 55. A subsequent repaint replaces only terminal DOM text
spaces with nonbreaking spaces, through formatting children while preserving
their markup and selection. A break or atom ends that scan. There is no model
write, new operation kind or export change. Typing after this repaint still
operates on the same plain shared character.

## Scope and checks

The optional caret ports are supplied only to the shared Split binding.
Standalone does not mount that binding. A booted-app cost test spies on the
mapping, selection reading and space painting through full and row repaint,
with two and fifty rows, and expects zero calls. Existing standalone typing
cost tests remain unchanged. Writer visual buffers use their existing mapping
and do not receive these ports.

The clipboard correction has a literal in the existing shared-undo surfaces
table: append `x` to `Scene`, cut the whole name, undo the empty hold, and
Backspace over `x`. Both actual writes are typing, the typing group cancels to
zero undo entries, and two replicas plus an encoded late joiner hold `Scene`.
Its deliberate defect retains the discarded clipboard description.

The caret histories use three writers, ordinary insert/delete/mark operations,
separate and duplicate delivery, repeated letters and a plain typed space.
Literal endpoint and text expectations are checked on the painting copy and
the shared readers on all copies, including a separately encoded late joiner.
The declared-limit table is empty for those histories. No refusal expectation
or standalone assertion is changed by this cut.
