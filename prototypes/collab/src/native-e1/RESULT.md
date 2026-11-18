# E1: typing while remote changes land in the same cell

Prototype only, 2026-11-18, Yjs 13.6.33, Node 24.22.1. Design: draft PR #1627, section 4 (option A).

**Verdict.** Option A holds. In 43 hand-written tests, 7 undo tests and 40,000 generated histories, no character
anyone typed is lost or doubled, nothing is deleted that nobody deleted, and three copies plus a late joiner agree,
also through `Y.UndoManager` undo and redo. Two findings, neither in the fold itself:

1. **Stale cell.** A commit, or any write, through a `Y.Text` that has since been deleted vanishes on every copy:
   Yjs deletes items integrated into a deleted type. It happens when another copy undoes the split that made the cell,
   replaces the cell's map entry or deletes it. `Composition.commit()` now looks the cell up again by its beat's id
   and never reports success for a write that did not land: see "Stale cells" below.
2. **Order, no loss.** Text composed next to a character the document had already deleted can land on the other side
   of a concurrent insertion made next to that character. This is plain Yjs behaviour, declared as a difference and not
   worked around: 25 of 20,000 histories with undo, 28 of 20,000 without.

## The model (`fold.ts`)

`Composition` keeps the painted units of one `Y.Text` (UTF-16 units; an embed is one unit) and the person's screen
(painted units, local deletions, local typed units). Every `Y.Text` event is folded into the painted units the way
y-codemirror.next's observer turns a delta into editor changes: retain moves over live units, delete marks live units
dead, insert adds unpainted units. It folds every origin, not only remote ones as the design's sketch does, because both
bindings skip only their own writes (`tr.origin !== this.conf`, `origin !== this`); a local undo or another local command
on the cell would otherwise put the fold out of step. The commit is one transaction: each typed run goes right after
its nearest painted unit to the left, deleted or not, counted in live units; then only the person's deleted units that
are still live are deleted; at one place the insert comes first. Cancel writes nothing. Edits that would cut a
surrogate pair are refused.

`commit()` does not call `UndoManager.stopCapturing()`. The caller must call it before the commit, or the commit merges
into the undo step of typing inside `captureTimeout` (control test).

**Tie rule.** Where the commands leave two insertions unordered, text the person commits goes before remote text that
landed in the same painted gap meanwhile. That is where CodeMirror keeps a caret when text arrives at it
(`SelectionRange.map`, assoc −1), so it is what an immediate repaint would have shown. `@codemirror/collab` rebases
unconfirmed local changes after remote ones (`update.changes.map(changes)`), and CodeMirror maps a selected range's start
past an insertion at it, so both orders are standard. Neither loses text. Concurrent ties between other copies follow
Yjs (client id); only agreement is checked there. The hand tests pin the tie rule; the generated check does not.

## Stale cells

At commit the cell is resolved again through the public API, by the beat's id (`visuals.get(id)`), and compared with the
`Y.Text` the composition started on. The outcome says what happened: `written` (same cell), `unchanged` (nothing to
write), `moved` (the beat has a different live cell; the typed text is appended to it) or `recovery` (no live cell;
nothing is written and the typed text is handed back for a recovery list). Tests, each under both delete filters where
it differs:

| Remote change while A composes `Y` in beat 2's visual cell | never-delete-cells filter | design's filter (deletes an empty cell) |
| --- | --- | --- |
| B undoes the split that made beat 2 | `written`, cell kept, `2:Y` | `recovery`, nothing written |
| B undoes and redoes the split | `written`, `2:Y` | `moved` into the redone cell, `2:Y` |
| B deletes the map entry | `recovery`, nothing written | not run |
| B replaces the map entry with a new cell holding `Z` | `moved`, `2:ZY` | not run |
| B removes beat 2 by flag and restores it | `written`, `2:Y` | not run |

Ordinary typing that crosses B's undo on the wire is lost under the design's filter and kept under the never-delete
filter (control tests). This rule applies to every write in a real adapter, not only to composition: every write
resolves its target by id at the moment it runs and must not report success through a stale reference. The
never-delete filter is the rule experiment E3 owns; E1 uses it and does not decide it.

## Answers

1. **Kept and agreed.** Every typed character is present, every remote character is present, and nothing is deleted
   that neither side deleted. Copies and the late joiner agree in all hand and generated histories. The one way to lose
   text found is a write through a stale cell, now reported instead of silent.
2. **Open cases**, each a passing hand test with expected text from its commands:
   - A remote split inside the replaced range stays: `aY|2|d`. The remote undo of a split removes the boundary and the
     composed text joins the previous beat. Removed or joined by flag: the text lands and the flag stays.
   - A visual cell deleted, replaced or restored remotely: "Stale cells" above.
   - Surrogate pairs, a joined family emoji and a combining accent at both edges stay whole: no lone surrogate and no
     U+FFFD on any copy.
   - Atoms at both edges, and the tie with an atom: `aY[t][s]b`.
   - Remote formatting over the pending range stays. Committed text takes its left neighbour's formatting at commit,
     the Yjs default for `insert` without attributes: bold after a bolded `b`, plain over a replaced bold range.
   - Remote undo of painted text around the composition keeps the composed text. A remote delete then undo of what the
     person also deleted brings the restored copies back: the person deleted only the copies they saw, which is plain Yjs.
   - A cancelled composition writes nothing, and the remote change is shown. Undo pressed while composing commits
     first, then undoes only the composition.
