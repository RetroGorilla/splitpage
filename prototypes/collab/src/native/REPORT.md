# Native Yjs formatting and undo on the segment schema: spike report

A prototype. Nothing here ships and no file under `src/`, `server/`, `desktop/` or `shared/` changed. The variant is
`prototypes/collab/src/native/variant.ts`; its tests are in `prototypes/collab/test/native/`.

## Verdict

On the same script the variant stores about 200 times less than main and commits a local keystroke 280 to 2,800 times
faster, and in no history did copies disagree or a typed character go missing. It does not keep main's mark rules:
with one attribute key per mark name, formatting disappears from text nobody unformatted or deleted. One key per
formatting act removes most of that, not all. That choice and three undo rules need the owner's decision.

## Numbers

Main and variant ran the same script in the same run: Node v24.22.1, x64, commit `954c48398` (later commits change
tests and this report only). Timing cells are median / p95 in ms, each the median of 3 rounds of 200 timed keystrokes
after 20 untimed ones. Ranges are in `results.json`.

| | Main | Variant, one key per mark name | Variant, one key per formatting act |
| --- | --- | --- | --- |
| Stored bytes after the 11,287-character tape, two writers | 6,786,147 | 34,548 | 36,847 |
| Same tape, six writers | 6,749,038 | 34,548 | 36,779 |
| Bytes per typed character, two writers | 598.89 | 1.63 | 1.84 |
| Ten times the tape, 112,873 characters: bytes (per typed character) | not measured | 318,988 (1.70) | 344,926 (1.93) |
| 1,000 more keystrokes add, bytes | 291,048 | 1,010 | 1,010 |
| Update sent for one keystroke, bytes | 280 | 10 | 10 |
| Local keystroke, 30 beats | 7.60 / 10.11 | 0.027 / 0.052 | 0.028 / 0.052 |
| Local keystroke, 300 beats | 12.50 / 17.99 | 0.023 / 0.033 | 0.023 / 0.039 |
| Local keystroke, 900 beats | 34.75 / 42.72 | 0.022 / 0.033 | 0.023 / 0.033 |
| Local keystroke, 30 beats, after 1,000 characters typed in one beat | 65.08 / 82.77 | 0.023 / 0.030 | 0.023 / 0.030 |
| Remote keystroke with its change set, 30 beats | 1.58 / 2.07 | 0.022 / 0.038 | 0.022 / 0.036 |
| Remote keystroke, 300 beats | 6.83 / 8.27 | 0.022 / 0.040 | 0.023 / 0.038 |
| Remote keystroke, 900 beats | 23.52 / 32.97 | 0.022 / 0.037 | 0.022 / 0.038 |
| Heavy-use schedule, long script: bytes per repetition, stored copy | not measured | 5,985 | 5,985 |
| Heavy-use schedule: 2 MiB crossed | not measured | no, 618,014 after 98 | no, 612,864 after 97 |

## Answers

1. **Size.** The table. The number of writers changes nothing. The heavy-use schedule ran 600 s per key scheme on
   the long script and did not reach 2 MiB: 98 repetitions (980,000 typed characters and 29,400 other commands,
   each undone) left 618,014 bytes. Growth was linear, so it would cross near repetition 345; that figure is
   extrapolated, not measured. Appendix C.
2. **Local keystroke.** Flat in the number of beats and in what was typed before.
3. **Remote keystroke.** Flat as well. The change set is read from the Yjs events.
4. **Marks.** In 6,000 generated histories every copy and a late joiner agreed, and the text was always what was
   typed minus what was deleted. Formatting differs from main's rule as listed below. Appendix D.
5. **Undo.** Plain `Y.UndoManager` does typing with remote edits in between, redo, issue #1612, split, join, and
   removal while a collaborator types into the removed beat. Used-up steps and identical changes need a guard of
   about 60 lines (`undoStep`). Appendices E and F.
6. **Traces.** Of the Stage 1 document traces 16 pass as they are, 3 in the part the spike builds, 3 with a
   declared difference; headings were not built. The 187 test files under `tests/collab/` and
   `tests/adapters/collab/` cannot run: they call main's executors and assert main's stored records. Appendix G.

