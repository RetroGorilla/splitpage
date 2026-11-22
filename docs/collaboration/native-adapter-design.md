# Design: the shared-document layer on standard Yjs

Round 8, 2026-11-19.

When several people open one script together, each copy holds a shared document that the library Yjs keeps in
step. This note designs that layer. It replaces `src/adapters/collab/` under rule 12 of `AGENTS.md`: a library's
standard behaviour is the default. Every figure names its result file ([appendix A](#a-sources)). "Generated" marks
counts from generated test histories, built to hit bad cases, so not rates in real use. Accounts, invitations,
pictures and screen design are out of scope.

## Build status

Slices 1 to 7 are built on `main` at `2a1cebba1`. The native session runs Split and Writer with buffered
narration and Visual input, composition, local undo and selection replay. The editor routes include beat and
heading structure, anchored blank-beat insertion, Writer Markdown headings, Find and replacement, plain inline
formatting, beat status and duration, picture galleries, comment threads and production registries.

The native relay has the reconnect wrapper, size admission, SQLite snapshots and backup and restore commands.
The session layer has the offline-notice journal and put-back command, and local replica stores with an update
log, checkpoints and local write receipts in browser IndexedDB and through desktop test IPC
([#1668](https://github.com/RetroGorilla/splitpage/pull/1668), [#1679](https://github.com/RetroGorilla/splitpage/pull/1679)).
These components have their own integration tests. The standard shared test hook `__sharedTest` opens only the
native session. The [slice 8 app test mapping](slice-8-test-mapping.md) records which assertions were replaced and
which still run through direct old wiring or the isolated legacy test fixture. The old adapter and its dedicated tests
remain for the rest of [slice 8](#11-build-order). There is no release entry for shared mode.

A successful native switch restores a Writer or Split selection only when focus stayed in that editor and the
touched beats, joined narration members and headings keep their identities, order and text. If a captured
selection cannot be restored, there is no caret and typing waits until the person places one. Leave ends an
existing entry wait. If Leave itself cannot restore a captured selection, it clears the stale selection and
waits for a new caret. App stop and entry rollback release any active wait.

## Known differences from standalone editing

| Area | What a person sees in the native shared editor | Source |
| --- | --- | --- |
| Script title | Split and Writer refuse title changes. | [#1665](https://github.com/RetroGorilla/splitpage/pull/1665) |
| Split add bar | The unanchored add bar refuses to add a beat. | [#1665](https://github.com/RetroGorilla/splitpage/pull/1665), [#1686](https://github.com/RetroGorilla/splitpage/pull/1686) |
| Empty Writer | Writer has no first-beat input. Legacy shared Writer showed one and discarded its unfinished composition on app stop. Native stop lands the empty script as an unsaved copy and schedules its recovery draft. | [#1684](https://github.com/RetroGorilla/splitpage/pull/1684), [native app stop test](../../src/test/shared-native-routes-lifecycle-app.test.mjs) |
| Opening an empty shared script in Writer | Writer stays open with no beat input or caret for creating the first beat. The legacy shared Writer offered a field that kept composition open and placed the narration caret after the first committed text. | [Native hook app tests](../../src/test/shared-native-hook-mapped-app.test.mjs) |
| Joined row removal | A joined row keeps its member beats. The row's Remove acts on its visible head. | [#1682](https://github.com/RetroGorilla/splitpage/pull/1682) |
| Split Remove with an unseen peer change | The first click arms Remove while buffered typing and the held peer change can remain out of the projection. Confirmation settles the typing and then removes the intended beat. If a peer join hid that beat, confirmation clears the arm and warns once. | [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs) |
| Moving past a heading | Scene headings have their own positions in the ranked outline. Moving a beat across a heading can change which beat follows that heading. | [#1682](https://github.com/RetroGorilla/splitpage/pull/1682) |
| Entering shared mode with Writer open | With the caret at offset 5 in the first beat, Writer stays open and the text stays intact. Focus moves to the page body and the visible caret disappears. Typing immediately inserts nothing. Returning focus to Writer without placing the caret puts it at offset 0 of the first beat, where typing inserts before the existing text. Entry through the old backend kept the caret at offset 5. | [#1694](https://github.com/RetroGorilla/splitpage/pull/1694) |
| Writer move with stale paint | A cross-beat Alt+Arrow move refuses if a peer edit has invalidated the paint needed to resolve the selection. The selection and buffered typing stay in place. | [#1683](https://github.com/RetroGorilla/splitpage/pull/1683) |
| Writer command with missing paint | Enter leaves the text and beats intact on both copies and shows “This is not available in a shared session yet.” ArrowRight on a line whose paint is out of step leaves both copies intact without a warning. The legacy editor showed “This line changed. Try writing again.” on ArrowRight. | [Native hook app tests](../../src/test/shared-native-hook-mapped-app.test.mjs) |
| Writer heading name | Editing a heading name to empty or whitespace is refused. Standalone Writer can keep an empty heading draft. | [#1682](https://github.com/RetroGorilla/splitpage/pull/1682) |
| Writer Enter at the first heading | Enter at the start of a heading needs a preceding beat. It is refused when the heading starts the script. | [#1686](https://github.com/RetroGorilla/splitpage/pull/1686) |
| Writer Enter on a blank | A second Enter on the blank between `Hello` and `World` in one paragraph inserts another blank and puts the caret there. Standalone removes the first blank and starts a paragraph at `World`, with the caret at its start. | [#1686](https://github.com/RetroGorilla/splitpage/pull/1686) |
| Writer Enter on a selected prefix | Enter with `Wo` selected at the start of `World` leaves the original beat empty and puts `rld` and the caret in a new beat. Standalone keeps `rld` in the original beat and starts a paragraph there, with the caret at its start. | [#1686](https://github.com/RetroGorilla/splitpage/pull/1686) |
| Writer Enter deleting and inserting | Enter refuses a selection deletion that would also insert an adjacent blank. | [#1686](https://github.com/RetroGorilla/splitpage/pull/1686) |
| Writer Enter in a heading name | Enter refuses a split inside a heading name or an edit over a heading selection. | [#1686](https://github.com/RetroGorilla/splitpage/pull/1686) |
| Peer text inside a pending split selection | A split deletes a peer character inside the resolved selection if the update arrived before the press, even while the editor still shows the earlier text. Both copies show the split without that character. Undo restores what the split deleted. | [Owner decision and native coverage](slice-8-test-mapping.md#peer-insertion-inside-a-pending-split) |
| Peer text inside a Writer composition replacement | A composition replacement removes a co-writer's character that arrived inside the replaced selection before the editor painted it. Replacing `bc` in `abcd` with `β` after a peer inserts `X` between `b` and `c` leaves `aβd` on both copies. Undo restores `abXcd`. | [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs) |
| Split shortcut after an unseen structural edit | Alt+Enter or Ctrl+Enter can warn once when a peer split or join changes the target or insertion gap. The person's buffered letters settle and the peer's structure remains. After placing a new selection, the person can press again. | [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs), [pending-structure tests](../../src/test/shared-native-pending-structure-app.test.mjs) |
| Alt+Arrow on a live narration beat | Alt+Up and Alt+Down move an addressable beat and preserve its narration caret. The legacy shared editor refused the gesture. | [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs), [native undo tests](../../src/test/shared-native-undo-app.test.mjs) |
| Writer Markdown undo | After undoing the conversion of typed `# Intro`, native undo removes `Intro` and then `# ` in separate steps. Standalone removes the typed line in one step. | [#1687](https://github.com/RetroGorilla/splitpage/pull/1687) |
| Writer Markdown in a joined row | Enter on a pending heading leaves the text and caret in place and warns once for the unchanged candidate. | [#1687](https://github.com/RetroGorilla/splitpage/pull/1687) |
| Concurrent Writer Markdown conversion | Two conversions of the same line can leave two stored headings and one visible title. Text that survives only in the other title is hidden. This can be the suffix after the earlier Enter position, or letters one writer added before converting. | [#1687](https://github.com/RetroGorilla/splitpage/pull/1687) |
| Undo after typing and forward Deletes | In Writer and Split, start with `a\|bcd`, type `Z`, then forward-delete `b` and `c`. The first undo restores `aZ\|bcd` and the second restores `a\|bcd`. The legacy shared editor restored `abc\|d` in one undo. | [Native app tests](../../src/test/shared-native-measure-undo-mapped-app.test.mjs) |
| Cross-beat text | A text edit or format range must address one native cell. Writer edits across beats and narration edits across joined members are refused. Deleting, typing or composing over a selection that crosses a join or covers its synthetic space warns once and leaves the committed text editable. The same refusal applies when a deletion in a joined row targets stale paint. Other refused drafts that have already been previewed can stay on screen with input stopped. With empty history, after Ctrl+B is refused for a Writer selection from `r1:2` to `r2:2`, switching to Split puts the Narration caret at `r2:2`. Undo, redo and undo keep it there. | [#1675](https://github.com/RetroGorilla/splitpage/pull/1675), [#1684](https://github.com/RetroGorilla/splitpage/pull/1684), [Joined input tests](../../src/test/shared-native-join-delete-app.test.mjs), [Native app tests](../../src/test/shared-native-measure-undo-mapped-app.test.mjs) |
| Joined Visual | A write to assembled Visual text is refused if it cannot be addressed in one native cell. | [#1684](https://github.com/RetroGorilla/splitpage/pull/1684) |
| Visual split | The Split Visual split gesture is refused. The anchored shortcut for inserting a blank beat works in Visual. | [#1684](https://github.com/RetroGorilla/splitpage/pull/1684), [#1686](https://github.com/RetroGorilla/splitpage/pull/1686) |
| Formatting at a caret | A collapsed format toggle is refused. Plain inline formatting can be applied to an addressable selection. | [#1684](https://github.com/RetroGorilla/splitpage/pull/1684) |
| Editing inside a Split cell | Enter and Shift+Enter can insert a line break, a selected range can receive inline formatting, and history shortcuts undo and redo the edits. During composition these gestures leave the draft in place. | [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs), [stale-target tests](../../src/test/shared-native-stale-target-app.test.mjs) |
| Tag and link tools | Applying tags in script text, editing links, and applying Find bulk tags are refused. | [#1681](https://github.com/RetroGorilla/splitpage/pull/1681), [#1684](https://github.com/RetroGorilla/splitpage/pull/1684) |
| Text clipboard and drag | Rich, script and multiline paste, cut, and text drag and drop are refused. Plain single-line text paste works in an addressable cell. | [#1684](https://github.com/RetroGorilla/splitpage/pull/1684) |
| Split trailing spaces on copy and drag | Copying `Word` followed by a nonbreaking space yields a normal trailing space in plain text and keeps the nonbreaking space in HTML, during sharing and after Leave. The old shared copy and drag payloads both used a nonbreaking space in plain text. Native supplies no custom text drag payload. | [Native app tests](../../src/test/shared-native-measure-undo-mapped-app.test.mjs) |
| Split typing before publication | The active cell shows a typed character immediately. The native typing buffer publishes it to the app projection and the peer when it commits, such as on page hide. The old shared editor published by the end of the keystroke. | [Native app tests](../../src/test/shared-native-measure-undo-mapped-app.test.mjs) |
| Transfers during Split composition | Rich paste, cut and drop each warn on refusal. The first composition-blocked plain paste warns, and further plain paste or blocked transfer input during the same composition is canceled quietly. The preview, focus and selection stay in place. | [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs) |
| Script beat paste with typing pending in Split | The paste is refused immediately. The person's buffered text and selection stay on screen, and normal typing settlement sends the text with any held peer edits. | [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs) |
| Control-only paste | A paste that cleans to empty text leaves the selection intact. Standalone Writer deletes the selection. | [#1684](https://github.com/RetroGorilla/splitpage/pull/1684) |
| Picture and media clipboard | A picture file can be pasted or dropped in Split Visual. A paste combining an image with text is refused, including captions present only in HTML. The native clipboard and drop routes do not add web media or video files. | [#1676](https://github.com/RetroGorilla/splitpage/pull/1676) |
| Joined galleries | An edit that depends on changing another member's picture, such as removing its picture from the assembled gallery, is refused. | [#1663](https://github.com/RetroGorilla/splitpage/pull/1663), [#1676](https://github.com/RetroGorilla/splitpage/pull/1676) |
| Concurrent gallery edits | Concurrent edits to one beat's gallery choose one whole gallery, even if each writer edited a different gallery field. A picture can appear with a success notice and disappear when the other edit arrives. | [#1660](https://github.com/RetroGorilla/splitpage/pull/1660), [#1676](https://github.com/RetroGorilla/splitpage/pull/1676) |
| Comment from a selection | The Split selection-comment button works. The Writer selection-comment route is unavailable. | [#1676](https://github.com/RetroGorilla/splitpage/pull/1676), [#1684](https://github.com/RetroGorilla/splitpage/pull/1684) |
| Comment and reply author | The name field is read-only and shows the session author. If Post is refused while edits are held, the typed body stays in the composer through redraw and release. The next Post submits it once under the session author. | [Native typed box tests](../../src/test/shared-native-typed-boxes-mapped-app.test.mjs) |
| Comment and reply publication | After an accepted Post, the native write commits and closes the composer immediately, while the app projection publishes the new comment or reply on the next microtask. In the legacy shared editor, the projection updated synchronously inside Post. | [Native record draft tests](../../src/test/shared-native-record-drafts-mapped-app.test.mjs) |
| Comment assignment | The assignee control is disabled. | [#1676](https://github.com/RetroGorilla/splitpage/pull/1676) |
| Imported conflicts | The imported conflict card cannot apply “Use my version”. | [#1676](https://github.com/RetroGorilla/splitpage/pull/1676) |
| Find across members | A match spanning synthetic join text or another unaddressable range cannot be replaced. | [#1684](https://github.com/RetroGorilla/splitpage/pull/1684) |
| Find in Writer headings | A heading match can be replaced singly. A Replace all batch containing a heading match is refused. | [#1684](https://github.com/RetroGorilla/splitpage/pull/1684) |
| Find after a peer edit | Replacement requires the original matched characters. A peer's replacement with identical spelling still invalidates the match. Single Replace refuses it and Replace all skips it. | [#1684](https://github.com/RetroGorilla/splitpage/pull/1684) |
| Find after a peer prefix | If a peer types before a displayed Find match and its letters survive, Split replaces the shifted match on the first click without a warning. The Find and Replace fields remain usable, the focused field stays in place, and undo keeps the peer's prefix. The old shared editor warned and required a second click. | [Native app tests](../../src/test/shared-native-measure-undo-mapped-app.test.mjs), [native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs) |
| Find in a Split cell with inline media | Both native Replace commands use the first matched character's marks. Standalone Split uses a DOM range in a cell with inline media, which can drop bold from a match that starts bold and ends plain. | [Standalone Find tests](../../src/test/find-replace.test.mjs), [native Replace all tests](../../tests/adapters/collab/native/replace-all.test.ts) |
| Undo selection after a peer change | Undo and redo resolve each saved endpoint against the live members. After a peer split a surviving endpoint can land in the new beat. If either endpoint no longer resolves, the command returns no selection to replay. | [#1671](https://github.com/RetroGorilla/splitpage/pull/1671), [#1677](https://github.com/RetroGorilla/splitpage/pull/1677) |
| Writer undo of a replacement beside peer text | In `the the`, replacing the second `the` with `a` while a peer appends `n` makes `the an`. Undo restores and selects the second `the` in `the then`. Redo leaves the caret after `n`. | [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs) |
| Split typing history across a peer update | Consecutive local keys in the same typing group can undo together even when a peer edit arrived between them. The peer letters stay in place. | [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs) |
| Split composing keys | With a composition open, Enter is canceled without inserting a break or issuing a warning. Synthetic IME-key tests check that Enter, Backspace, Escape and ArrowLeft do not trigger editor shortcuts or disturb the draft selection. | [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs) |
| Deletion undo | Consecutive same-direction deletions at one caret in one cell can share an undo step within a rolling second. In the Split comparisons, Backspace then Delete, a caret move between deletions, and a selection deletion then Backspace take two native steps each. Backspace, typing, then Delete and deletions around Find Replace take three each. Each sequence takes one step in standalone. | [#1685](https://github.com/RetroGorilla/splitpage/pull/1685) |
| Typing followed by deletion | Appending a character and then deleting an original character in the same beat takes two undos. The first restores the deleted character and the second removes the new one. The legacy shared editor took both back together. | [Native hook app tests](../../src/test/shared-native-hook-mapped-app.test.mjs) |
| Typing around a format attempt | At the native command boundary, a refused or unchanged format starts a new undo group for subsequent typing. The two typing steps can be undone separately. A format that changes the text adds its own step between them. | [Native hook app tests](../../src/test/shared-native-hook-mapped-app.test.mjs) |
| Spent undo and redo | If a peer deletes the last character someone typed, Undo can silently pass the spent step and undo the previous change. An all-spent Undo leaves the script unchanged. Redo cannot overwrite a later peer value on the same field. Neither press shows the legacy spent-history warning. | [Native hook app tests](../../src/test/shared-native-hook-mapped-app.test.mjs) |
| Undo of a text replacement | Replacing selected `bc` in `abcd` with `Z` restores the original `bc` selection on undo, including with Ctrl+Z in the focused Split cell. The old shared editor collapsed the caret at the selection end. Redo places the caret after `Z`. | [Native app tests](../../src/test/shared-native-measure-undo-mapped-app.test.mjs) |
| Typing after a buffered deletion | Typing immediately after a buffered deletion starts its own undo step. | [#1685](https://github.com/RetroGorilla/splitpage/pull/1685) |
| Buffered typing at the previous beat's end | A co-writer removes the next beat while a character typed at the end of the previous beat is buffered, then undoes the removal after the character is sent. The character survives and stays editable, one beat down on the restored beat. Yjs inserts past deleted items at the resolved position. | [Native app test](../../src/test/shared-native-removed-beat-typing-app.test.mjs), [Y.Text insertion](https://github.com/yjs/yjs/blob/v13.6.33/src/types/YText.js#L195-L265) |
| Buffered typing in a removed beat | Pending narration appears in a nearby row under the reading rules. The remover's undo can return it at the end of the restored beat because deleting the text collapses its original offsets. If the following boundary is also gone, the editor can discard the pending typing with one warning. | [Native app test](../../src/test/shared-native-removed-beat-typing-app.test.mjs), [reading rules](#3-reading-rules) |
| Peer insertion during Delete | A peer insertion at offset zero during a forward Delete run can break the run. | [#1685](https://github.com/RetroGorilla/splitpage/pull/1685) |
| Composition after a buffered deletion | Starting composition before a buffered deletion is sent can use an offset taken before the flush rebases the caret. | [#1685](https://github.com/RetroGorilla/splitpage/pull/1685) |
| Registry and text rewrites | Renaming a tag used in the script, deleting registry tags that still have inline labels, and removing those labels alone are refused. | [#1670](https://github.com/RetroGorilla/splitpage/pull/1670), [#1681](https://github.com/RetroGorilla/splitpage/pull/1681) |
| Tag rename collision | Renaming a tag to an existing name in its category is refused. Standalone can merge the records and repoint shot props. | [#1670](https://github.com/RetroGorilla/splitpage/pull/1670), [#1681](https://github.com/RetroGorilla/splitpage/pull/1681) |
| Waiting tag person editor | Expanding a second tag card leaves the first card open with its unsaved person name in the box. In the old shared editor the draft moved to the unsaved strip until the first card was reopened. | [Draft mapping](slice-8-test-mapping.md) |
| Waiting tag rename editor | Expanding a second tag card leaves the first card open with its unsaved new name in the rename box. In the old shared editor the draft moved to the unsaved strip until the first card was reopened. | [Draft mapping](slice-8-test-mapping.md) |
| Tag notes during a peer rename | If a peer renames a tag while its note is unsaved, the note box stays open on the renamed card. A new tag that reuses the old name has a blank note. In the old shared editor the moved draft first appeared in the unsaved strip. | [Draft mapping](slice-8-test-mapping.md) |
| B-roll script rewrites | Adding a B-roll key to a line or renaming a script shot through its line is unavailable. | [#1665](https://github.com/RetroGorilla/splitpage/pull/1665), [#1681](https://github.com/RetroGorilla/splitpage/pull/1681) |
| Closing a Visual B-roll edit | Typing `B-roll: Close up` stays as plain text when focus leaves the Split Visual cell or Escape closes the Writer Visual box. The old shared editor added a key on leaving the field. | [Native app tests](../../src/test/shared-native-measure-undo-mapped-app.test.mjs) |
| B-roll text on leaving Writer Visual | Escape, Close and a view switch keep a typed `B-roll:` line in its literal form during sharing, with the shot list empty. Undo and redo step the text change itself. The legacy browser suite still checks reopening the Visual box and restoring its focus on undo. Native browser coverage has yet to match those assertions. | [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs), [legacy browser suite 982](../../.claude/skills/run-splitpage-app/tests/982-shared-writer-broll-leave.txt) |
| Derived B-roll shots | A shot projected only from a surviving key has no live record to edit. Undo can reveal the kept fields. | [#1681](https://github.com/RetroGorilla/splitpage/pull/1681) |
| Unkeyed B-roll removal | Removing the shot behind an unkeyed line leaves it absent from the live projection. Core reload derives a shot with a new ID. | [#1670](https://github.com/RetroGorilla/splitpage/pull/1670) |
| Registry recovery | The native editor does not expose the old Recovery panel's deleted registry entries. Local undo can restore a removal. | [#1681](https://github.com/RetroGorilla/splitpage/pull/1681) |
| Recovery after a peer removes a beat | The Recovery action and its Restore and Discard buttons are absent. The peer who removed an unedited beat can undo the removal to restore it and its words on both copies. | [Native hook app tests](../../src/test/shared-native-hook-mapped-app.test.mjs), [Native caller tests](../../src/test/shared-native-callers-mapped-app.test.mjs) |
| Concurrent same-name tag creation | Both records and distinct IDs survive. Production shows one card for the category and normalized name. | [#1681](https://github.com/RetroGorilla/splitpage/pull/1681) |
| Concurrent registry writes | Undo of the winning write can leave a field absent. Unnamed stored entries are hidden, and a missing status can read at its default. An entry without a rank reads before ranked entries in ID order. See [appendix H](#h-outcomes-that-lose-nothing). | [#1670](https://github.com/RetroGorilla/splitpage/pull/1670) |
| Concurrent shot prop additions | Distinct prop keys survive, with at most 40 shown. Removing a visible entry can reveal an overflow entry. | [#1678](https://github.com/RetroGorilla/splitpage/pull/1678) |
| Concurrent shot prop moves | Two moves of one prop compete for its rank. Undo of the winning move can clear the rank and put the prop before ranked entries. Redo restores the winning order. See [section 5](#5-accepted-losses). | [#1678](https://github.com/RetroGorilla/splitpage/pull/1678) |
| Cleared beat status | A cleared status is absent in the shared snapshot. Core reload supplies `todo`. | [#1660](https://github.com/RetroGorilla/splitpage/pull/1660) |
| Edit size admission | One admitted edit can cross the measured 15 MB limit and even the 15.75 MB ceiling. It stays committed. The next addition is refused at the measured limit. At the measured ceiling all local writes, including removals and undo or redo, are refused. Reading, export and peer delivery remain available. | [#1667](https://github.com/RetroGorilla/splitpage/pull/1667), [#1680](https://github.com/RetroGorilla/splitpage/pull/1680) |

## Server-stop results and backup runbook

Two product copies received the edit before each stop. A fresh copy then joined a restarted server. Each row was run
twice, with both original copies returning and with every copy that held the edit closed before restart.

| Stop | Point | Edit on disk at restart | Fresh copy if original copies return | Fresh copy if all original copies are gone |
| --- | --- | --- | --- | --- |
| Clean | Before store starts | Yes | Has edit | Has edit |
| Clean | Store hook held before the SQLite write | Yes | Has edit | Has edit |
| Clean | After SQLite commits | Yes | Has edit | Has edit |
| Kill | Before store starts | No | Recovers edit | Edit lost |
| Kill | Store hook held before the SQLite write | No | Recovers edit | Edit lost |
| Kill | After SQLite commits | Yes | Has edit | Has edit |

The writer's pending count went from 0 to 1 on editing, back to 0 when the server applied the edit, and stayed at
0 through the stop and disconnection. It went from 1 back to 0 during the reconnect handshake. Clearing the offline
notice journal on that first zero would leave no entry for the later loss. A returning copy restored the missing
work to SQLite in 2 of 2 cases. With every copy gone, that work was lost in both cases.

With default settings, a kill can lose edits still waiting for SQLite to commit. A quiet edit waits about 2 seconds
before the store starts. With repeated edits, the 10-second threshold is checked when an edit arrives, so the last
timer can run up to 2 more seconds. Allow roughly the last 12 seconds of edits plus encoding and write time on a
healthy host. A stalled write or event loop can extend that window. The tests used the stock debounce with short
settings to reach the store, a longer debounce to stop before it, and a gate in the test process to hold the store
hook. They leave a mid-transaction kill and power loss unmeasured. On 2026-11-20 the owner reviewed these
results and kept stock snapshots for the first version.

The service lives in `collab-server/`. It uses the stock Hocuspocus Database extension and Node 24.22.1's SQLite
module (stability 1.2, release candidate). The Node module supplies the online backup API and avoids native add-on
installation. See the [Node SQLite API](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html).

### Backup runbook

**Start the relay.** From the repository root on the Docker host, replace the placeholder pool directory, editor
origin and token. Use a directory on the direct local pool. Keep the environment file in host secret storage,
with access limited to the operator. The example exposes the relay only on loopback for the intended tunnel or
proxy. Set CPU and memory limits for the host. One relay process can own the volume at a time.

```sh
set -eu
docker build -t splitpage-relay collab-server
sudo install -d -m 0700 -o 1000 -g 1000 /REPLACE_WITH_DIRECT_POOL_PATH/splitpage
docker volume create --driver local --opt type=none --opt o=bind --opt device=/REPLACE_WITH_DIRECT_POOL_PATH/splitpage splitpage-relay-data

umask 077
config_dir="$HOME/.config/splitpage-relay"
mkdir -p "$config_dir"
cat > "$config_dir/relay.env" <<'EOF'
SPLITPAGE_DATA_DIR=/data
SPLITPAGE_PORT=8080
SPLITPAGE_ALLOWED_ORIGINS=https://REPLACE_WITH_EDITOR_HOST,splitpage://app
SPLITPAGE_ACCESS_TOKEN=REPLACE_WITH_ACCESS_TOKEN
SPLITPAGE_STORE_DEBOUNCE_MS=2000
SPLITPAGE_STORE_MAX_DEBOUNCE_MS=10000
SPLITPAGE_BACKUP_KEEP=7
EOF

docker run -d --name splitpage-relay --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --stop-timeout 20 --cpus 2 --memory 2g --publish 127.0.0.1:8080:8080 --env-file "$config_dir/relay.env" --mount type=volume,source=splitpage-relay-data,target=/data splitpage-relay
docker logs splitpage-relay
```

**Back up daily and copy off-machine.** Save this as `relay-backup.sh`, replace the remote account, host and
archive directory, and run `sh relay-backup.sh` once. Use an account with scheduled access to Docker and
non-interactive SSH access to the archive. The script copies the exact file reported after verification.

```sh
set -eu
output=$(docker exec splitpage-relay node backup-command.ts)
case "$output" in
  "Verified relay backup relay-"*.sqlite.) ;;
  *) printf '%s\n' "Backup did not report a verified file." >&2; exit 1 ;;
esac
name=${output#Verified relay backup }
name=${name%.}
staging=$(mktemp -d)
trap 'rm -f "$staging/$name"; rmdir "$staging"' EXIT
docker cp "splitpage-relay:/data/backups/$name" "$staging/$name"
scp -B "$staging/$name" REPLACE_WITH_ARCHIVE_USER@REPLACE_WITH_ARCHIVE_HOST:/REPLACE_WITH_ARCHIVE_DIRECTORY/
```

Run `crontab -e` and add the line below with the real script path. Set up an alert for failed jobs and check the
copied file after the first scheduled run. A successful copy every day limits backup age to about 24 hours,
plus edits still waiting to reach SQLite when the backup began.

```cron
15 2 * * * /bin/sh /REPLACE_WITH_SCRIPT_PATH/relay-backup.sh
```

**Restore in isolation before anyone else uses the relay.** With old clients disconnected, fetch one verified
backup from the archive. Use a fresh volume, a separate token in a copy of `relay.env` named
`relay-restore.env`, and keep the restore port out of the public proxy. The helper checks that the volume is
empty before creating `relay.sqlite`. If it exits with an error, choose a new volume before continuing.

```sh
set -eu
umask 077
config_dir="$HOME/.config/splitpage-relay"
cp "$config_dir/relay.env" "$config_dir/relay-restore.env"
"${EDITOR:-vi}" "$config_dir/relay-restore.env"
backup_name=REPLACE_WITH_VERIFIED_BACKUP_FILENAME
scp -B "REPLACE_WITH_ARCHIVE_USER@REPLACE_WITH_ARCHIVE_HOST:/REPLACE_WITH_ARCHIVE_DIRECTORY/$backup_name" "$backup_name"
restore_volume="splitpage-relay-restore-$(date -u +%Y%m%dT%H%M%SZ)"
if docker volume inspect "$restore_volume" >/dev/null 2>&1; then echo "Choose a new restore volume name." >&2; exit 1; fi
docker volume create "$restore_volume"
docker run --rm -i --read-only --mount "type=volume,source=$restore_volume,target=/data" --entrypoint sh splitpage-relay -ec 'contents=$(ls -A /data); test -z "$contents" || { echo "Restore volume is not empty." >&2; exit 1; }; set -C; cat > /data/relay.sqlite' < "$backup_name"
docker run -d --name splitpage-relay-restore --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --stop-timeout 20 --cpus 2 --memory 2g --publish 127.0.0.1:8081:8080 --env-file "$config_dir/relay-restore.env" --mount "type=volume,source=$restore_volume,target=/data" splitpage-relay
docker logs splitpage-relay-restore
```

Open the recovered scripts with fresh copies. Check that they match the backup and that changes made after it
are absent. Decide how to recover those changes before allowing old copies to reconnect.

## Decisions made

Decided by the owner: rows 1 to 13 on 2026-11-18; row 4's new form and rows 14 to 19 on 2026-11-19.

| # | Decision | What a person will notice | Source |
| --- | --- | --- | --- |
| 1 | Standard Yjs. Beats share a segment's text, cut by boundary markers; each beat has a record and a visual cell | Nothing directly | Spike, E2 |
| 2 | A shared script stays on the server between sessions. The first version includes server storage and uses 15 MB for admission (section 8). Decision 19 records the storage choice and the backup runbook follows it | Reopen any time; an offline copy can return days later | Owner |
| 3 | A plain formatting key per kind; a key per application for production tags only; standard writes; explicit attributes on every insert | Two people formatting touching words at once can lose some bold. Tags: section 5 | E4, E6, E11 |
| 4 | Removing a row deletes its narration and boundary; its record and visual cell stay, hidden (replacing deletion of them) | If the remover undoes, others' unseen changes come back with the row, except a narration tag (section 4) | Owner, E14 |
| 5 | A heading's name has its own text cell; the heading keeps its boundary, record, rank and `removed` mark | A removed heading restores with its name; narration never ends up in a title | E5, E11 |
| 6 | Reading rules (a) to (g) show stray narration, writing nothing | Letters typed into a removed beat appear in a nearby row, editable | E9, E11, E17 |
| 7 | No command copies narration | A split inside recovered text breaks at the nearest point needing no copy | E11 |
| 8 | Undo is `Y.UndoManager` with core Yjs's default delete filter | Undo takes back only your own changes; snapshots and autosave go further back | E3, E11, E15 |
| 9 | Moves with flat ranks: one sortable position per block | A beat split while you move it leaves its second half behind | E10, E11 |
| 10 | Comment and reply bodies are whole values only their author edits; anyone may resolve or remove | Two choices at once: one wins everywhere | Appendix B |
| 11 | The size limit is 15 MB | A full-size script opened in about 1.6 s | E8 |
| 12 | Offline merges get a notice listing clashed beats with "put it back", reusing the file-merge banner and review list. When unsure whether the remover had seen your edit, it shows the possible clash: "a beat you changed was removed", with what you had | One banner after reconnecting; sometimes a card the remover had seen | Owner, E12 |
| 13 | The relay runs on the owner's own server (plan of record); presence is late and optional | — | Plan |
| 14 | Reconnect goes through a 38-line wrapper around the stock provider that holds document sends until the client's own state reply has gone out | Formatting changed across a dropped connection is kept in the measured pairs; first edits after a reconnect arrive about 29 ms later | Owner, E13 |
| 15 | Two same-moment moves of one row, then the winner's undo: placed as built, with plain undo (E15's option A). Every command checks each part it will touch before writing, or refuses | The row follows its narration neighbour, later perhaps into another scene (section 10) | Owner, E15 |
| 16 | A first load keeps the stock 30 s wait, with the script sizes that fit at each speed, a limit on restarts, and a clear message when a script is too large for the line | Worked out from E13: about 3.5 MB loads at 1 Mbit/s, 7 MB at 2, 14 MB at 4. A larger script gets the message instead of restarting forever | Owner, E13 |
| 17 | The offline notice flags a production tag lost through someone's unseen delete and undo | The person returning is told; one who stayed online is not | Owner, E12, E16 |
| 18 | A marker whose record or visual cell is missing is not a row: its narration reads into the row above, and nothing is written (rule (g), E17's option R) | Section 10 | Owner, E17 |
| 19 | On 2026-11-20 the owner reviewed the [six-row stop table](#server-stop-results-and-backup-runbook) and kept stock snapshot storage for the first version. The update journal and durability receipts are deferred. With default settings about 12 seconds of edits can be waiting on a healthy host, plus encoding and commit time | Clean stops kept the edit in 6 of 6 runs. Returning copies restored uncommitted edits in 2 of 2 kill cases. The edits were lost in both cases where every copy was gone. The first version makes no "saved to server" claim | Owner, E13, slice 7d |

**The guide for same-spot, same-moment conflicts** (owner): it is enough if they merge without losing data about
nine times in ten; a guide, not a hard rule, and stricter where a defect must never happen (section 6).

**E11's verdict:** with the reader and writer corrections and name cells the combination holds, except a beat with
no rank (rule (e)). Kept records close one route to it (E14); decision 15 accepts the other, a move race.

## Open for the owner

The round 8 decisions are recorded above. The smaller points in
[appendix I](#i-smaller-open-points) proceed on their defaults unless the owner objects.
The owner approved the build. See [the open choices before slice 7](#where-the-older-plan-and-this-note-disagree).

## 1. Stored shape

One `Y.Doc` per script. Segment text (`Y.Text`) holds narration and one-unit boundary embeds, `{b}` for beats and
`{h}` for headings; a segment's first block is named by its `head` key. Visual cells and heading names are separate
`Y.Text`s. Records are `Y.Map`s: each beat and heading has a `rank`, a joined beat `joined = {into, glue}`. Every
other field is a plain value at its own key, with the beat's gallery fields together in one value. Simultaneous
writes to different keys both survive. Of two writes to one key Yjs keeps one. A removed beat's record and visual cell stay
with no boundary; the outline ignores them. Roots: [appendix G](#g-roots).

**Formatting.** Plain keys `b`, `i`, `u`, `s`, `hl`, `dir`, `cue`, `c:<commentId>`, `l:<url>`. A production tag is
`t:<tagId>`, U+001F, then the writer's client id and clock, fresh per application (E3b). Keys build up where a tag
is reapplied, 301 on one letter after 300 rounds (E6); that growth is accepted.

## 2. What each command writes

Each command is one transaction.

| Command | Writes |
| --- | --- |
| Type, paste | `insert` with an explicit attributes object, before any delete |
| Replace all | Resolve and validate all narration and visual ranges together. In each Yjs text, replace from the highest stored offset down. Like single Replace, each insertion uses the first matched character's marks, normalizes audio cues through core, and writes explicit Yjs attributes before deleting the matched units |
| Bold and other plain kinds | `format` with the plain key, `true` or `null` |
| Tag, untag | A fresh application key; untag sets `null` on the keys seen. No re-keying |
| Split | Boundary, record copying the parent's rank, visual cell. Never narration |
| Delete and split | Delete a narration selection in one beat, then split at the resulting caret. Resolve the selection and validate the split before either write. A peer-erased selection changes nothing |
| Create first beat | Reuse put-back to write a fresh segment, beat record, rank and cells if no beat is shown. Rule (b) letters stay in their original segments and the reader assigns them to the new beat |
| Join, unjoin | Set or delete `joined` on the lower beat |
| Remove beats | The observed text with its boundary (or `head`); the records, visual cells and segment stay |
| Create, rename, remove heading | Boundary or segment, record, rank, name cell; rename edits the name cell; remove sets `removed` |
| Move | A new rank per moved block, and the shown rank of a rankless neighbour (rule (e)); a tie at the drop re-ranks the right side |
| Fields, status, resolve, body | `Y.Map.set`, only if the value differs (appendix B) |
| Create person, production tag or shot | One record map keyed by minted ID, its field keys and its rank. Tag IDs encode the writer and clock in the core's tag ID form |
| Edit registry fields, cycle tag status, quick-add gear | Changed field keys only. A new owner or tag gets a new record. Quick add marks only omitted orphaned gear removed |
| Move, remove, restore registry entries | Move writes a rank and re-ranks the right side of a tie at the drop. Remove sets `removed` and restore clears it. The reader keeps comment assignee names, clears missing owners and derives tags and shots from surviving labels and keyed lines as on reload |
| Add, remove or reorder shot props | Targeted commands require a stored prop map. Add writes the prop's entry and may create its tag in the same transaction. A name already shown is a no-op. Remove sets `removed` on a valid entry. Reorder writes its rank. A whole-list set keeps retained props on the keys they were read from and removes omitted entries, including overflow. It can replace a damaged prop map |

**Check before writing** (decision 15). Every command finds each part it will touch by id: its rows' records,
cells and boundaries, and the ranks of neighbours a move will write. If one is missing, it refuses without writing.
A command aimed at a removed or hidden row returns that refusal; it never reports success, or nothing, through a
stale target (E1). On section 10's four-step row 5 of 16 commands wrote and then threw as built, none under rule
(g); the prototype skips some silently and its join throws (E16, E17). Commands on the row above work on the
narration it shows. Targeted prop commands reject argument accessors before reading values.

A buffered narration insertion anchored while its beat was live can still write into that segment after removal
when its captured position identifies the gap. The reader then shows the surviving text under decision 6.

Composition folds in remote changes made meanwhile (E1). The reader writes nothing back. The file is converted
once, and every copy adopts that conversion (appendix B). Conversion writes each heading's name into its name cell,
not the segment text: the prototype import does the latter, so its headings read blank (E15).

**Stale selections.** A selection holds Yjs relative positions and, when it is not collapsed, the state its copy had seen; a caret holds no state vector ([format-commands.test.ts](../../tests/adapters/collab/native/format-commands.test.ts), "closing round, item 2"). A selection that still holds a letter of its own covers what a peer typed into it ([format-commands.test.ts](../../tests/adapters/collab/native/format-commands.test.ts), "closing round, item 1, as built"). A selection with no letter of its own left has collapsed, and the command changes nothing, even where a peer typed into it ([text-commands.test.ts](../../tests/adapters/collab/native/text-commands.test.ts), "round 3, item 8"). Owner.

**Concurrent Find formatting.** In the tested Yjs races, replacing `cup` with `mug` while a peer bolds `cup` leaves
`mug` plain. If the original `cup` was bold and the peer concurrently unbolds it, `mug` also ends up plain.
Both delivery orders preserve the replacement text and converge ([replace-all.test.ts](../../tests/adapters/collab/native/replace-all.test.ts)).

**Marks on part of a tag.** A link, comment or text direction set or cleared on part of a tag is stored on those letters only. Every copy reads it across the whole tag, the same as core `setMark` reads it in an unshared script ([format-commands.test.ts](../../tests/adapters/collab/native/format-commands.test.ts), "review round 1, pin 6, as built"). Owner.

**Marks a unit cannot carry.** A link over a video goes on the letters only, and the video is not written ([format-commands.test.ts](../../tests/adapters/collab/native/format-commands.test.ts), "review round 1, fix 2"). A stored mark the reader cannot show is reported as an `unshown-marks` problem, and its unit stays visible. The same test stores a link on a video by a direct Yjs write to show this. Owner.

**A tag repeated inside itself.** Conversion gives the repeated letters one application of their own, which differs from the application on the letters that follow, in the narration and in the visual cell ([convert.test.ts](../../tests/adapters/collab/native/convert.test.ts), "closing round, item 1"). Owner.

## 3. Reading rules

Blocks show in rank order; ties follow stored order (E10). A joined beat shares the row above (E2). Seven rules make
every surviving letter reachable without writing anything.

| Rule | What a person sees | Known limit |
| --- | --- | --- |
| (a) Text before a segment's first boundary belongs to that segment's first beat, or to the row above if the segment has no beat | Letters typed in a removed beat that headed its segment show at the start of the next beat | — |
| (b) An empty script holding stray letters shows them as a narration-only row | Stray letters stay on screen | — |
| (c) A boundary repeating a beat id is ignored | Two people remove a row and both undo: it returns once, narration twice (`xx`) | — |
| (d) A join counts only if its target is the beat directly above | A beat whose target was removed or moved shows as its own row | A later move can make an old join count again (11 in 600 generated histories, E11) |
| (e) A beat whose record has no rank is read after the block before it in the narration | After two people move the same row at once and the winner undoes, the row shows after its narration neighbour | No fixed place: when that neighbour moves or goes, the row follows the next one, possibly into another scene (E14, E15) |
| (f) Text between a heading's boundary and the next boundary is narration without a beat, shown in the first of: the beat directly after the heading, the nearest beat above, the next beat further down, the narration-only row | Letters typed in a deleted scene's beat show in a neighbouring beat, editable | The third step can show it under a different scene, and it moves with that beat (E11) |
| (g) A beat marker whose record or visual cell is missing is not a row; its narration reads as if the marker were absent, in a neighbouring row ([appendix N](#n-a-row-without-its-record)) | After section 10's four steps, N's narration shows in B, editable, as before the split | The restoring undo brings back the narration, not the row. Text typed inside or after the hidden text moves into N on a redo; a split inside it lands right after the beat's own marker (E17) |

A beat loses its rank through a same-moment move race (section 10): 3 of 600 generated histories (E14).

**Tags on the same letters.** A writer who untags, then retags a tag on exactly another tag's letters: which of the two reads as the outer tag follows the writers' client ids. With writer client 5 the retagged tag reads outer; with writer client 20 the other tag does. Every copy agrees and both tags stay ([format-commands.test.ts](../../tests/adapters/collab/native/format-commands.test.ts), "carried item 1, as built: across writers"). Accepted as built (Owner).

## 4. Undo

One `Y.UndoManager` per person over every root a command writes, headings and names included, not `births` or
`edited`. Only the local command origin is tracked. Grouping follows the app's word rule with `stopCapturing()`
(E3). Default delete filter; no depth cap.

- Undo takes back only the presser's changes. A press can pass over spent steps (E11) or change only a removed
  row's hidden record (E14).
- An older redo that would replace someone else's later change returns false: the press is used up and nothing
  changes (E15 histories 9 and 10).
- Undoing a removal brings back others' unseen visual text, status, fields, visual tags (40 of 40 generated
  histories each) and a single unseen move (80 of 80), but not an unseen narration tag (0 of 80). An unseen join or
  unjoin takes effect (E14).
- After two writes at once to one field, the winner's undo leaves it empty: rank, status, join (E15) and beat extra fields.
- Undoing a creation removes everything written into it, seen or unseen (E11, E14); see section 10 for a row cut
  and restored meanwhile.

## 5. Accepted losses

E16 recounted E11's 600 generated histories with kept records ([appendix M](#m-accepted-losses-counted)). Unseen
record changes lost with a removed beat fall from 131 (in 110 of 600 histories) to 1 (1 of 600); unseen visual
changes from 106 (94 of 600) to 0, stored with the hidden row and shown if the removal is undone. The rest are
unchanged and small: typing in a creation its creator undoes unseen (4 of 600), a split beside a move, a deletion
missing a restored row, doubled narration (also after E17's histories), tags, and decision 15's rankless row.

**5a. Tags.** Of 845 requested tags, 800 were kept, 40 undone by their author and 5 lost (E11); the same 5 with
kept records (E16). Plain Yjs causes both: an undo the tagger had not seen restored deleted letters as new ones
(4), and a doubled letter kept the tag on one copy (1). Decision 17 flags such a loss. Outcomes that lose nothing:
[appendix H](#h-outcomes-that-lose-nothing).

**5b. A mark lost with a deleted letter.** A marks `pqr` and types a plain `X` inside it. B deletes `X`, and at the same time C removes the mark from `p`. Every copy then reads `opqr`, with the mark gone from `q` and `r` too. The test runs this with three copies, for a tag and for bold ([format-generated.test.ts](../../tests/adapters/collab/native/format-generated.test.ts), "found by the generated histories"). On raw Yjs with no observer, every copy reads `opqr` when it opened the text before the first updates arrived, and `op[qr|b]` when it opened the text after them (same test). Accepted with no repair writes (Owner). Generated counts: [appendix M](#m-accepted-losses-counted).

**5c. Shot props.** The earlier candidate exposed 41 props in two of 144 histories and core reload kept 40. The keyed
reader now caps the projection before reload. All 144 command histories keep the projected document through reload.
Stock Yjs still picks one writer when both add the same existing tag ID or move the same entry. Undo of the winning
add clears that entry. Undo of the winning move can clear the rank so the prop reads before ranked entries. Redo
restores the winning rank. The losing writer's undo and redo leave the winning rank in place after both updates arrive.
If undo clears the fallback name of a prop with an orphaned tag ID, that prop is hidden. A targeted drop that would
require rewriting a peer's tied rank is refused. [Shape and undo tests](../../tests/adapters/collab/native/prop-shape.test.ts),
[command races](../../tests/adapters/collab/native/registry-races.test.ts).

## 6. Never acceptable

Evidence: E11, and E14 and E16 with kept records, names in cells, five deliveries each: E9's 2,257 runs, E10's
histories, 600 mixed and 200 double-split generated histories.

| Defect | Evidence |
| --- | --- |
| Narration stored but in no row, or shown but not editable | 0 in every set. With names inline it was 27 letters in 19 of 600 |
| A beat shown twice, or its surviving narration nowhere | 0 in every set. Narration shown twice by a command of ours: 0 |
| Copies disagreeing after everything is delivered | 0 in every set, and in E1 to E11, E14 and E15 |
| A thrown error in a reader or writer | 0 in every set. Writers threw under controls (39) and on section 10's four-step row; section 2 makes these refusals |
| A shown row without its record or visual cell | 0 of 4,000 generated runs, which seldom make the sequence (E16). Section 10's four steps do it as built in 5 of 5 deliveries; across E17's named histories, 30 of 90 runs as built and 0 of 90 under rule (g) |
| An existing beat changing scene with one person working | 0 in every set, **except rule (e)'s case**: after two same-moment moves and the winner's undo, deleting the neighbour moves the rankless row out of its scene in every delivery (E14, E15). Decision 15 accepts it |

## 7. Requirements on the product code

- **No copying** (E11): a split that copied text doubled it when two people split at once.
- **Explicit attributes** on every insert, standard tag writes (E6); crossing tags need a read-side fix (appendix I).
- **Check before writing** and **name cells on conversion** (E15): section 2.
- **Recovery skips removed rows** (E14): the inherited recovery list shows removed beats with visual text as
  unplaced.
- **One reading everywhere** (E16, E17): rules (a) to (g) apply the same way in the outline, command lookup, the
  offline notice and its put-back, the recovery list, and export, autosave and snapshots. As built, the outline
  showed E16's row and the notice did not.
- **Incremental reading** (E8, E11): a full rebuild is 84 to 99% of a 900-beat command. Keep the parsed narration
  of unchanged segments and recompute which rows own the affected text (rule (g); appendix N). Relay order, memory,
  storage and signals: appendix J.

## 8. Relay and size

The relay is stock Hocuspocus 4.8.0. It kept order in every condition E13 tried, a restart included. Its one
break, an undo sent into a dead socket overtaken by a redo queued for the reconnect, lost formatting only; decision
14's wrapper prevented it in every measured pair.

At 15 MB a keystroke took 0.201 ms (E8); a first download at 1 to 4 Mbit/s never finished in 30 s (decision 16).
Kept records add about 100 bytes per removed row, 160 to 174 for edited ones (E14). Detail:
[appendix J](#j-relay-size-and-the-reconnect-wrapper).

The server checks the encoded size when a copy joins. At 15 MB and above, the new connection is read-only.
A connection already admitted as writable keeps that access if the script crosses 15 MB. The clients refuse
additions at 15 MB, with a 105% ceiling (#1667), and the server still caps each WebSocket payload at
16,000,000 bytes. The admission tests pin both outcomes.

## 9. Offline notice

On reconnecting, a copy compares its own state with the merged result, per beat, and lists beats it changed that
someone else changed or removed. "Put it back" makes a fresh beat from what the person had, as one undo step (E12).

- **Counts** (E16, kept records, 85 named and 240 generated histories), with the person's own journal of pending
  edits: 46 false banners of 325, 26 misses of 238 losses (appendix I).
- **Product counts** ([7e replay](../../tests/adapters/collab/native/offline-notice-e16.test.ts), with issuing-copy checks and a muted-write control per generated command kind) found 47 false banners of 325 and 26 misses of 238 losses. The tag sweep lost 6 of 28 unseen tags and flagged all 6.
- **Seen and unseen** edits to visual text, visual tags, status and fields still leave identical evidence (4 of 4
  pairs, E16), hence decision 12's possible clash.
- **Tags** (decision 17): E16's sweep lost 6 of 28 unseen tags and flagged all 6.
- **Journal clearing:** an entry clears on the server's "applied" status, which under decision 19's storage means
  applied in memory, not stored. An edit a server stop then loses is not listed (appendix I).
- **Who is told:** only the returning person. Someone online sees a removed row they edited go with no message;
  their edits return if the remover undoes, and a tag lost that way goes untold (E16; appendix I).

## 10. Races on one row under undo

The experiments, all merged, found four histories where an undo meets someone else's change to one row.

- **An undone creation after a cut and its undo** (E16). Alice splits B, making N; Bob cuts N; Alice undoes; Bob
  undoes. No race is needed: Alice's undo deletes N's record and visual cell, which the cut had kept, and Bob's
  brings back only N's marker and narration. As built every copy shows N with neither (5 of 5 deliveries). Under
  rule (g) (decision 18), after Alice's undo B is empty; Bob's undo brings the narration back, shown in B, but not
  N as a row. Bob's status and visual text on N return only if Alice redoes her split
  ([appendix N](#n-a-row-without-its-record)).
- **Rank** (E15). Two same-moment moves and the winner's undo leave a row without a rank; rule (e) places it
  (decision 15; [appendix L](#l-a-rows-place-after-competing-moves-and-undo)).
- **Record** (E15). Two people remove a row offline, both undo, one redoes: kept records keep its record and cell.
- **A segment's first row** (E15, E16). The same race loses the `head` key: the row's narration shows, editable, at
  the start of the next beat (appendix I).

The last three follow from one Yjs rule: of two writes to one key the higher client's stays, and plain undo never
overwrites another person's write.

## 11. Build order

The native adapter lives in `src/adapters/collab/native/`, the only place the dependency gate admits Yjs.
Where each experiment's histories enter as tests is this note's reading of the slices; the cases in appendix O are
requirements from the outside review.

| # | Slice | Gate | Status |
| --- | --- | --- | --- |
| 1 | Shape, conversion with name cells, typing, deleting text, incremental reader | The spike's tape on three copies and a late joiner; headings named in cells; a 900-beat structural change within 8 ms | Done ([#1649](https://github.com/RetroGorilla/splitpage/pull/1649)) |
| 2 | Formatting and tags | E4, E6 and E11's two tag-loss causes in a cell; crossing display | Done ([#1651](https://github.com/RetroGorilla/splitpage/pull/1651)) |
| 3 | Split, join, removal with kept records, headings, reading rules (a) to (g) | E9, E10, E11 and E14 sets; rule (g) on a marker without its record; E17's command table and the split timing with a parse counter (appendix O); section 6 at zero but decision 15's case; recovery lists no removed row | Done ([#1654](https://github.com/RetroGorilla/splitpage/pull/1654), [#1653](https://github.com/RetroGorilla/splitpage/pull/1653)) |
| 4 | Moves | E10's collision table; a move including a row without its record refused unwritten | Done ([#1656](https://github.com/RetroGorilla/splitpage/pull/1656)) |
| 5 | Records, status, comments | Exact row changes; author-only bodies | Done ([#1658](https://github.com/RetroGorilla/splitpage/pull/1658)) |
| 6 | Undo | E3, E11, E14 and E16 tests; E15's histories under option A; E17's histories under rule (g); creation undo and redo timing (appendix O); one change per press; E11's full tag recount (845 requested, 800 kept, 40 undone, 5 lost) | Done ([#1659](https://github.com/RetroGorilla/splitpage/pull/1659)) |
| 7 | Session, editor, relay with the wrapper, server storage, offline notice | E13's pair table; E16's notice counts; every reader agrees on E17's histories; first loads per decision 16; a large offline return under stock timers; two writers past the size limit; server stops per decision 19; stale-target editor cases (appendix O); store and reload | Built on `main` at `2a1cebba1`. Open acceptance cases are in [appendix O](#o-acceptance-cases-from-the-outside-review). |
| 8 | Delete the old adapter | Every deleted test mapped ([app tests](slice-8-test-mapping.md)); `npm run verify` | Native-only hook complete. Adapter removal pending. |

Slice 3 was built as two pull requests: 3a, split, join and removal with
kept records; 3b, headings and reading rules (a) to (g). The E11 full tag recount moved from slice 2 to slice 6, because
it needs the structural commands and undo. Slice 2 reproduced both E11 tag-loss causes in a cell ([format-e11.test.ts](../../tests/adapters/collab/native/format-e11.test.ts)). Owner.

## 12. What changed in round 8

An outside review found the design sound to build. Its corrections are in sections 2, 3, 7, 9 and 10 and
appendices I and N; its acceptance cases are appendix O. Decisions 16 and 19 are the owner's answers to its two
questions. Earlier rounds: [appendix K](#k-earlier-rounds).

## Rules the session keeps (slice 7)

**(a) Apply peer updates only between local commands.** The provider or local store applies bytes directly to the exposed `Y.Doc` with a peer origin. Applying an update inside a transaction listener is unsupported. Applying one in `beforeTransaction` folds it into the local origin, so undo can take back the peer’s edit and a command can read stale layout. [Session tests](../../tests/adapters/collab/native/session.test.ts) pin direct peer delivery after typing, undo, redo, refusal and a throw. [Undo tests](../../tests/adapters/collab/native/undo-commands.test.ts), [move command tests](../../tests/adapters/collab/native/move-commands.test.ts).

**(b) Keep transaction listeners from throwing.** The session registers no listener that can throw in `beforeTransaction`, `afterTransactionCleanup`, `update`, a late-registered `beforeAllTransactions` or an early-registered `afterAllTransactions`. A throw at any of these points can leave every later command refused as `busy`, as pinned in [undo tests](../../tests/adapters/collab/native/undo-commands.test.ts). The session owns one `Y.Doc` throughout its life. If the script stays busy, the session closes as failed and hands back its encoded bytes in `closed`. There may be no final `changed` if Yjs emitted no update. The bytes on `closed` are then the caller's source of truth. In the relay part the caller destroys its provider and opens a new session from those bytes with a new provider and fresh undo. With a local store attached, the store commits the recovery checkpoint and installs the replacement under the same writer lock. [Session tests](../../tests/adapters/collab/native/session.test.ts) pin the byte handoff and provider exchange.

**(c) Close a script only between commands.** A close from `beforeTransaction` after a press has checked availability still lets the press write. [Undo tests](../../tests/adapters/collab/native/undo-commands.test.ts). A requested close delivers the final `changed` while `document()` can read the committed edit, then delivers `closed` exactly once to each subscriber. A failed close can omit the final `changed` if Yjs emitted no update. The bytes on `closed` are then the caller's source of truth. [Session tests](../../tests/adapters/collab/native/session.test.ts) pin both paths, including throws from subscribers and a destroy listener.

**(d) Deliver each person's undo and redo in order.** A redo that overtakes its undo lets formatting cleanup drop a restored tag on every copy. A closing socket can still report connected, so hold document sends whenever the socket is not open for sending. See [section 8](#8-relay-and-size). Pinned in the [native relay tests](../../tests/adapters/collab/native/relay-order.test.ts). E13 has a library reproduction in [raw tag relay tests](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/test/native-undo/raw-tag-relay.test.ts).

**(e) Supply the real comment body sanitiser.** `NativeCommentBodyPorts.sanitize` runs inside the write transaction before any write. It must leave the document and script lifecycle alone. The command catches a throw and refuses the body. The body check refuses text that would change on reload. [Record command tests](../../tests/adapters/collab/native/record-commands.test.ts) pin refusal of bodies the core changes. [Session tests](../../tests/adapters/collab/native/session.test.ts) pin callback timing and refusal on a throw from the sanitiser itself. Its document and lifecycle restrictions are not pinned. [Slice 5 PR](https://github.com/RetroGorilla/splitpage/pull/1658).

**(f) Own word grouping and the undo binding's lifetime in the session.** `openNativeUndo` exposes `undo()`, `redo()`, `stopCapturing()`, frozen `undoStack` and `redoStack` summaries of opaque entry numbers, and `destroy()`. Call `stopCapturing()` at a word-group boundary and `destroy()` when retiring the binding. Elapsed time alone leaves typing in the same group. Even an empty redo ends the group. Presses on a destroyed binding refuse as `closed`. [Undo tests](../../tests/adapters/collab/native/undo-commands.test.ts) pin the binding behaviour. [Session tests](../../tests/adapters/collab/native/session.test.ts) pin instant and elapsed word grouping by beat and cell, unchanged and empty replacements, capture stops on presses, fresh word state after a press or a new session open, and undo retirement. [Slice 6 PR](https://github.com/RetroGorilla/splitpage/pull/1659). `endTypingGroup()` stops capture and clears typing state at a focus or caret boundary. A bound write's `withSelection()` and its `recordAfter()` keep the group's first before-anchor and last after-anchor in the local Yjs stack item. Typing can call `recordAfter()` with no argument to use the relative caret the write produced. A selection keeps two Yjs relative positions, each in its member beat or heading. Undo and redo resolve both ends independently and return member coordinates, which also address the edit commands. Two ends can land in different members or rows. A coincident pair is a caret, and a missing end yields no selection. [Selection tests](../../tests/adapters/collab/native/undo-selection.test.ts) pin focus boundaries, grouping, peer edits, spent steps, surface changes and byte-identical shared state. [Selection measurement](../../tests/adapters/collab/native/measure-undo-selection.ts).

**(g) A taken minted ID stays taken until that copy's clock advances.** Retrying before then keeps returning `taken`. Another write that advances the clock, such as setting a field to a new value, gives the retry a new ID. The refusal for comments and replies, including IDs held by removed records, is pinned in [record command tests](../../tests/adapters/collab/native/record-commands.test.ts). [Session tests](../../tests/adapters/collab/native/session.test.ts) pin retry before and after a clock advance. [Slice 5 PR](https://github.com/RetroGorilla/splitpage/pull/1658).

**(h) Session acceptance notes.**

- Pinned. Refused carets and selections, including root-named relative positions, leave `doc.share` and the encoded state unchanged. [Text command tests](../../tests/adapters/collab/native/text-commands.test.ts). [Slice 3a PR, Deferred](https://github.com/RetroGorilla/splitpage/pull/1654).
- The session warns at a measured 12 MB and refuses local additions at a measured 15 MB. It measures at open and after enough Yjs update bytes accumulate to cover half the distance to the next line, with a minimum step of 64 KiB. Near a line, the measurement tolerance is in update bytes. One large edit can jump several lines. The published state can lag behind the exact size by more than a step because Yjs can split retained items or hold pending peer updates without emitting an update until they integrate. The session publishes one size event with the latest measured state after the transaction when the published state changes. Removals and undo/redo still work below the measured ceiling of 105% of the limit. At the ceiling every local write is refused, and reading, export and close remain available. Peer updates still apply. After a deletion while warning or full, a recovery measure can run before the growth step is reached, at least two seconds after the last measure. An arriving update or an attempted addition at full checks for recovery. One timer checks again when due if the copy stays idle. Closing cancels the timer. Deleting does not free space on your own copy while undo retains the text. Reopening may reclaim that space, and removed rows and comments keep their records. Export is the way out. [Session size tests](../../tests/adapters/collab/native/session-size.test.ts).
- Pinned. Removing a comment leaves its inline mark in `document()`, matching core reload, which keeps orphan comment marks. [Record command tests](../../tests/adapters/collab/native/record-commands.test.ts). [Slice 5 PR](https://github.com/RetroGorilla/splitpage/pull/1658).
- Author-only editing compares names. The session supplies the actor. [Record command tests](../../tests/adapters/collab/native/record-commands.test.ts) pin the equal-name edit. [Session tests](../../tests/adapters/collab/native/session.test.ts) pin actor selection for comment and reply bodies. [Slice 5 PR](https://github.com/RetroGorilla/splitpage/pull/1658).
- Pinned. `document()` returns a snapshot frozen at every depth, and with several headings stacked above one row only the heading directly above it appears in `sections` while `problems()` reports each omitted heading. [Reader tests](../../tests/adapters/collab/native/reader.test.ts), [record command tests](../../tests/adapters/collab/native/record-commands.test.ts). [Slice 3b PR](https://github.com/RetroGorilla/splitpage/pull/1653), [native reader](../../src/adapters/collab/native/reader.ts).
- Text command selection anchors retain a state vector. A caret does not carry one. [Formatting tests](../../tests/adapters/collab/native/format-commands.test.ts) pin the caret and selection behaviour. The cost of that text-command state vector is not pinned. [Section 2](#2-what-each-command-writes), [slice 2 PR](https://github.com/RetroGorilla/splitpage/pull/1651).
- Pinned. A picture change on a joined row is checked against the assembled gallery before the core's form is applied, so it can be refused for a link the reader hides. [Record race tests](../../tests/adapters/collab/native/record-races.test.ts).

**(i) Accepted as built.** After two competing moves and an undo, E15 history 16 ends `A B N X C D` in the product. The experiment's option A gave `A B X N C D`. Slice 4 moves pin followers that have no rank. Undo removes that pin and the split-off follows its narration neighbour. [Move race tests](../../tests/adapters/collab/native/move-races.test.ts), [slice 6 PR](https://github.com/RetroGorilla/splitpage/pull/1659).

**(j) Open cold-read measurement.** The cold read has exceeded its limit on a busy machine and passed when measured alone. [`measure-structural.ts`](../../tests/adapters/collab/native/measure-structural.ts) enforces the 7.5 ms limit. The busy-machine effect is not pinned. The open options are to measure it alone in CI or for the owner to change the limit. [Slice 3a PR](https://github.com/RetroGorilla/splitpage/pull/1654), [slice 4 PR](https://github.com/RetroGorilla/splitpage/pull/1656), [slice 5 PR](https://github.com/RetroGorilla/splitpage/pull/1658).

## Where the older plan and this note disagree

### Crossing tags

The older plan's [Schema requirements](../COLLABORATION-PLAN.md#schema-requirements) call for deterministic nesting. Its [Mandatory feasibility traces](../COLLABORATION-PLAN.md#mandatory-feasibility-traces) also say nothing is dropped silently. This note's [appendix I](#i-smaller-open-points) shows the second tag only on its letters outside the first. Both require consistent nesting. The open difference is whether to disclose the hidden part.

On `main`, the native writer stores both applications. The reader clips the displayed overlap. [Formatting tests](../../tests/adapters/collab/native/format-commands.test.ts).

- **A.** Keep the current display. A person sees part of the second tag disappear in the overlap.
- **B.** Keep the same nesting and disclose the hidden part. A person can see why the tag looks shorter.

The owner chose option A on 2026-11-20.

### Client-side storage

The older plan's [Local replica storage](../COLLABORATION-PLAN.md#local-replica-storage) calls for a store that reports when a write completes. It uses IndexedDB in the browser and a main-process store on desktop. Its [Offline guarantees](../COLLABORATION-PLAN.md#offline-guarantees) describe reopening retained work. This note's [section 9](#9-offline-notice) describes a pending-edit journal for the notice. It specifies no local store or restart guarantee. The two passages cover different parts of offline work and do not disagree.

On `main`, the native store can persist and reopen a session through browser IndexedDB or desktop test IPC.
The editor entry through `__sharedTest` does not attach either store.

- **A.** Include the plan's local store in the session work. A person can recover confirmed local edits on restart subject to the plan's storage conditions.
- **B.** Stage the local store separately. Until it is available, a person can keep editing in a loaded offline session and cannot rely on reopening unsynced work after a restart.

The owner chose option A on 2026-11-20.

On 2026-11-20 the owner chose an appending store owned by Splitpage, using standard Yjs updates and checkpoints.

Peer updates waiting for a missing dependency emit no applied update and are not appended, since the server still holds the script and resends them on the next sync.
Measurements use Node with simulated IndexedDB. Real-browser write latency, disk durability and tab-kill lock release remain untested.
The two-second open deadline also reports an ordinary slow open as `blocked`.

### Undo across a restart

The older plan's [Undo and rendering](../COLLABORATION-PLAN.md#undo-and-rendering) says undo may reset on restart in v1. This note's [section 4](#4-undo) describes a local undo manager and word grouping. It makes no restart promise. The passages are compatible with starting a fresh history.

On `main`, `openNativeUndo` creates an in-memory history binding. No session restores that binding across restart. [Slice 6 PR](https://github.com/RetroGorilla/splitpage/pull/1659).

- **A.** Start a fresh undo history on reopening. A person can undo edits from the new session.
- **B.** Preserve undo history across restart. A person can also undo edits from before they closed the app.

The owner chose option A on 2026-11-20.

### Validation limits

The older plan's [Validation and resource limits](../COLLABORATION-PLAN.md#validation-and-resource-limits) call for separate bounds and checks before rejected updates affect other copies. The plan requires an explicit outcome for two valid edits that exceed a limit together. This note's [appendix B](#b-checks) and [appendix I](#i-smaller-open-points) specify a 15 MB encoded limit and local edit refusal. [Appendix O](#o-acceptance-cases-from-the-outside-review) records the gap for server checks and merged edits.

On `main`, the session checks the last measured encoded size before a local command. The relay checks encoded size
when admitting a connection and caps individual WebSocket payloads. Already admitted writers keep access when
their updates cross the limit. See [section 8](#8-relay-and-size).

- **A.** Use the local size check and define what happens when a merge goes over the limit. A person can hit a warning or refusal while editing. They need a clear outcome when offline edits combine.
- **B.** Add the plan's server-side limits to the local check. A person whose valid local work would push the shared copy over its limit can be stopped from publishing it and keep it for export.

The owner chose option A on 2026-11-20.

### Backup timing

The older plan's [Backups and restore](../COLLABORATION-PLAN.md#backups-and-restore) calls for daily backups and a restore drill before limited release. The native relay's [backup runbook](#backup-runbook) gives the schedule and the isolated restore procedure for SQLite snapshots.

On `main`, the relay stores SQLite snapshots and has commands to verify backups and restore into an empty volume.

- **A.** Require daily backups and a restore drill before limited release. A person can expect recovery from the last backup if the server store is lost.
- **B.** Set the schedule and release gate when slice 7 designs backups. A person has no promised backup interval until that decision is made.

The owner chose option A on 2026-11-20.

### Server storage and saved status

The older plan's [Server storage](../COLLABORATION-PLAN.md#server-storage) and [Durability receipts](../COLLABORATION-PLAN.md#durability-receipts) require a committed update journal before a durable receipt. Its update supersedes that first-version choice. After reviewing the [server-stop results](#server-stop-results-and-backup-runbook), the owner confirmed [decision 19](#decisions-made) on 2026-11-20. The first version uses stock snapshots and makes no "saved to server" claim.

On `main`, the relay stores SQLite snapshots. The provider's applied acknowledgement carries no durability receipt.

- **A.** Keep snapshots if the server-stop results are acceptable to the owner. Recent edits can be missing from the server after a stop, and a person gets no receipt that they were saved there.
- **B.** Require the journal and durable receipts before others use the layer. A person can tell which edits were committed to server storage before a server process stop.

The owner chose option A on 2026-11-20.

## Appendix

### A. Sources

Result files, under [`prototypes/collab/src/`](https://github.com/RetroGorilla/splitpage/tree/5b9b2b141/prototypes/collab/src):

| Name | File |
| --- | --- |
| Spike | [`native/REPORT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native/REPORT.md) |
| E1, composition | [`native-e1/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-e1/RESULT.md) |
| E2, split and join races | [`native/E2-RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native/E2-RESULT.md) |
| E3 and E3b (its follow-up with the chosen keys), undo | [`native-undo/RESULTS.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-undo/RESULTS.md) |
| E4, formatting keys | [`format-keys/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/format-keys/RESULT.md) |
| E5, headings | [`native/E5-RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native/E5-RESULT.md) |
| E6, production tags | [`format-keys/E6-RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/format-keys/E6-RESULT.md) |
| E7, moves by placement | [`native-moves/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-moves/RESULT.md) |
| E8, size | [`native-size/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-size/RESULT.md) |
| E9, real deletion | [`native-delete/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-delete/RESULT.md) |
| E10, move ranks | [`native-moves/E10-RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-moves/E10-RESULT.md) |
| E11, the chosen combination, with its 2026-11-19 correction | [`native-chosen/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-chosen/RESULT.md) |
| E12, the offline notice | [`native-notice/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-notice/RESULT.md) |
| E13, the stock relay | [`native-relay/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-relay/RESULT.md) |
| E14, kept record and visual cell | [`native-kept/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-kept/RESULT.md) |
| E15, a row's place after competing moves and undo | [`native-rank-undo/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-rank-undo/RESULT.md) |
| E16, the recount with kept records | [`native-kept-recount/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-kept-recount/RESULT.md) |
| E17, a shown row always has its record | [`native-row-record/RESULT.md`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/src/native-row-record/RESULT.md) |

Library sources read: Yjs 13.6.33 `src/utils/UndoManager.js`, `src/types/YText.js`; y-prosemirror 1.3.7
`sync-plugin.js`, `undo-plugin.js`; y-codemirror.next 0.3.5 `y-sync.js`, `y-undomanager.js`; y-protocols 1.0.6
`sync.js`; Hocuspocus 4.8.0 server and provider; the Yjs documentation on `Y.UndoManager`, `Y.Text`, `Y.Doc`,
document updates and relative positions. Rule ids such as U14 are from
[`native-rule-inventory.md`](native-rule-inventory.md).

### B. Checks

[`prototypes/collab/test/native-design/native-design.test.mjs`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/test/native-design/native-design.test.mjs), Yjs 13.6.33, Node 24.22.1; all 19 pass. Run
`npm ci --prefix prototypes/collab`, then `node --test test/native-design/native-design.test.mjs` in
`prototypes/collab`. The prototype code lives at commit `5b9b2b141`.

| Check | Result |
| --- | --- |
| Two independent conversions of one file, merged | The beat listed twice; one copy's typing gone |
| Two conversions under one fixed client id, different text | The copies disagree |
| A retried conversion under one creation id, both copies typing | One `births` entry, the segment listed twice, one copy's typing gone |
| Join by copying the second visual cell while another copy types in it / join as a flag | That typing gone / kept |
| A throw after the first write in `doc.transact` | The first write committed and sent |
| A map key set to its current value | One update sent; the remote observer called |
| A visual cell replaced after a position was taken in it | The position resolves to `null`; a write through the old cell is not shown |
| Plain undo of a group that deleted all it typed | Passed over; the same press undoes the step before |
| Plain undo of a record's creation after another copy set a field, seen by the undoer | Record and field gone on both copies |
| `undo()` inside `doc.transact(..., undoManager)` | 1 undo entry, 0 redo entries |
| Two identical statuses, the winner undoes / a fallback written after | Absent on both, redo restores / the next redo does nothing |
| Both copies delete the same `b` of `abc` and undo before seeing each other's undo | `abbc` on both |
| 10,000 letters inserted and deleted under undo, then `clear()` | Over 10,000 bytes encoded; under 100 in a fresh copy |
| 100 growing prefixes, each formatted under its own application key | 100 live keys on the first letter; 3,610 bytes; 1,739 in a fresh copy after removing them all; 113 plain |
| A 1,000-letter paste | 1,014 bytes plain; 37,809 with one key per letter; 145,593 with four |
| A new history built from the visible text, synced with the old | The text doubled |
| A comment body as a whole string, two people adding at once | One addition kept, the same on both copies |

The throw-in-transaction check is why every command checks before its first write (section 2). The cleared-undo
check backs the rebuild in appendix C. The rebuilt-history check is why a stored room is never rebuilt from its
visible text. The paste check is why size is counted in encoded bytes: a command that would pass 15 MB is refused
before writing.

### C. Costs and rebuild

| Cost kept for the document's life | Bytes | Source |
| --- | --- | --- |
| Split | 54.51 | E2 |
| Live join | about 40 | E2 |
| Heading name in its own cell, per heading | 13 to 15 | E11 |
| Flat-rank row move, kept / sent | 9.19 / about 38 | E10 |
| Kept record and visual cell per removed row, plain / edited | 97.8 to 101.4 / 159.7 to 174.2 | E14 |
| Production tag history per application, plain key / per-application key | 50.2 / 70.9 to 72.2 | E6 |
| Tag keys over a script's life | about 9 to 10% more | E6 |

E14's kept-record bytes come from a fixture that cuts every beat in one transaction; they are a low estimate for
cells edited over many sessions. With 9,000 removed rows a full read took 13.23 to 14.15 ms against 12.26 to 12.73
with records deleted, and a keystroke 0.274 to 0.291 ms against 0.271 to 0.276; neither reads the record or visual
maps in full (E14).

Rule (g) stores nothing. Its read and keystroke times stayed within the spread between passes, and a split with
its undo took about 0.6 ms more than as built (E17). The prototype clears every cached segment view whenever a
record or visual cell is added or removed; that re-reading cost during editing, including when many records change
at once, was not measured.

An editing copy keeps every letter its own undo history deleted, and `clear()` frees none (appendix B): pasting and
deleting a 10,000-letter block 100 times gave 1,003,678 encoded bytes against 3,678 in a fresh copy (E3). A copy
loads fresh on entry and rebuilds from its stored state at an idle moment once its own deleted letters pass a
threshold (E3 proposes 1,000,000), telling the person undo history was cleared.

The notice's comparison took 1.65 to 1.68 ms median at 900 beats, and capturing a reading 10.2 to 11.6 ms (E12).

### D. Rules decided or dropped

Decided 2026-11-18: R01 (removal is a real deletion; unseen changes go with the beat), changed on 2026-11-19 to
deleting narration and boundary while keeping the record and visual cell (decision 4); F40 (whole bodies, author
only), U14 (moot), and, as in round 3, F01, M01, U02, U13, F13, F32. Dropped with no reproduced defect: M02 to M04,
M15; S11 to S15, S22; F03 to F05, F35 to F39; U03, U04, U15, U16, U18, U21, U25 to U33, U39; R02, R03, R05, R06, R08
to R10, R13, R17; Q02, Q04, Q06, Q07. Dropped after E3: U10.

### E. What stays, changes and goes

| Code | Fate |
| --- | --- |
| Adapter: document state, ingress gate, trial replica, read caches, identities, anchors, text units, birth, creation and mark records, undo executors | Go: Yjs items, relative positions and `Y.UndoManager` replace them |
| Adapter: executors and preparation | Rewritten as four writers: text, formatting, structure, records |
| Adapter: projection, indexes, hydration, text import | Rewritten: the incremental reader and one conversion |
| Adapter: buffer, painted base, recorded selection | Replaced by the composition fold |
| Adapter: move refusal | Goes: moves are in |
| Core: `operations.ts`, `read-operation.ts`, `base-reference.ts` | Change: text by cell, offset and base; operations for dropped rules go |
| Core: `undo-record.ts` | Goes; a description keeps label, selection, typing key |
| Core: `recovery.ts`, `removal-state.ts` | Change: removed beats, and their kept records, are not listed; removed headings and local refused text stay |
| Core: `merge/review.ts`; feature: `merge/banner.ts` | Reused by the offline notice, with new wording |
| Application: `shared-session.ts` | Stays |
| Application: `shared-undo.ts`, `replayed-steps.ts` | Shrink to admission and the grouping rule |
| Tests: `tests/collab/` delivery, agreement, checker, fixtures | Carry over; dropped rules marked |
| Tests: `tests/adapters/collab/` (173 files), `tests/collab/*-mutants.json` (41 lists) | Deleted once slice 8 maps each behaviour to its replacement |
| Tests: `src/test/shared-*-app.test.mjs` | Native suites and direct tests with remaining coverage stay. The [app test mapping](slice-8-test-mapping.md) accounts for retired cases. |

### F. Evidence rule for generated tests

The model imports neither Yjs nor the code under test. A clean baseline passes, then each effective write is muted
once; each mute must be caught at the command that made it, before a later command fails for a missing target. A
throw or lost coverage fails the control. Every value read from the implementation is listed with what it limits.
E5's checks are the template.

### G. Roots

| Root | Holds |
| --- | --- |
| `meta` | Format version, `docId`, timing settings, the file's schema, unknown file fields as one JSON string; `title` as `Y.Text` |
| `births` | Creation id to `{at, by}`: the one conversion of the file |
| `order` | Segment keys in stored order |
| `segments` | Per segment: `head` (`{b: beatId}` or `{h: headingId}`) and `text` (narration and boundaries) |
| `beats` | Per beat: `rank`, `status`, `lengthSeconds`, `paragraphStart`; `joined = {into, glue}` when set. `gallery` holds the primary image, name, annotation, links and secondary pictures together. Each other extra field has its own `f:` key followed by its JSON-encoded name. Kept after the beat is removed |
| `visuals` | One visual cell (`Y.Text`) per beat, kept after the beat is removed |
| `headings` | Per heading: `rank`, other fields; `removed` when set |
| `names` | One name cell (`Y.Text`) per heading, written at conversion |
| `comments`, `replies`, `people`, `tags` | The file's fields; bodies are whole strings |
| `shots` | The shot's file fields and a nested `props` map. Each key is the tag ID, or `n:` followed by the JSON-encoded normalized name. Its record holds the encoded name, rank and optional `removed` mark |
| `edited` | Per beat, `{by, at}` of the last typing |

Conversion and creation store the prop map in the same transaction as the shot, even when it has no props.
Props read in rank order, with equal ranks ordered by key. The core normalizer defines the projection, including
the 40-prop cap. Other active entries stay stored and count toward the add limit. A missing or invalid map reads
as empty and produces one problem for the shot's props. The old array form was never released. An explicit whole-list
set can replace it with a map containing the requested props. Within a valid map, the reader reports damaged entries
individually and keeps readable entries. A whole-list set replaces damaged requested keys and deletes omitted ones.
A targeted removal of a damaged entry deletes its key.

### H. Outcomes that lose nothing

E11, 600 generated histories, names in cells, unless marked:

| Outcome | Count |
| --- | ---: |
| A split inside rule-read text placed at the nearest point | 8 |
| An undo press passed over items that no longer changed anything | 16 |
| A move made an old join count again (rule (d)) | 11 |
| An undo of a move did nothing visible | 8 |
| Letters whose fate Yjs decides, all absent at the end | 10 |
| Formatting differing by delivery order, marks only | 8 histories |
| An undo press changed only formatting on letters someone else had erased | 2 |
| A restored row without a rank read at its stored place (rule (e)) | 5 histories; 3 with kept records (E14, E17) |
| Two people edit the gallery of the same beat at once | One writer's whole gallery survives and stays intact on core reload, even when the writers edited different gallery fields |
| Someone restores a registry entry before receiving another person's removal | The entry disappears again when the unseen removal arrives. Restoring it again brings back its fields |
| Two people change one registry value at the same moment and the winner undoes | The stored value can become absent. An entry without a name is hidden. A missing tag status reads as `needed`. Rankless entries appear first in ID order and a move gives them a rank. [#1670](https://github.com/RetroGorilla/splitpage/pull/1670) |
| Two people add different props or move different props on one shot | Both entries survive. Equal ranks sort by key and undo on one copy leaves the other copy's edit |
| Two people add the same normalized prop name under different tag IDs | Both show in rank and key order when within the cap, as on core reload. Undo removes the acting copy's addition and redo brings it back |
| One person removes a prop while another edits it | The removed prop stays hidden. Undo of the removal restores it with the concurrent edit |
| One person removes a prop while another keeps it in a whole-list set | The removal still applies, even when the prop's displayed tag ID differs from its stored name key |
| Two people move the same prop and the losing writer undoes after both updates arrive | Undo and redo leave the winning order in place |
| Two people add different props to a shot with 39 props | Both stay stored and 40 show. Removing a visible prop reveals the overflow entry. Core reload preserves the projection |
| Two people create the first beat at the same moment | Both beats and their text stay. The tied ranks follow stored order, and any rule (b) letters are assigned by the reader |
| A peer types inside a selection being deleted and split, or splits inside it | The peer's inserted letters or boundary survive. A surviving boundary can leave an empty beat |
| A peer types inside a range being replaced by a batch | The new letters survive alongside the replacement |
| A peer removes a beat while a batch replaces text in it | The new narration reads in a surviving beat under the reading rules. Undo of the batch can restore the matched letters there while the beat stays removed |

Also, with no text lost: plain bold in E4's 60 two-copy trials, 72 letters missing bold at merge and 34 left bold
after an undo; text composed beside a deleted letter landing across a same-moment insertion, 25 of 20,000 (E1); two
people deleting the same `b` of `abc` and both undoing give `abbc` (appendix B); a letter at a tag's edge takes the
tag by client order (E6).

**Concurrent untagging.** A tags `abc`, B tags `bcd`, and both have both applications. A clears `ab` while B clears `bc`; both applications survive on `c` and `d`, so `c` stays tagged on every copy. Plain `Y.Text.format` gives the same result in each client order and delivery order the test tries ([format-commands.test.ts](../../tests/adapters/collab/native/format-commands.test.ts), "review round 1, pin 8", including its raw Yjs part). Accepted with no repair writes (Owner).

### I. Smaller open points

Each is the design's default unless the owner objects.

| Point | Default | What a person notices |
| --- | --- | --- |
| A split whose caret is inside recovered text | Nearest point that needs no copy, as built (E11) | With recovered `X` before the beat's own `b`, asking for a break before `X` gives `B: X` / `N: b`; with `X` after `b`, a break at the end gives `B: b` / `N: X`. The break moves by the whole recovered text |
| Where rule (f) places narration with no beat in its scene | As built (E11) | Rarely, a few letters from a deleted scene start a row in the next scene and move with it |
| Undoing a heading's creation after an unseen rename | Plain undo; the rename is lost (1 in 600, E11) | The heading and the rename disappear |
| An old join counting again after a move | As built (11 in 600, E11) | Rarely, a moved row merges with the row it was once joined to |
| An unseen join or unjoin on a removed row | As built: it takes effect when the row returns (E14) | An undone removal brings the row back joined to the row above, or separate |
| An undo press spent on a removed row's hidden record | Library behaviour (E14) | A press changes nothing visible. The caret may return to where that step was made. |
| What a removed row leaves in the stored script | Kept for the script's life; no clean-up in the first version (E14 lists what one would need) | Its visual text, fields, rank and tags stay readable to anyone holding the script, in every later copy; its narration does not |
| A segment's first row lost in a remove, undo and redo race | As built (E15, E16); rule (g) does not change it, since the record is not what is missing (E17) | The row's narration joins the start of the next row (5 of 5 deliveries); its visual text and fields stay stored, not shown. The inherited recovery list showed a non-empty visual as unplaced (E16); the product reader leaves kept records out (section 7) |
| Formatting that differs by delivery order | Accept: library behaviour (E11) | A mark's exact edge can differ; copies agree once everything is delivered |
| What happens at 15 MB | Warn at a measured 12 MB and refuse additions at a measured 15 MB with a message and an export. Recheck growth near each line after at least 64 KiB of update bytes. After a deletion while warning or full, timed recovery can measure sooner, two seconds after the last measure. Large edits, retained items and pending peer updates can carry the exact size beyond that tolerance. Refuse every local write at the measured 105% ceiling. | Deleting does not free space on your own copy until the script is reopened, and kept records still take space. Export is the way out. |
| Two crossing tags | The second shows on its letters outside the first (E6) | Part of the second tag looks absent |
| What counts as pending work for the notice | The person's own journal (E12); no client can observe a "last state both had" moment (E13). Under decision 19 an entry is cleared by the server's built-in "applied" status, which means applied in memory only, and not reliably: it is also sent when applying threw or the update waits on missing dependencies (plan, "Durability receipts"). An edit lost by a server stop after that status leaves no entry, so the notice cannot list it. Only a journal commit in `beforeSync`, as the plan requires, would make the status mean stored | Fewer false cards for someone who was idle. With kept records: journal 46 false banners of 325 and 26 misses of 238; ideal base 64 and 25 of 238; both miss 16 of 30 generated split-and-move losses; counting an edit stored on a hidden row as kept, false banners rise to 87 and 103 (E16) |
| Words already shown in the row above when a beat is put back | As built: both show (E12) | The words appear twice; the person deletes one. After a double delete and double undo, a third copy |
| Two people putting the same beat back | Two rows (E12) | Both rows show; someone deletes one |
| "Undo merge" | Hidden; ordinary undo takes back a put-back (E12) | No "Undo merge" button in shared mode |
| The first upload of a large script | Accept the built-in server's ceiling. Measured with both Hocuspocus timers raised to 180 s, not decision 16's stock settings: largest single uploads about 7.15 MB at 1 Mbit/s and 14 MB at 2; the full 15 MB script passed at 4 (E13). Under stock timers, a 5 MB offline return at 1 Mbit/s reached the server at 41.8 s; the provider then forced a disconnect at 66.1 s, and on the next connection the pending count reached zero at 67.2 s, the re-sent reply being 2 bytes because the server already had the work (E13). The documented `handleConnection` route on a host-owned listener has no such sweep, but the host then owns connection lifetime and heartbeat | Sharing a large script over a slow upload fails, and the host retries on a faster link |
| Backups of scripts stored on the server | Verified daily SQLite snapshots copied off-machine. Restore drill before anyone else uses the relay | If the server's store is lost, scripts return as of the last verified backup. Changes since then are absent from the restored store |
| Undo passing over spent steps | Library behaviour (16 in 600, E11) | A press occasionally undoes something older |
| A person who stays online while a beat they edited is removed | Not told; no online signal is used. With kept records the beat-map signal fell from 131 to 12 banners of 325, all from undone creations, and the row-reading observer misses 92 of 192 losses (E16) | The row disappears with no message; their edits return only if the remover undoes. A tag lost that way is not flagged for them (decision 17) |
| Hidden edits on a removed row | No route to them other than the remover's undo (E16 did not measure one) | Status, fields and visual text on a row that stays removed are stored but not reachable |
| Rank between two blocks | Owner, as built: the same neighbours give the same rank, and so does the rank with both neighbours null ([rank.test.ts](../../tests/adapters/collab/native/rank.test.ts), "ranks between adjacent and distant initial ranks"; "ranks before the first, after the last, with both null, and at tight prefixes") | Nothing visible |
| Rank length at the open ends | Owner, as built: 10,000 appends from the initial rank keep the rank at 7 characters at step 900 and at step 10,000, 70,000 characters in all ([rank.test.ts](../../tests/adapters/collab/native/rank.test.ts), "10,000 appends and 10,000 prepends keep strict order and compact sizes") | Nothing visible |

### J. Relay, size and the reconnect wrapper

| At 15 MB | Result |
| --- | --- |
| Keystroke median (E8) | 0.201 ms |
| First join, cold server / late join, warm (E13) | 4.99 s / 1.98 s |
| First download at 1, 2, 4 Mbit/s: stock / 180 s timeout (E13) | Restarted at 35 to 39 s, never finished / 129.3, 80.0, 35.9 s |
| Years that fill it, one writer (E8) | About 37 realistic or 6.8 heavy |
| Memory per open script (E8, E13) | 344 MiB in a Node copy; 306.9 MiB on the server |

**First upload.** The built-in server's 30 s heartbeat sweep ends a connection still receiving one large message,
with no setting for it; 15 MB passed at 4 Mbit/s (E13). **Storage** (E13): each store rewrites the whole snapshot
(438 ms encode at 15 MB), 2 to 10 s after an edit; a positive status does not mean saved. **Reading** (E8, E11):
the Yjs write is 0.02 to 0.07 ms; walk a cell once per key.

What the stock provider's signals promise (E13). No stock event means "caught up both ways": `synced` and a zero
pending count both held while a download was still held back.

| Signal | Promises | Does not promise |
| --- | --- | --- |
| `status` connected, `connect` | The socket is open | That the document has arrived; a silently dead link stays "connected" 36 to 39 s, or 216 to 234 s with a 180 s timeout |
| `synced` | After the server's state reply is applied, the copy has what the server had when it answered | Caught up both ways: it fired once before the reply on a reconnect, and stayed true through a forced disconnect |
| Pending count at zero | On an unbroken connection, every update this copy sent was applied by the relay | Saved to storage; after a reconnect an offline queue reset to 1 and reached zero early |

The wrapper (decision 14) is a 38-line subclass of the stock provider. It holds document sends while disconnected
and from open until its own state reply is sent; authentication, awareness and the handshake stay stock. Measured:
the tag kept in 5 of 5 runs where stock lost it; the first edit after reconnect reached a peer about 29 ms later; a
1 MB offline return sent 1,000,485 bytes against 2,001,048. A large combined reply is subject to the upload ceiling
in appendix I (E13).

### K. Earlier rounds

**Round 7.** Decisions 16 to 18 (owner); rule (g) answered E16's row without its record. Losses and the notice moved
to E16's recount with kept records, and the online case was stated. Every reader applies the same reading. E16's
history replaced E15's 17 and 18 as the check-first evidence.

**Round 6.** Decisions 4, 12, 14 and 15 (owner): kept records, the possible-clash card, the reconnect wrapper, and
the move race accepted with plain undo plus check-before-writing. Rule (e)'s cause became a move race, not a removal
(E11's correction, E14, E15). Undo stated what an undone removal brings back, its side effects and the blocked redo.
Section 10 listed the three races; E15's options went to appendix L. Conversion fills name cells (E15).

**Round 5.** Rooms stay on the server (owner); the session-only proposal was dropped and the relay host settled.
Heading names moved into their own cells: inline, narration typed in a deleted scene ended up inside a removed
title, in no row (E11). Rules (e) and (f) were added with their limits, and no command copies narration, after a
copying split doubled text (E11). What undo does not bring back was stated (E11, E12). E11's tag counts and E12's
flag rule replaced the lost-tag question. Relay, loads and the notice came to rest on E13 and E12.

**Round 4.** The removed mark on beats, the keep-always undo setting, the refusal of moves, the 2 MiB budget and the
U14 row were dropped; plain keys replaced per-action keys except for production tags; the join target is stored
again for rule (d).

### L. A row's place after competing moves and undo

E15 compared five options. The structural cause it names: a beat's place is one rank, one plain value under one key
of its record. Of two same-moment writes Yjs keeps the higher client's, and plain undo never overwrites another
person's write, so the winner's undo leaves the key empty. A second cause runs through every option: a move also
writes ranks of rows it did not select, and undoing the move takes those back (histories 15 and 16).

In the named histories (five deliveries each) and the generated sets (600 mixed, 200 double-split, E10's 229), no
option lost narration, showed a beat twice or left copies disagreeing. With records deleted, every option lost a
row's record in history 12 and a segment's first row in the same race.

| Option | After the race and the winner's undo | Presses against a later change someone else made and had seen | Cost over A (bytes kept per move; read, move at 900 beats) | Against it |
| --- | --- | --- | --- | --- |
| **A, as built (chosen)** | The row follows its narration neighbour, and can later change scene (histories 1 and 5) | Never; a conflicting older redo returns false and is used up (histories 9 and 10) | Baseline: 9.42 bytes; 3.80 to 3.98 ms; 4.15 to 4.30 ms | The open case in section 6 |
| B, `ignoreRemoteMapChanges` | Back where it was before the race | Any undo or redo can replace one: histories 2, 6, 9, 10, 21; 6 of 1,104 generated presses changed 8 values | Same bytes; read about 9%, move about 4% slower | Applies to every map key, status included; Yjs marks it experimental |
| C, one map key per rank write | Where the other person put it | A redo can (histories 9 and 10) | 22.89 bytes; read about 46%, move about 70% slower; about 42 lines | Slowest, and a reader order to keep |
| D, a list of ranks per record | Where the other person put it | A redo did in one three-person history (10) | 10.53 bytes; read about 9%, move about 7% slower; about 39 lines | Stored entries double with each round of racing moves and undos: 256 after 8 rounds |
| E, a fixed place written with each boundary | Where the row was created: 0 to 4 rows from where it stood, in another scene for 3 of 5 rows (mixed) and 2 of 3 (double split) | Never, as A | About 15 more bytes per row; read about 8%, move about 18% slower; about 62 lines plus hooks | Undoing a move can relocate a row it did not select (histories 15 and 16); one boundary without its fixed place turns the whole reading back to A's, and the import writes none |

B, C and D, like E, can also relocate a row an undone move did not select (histories 15 and 16); A left it in place
there, by where the narration happened to put it.

### M. Accepted losses, counted

E16's recount of E11's 600 generated histories, names in cells, forward delivery: occurrences, and the histories
they fall in. Tags use E11's five-delivery rule.

| Loss | Records deleted | Kept records |
| --- | ---: | ---: |
| Unseen record change discarded with a removed beat | 131 in 110 of 600 | 1 in 1 of 600 |
| Unseen visual change discarded with a removed beat (kept: stored, not necessarily shown) | 106 in 94 of 600 | 0 in 0 of 600 |
| Typing lost when an unseen creation undo removes a new beat | 3 in 3 of 600 | 3 in 3 of 600 |
| Typing lost when an unseen creation undo removes a new heading | 1 in 1 of 600 | 1 in 1 of 600 |
| A split half stays behind after an offline move | 1 in 1 of 600 | 1 in 1 of 600 |
| A deletion misses a row restored by an unseen undo | 3 in 3 of 600 | 3 in 3 of 600 |
| A double delete and double undo doubles the narration | 3 in 1 of 600 | 3 in 1 of 600. The same shape after E17's histories 4c and 5c: both people cut N unseen and each undoes; four N markers and `bb` are stored and one row `N: bb` shows, in every option and delivery. Histories 4c and 5c themselves end with two N markers stored and one N and one `b` shown; no continuation showed N twice (E17) |
| Production tag lost | 5 of 845 | 5 of 845 |

The one kept record loss is a field on a beat whose creating split was undone; it is absent with or without the cut
(E16). Following each latest value through every cut, a different denominator:

| Latest value | Records deleted | Kept records |
| --- | ---: | ---: |
| Field still stored on a row that stays removed | 0 of 123 | 120 of 121 |
| Visual character still stored on a row that stays removed | 0 of 103 | 103 of 103 |
| Field shown on a row that returns | 2 of 6 | 6 of 6 |
| Visual character shown on a row that returns | 1 of 8 | 8 of 8 |

Also accepted, not in E16's ledger: two people dropping into each other's spot meet neither request (E10, all 8
histories); a rankless row placed by rule (e), 3 of 600 histories with kept records (E14), decision 15.

Also not in E16's ledger: the generated tag histories ([format-generated.test.ts](../../tests/adapters/collab/native/format-generated.test.ts), "generated tag histories on three copies") lose a stored application on two letters, `q` and `r` of one rope application (seed 6, 30 seeds in all). In each case another application of the same tag still covers the letter, as the test asserts for every shortfall. The test's own comment attributes the shortfall to the library, reproduced on raw Yjs by the next test (section 5b).

### N. A row without its record

E17 compared what to do when a beat's marker comes back without its record and visual cell (section 10's four
steps and their variants, on kept records). Each option ran 18 named histories in five deliveries, 90 runs, plus
E15's 21 histories, the segment-head race, 16 commands on the four-step state, and E14's and E16's generated sets.
In all of them, no option lost narration, showed a row twice, left copies disagreeing or failed a reader.

| Option | What happens | Cost | Against it |
| --- | --- | --- | --- |
| K, as built | The row shows without its record or cell in 30 of 90 runs (480 of 3,000 copy-steps). 5 of 16 commands throw after writing: a heading above N or above B, and three moves that leave `B, N, A` stored. The row list shows N; the notice reader leaves it out. Restoring a cut neighbour from the notice throws before writing | — | The defect |
| **R, rule (g) (chosen)** | 0 of 90. Alice's undo wins: the document reads as before the split, and Bob's undo brings back the narration, not the row; Alice's redo brings N back with its record, cell, rank and Bob's status. No command throws after writing; joining the hidden row throws before writing. Outline and notice agree, and restoring from the notice works | Stores nothing. Read and keystroke times within the spread between passes; a split and its undo about 0.6 ms slower; the re-reading cost during editing not measured. About 20 lines and a 4-line hook | The hidden marker stays in the text: later typing after it moves into N on Alice's redo, and cutting B takes it. A split inside that text lands right after the beat's own marker. It moves no generated figure |
| U, an undo filter that keeps created records and cells | 0 of 90. Bob's undo wins: N comes back whole with his status and visual text, and all 16 commands work. It also removes E16's one remaining record loss | About 31 bytes kept per undone creation (30.6 per split, 30.8 per insert), for good. About 7 lines | N has no rank and follows rule (e): an unrelated move gives it one, cutting B can carry it across a scene line, and restoring from the notice throws until it has one. The filter refuses to delete any record or visual cell in the root maps, on undo and redo, whichever command made it, so a redo no longer deletes containers a command deleted directly. A remote creation undo no longer reaches the beat-map observer |

**Where rule (g) shows the narration.** As if the marker were absent: into the row above; at a segment's start,
into that segment's first beat, else the beat before, else the next; after a heading, into the beat after it, the
name unchanged; with no beat, the narration-only row. **The seam:** B shows its own text, then the hidden text.
Typing at the seam (the offset where B's own text ends; 0 when B has none) lands before the hidden marker and stays in B on a redo;
typing inside or after the hidden text moves into N on a redo, and cutting B takes it (E17, pinned by the test "where the seam sits" in [`prototypes/collab/test/native-row-record/review.test.ts`](https://github.com/RetroGorilla/splitpage/blob/5b9b2b141/prototypes/collab/test/native-row-record/review.test.ts)). **Refreshing** keeps the parsed narration of unchanged segments and recomputes which rows
own the affected text. The marker's own segment alone is too narrow: a hidden marker at a segment's start moves its
narration to a beat in another segment.

**Other routes.** Creating the record and cell in an untracked transaction nested inside the command does not work:
Yjs keeps the outer origin. A separate, outer, untracked transaction run before the tracked one does work (E17's
review): undo removes the marker and rank and keeps the record. Its cost is a second transaction, with its own
moment when other copies can see it and its own way to fail half-done. It was not wired into the commands, and R
and U together were not tried.

None of the options changes the segment-head race, the doubled narration of a double delete and double undo, or
rule (e)'s placement. The owner chose R. Per E17, it writes and stores nothing, it is the one option under which
outline, notice and restore-from-notice all work on the four-step state. Its cost: Bob's undo brings back N's
narration, shown in B, but not N as a row.

The outside review of this note measured remote apply through the prototype's reader on the 900-beat fixture: a
split 4.6 to 5.2 ms as built against 5.0 to 5.35 ms with the rule; a creation undo or redo 4.6 to 5.0 against 4.9 to
5.3; a keystroke about 0.75 ms in both. These are the reviewer's own uncommitted measurements, not an experiment
result, and they include a full reparse: the prototype's hook clears every segment's parsed text. The design keeps
parsed narration for unchanged segments instead (section 7). Open: whether the older `views` cache in
`src/native/variant.ts` reads records and needs the same split.

### O. Acceptance cases from the outside review

Requirements from the outside review of this note, added to the build order (section 11).

**Slice 3.**
- E17's 16-command table on the four-step state: every command aimed at the hidden row returns a refusal and leaves
  the document snapshot unchanged. Commands on the row above succeed on the shown narration: typing at the seam and at
  the end, cut, move, join and unjoin, a heading above. "Move the run B through N" refuses or moves B alone.
- A split's timing through the reader on the 900-beat script with warm caches, including one case at a segment's
  start, with a parse counter showing no unrelated segment was reparsed, so a full rebuild that happens to meet the
  time does not pass.

**Slice 6.** The same timing for a creation's undo and redo, and the outline before and after Bob's undo in section
10's four-step history.

**Slice 7.**
- **First loads** (decision 16): the [relay tests](../../tests/adapters/collab/native/relay.test.ts) pin one restart
  after the stock receive wait and the message after the second timed-out attempt. The speed figures and large
  offline return under stock timers in appendix I are from E13.
- **Two writers past the size limit:** two offline copies, each under 15 MB, whose merge exceeds it. The test shows
  where the refusal happens, what each person sees, how refused work is exported, and that retries stop. The plan
  also requires bounds on total document state checked before an update reaches other clients, explicit handling of legitimate concurrent
  limit conflicts, never discarding an update while claiming synchronization succeeded, preserving recoverable data,
  and a test where individually valid edits merge past the limit ("Validation and resource limits"). The relay
  checks size at connection admission and the session can refuse the next local write after crossing a measured
  line. The combined offline-writer case and its export and retry outcomes remain open.
- **Server stops** (decision 19): the [six-row stop table](#server-stop-results-and-backup-runbook) covers clean
  and killed stops before, during and after the store. The plan's receipt checker and kill-before-and-after-receipt
  tests are deferred with the update journal.
- **Stale targets in the editor.** The [stale-target tests](../../src/test/shared-native-stale-target-app.test.mjs)
  cover buffered narration and narration and Visual composition in Split and Writer after a peer removes, replaces,
  restores, or hides the target. They start composition in a visible N and commit after the four-step history hides
  N under rule (g). A restored beat accepts the text in its live cell. A missing target leaves the shared state
  untouched by the draft, keeps the preview visible, and stops input with a refusal. Writer close preserves a
  stopped draft on screen. Plain Visual typing settles in the input event, and the tests cover stale paint across
  the same four peer changes. The target-state matrix is covered for the input routes that can remain pending.
  After a completed composition is refused because its beat is missing, restoring the beat does not retry
  the write. Explicit Leave retries once if the retained range still resolves to the original offsets in
  the same beat and field, the field content matches the original paint, and any selected units still
  have their original identities. A successful write lands the complete document under a fresh ID.
  An unavailable or ambiguous target keeps its local preview and the session open. Further Leave attempts
  report the refusal and emit no writes while the range remains invalid.
