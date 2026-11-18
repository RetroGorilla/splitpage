# E4: one formatting key per action over a long life

A prototype; nothing ships, no file under `src/`, `server/`, `desktop/` or `shared/` changed. Code in this folder,
tests in `prototypes/collab/test/format-keys/`. Node v24.22.1, Yjs 13.6.33, on top of the native spike
(`../native/variant.ts`, act keys as built there). All figures are bytes or milliseconds as measured; nothing is
extrapolated except where it says so.

## Verdict

- **Realistic use: bounded, yes.** After 250 working days (5,500 formatting actions) the most keys of one kind on any
  character is 5, reading the busiest cell takes 0.04 ms, and each action costs 77 to 81 stored bytes against 55 to
  58 with one key per kind: the script ends at 495,136 to 521,823 bytes, 19% more than with kind keys. The cost per action
  does not grow over the year.
- **Heavy use: bounded per action too** (86 bytes, at most 10 keys of one kind, 0.77 ms read), but the script
  passes 2 MiB between days 150 and 200 with action keys and between days 200 and 250 with kind keys. History, not
  keys, drives most of that.
- **Worst pattern:** unbolding one letter inside a range that was bolded again and again, then bolding the range
  again (`punch`): 700 to 780 bytes per action, 43 times kind keys, and 301 keys on one letter after 300 rounds.
- **Normalisation rule: not adopted.** It changes what people see in 3.4 to 4.6% of generated histories. Shortest
  failing history, three steps: *A makes b..e bold; A presses undo; B, not having seen either, takes a..d out of bold.*
  Without the rule `abcdef`, with it `a[bcd|b]ef`: bold comes back on text B unformatted.
- **Limit:** collapse at **32 live keys of one kind on a character**; rebuild the document when it holds more than
  4 times its rebuilt size. A collapse does not shrink the stored file.

## 1. Realistic and heavy use

Day 0 is the spike's tape (11,287 typed characters of the long demo, 72 formatted runs, 61 of them tags). Each day
revises about 1,000 characters (a tenth of the script: delete a span, type the replacement letter by letter taking
the formatting on the left), then runs the formatting commands. **Realistic**: 20 formatting commands and 2 pastes of
formatted text a day, 20% of them re-selecting a run that already shows the kind, i.e. about three times the demo's
density of formatted runs, since revising also unformats. **Heavy**: 200 commands and 20 pastes a day, half over text
that already shows the kind, the pattern where action keys stack. Kinds: tags 40%, highlight 15, bold 15, italic 10,
direction 5, cue 5, comments 10 (40% of these resolve an open comment). Commands toggle as the app does (a range that
shows the kind throughout is unformatted). 10% of formats and pastes are undone at once. Writers work at the same time on
different beats and see each other's work between five rounds per phase. The day's work is split between the
writers. One key per action (`act`) shown here; all three schemes are compared in section 5.

| Rate | Writers | Day | Actions | Keys per formatted letter: median / p95 / max | Most of one kind | Stored bytes | Bytes per action (day / mean) | Read busiest cell, ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| realistic | 1 | 25 | 550 | 1 / 4 / 7 | 3 | 88,636 | 81.5 / 65.7 | 0.003 |
| realistic | 1 | 100 | 2,203 | 2 / 6 / 11 | 4 | 240,404 | 71.4 / 75.6 | 0.021 |
| realistic | 1 | 250 | 5,507 | 3 / 7 / 17 | 5 | 521,823 | 77.8 / 80.8 | 0.045 |
| realistic | 2 | 250 | 5,516 | 3 / 8 / 12 | 4 | 514,336 | 66.8 / 81.1 | 0.040 |
| realistic | 6 | 250 | 5,515 | 3 / 7 / 12 | 5 | 495,136 | 86.5 / 77.1 | 0.036 |
| heavy | 1 | 25 | 5,543 | 3 / 11 / 17 | 7 | 407,659 | 87.1 / 76.1 | 0.035 |
| heavy | 1 | 100 | 22,326 | 6 / 12 / 22 | 8 | 1,455,349 | 89.0 / 84.3 | 0.353 |
| heavy | 1 | 250 | 55,851 | 7 / 14 / 25 | 9 | 3,398,236 | 90.8 / 85.8 | 0.587 |
| heavy | 2 | 250 | 55,790 | 7 / 14 / 23 | 9 | 3,340,783 | 71.9 / 86.4 | 0.442 |
| heavy | 6 | 250 | 55,853 | 7 / 14 / 22 | 10 | 3,236,672 | 80.9 / 86.0 | 0.768 |