## Declared differences: what a person sees

Marks, with both key schemes (accepted for this spike as briefed):

- **Outside edge.** Text typed just beside a range that someone else formats at the same moment takes the
  formatting; main leaves it plain.
- **Typed inside while the range is unformatted.** The letters after the typed text keep the formatting. With the
  outside edge: 187 to 215 of 1,000 two-writer histories.
- **Typed inside, letters gone.** Text typed inside a formatted range arrives plain when every letter of the range
  was deleted meanwhile; main formats it.

Marks, by key scheme. These touch the owner's rule that formatting never disappears from text nobody unformatted or
deleted, so they are his decision and not accepted by default:

- **One key per mark name breaks the rule in two commands.** Two people make neighbouring words bold at the same
  moment: one word stays plain (106 to 152 of 1,000 histories). M-loss ends with plain `d` when updates arrive one
  by one. In 2 to 5 of 1,000 histories formatting appears on text nobody formatted.
- **One key per formatting act kept the rule for every character someone selected and formatted**, in 3,000
  histories and in M-loss. It is not a guarantee: a letter typed as the continuation of a formatted run arrives
  plain when the letter on its left was deleted or someone typed between them, unseen (5 to 7 of 1,000). Closing
  that needs a marker pair per formatted keystroke; not built. Cost of the scheme: appendix C.

Structure and undo:

- A removed beat that someone else split, unseen: the half split off stays in the script (T11).
- Undo of typing in a beat someone removed happens at once; main waits for the restore.
- Two different statuses set at once: one wins; the Stage 1 oracle keeps the old one (T21 scalar).
- Two crossing tags are both kept; the Stage 1 oracle keeps one and lists the conflict (T20 cross).
- Undo of a split after someone wrote in the new beat's visual cell: that text moves to the recovery list.
- A letter that someone else deleted and brought back is no longer its typist's to undo.
- Identical changes by two people (join, status, tag, removal): either undo takes the change back once both have
  arrived. An undo made before the other's change arrives does not; the change shows until the other undoes too.

## Real findings

No disagreement between copies and no lost typed character, in the generator or in any trace.

One loss in the first version of the variant, fixed and kept as a test: undoing a split whose new beat was created
in the same transaction deleted what a collaborator had typed in that beat's visual cell. `Y.UndoManager` undoes a
creation by deleting the created type with everything in it. The variant now writes the new beat's record and visual
cell outside the undo history; an undone split then leaves an unused record, 51 bytes on the stored copy.

## Surprises

- `text.insert` with explicit attributes writes a marker after the text that turns the earlier formatting on again.
  When the run's own end marker is later removed elsewhere, that marker formats everything to the end of the text.
- The same history can end differently depending on whether a copy received each update or the whole state.
- An editing copy with undo history does not collect deleted text until it is reloaded: after 98 repetitions its
  encoded state was 3,188,934 bytes against 618,014 on the stored copy. Reloaded, it was 618,014.
- Plain `undo()` goes on to an older step when the top one changes nothing, and can leave a field blank.
- The dependency gate forbids a prototype from importing the adapter, so main and the variant run in two child
  processes with one shared measurement block. That put one file under `tests/collab/measure/`.

## Not done, not measured

Main at ten times the tape and under the heavy-use schedule. Any browser. Headings, pictures, comment records, status
merging, beat moves, word-boundary grouping, the 200-entry bound and the hold. The server. Memory use. Nothing forced
a per-keystroke record or a map that grows with every edit. Reproduction commands: appendix H.

# Appendix

## A. The variant

- **Layout, kept from main.** A `segments` map of `{head, text}`, an `order` array, boundary embeds `{b: id}` inside
  the segment text, a `beats` map with one record per beat and a `visuals` map with one `Y.Text` per beat.