3. **Undo and redo** of the commit after remote changes take back and restore only the person's own characters. Remote
   typing inside the committed text survives undo and sits between the redone characters again. Undo restores what the
   commit deleted even if another copy deleted it concurrently, which is selective undo as Yjs defines it. A used-up
   commit is passed over, as the design notes.

## Shortest order history

Base `xy`. A composes `Y` before `x`. B types `R` after `x`, then deletes `x`, and A receives only the deletion. A
commits, then all sync. The commands give `YRy`. If A's client id is greater than B's, the result is `RYy`. Cause:
`Y.Text.insert` by index skips the deleted items right of its live left neighbour (YText.js `minimizeAttributeChanges`),
so `Y`'s right origin is `y`, not `x`, and it ties with `R` by client id. No public `Y.Text` call can insert relative to
a deleted character.

## Evidence

**Oracle** (`ledger.ts`, driven by `history.ts`). The oracle keeps its own copy of the person's screen, changed only by
the recorded composition commands; it never reads `Composition`. Every instance it expects is created from a command
before the write runs: base tokens from the seed command, remote insertions from B's and C's commands, every token the
person types, and each undo restoration from a forecast by Yjs's `popStackItem` and `redoItem` rules. Every typed token
is expected unless a recorded deletion covers it. Deletions are recorded from commands: the person's screen deletions,
B's and C's deletions, and undo's forecast deletions. The final text of every copy and the late joiner must show
exactly the expected instances.

Read from Yjs, and why that cannot hide a loss:

- Yjs ids, bound to expected instances after each write only as labels. An instance the write never produced stays
  unbound and is reported missing; an instance nobody expected is reported as unknown.
- What an actor saw when it acted: the neighbours of B's and C's insertions, the targets of their deletions, which of
  an undone step's insertions are still visible at the undoing copy, and which of the person's deletions are still live
  at commit. These only decide which expected instances a command kills. An instance a copy lost is not visible there,
  so it is not killed and is reported missing.

The commit is also checked when it runs: it must remove exactly the person's deletions still live and write exactly
the tokens on the oracle's screen.

**Order** is a partial check, not a full expected order: the transitive closure of the neighbour constraints from the
commands (each insertion goes between the neighbours its actor saw), the person's screen and the commit. It is checked
twice, once with the person's screen neighbours and once with only those still live at commit. Every break left is in
the first check only (finding 2). The generated check leaves ties unordered and so does not enforce the tie rule.

**Generator** (`history.ts`, seeded). One composing copy A, writers B and C, and a late joiner. The base is 2 to 7
tokens: BMP letters, astral characters (surrogate pairs), atoms and beat boundaries, all unique. B and C insert runs of
1 to 3 tokens, delete 1 to 3, bold or unbold, and undo their last step. A composes 3 to 12 events of insert, delete and
replace, then commits (85%) or cancels, and then may undo and redo with remote changes around them. Single updates are
delivered between random copies in random order and repeated. At the end every update goes to every copy, shuffled,
with repeats; a late joiner loads them all shuffled. **Not covered by the generator:** a second composing copy, maps
and flags (beats, visuals), deleted or replaced types, multi-code-point graphemes, local edits during composition other
than the composition itself, and caret placement. The hand tests cover the maps, stale cells and the graphemes; caret
placement and a second composing copy are not covered. Node only: no browser and no input method.

**Negative controls**, all tests:

- Input side, seeds 1 to 500, with `Composition` broken: `insert` doing nothing fails 368 of 368 histories it
  touches, `delete` doing nothing 323 of 323, and a commit dropping its last typed character 368 of 368.
- Output side: dropping one character, dropping one the person typed, doubling one, or swapping two base characters in
  a passing history is reported every time (at least 50 histories each).
- Rejected designs: the commit by one relative position per painted unit is caught in 23 of 500 histories, the commit
  by painted offsets in 44 of 500.

**Coverage in the 20,000 histories with undo:** 17,064 commits and 2,936 cancels; 39,394 typed tokens committed;
32,044 deletions committed or made during composition; 5,398 commits after a folded remote change; 1,646 commits with a
deleted character still on screen; 1,056 commits where another copy had already deleted what the person deleted; 50,673
remote insertions, with tallies of 60,535 letters, 25,388 surrogate pairs, 10,241 atoms and 5,174 splits; 36,575 remote deletions; 18,521 remote
formatting changes; 11,705 out-of-order and 6,814 repeated deliveries; 9,603 deliveries to the composer while
composing; 9,389 undos and 5,634 redos by the composer; 10,089 remote undos.

## Left for the browser stage

The input method is modelled as screen edits. These real behaviours are not exercised and are work for the browser
stage: event order around the end of composition; repeated final input events; provisional text replaced during
composition; reconversion of committed text; selection restore on cancel; commit or cancel driven by blur; grapheme
deletion and normalisation; composition interrupted by a repaint or by the cell's removal.

## Least sure

- The input method behaviours above; the model may be cleaner than a real input method.
- The tie rule is a choice between two standard behaviours, made on CodeMirror's caret mapping, and only hand tests pin it.
- `moved` appends to the end of the live cell; where the text should go in a replaced cell is a product decision.

## Reproduce

```
npm ci --prefix prototypes/collab
node --test prototypes/collab/test/native/e1/composition.test.ts prototypes/collab/test/native/e1/composition-undo.test.ts
node --test prototypes/collab/test/native/e1/composition-generated.test.ts
E1_RUNS=20000 node --test prototypes/collab/test/native/e1/composition-generated.test.ts
```

Tests sit under `test/native/` because the Stage 1 undo-record scan exempts that folder for `Y.UndoManager` tests.