"Keys" counts every live key, all kinds together (a letter can carry a tag, a comment, bold and highlight at once);
"most of one kind" is what the limit acts on. Bytes are the stored copy (no undo history). "Bytes per action" is what
the day's formatting phase added, over its formatting commands and pastes; the day's typing is not in it. Stored size grows in a straight line:
about 1,940 bytes a day realistic, 13,400 heavy. Every day in `life-*.json`.

## 2. Worst cases

One beat, one writer unless stated; 300 actions (100 in the JSON). Stored bytes include the starting text, shown in
brackets.

| Pattern | Keys per formatted letter: median / p95 / max | Stored bytes (start) | Bytes per action | Read, ms | All unformatted | Collapsed | Rebuilt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| prefix: type a plain letter at the end, bold letters 1..k | 150 / 285 / 300 | 15,455 (107) | 51.2 | 5.88 | 8,876 | 8,910 | 444 |
| toggle: bold and unbold the same 50 letters | 0 / 0 / 0 | 2,805 (514) | 7.6 | 0.000 | 2,805 | 2,805 | 510 |
| overlapping: toggle random ranges of 5 to 80 in 400 | 2 / 5 / 12 | 12,223 (514) | 39.0 | 0.019 | 10,527 | 10,710 | 727 |
| alternate: two writers in turn bold almost the same 100 letters | 2 / 2 / 3 | 6,806 (514) | 21.0 | 0.004 | 6,579 | 6,655 | 588 |
| sliding: bold k..k+20 | 20 / 20 / 20 | 14,088 (434) | 45.5 | 0.757 | 7,529 | 7,568 | 468 |
| type-inside: type a plain letter inside a bold range, bold the range again | 175 / 301 / 301 | 42,718 (514) | 140.7 | 6.35 | 20,015 | 20,054 | 853 |
| **punch**: unbold one letter inside, bold the range again | 37 / 165 / 301 | 210,118 (514) | **698.7** | 0.601 | 150,344 | 150,383 | 552 |
| paste 40 formatted letters at a random place | 1 / 2 / 2 | 147,883 (617) | 490.9 | 1.04 | 78,796 | 164,334 | 132,138 |

**Worst growth per action: `punch`.** Unformatting one letter turns off every key on it and gives what follows each
key's gap a new key: 783 bytes per action over 100 rounds, 699 over 300, against 16 to 18 with kind keys; the most
keys on one letter rises by one a round. `prefix` and `type-inside` add one key to every earlier
letter per action, so reading the cell grows with the square (6 ms at 300). `sliding` stays at 20 keys and is the
pattern the normalisation rule cannot reach. Paste costs are mostly the pasted text itself (kind keys: 330 per paste).

## 3. The normalisation rule

The rule as written in the design note: a format command turns off, in the same transaction, every key of the same
kind it had seen whose whole run lies inside its range (`NormalisingReplica` in `keys.ts`). Tested only against the
bar: the same commands on copies without and with it must show the same formatting on every letter, on every copy,
after every step, once all is delivered, and on a copy loaded late from each copy's state.

Generator (`race.ts`): text `abcdefgh` with `bcd` bold and `gh` italic made by a fourth copy and seen by all; 20 steps
of bold or italic on and off, deleting, typing (plain, bold, italic, or taking the formatting on the left), plain
`Y.UndoManager` undo, and delivery; two and three writers; delivery update by update in order, reversed or twice
(changing with the step), or as whole state; late joiners at the end. Typed letters are unique, so commands are
addressed by letter.