- **Marks.** Native `Y.Text` attributes with the value `true`. Two key schemes, chosen per copy:
  - *One key per mark name*: `b`, `i`, `u`, `s`, `hl`, `dir`, `cue`, `c:<comment id>`, `t:<tag id>`, `l:<url>`. Why:
    main reads a mark as present or absent per character by name, two people adding one comment, tag or link agree
    on one attribute, different names overlap freely, and no key is ever made up.
  - *One key per formatting act*: the name, the character U+001F, then the writer's client id and clock in base 36,
    made when the command runs; the reader strips the suffix (`nativeMarkName`). Why: an act can only be turned off by someone who saw it, which is main's rule.
    Unformatting turns each key off as far as its run goes and gives what follows the gap a new key, so no marker is
    written that turns a key on again. Typed text is inserted with the keys of the letter on its left and then
    changed, for the same reason.
- **Atoms.** Yjs embeds, length 1. An embed cannot be split or merged with text by a concurrent edit, carries its
  record id and takes attributes as a character does. A single-character convention has none of the three.
- **Removal.** `beats[id].removed = {by, at, seen}`, where `seen` is the remover's state vector. The text stays where
  it is. The recovery list shows the beat's text and marks what was typed after the removal: characters whose clock
  is not below `seen[client]`. A restore deletes the key.
- **Join.** `beats[from].joined = {into, glue}`. The text stays in its own beat and the reader joins the rows.
- **Undo.** One `Y.UndoManager` over `segments`, `order`, `beats`, `visuals` and `comments`. The tracked origin is the
  copy's own origin object. Untracked: `"hydration"`, `"setup"` (a new beat's record and visual cell), `"takeback"`
  (the guard's forward writes) and `"remote"`.
- **Remote updates.** Plain `Y.applyUpdate`, at any time. `changes()` reads the Yjs events: a structural event
  rebuilds the rows, a text event touches only the rows of the segments it names.
- **Limits kept.** Public Yjs API only, no `Y.Item` built by hand, no private field read. Besides text, two things
  grow: one beat record per split, and with act keys one attribute key per formatting command.

## B. How main and the variant were measured

`bench.ts` starts each subject in its own child process: `tests/collab/measure/native-spike-main.mjs` drives main
through `hydrateSharedDocument`, `createSharedReplica`, `sharedUndoOwner` and `executeSharedOperations`;
`subject.mjs` drives the variant. Both files hold the same measurement block, and `bench.ts` refuses to run when the
two copies differ. Each round changes which subject runs first. The tape (`tape.ts`) types the long demo script
character by character with one correction per 55 characters and five range replacements, the same counts as the
Stage 1 lifetime workload. The final text of every subject is compared: it was the same in every row. Sizes are
taken from a copy without undo history, as a server holds it.

A local keystroke on the variant is timed from the `splice` call to the returned change set. On main the painted
text is read and the operation built before the clock starts; the clock covers `replica.execute` and
`replica.changes()`. A remote keystroke is timed from applying the update to the returned change set on both.

## C. Heavy use, and what formatting acts cost

One repetition: 100 blocks of 100 single-character inserts, each block deleted, undone and redone; 50 splits, 50 joins
and 100 removals, each undone; 100 bold commands, each undone. The stored copy receives every update and has no undo
history. The undo history is cleared after each repetition.

| Script | Key scheme | Fresh | After the text part | After splits, joins, removals | After one repetition | Repetitions run | Stored copy then | Editing copy then | Editing copy reloaded | 100 undo and redo pairs add |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| short | name | 1,546 | 2,914 | 5,624 | 7,220 | 1 | 7,220 | 33,360 | 7,220 | 804 |
| long | name | 31,665 | 33,188 | 35,898 | 37,494 | 98 in 603 s | 618,014 | 3,188,934 | 618,014 | 804 |
| large | name | 287,268 | 288,874 | 291,636 | 293,432 | 1 | 293,432 | 319,572 | 293,432 | 804 |
| short | act | 1,606 | 2,974 | 5,684 | 7,280 | 1 | 7,280 | 34,620 | 7,280 | 804 |
| long | act | 32,509 | 34,032 | 36,742 | 38,338 | 97 in 606 s | 612,864 | 3,296,294 | 612,864 | 804 |
| large | act | 296,712 | 298,318 | 301,080 | 302,876 | 1 | 302,876 | 330,416 | 302,876 | 804 |

Stored copy of the long script with name keys, by repetition: 37,494 (1), 43,388 (2), 49,283 (3), 180,451 (25),
330,302 (50), 480,152 (75), 618,014 (98). All figures are bytes.

Formatting that stays. "Apart" formats a different word each time; "stacked" formats one range again and again.

| Key scheme | Acts | Shape | Bytes added | Bytes left once all is unformatted | Reading the cell, ms | Keys on the busiest character |
| --- | --- | --- | --- | --- | --- | --- |
| name | 100 | apart | 3,642 | 2,448 | 0.03 | 1 |
| name | 1,000 | apart | 37,842 | 25,848 | 0.222 | 1 |
| name | 10,000 | apart | 420,183 | 300,191 | 1.635 | 1 |
| name | 100 | stacked | 36 | 29 | under 0.001 | 1 |
| name | 1,000 | stacked | 36 | 29 | under 0.001 | 1 |
| act | 100 | apart | 4,642 | 2,448 | 0.02 | 1 |
| act | 1,000 | apart | 49,842 | 25,848 | 0.179 | 1 |
| act | 10,000 | apart | 560,183 | 300,191 | 5.679 | 1 |
| act | 100 | stacked | 3,736 | 1,542 | 0.028 | 100 |
| act | 1,000 | stacked | 38,246 | 15,042 | 0.37 | 1,000 |

What one key per act costs as acts accumulate:

- Formatting different words: 10 to 14 bytes more per act than name keys, and nothing more once it is unformatted.
- Formatting text that is already formatted: name keys add nothing. Act keys add 37 to 38 bytes per act, the
  character carries one key per act, and the reader's time grows with the number of keys (0.37 ms for a cell with
  1,000). Unformatting leaves 15 bytes per act. A key that still shows cannot be reclaimed. Not making a new key
  when the whole range already shows the mark would stop this growth; it was not built, and that act could then not
  be undone on its own.
