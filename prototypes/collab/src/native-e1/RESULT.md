# E1: typing while remote changes land in the same cell

Prototype only, 2026-11-18, Yjs 13.6.33, Node 24.22.1. Design: draft PR #1627, section 4 (option A).

**Verdict.** Option A holds. In 36 hand-written tests, 7 undo tests and 40,000 generated histories, no character
anyone typed is lost or doubled, nothing is deleted that nobody deleted, and three copies plus a late joiner agree,
also through `Y.UndoManager` undo and redo. Two findings, neither in the fold itself:

1. **Loss.** Composing in a new beat's visual cell while another copy undoes the split that made the beat. That copy's
   delete filter sees an empty cell and deletes it; the commit writes into a deleted type and the text is gone on
   every copy. Ordinary typing whose update crosses the undo loses it the same way (control test); composition only
   widens the window from network delay to the whole composition. Narration is safe: it is one shared `Y.Text`.
2. **Order, no loss.** Text composed next to a character the document had already deleted can land on the other side
   of a concurrent insertion made next to that character. 25 of 20,000 histories with undo, 28 of 20,000 without.

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

**Tie rule.** Where the commands leave two insertions unordered, text the person commits goes before remote text that
landed in the same painted gap meanwhile. That is where CodeMirror keeps a caret when text arrives at it
(`SelectionRange.map`, assoc −1), so it is what an immediate repaint would have shown. `@codemirror/collab` rebases
unconfirmed local changes after remote ones (`update.changes.map(changes)`), and CodeMirror maps a selected range's start
past an insertion at it, so both orders are standard. Neither loses text. Concurrent ties between other copies follow
Yjs (client id); only agreement is checked there.

## Answers

1. **Kept and agreed.** Every typed character is present, every remote character is present, and nothing is deleted
   that neither side deleted. Copies and the late joiner agree in all hand and generated histories.
2. **Open cases**, each a passing hand test with expected text from its commands:
   - A remote split inside the replaced range stays: `aY|2|d`. The remote undo of a split removes the boundary and the
     composed text joins the previous beat. Removed or joined by flag: the text lands and the flag stays.
   - A visual cell deleted by a remote split undo: finding 1.
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
   commit deleted even if another copy deleted it concurrently, which is selective undo as Yjs defines it. A used-up commit is
   passed over, as the design notes. The commit is its own undo step only because `stopCapturing()` runs before it
   (control: without it, it merges with typing inside `captureTimeout`).

## Shortest failing histories

- **Loss:** base `abcd`. B splits between `b` and `c` and all copies sync. A starts composing `Y` in the new beat's empty
  visual cell. B undoes the split and A receives it. A commits, then all sync. The cell is gone, and `Y` with it.
- **Order:** base `xy`. A composes `Y` before `x`. B types `R` after `x`, then deletes `x`, and A receives only the
  deletion. A commits, then all sync. The commands give `YRy`. If A's client id is greater than B's, the result is
  `RYy`. Cause: `Y.Text.insert` by index skips the deleted items right of its live left neighbour (YText.js
  `minimizeAttributeChanges`), so `Y`'s right origin is `y`, not `x`, and it ties with `R` by client id. No public
  `Y.Text` call can insert relative to a deleted character, so fixing this would be a departure.

## Evidence

**Oracle** (`ledger.ts`). It works from recorded commands only: who inserted which token between which neighbours they
saw, and who deleted which. Expected survivors are inserted minus deleted. Order is the transitive closure of those
neighbour constraints. Undo and redo are forecast from the step's own insertions and deletions, by Yjs's documented
rules (`popStackItem`, `redoItem`). A redone character is held only to what the undoing copy already held before the
run it belonged to. Yjs ids only label instances. The commit is checked at the moment it runs: it must remove exactly
the person's deletions that were still live, and write exactly the characters on their screen. Order is checked twice,
once with the person's screen neighbours and once with only those still live at commit. Every break left is in the
first check only (finding 2).

**Generator** (`history.ts`, seeded). One composing copy A, writers B and C, and a late joiner. The base is 2 to 7
tokens: BMP letters, astral characters (surrogate pairs), atoms and beat boundaries, all unique. B and C insert runs of
1 to 3 tokens, delete 1 to 3, bold or unbold, and undo their last step. A composes 3 to 12 events of insert, delete and
replace, then commits (85%) or cancels, and then may undo and redo with remote changes around them. Single updates are
delivered between random copies in random order and repeated. At the end every update goes to every copy, shuffled,
with repeats; a late joiner loads them all shuffled. **Not covered by the generator:** a second composing copy, maps
and flags (beats, visuals), deleted types, multi-code-point graphemes, local edits during composition other than the
composition itself, and caret placement. The hand tests cover the maps, the deleted visual cell and the graphemes;
caret placement and a second composing copy are not covered. Node only: no browser and no input method.

**Negative controls.** The rejected commit by one relative position per painted unit is caught in 23 of 500 histories,
and the commit by painted offsets in 44 of 500. Both delete a surviving character or drop typed text. Dropping one
character, dropping one the person typed, doubling one, or swapping two base characters in a passing history is
reported every time (at least 50 histories each).

**Coverage in the default 3,000 histories with undo:** 2,526 commits, 474 cancels, 795 commits after a folded remote
change, 230 commits with a deleted character still on screen, 1,736 out-of-order and 976 repeated deliveries, 1,447
undos and 859 redos by the composer, and 1,486 remote undos.

## Least sure

- The tie rule is a choice between two standard behaviours, made on CodeMirror's caret mapping.
- The input method is modelled as screen edits. Real browser event sequences, including how a cancel treats a replaced
  selection, are not exercised.

## Reproduce

```
npm ci --prefix prototypes/collab
node --test prototypes/collab/test/native/e1/composition.test.ts prototypes/collab/test/native/e1/composition-undo.test.ts
node --test prototypes/collab/test/native/e1/composition-generated.test.ts
E1_RUNS=20000 node --test prototypes/collab/test/native/e1/composition-generated.test.ts
```

Tests sit under `test/native/` because the Stage 1 undo-record scan exempts that folder for `Y.UndoManager` tests.