| Writers | Delivery | Histories | Rule fired in | Rule ran at the same time as typing / formatting / unformatting / deleting / undo; undone by its own author | Differ | Copies disagree without / with |
| --- | --- | --- | --- | --- | --- | --- |
| 2 | each update | 2,000 | 1,432 | 958 / 1,033 / 697 / 609 / 918; 427 | 72 | 0 / 0 |
| 2 | reversed or twice | 2,000 | 1,432 | 958 / 1,033 / 697 / 609 / 918; 427 | 72 | 0 / 0 |
| 2 | whole state | 2,000 | 1,433 | 958 / 1,033 / 698 / 609 / 918; 427 | 70 | 0 / 0 |
| 3 | each update | 2,000 | 1,335 | 1,130 / 1,171 / 844 / 740 / 1,086; 347 | 91 | 0 / 0 |
| 3 | reversed or twice | 2,000 | 1,337 | 1,131 / 1,172 / 844 / 741 / 1,088; 347 | 91 | 0 / 0 |
| 3 | whole state | 2,000 | 1,343 | 1,131 / 1,171 / 836 / 732 / 1,080; 351 | 68 | 0 / 0 |

**Verdict: the rule fails the bar and is not adopted.** Reduced failing histories, each a test in `e4.test.ts`:

- *A makes b..e bold; A presses undo; B takes a..d out of bold* (B saw neither). Without: `abcdef[gh|i]`. With:
  `a[bcd|b]ef[gh|i]`. A's undo writes the turned-off key's markers again as new items, which B's unformat never saw.
- *A makes d italic; B makes a..d bold; B types D after d, plain*. Without: `[abc|b][d|b,i][D|i]ef`; with:
  `[abc|b][d|b,i]Def`. The rule's markers change where D lands beside A's unseen edge.
- *B deletes g..h; A makes f..h italic; B presses undo; A presses undo*. Without: `a[bcd|b]ef[gh|i]`; with: `a[bcd|b]efgh`.

## 4. A limit

Reading time against keys per character (`readCurve`: random half-cell bolds on 400 letters, fresh key each):

| Keys on a letter: median / max | 4 / 4 | 11 / 16 | 19 / 32 | 33 / 64 | 65 / 128 | 129 / 256 |
| --- | --- | --- | --- | --- | --- | --- |
| Read the cell, ms | 0.002 | 0.014 | 0.10 | 0.38 | 1.51 | 4.86 |
| Stored bytes; after collapse | 690; 644 | 1,233; 923 | 1,945; 1,283 | 3,357; 1,992 | 6,097; 3,324 | 11,273; 5,684 |

**Proposal: collapse at 32 live keys of one kind on a letter**, in the next format command on that cell, as the
design note describes. Realistic use reached 5 and heavy 10 in a year, so it would not fire in either. At 32 one
cell reads in 0.1 ms; at 128 in 1.5 ms, a tenth of a 16 ms frame for one cell. The design's 16 would not have fired
in these runs either; 32 leaves three times the heavy maximum before protection is given up, for 0.09 ms per read.

**A collapse fixes reading time, not size.** It brings reads back under 0.2 ms, but stored bytes barely move
(prefix 15,455 to 8,910, punch 210,118 to 150,383): turned-off markers stay as deleted items. Only a rebuild (a
fresh document from what shows) returns to the start: 444 and 552 bytes. **Size: rebuild when the stored copy
exceeds four times its rebuilt size** (the heavy year ended near 90 times the 36,847-byte typed tape; realistic
near 14 times; extrapolated from that figure, not a rebuilt year).

What a person would notice:

- **Collapse:** nothing on the page. Measured: B bolds `cde`; A bolds `hi` and the cell collapses in that command; B
  presses undo. Without collapse `cde` goes plain; with it the undo changes nothing and `cde` stays bold. Protection
  against the two Yjs defects holds only for keys written after the collapse.
- **Rebuild:** every open copy must reload; undo history ends; a copy with unsent offline edits cannot merge into the
  new document and needs its edits replayed or offered as recovery. Not built.