- On the typing tape, which types formatted text beside plain text, act keys cost 0.2 bytes more per typed character.

## D. Marks under concurrency

`marks-generator.ts` builds each history from a seed: 14 steps of typing (plain, with a mark, or taking the
formatting on its left), deleting, formatting, unformatting and delivering, on the text `abcdef`. It runs the history
on the variant and on a model of main's rule that does not use Yjs for marks: a mark covers the characters it selected
and what arrives unseen strictly inside them, a removal takes away only marks it had seen, and typed text carries
the marks it was given. Each difference is put in exactly one class, decided from the commands alone.

| Key scheme | Writers | Delivery | Histories | Commands | Copies or late joiner disagree | Text wrong | Formatting lost | Formatting gained | lost-selected | lost-typed-with | lost-unformat-apart | lost-typed-inside | extra-typed-apart | extra-unformatted | extra-nowhere |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| name | 2 | each update | 1,000 | 9,087 | 0 | 0 | 160 | 190 | 117 | 23 | 33 | 20 | 187 | 2 | 5 |
| name | 2 | whole state | 1,000 | 9,087 | 0 | 0 | 144 | 197 | 106 | 17 | 29 | 18 | 195 | 2 | 2 |
| name | 3 | whole state | 1,000 | 8,720 | 0 | 0 | 197 | 287 | 152 | 19 | 28 | 41 | 284 | 2 | 4 |
| act | 2 | each update | 1,000 | 9,087 | 0 | 0 | 13 | 205 | 0 | 7 | 0 | 6 | 205 | 0 | 0 |
| act | 2 | whole state | 1,000 | 9,087 | 0 | 0 | 10 | 215 | 0 | 5 | 0 | 5 | 215 | 0 | 0 |
| act | 3 | whole state | 1,000 | 8,720 | 0 | 0 | 16 | 322 | 0 | 5 | 0 | 12 | 319 | 3 | 0 |

The columns from "Formatting lost" on count histories with at least one such difference.

The complete list of ways the result differs from main's mark records, each with its shortest reduced history. `[x|b]`
is bold x, `[x|i]` italic x. Every history found, with its reduction, is in `marks-results.json`.

