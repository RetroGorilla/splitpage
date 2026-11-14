# Writer visual box in a shared session

Owner rule 86 on #1414 allows the Writer visual box to edit shared visual text. This cut supplies its feature port and wiring factory; C6 installs that port when starting a shared Writer.

## Existing standalone path

`src/features/writer/flow-visual-box.ts` owns a floating contenteditable surface. `flow-writer.ts` supplies its save and shortcut callbacks. At a collapsed narration caret, each native input commits the entire visual through `wholeFieldText.commit`; composition waits until compositionend. For a narration selection, the first save runs `visual-selection` / `setVisualForRange`, isolating the selection into its own beat; later input uses whole-field commits. Standalone callbacks can create records from visual shortcuts.

The standalone input, key, paste and composition handlers are retained. The factory selects the shared wrapper once at construction; standalone keys execute no added check, read, allocation, buffer construction or operation preparation. The production cost literal pins 12 row reads and five decodes for a visual key at both 2 and 200 rows, with no shared field, painted record or cell buffer constructed.

## Shared binding

`writerVisualBuffer` mounts the existing `mountCellBuffer` through its named ports. It uses the same `sharedBufferPorts`, `createBufferedField`, painted-base record and native target evidence as the Split visual column. M1 holds remote ingress during native input and composition. The existing selection model resolves visual character identities during idle repaint. Commit-time caret restoration stays with the existing buffered binding.

The shared wrapper suppresses standalone whole-field synchronization and the visual input, leave and shortcut callbacks. B-roll lines, `@Name` and `SFX:` stay ordinary text and create no records. The first input over a narration selection holds its narration base until `visual-selection` commits, then binds the newly resolved beat's visual. The adapter records that fresh visual's text provenance under its resolved owner, so an operation following a split in the same list can find it.

Hidden visual cells have an inactive field and cannot participate in command admission. Close, opening another visual, Writer settlement and disposal respect an unfinished visual buffer. An unsuccessful settlement leaves the mounted surface available for its eventual input/compositionend.

## Refusals and limits

- A beat without a visual record refuses `buffer-no-visual` and writes nothing.
- A joined row's combined visual has no single painted base; input calls `missingBase` with its visual field key and writes nothing, retaining rule 93 and the Split binding's existing behavior.
- Pending input and composition keep their existing `buffer-pending` and `buffer-composition` refusals. Unsupported native inputs retain the Split binding's `buffer-unsupported-input` and `buffer-native-target` refusals; this cut adds no input handler to that binding.
- Selection commands use #1560's existing flow operation form. This cut changes no undo builder, shared start or session-entry path.

## C6 call contract

When composing a shared Writer, construct `shared = sharedBufferPorts(handle, session, effects)` once, then set `FlowWriterPorts.visualBuffer` to `writerVisualBuffer(shared, { document, lifetime: session, decode, storedHtml, shown })`. `document` reads that session's current projected document; `decode` is its rich-text reader; `storedHtml` is its existing stored-cell conversion; `shown` is the Writer's paint guard. Pass that same `shared` object as the Writer's narration buffered/painted ports, along with `writerFlowCommands` for selection commands. The Writer mounts and disposes the popup binding itself. The running app does not call this factory in this cut.

## Evidence

The feature literals compare complete projected documents on both live copies and a fresh handle loaded from encoded state. They cover typing, deletion, whole replacement, plain record-looking multiline text, selection isolation followed by typing, idle caret remapping, close/reopen, hidden-cell admission, missing visuals and joined visuals. Duplicate and reversed delivery cover two Writer visual boxes, the Split column, another writer's insertion and beat removal. A seeded history runs all three native command kinds with three writers, duplicate/reordered delivery and an encoded late joiner; no convergence exceptions are declared.

The C2 undo seam is exercised with the real shared undo owner: two visual keys form one typing group, undo keeps another copy's insertion in that visual, and redo restores the local text. Each checkpoint compares both live copies and an encoded late joiner, including the retained beat stamp.

## For later cuts

`sharedPeopleIntroducedByText` still takes a caller-supplied id, so a typed `@Pat` and a pasted Pat created at the same moment would not meet in one record until the cut that wires that builder uses the same name-derived id; this remains with the lane that owns that builder.