## 5. One key per kind, the same workloads

| Rate | Writers | Stored bytes, kind / action / action + rule | Bytes per action, kind / action | Most of one kind, kind / action | Read busiest cell, ms, kind / action |
| --- | --- | --- | --- | --- | --- |
| realistic | 1 | 437,985 / 521,823 / 515,483 | 57.2 / 80.8 | 1 / 5 | 0.028 / 0.045 |
| realistic | 2 | 429,525 / 514,336 / 507,266 | 57.5 / 81.1 | 1 / 4 | 0.032 / 0.040 |
| realistic | 6 | 415,341 / 495,136 / 486,655 | 55.5 / 77.1 | 1 / 5 | 0.031 / 0.036 |
| heavy | 1 | 2,234,969 / 3,398,236 / 3,263,488 | 58.1 / 85.8 | 1 / 9 | 0.041 / 0.587 |
| heavy | 2 | 2,182,087 / 3,340,783 / 3,180,549 | 58.6 / 86.4 | 1 / 9 | 0.096 / 0.442 |
| heavy | 6 | 2,103,973 / 3,236,672 / 3,084,617 | 58.3 / 86.0 | 1 / 10 | 0.157 / 0.768 |

The price of action keys: about 22 to 28 more bytes per formatting action, +19% stored size after a realistic year
and +52% after a heavy one; reads 1.2 to 14 times slower but under 1 ms. Worst cases at 300 actions: kind keys
stay at 1 key per letter and 7.6 to 27 bytes per action, pastes apart (punch: 16.4 against 698.7).

## Evidence and what is read from the implementation

- **Life and worst cases.** Expected text and formatting come from `FormatModel` (`model.ts`), started from the
  document source (plain text only) and updated from each recorded command; the driver chooses positions, toggles
  and paste content from the model. After every command the acting copy's cell length must match the model; at
  each reported day every writer and a copy loaded from the stored state must show the model's formatting on every
  letter. **Read from the implementation:** only what is checked (each letter's visible kinds, the cell's length)
  and the measurements (keys, bytes, timings). 0 mismatches in every run above.
- **Race.** The bar compares the variant with itself, without and with the rule; that is what the bar asks. Besides
  that, every command must show its own effect on the copy that made it, from the command alone. **Read from the
  implementation:** the letters a command selects, the letter to the left of a typed letter and that letter's
  formatting, as shown on the acting copy just before the command (what the person sees and selects). Commands
  made on text holding a letter twice (two undos restoring the same deleted letter, the spike's double-restore)
  are not effect-checked: 28 and 5 per 2,000 histories. 0 commands lacked their effect.
- **Negative controls** (tests): dropping one letter's formatting on one copy fails the life check and the race
  comparison; making the format command, the unformat command or typing do nothing, in memory, fails the generated
  day, a worst-case pattern and the race effect check, each.

## Not covered

Splits, joins, removals, headings and atoms made during the days (the tape's atoms are typed); links (one per
letter); the undo guard (plain undo only); undo of anything but the command just made, in the life runs; long
offline divergence in the life runs (writers sync every round); the collapse racing with other people beyond the
one undo case; a rebuild protocol; memory; any browser or server.

## Reproduce

```
npm ci && npm ci --prefix prototypes/collab
cd prototypes/collab
node src/format-keys/life.ts --part=life --days=250 --rates=realistic --writers=1 --write=src/format-keys/life-realistic-1.json
node src/format-keys/life.ts --part=life --days=250 --rates=heavy --writers=6 --schemes=act --write=src/format-keys/life-heavy-6-act.json
node src/format-keys/life.ts --part=patterns --actions=100,300 --write=src/format-keys/patterns.json
node src/format-keys/race.ts --seeds=2000 --length=20 --write=src/format-keys/race.json
node src/format-keys/report.ts
node --test test/format-keys/e4.test.ts
```

Repeat the life line for each rate, writers 1, 2, 6 and, for heavy, schemes `act`, `act+norm`, `name` (file names
use `-` for `+`). Each process takes under 9 minutes; all of them about 50.