| Class | What a person sees | Key scheme | Reduced history | Variant | Main's rule |
| --- | --- | --- | --- | --- | --- |
| lost-selected | Formatting gone from a character someone selected and formatted, and nobody unformatted | name only | B makes b bold; A makes c..d bold | `a[b|b]cdef` | `a[b|b][c|b][d|b]ef` |
| lost-typed-with | Formatting gone from a character typed with it | name | A makes c..d italic; A types B after d, taking the formatting on its left; B makes a..b italic | `[a|i][b|i]cdBef` | `[a|i][b|i][c|i][d|i][B|i]ef` |
| | | act | B makes d italic; that reaches A; B types B after d, taking the formatting on its left; A deletes d | `abcBef` | `abc[B|i]ef` |
| | | act | B makes d italic; that reaches A; B types C after d, taking the formatting on its left; A types D after d, bold | `abc[d|i][D|b][C|b]ef` | `abc[d|i][D|b][C|i]ef` |
| lost-unformat-apart | Formatting gone from a character one person formatted while another, who had not seen that, unformatted it | name only | C makes d..f bold; B makes f bold; C takes f out of bold | `abc[d|b][e|b]f` | `abc[d|b][e|b][f|b]` |
| lost-typed-inside | No formatting on a character typed inside a formatted range by someone who had not seen the formatting | name | B makes d..f bold; A makes b..d bold; A types B after d, plain | `a[b|b][c|b][d|b]Bef` | `a[b|b][c|b][d|b][B|b][e|b][f|b]` |
| | | act | A makes d..f bold; A deletes d..f; B types E after e | `abcE` | `abc[E|b]` |
| | | act | A makes b..c bold; A takes c out of bold; C types D after b, plain | `a[b|b]Dcdef` | `a[b|b][D|b]cdef` |
| extra-typed-apart | Formatting on a character typed without it, beside or inside a range someone formatted or partly unformatted without having seen the character | both | B types E after e, plain; A makes f italic | `abcde[E|i][f|i]` | `abcdeE[f|i]` |
| extra-unformatted | Formatting still on a character that someone unformatted after seeing every formatting of it | name | B makes f bold; that reaches A; B makes d..e bold; A takes e..f out of bold | `abc[d|b][e|b][f|b]` | `abc[d|b][e|b]f` |
| | | act | B makes b..c italic; that reaches C; C takes b out of italic; B takes a..c out of italic | `ab[c|i]def` | `abcdef` |
| extra-nowhere | Formatting on a character nobody formatted and no unseen range reaches | name only | B makes b..c italic; that reaches C; C takes b out of italic; B takes a..c out of italic | `ab[c|i][d|i][e|i][f|i]` | `abcdef` |

The literal histories, on `abcd` with two writers, are tests in `marks.test.ts`:

| History | Main's rule | Name keys, each update | Name keys, whole state | Act keys, both deliveries |
| --- | --- | --- | --- | --- |
| M-loss. A: italic `bc`, then italic `d`. B: italic `c`, then delete `abc` | `[d|i]` | `d` | `[d|i]` | `[d|i]` |
| Two people make `ab` and `cd` bold at the same moment | all four bold | `[a|b][b|b]cd` | `[a|b][b|b]cd` | all four bold |
| M-inside. A: italic `bc`, delete `bc`. B: types `X` after `b` | `a[X|i]d` | `aXd` | `aXd` | `aXd` |
| M-edge. B: types `X` after `a`. A: bold `bc` | `aX[b|b][c|b]d` | `a[X|b][b|b][c|b]d` | same | same |
| A: bold `bc`, delivered. B: types plain `X` after `b`. A: unbolds `bc` | `abXcd` | `abX[c|b][d|b]` | same | `abX[c|b]d` |

Which scheme guarantees that formatting never disappears from text nobody unformatted or deleted: neither. Name keys
break it in the second row. Act keys held it for every selected and formatted character in 3,000 histories, which is
evidence and not a proof, and break it for a letter typed as the continuation of a run (`lost-typed-with`).

## E. Undo, rule by rule

Against `docs/collaboration/stage-2-shared-undo.md`. "Plain" is `Y.UndoManager.undo()`; "guard" is `undoStep`.

| Rule | The variant | What a person sees where it is not met |
| --- | --- | --- |
| Typing in one text within one second is one entry | Met by `captureTimeout` (tested) | |
| Another text, or a command that is not typing, starts a new entry | Commands: met. Another text: not built, the library groups by time alone | Typing in two cells within the second is one undo press |
| A word begun after a space starts a new entry | Not built; one `stopCapturing()` call | Words typed within the second undo together |
| An undo or a redo ends the group | Met by the library (tested) | |
| A group that deletes all it typed leaves no entry | Not met (tested) | One undo press changes nothing and says the step was used up |
| 200 entries; a hold | Not built | |
| A new command clears redo | Met by the library (tested) | |
| Rule 71: a step that cannot be undone is skipped | Not exercised: every command the spike builds can be undone | |
| Rule 90: a used-up step is removed, adds no redo, reaches no older entry and says so | Plain: not met, it undoes the entry before. Guard: met (tested) | Plain: an older change of one's own disappears instead |
| Typing in a removed beat: the undo waits for the restore | Not met (tested) | The letters go at once, inside the removed beat |
| Deleting earlier text and typing the same letters keeps its entry | Follows from the library; not tested | |
| An entry reverses its own parts; other people's changes stay | Met (tested) | |
| A cut and a paste are two entries | Not built; `format` and the flag commands end the group, `splice` does not | A cut and a paste within the second undo together |
| Selection kept as two anchors | Not built; mark ranges use `Y.RelativePosition` | |
| A remote change leaves both stacks as they were | Met (tested) | |
| A forward mark covers its range and what arrives unseen inside; text typed later with it in view does not take it | Met, except the mark differences of appendix D | |
| A field: a later set replaces; of two unseen sets the higher client id stays; a clear removes only what it saw | Met by `Y.Map` (tested) | |
| The same change by two people is one change either can undo | Plain: not met, appendix F. Guard: met once both have arrived (tested) | |
| The same, when the undo comes before the other's change arrives | Not met (tested); this is the Stage 1 result | The change shows until the other person undoes too |
| Inserted text: delete each unit still there, following a unit to its restoration | Own letters: met. A letter someone else deleted and restored: not met (tested) | The letter stays; the step is used up |
| Deleted text: restored at its place; a unit already restored is skipped | Place: met (tested). Two restores made apart give the letter twice, as on main | |
| A mark added: its undo takes it away, and an identical one made apart with it | Met with the guard (tested); issue #1612 met with both key schemes (tested). With name keys, bold undone after someone typed plain text inside comes back on everything after that text (tested); act keys do not do this | Name keys: bold to the end of the text |
| A mark removed: its undo puts the mark back where it was | Met (tested) | |
| A field or a status: the earlier value only while it still holds what the command wrote; a change that lost is used up and leaves nothing to redo | Plain: the winner's undo of a status leaves it blank. Guard: met (tested) | Plain: a beat with no status |
| Undo of a join; redo | Met (tested, T12 join, T06) | |
| Undo of an unjoin; a separator change | Unjoin built, its undo not tested; separator change not built | |
| Undo of a split; redo | The boundary is deleted, where main keeps it and marks it. Text others typed in the new beat runs on in the first beat, as the Stage 1 trace expects (T12). Their visual text moves to the recovery list | |
| Undo of a removal | Met (tested, T10) | |
| Heading removal, beat creation, heading creation, records, pictures | Not built | |

Main's declared limits, run on the variant (`undo.test.ts`):

| Limit | On main | On the variant |
| --- | --- | --- |
| double-restore | carried | the same: `abccd` |
| later-format | resolved | the same visible result, `a[bc|b]`; the step is used up |
| sequential-status | resolved | the same: ready, then todo |
| status-redo-conflict | resolved | the same: used up, nothing to redo |
| redone-recovery | waits for removal | not built |
| redone-mark-reversed | resolved | the same: the tag stays on every copy |
| pending-update | carried | the same: a copy reads `b`, then `YbX` |
| insert-after-deleted-run | carried | the same: `abcXd` |
| typed-beside-restored | carried: `aXb` | `abX`, the model's result |

## F. Identical changes by two people, and one undo

Two beats `ab` and `cd`, status `todo`. Each person first types a letter, so each has one older step. Both then make
the same change without seeing the other's, everything is delivered, and one of them presses undo. Of two writes to
one key the library keeps the one from the higher client id; "winner" below is that person.

| Change | Plain `undo()` by the loser | Plain `undo()` by the winner |
| --- | --- | --- |
| Join | The join stays. The loser's write is already gone, the step changes nothing, and the library goes on to undo the letter typed before | The join is taken back |
| Status | The status stays, and the letter typed before is undone | The status becomes blank: neither the new nor the old value. The library does not put the old value back while the other person's write sits beside it |
| Beat removal | The removal stays, and the letter typed before is undone | The removal is taken back |
| Tag, name keys | Here the lower client id holds the markers that survived the library's clean-up, so this undo removes the tag | Changes nothing visible; the step is spent and the tag stays |
| Tag, act keys | Removes its own key; the tag stays | Removes its own key; the tag stays until both have undone |

The cheapest way to meet the owner's rule is the guard built here, `undoStep`:

1. Take only the top entry, so a step that changes nothing is reported as used up and no older step is touched.
2. With each command, keep in the entry's `meta` what it meant: for a flag the beat, the key, the meaning written
   and the value before; for a mark the names, the keys in view and the range as two relative positions.
3. Before the undo: if the flag no longer means what the command wrote, the step is used up.
4. After the undo: if the flag still means the same, or the library left it blank, write the value before under an
   untracked origin. For a mark, turn off every key of the same name that covers exactly the same characters and
   was not in view when the command ran.

It stores nothing: `meta` lives in memory. With it, in all four cases either person's undo takes the change back and
the other's is used up (tested, both key schemes for the tag). Three things it does not do. An undo made before the
other's change arrives leaves the change showing. It cannot tell an identical change made apart from one made later
by someone who saw the first, so that one is taken back too. With name keys the second person's tag undo is spent
without a notice. Meeting the rule in full needs a generation number in each flag value and one key that lists
retired generations: two plain keys per flag, no growth per edit. That was not built.

## G. Traces

| Trace | Result |
| --- | --- |
| T01, T02, T02 boundary, T03, T03 replace, T04, T04 removed, T05, T05 two splits, T07, T10, T12, T12 join, T20 nest, T20 mark, T21 | Pass as they are, on three copies and a late joiner, delivered in order, reversed and twice. Document content only: carets, repaint and composition belong to the editing buffer |
| T06 | Passes for text and undo. Pictures and the merged status were not built |
| T09 | Passes. Its undo is three presses, because the spike writes the command as three transactions |
| T21 comment | Passes for the marks. Comment records and the reply's recovery entry were not built |
| T11 | Passes with a declared difference: the half split off unseen stays in the script |
| T20 cross | Passes with a declared difference: both tags are kept |
| T21 scalar | Passes with a declared difference: the status is `shot`, not `todo`; the loser's undo is used up, the winner's brings `todo` back |
| T08 remove, create, race; T09 header | Cannot run: headings were not built |
| T13 to T19, T22 to T24 | Cannot run: they are about the session, the server, images and the browser, not the document format |
| `tests/collab/` (25 test files) and `tests/adapters/collab/` (162 test files) | Cannot run: they call main's operation executors and assert main's stored records |
| Any trace | Fails: none |

## H. Reproduce

```
npm ci && npm ci --prefix prototypes/collab
node prototypes/collab/src/native/bench.ts --rounds=3 --volume=10 --write=prototypes/collab/src/native/results.json
node prototypes/collab/src/native/heavy.ts --repetitions=600 --seconds=600 --write=prototypes/collab/src/native/heavy-results.json
node prototypes/collab/test/native/marks-generator.ts --seeds=1000 --length=14 --write=prototypes/collab/src/native/marks-results.json
node --test prototypes/collab/test/native/undo.test.ts prototypes/collab/test/native/traces.test.ts prototypes/collab/test/native/marks.test.ts
```

About 8 minutes, 21 minutes, under a minute and a few seconds. Node 24.22.1; nothing starts a browser.
