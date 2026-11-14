export const builderOperationCoverage = [
  ["beatStatusCommand", "field-record", "status"],
  ["setBeatFilmedCommand", "field-record", "status"],
  ["beatLengthCommand", "field-record", "scalar"],
  ["addCommentCommand", "field-record", "record-create"],
  ["addReplyCommand", "field-record", "record-create,record-set"],
  ["setCommentAssigneeCommand", "field-record", "record-set"],
  ["toggleResolveCommand", "field-record", "record-set"],
  ["galleryCommand", "field-record", "record-create,record-set,record-delete"],
  ["registerTagCommand", "field-record", "record-create"],
  ["addPersonCommand", "field-record", "record-create"],
  ["deletePersonCommand", "field-record", "record-delete,record-set"],
  ["updateTagsCommand", "field-record", "record-create,record-set,status"],
  ["gearQuickAddCommand", "field-record", "record-create,record-delete"],
  ["addShotCommand", "field-record", "record-create"],
  ["setShotsCommand", "field-record", "record-create,record-set,status"],
  ["deleteShotCommand", "field-record", "record-delete"],
  ["addShotPropCommand", "field-record", "record-create,record-set"],
  ["removeShotPropCommand", "field-record", "record-set"],
  ["targetLengthCommand", "field-record", "scalar"],
  ["wordsPerMinuteCommand", "field-record", "scalar"],
  ["editStamp", "field-record", "scalar"],
  ["documentIdStamp", "field-record", "scalar"],
  ["initializeFlowParagraphs", "field-record", "scalar"],
  ["titleCommand", "field-record", "whole-field today, needs package 9"],
  ["fileTitleCommand", "field-record", "text-insert,text-delete,scalar"],
  ["renameSceneCommand", "field-record", "whole-field today, needs package 9"],
  ["cellTextCommand", "text-mark", "record-create | whole-field today, needs package 9", [
    ["whole-field native runs / comment-anchor-only capability exception", ["whole-field today, needs package 9"]],
    ["new tag/shot records", ["record-create"]],
    ["missing row/unchanged/capability refusal", []]
  ]],
  ["pasteCommand", "text-mark", "text-insert,text-delete,record-create,record-set", [
    ["text/runs appended with insertion attributes, visual cue/direction flattening", ["text-insert"]],
    ["replace selected observed content", ["text-delete", "text-insert"]],
    ["fresh b-roll records / new gallery picture, video or file", ["record-create"]],
    ["fill an existing gallery slot or update its links", ["record-set"]],
    ["cut comment anchors already carried by inserted runs", []],
    ["missing row/no-op", []]
  ]],
  ["cutCommand", "text-mark", "text-delete", [
    ["clamped observed range", ["text-delete"]],
    ["surviving mark normalization is a projection rule", []],
    ["empty range/missing row/no-op", []]
  ]],
  ["rewriteCellsCommand", "text-mark", "text-insert,text-delete,mark", [
    ["planner replaces cell text", ["text-insert", "text-delete"]],
    ["planner changes marks on observed content", ["mark"]],
    ["stamped/unstamped and capability options do not add text intent", []],
    ["unchanged/missing-row filtering", []]
  ]],
  ["tagCellsCommand", "text-mark", "text-insert,text-delete,mark,record-create", [
    ["planner replaces cell text", ["text-insert", "text-delete"]],
    ["planner changes observed tags/marks, including null-tag unlabel", ["mark"]],
    ["register alongside rewrites or register alone", ["record-create"]],
    ["no-op trial", []]
  ]],
  ["retagCommand", "text-mark", "text-insert,text-delete,mark,record-set,record-delete,status", [
    ["planner replaces cell text", ["text-insert", "text-delete"]],
    ["planner renames marks or null name unlabels them", ["mark"]],
    ["rename registry fields / merge owner and notes / repoint shot props", ["record-set"]],
    ["collision removes the old registry record", ["record-delete"]],
    ["collision raises the surviving tag status", ["status"]],
    ["no-op trial", []]
  ]],
  ["deleteTagsCommand", "text-mark", "text-insert,text-delete,mark,record-delete", [
    ["planner replaces cell text", ["text-insert", "text-delete"]],
    ["planner unlabels observed content", ["mark"]],
    ["registry removal with or without rewrites", ["record-delete"]],
    ["missing tags/no-op trial", []]
  ]],
  ["deleteCommentCommand", "text-mark", "text-insert,text-delete,mark,record-delete", [
    ["planner replaces cell text", ["text-insert", "text-delete"]],
    ["planner unwraps observed comment marks", ["mark"]],
    ["comment/reply record deletion", ["record-delete"]],
    ["missing comment/no rewrites", []]
  ]],
  ["unwrapCommentAnchorCommand", "text-mark", "text-insert,text-delete,mark", [
    ["planner replaces cell text", ["text-insert", "text-delete"]],
    ["planner unwraps observed comment marks", ["mark"]],
    ["record retained / unstamped capability exception / no rewrites", []]
  ]],
  ["restoreConflictCommand", "text-mark", "text-insert,text-delete,mark,scalar,record-create,record-set,record-delete", [
    ["title or cell text replacement", ["text-insert", "text-delete"]],
    ["cell value restores different marks on observed words", ["mark"]],
    ["image replacement creates or changes a gallery record", ["record-create", "record-set"]],
    ["image replacement clears the legacy visualImage field", ["scalar"]],
    ["conflict comment deletion", ["record-delete"]],
    ["missing comment/row", []]
  ]],
  ["addBeatCommand", "structure", "segment-create", [
    ["append or insert after existing beat, with initial defaults", ["segment-create"]],
    ["missing predecessor", []]
  ]],
  ["deleteBeatCommand", "structure", "remove,scalar", [
    ["observed beat removal", ["remove"]],
    ["surviving paragraph flags", ["scalar"]],
    ["scene first-beat derivation / empty-scene recovery / missing beat", []]
  ]],
  ["moveBeatCommand", "structure", "segment-move,scalar | move-in-shared-session", [
    ["before versus after", ["segment-move"]],
    ["destination membership and source paragraph repair", ["scalar"]],
    ["source occupies part of segment", ["move-in-shared-session"]],
    ["unchanged order with changed scene", ["scalar"]],
    ["missing/self/no-op", []]
  ]],
  ["swapBeatsCommand", "structure", "segment-move,scalar | move-in-shared-session", [
    ["previous/next delegates whole-beat movement", ["segment-move"]],
    ["delegated paragraph repair", ["scalar"]],
    ["source occupies part of segment", ["move-in-shared-session"]],
    ["edge/missing beat", []]
  ]],
  ["splitBeatCommand", "structure", "text-delete,split,segment-create,record-create", [
    ["narration split", ["split"]],
    ["visual component split with a new empty narration segment", ["split", "segment-create", "record-create"]],
    ["delete selected observed span before splitting", ["text-delete"]],
    ["initial beat defaults belong to creation / unsupported field/missing row", []]
  ]],
  ["joinBeatsCommand", "structure", "join", [
    ["join narration with glue and retained visual/gallery origins", ["join"]],
    ["status rank derives from the join group", []],
    ["missing next/header/gallery-limit guards", []]
  ]],
  ["pasteBeatsCommand", "structure", "segment-create,text-insert,text-delete,remove,restore,segment-move,heading-create,record-create,record-set,scalar | move-in-shared-session,cross-scene-structural-paste", [
    ["append/insert copied beats, including prefix/trailing blanks", ["segment-create", "text-insert"]],
    ["replace blank beat", ["remove"]],
    ["carries scene header", ["heading-create", "text-insert"]],
    ["repair surviving paragraph flags and existing header anchors", ["scalar"]],
    ["adopt a title", ["text-delete", "text-insert"]],
    ["copy comments, replies, registries and media", ["record-create"]],
    ["restore cut ids and place their segments", ["restore", "segment-move"]],
    ["restore an existing cut comment's fallback row", ["record-set"]],
    ["partial-source/cross-scene structural cut-paste", ["move-in-shared-session", "cross-scene-structural-paste"]],
    ["null/empty plan or incomplete apply", []]
  ]],
  ["removeBeatsCommand", "structure", "remove,scalar | cross-scene-structural-paste", [
    ["observed distinct existing beats", ["remove"]],
    ["surviving paragraph repair", ["scalar"]],
    ["cross-scene structural cut", ["cross-scene-structural-paste"]],
    ["scene-anchor derivation / empty-scene recovery / missing/duplicate/no-op ids", []]
  ]],
  ["addSceneCommand", "structure", "heading-create,text-insert", [
    ["new header with first-beat membership carried by creation", ["heading-create"]],
    ["initial heading name", ["text-insert"]],
    ["empty/overlong name and invalid/duplicate id guards", []]
  ]],
  ["removeSceneCommand", "structure", "heading-remove,scalar", [
    ["discard observed header without demotion", ["heading-remove"]],
    ["first beat paragraph flag", ["scalar"]],
    ["missing header", []]
  ]],
  ["moveSceneCommand", "structure", "segment-move | move-in-shared-session", [
    ["before/after whole scene, moving its header with beat segments", ["segment-move"]],
    ["scene cuts through a segment", ["move-in-shared-session"]],
    ["derived scene order / missing/self/unchanged guards", []]
  ]],
  ["importRowsCommand", "structure", "segment-create,text-insert,remove,heading-remove,record-create", [
    ["append imported narration with initial defaults", ["segment-create", "text-insert"]],
    ["import nonempty visual/gallery components", ["record-create", "text-insert"]],
    ["replace all observed rows", ["remove"]],
    ["replace clears scene headers", ["heading-remove"]],
    ["initial fields omit paragraph flags; scanner anchors new b-roll atoms before insertion", []],
    ["empty import", []]
  ]],
  ["standaloneFlowCommand", "structure", "text-insert,text-delete,mark,segment-create,split,split-before,join,remove,restore,segment-move,heading-create,heading-finalize,heading-remove,record-create,record-set,scalar | move-in-shared-session,cross-scene-structural-paste", [
    ["standalone typing and range-replacement policy", ["text-insert", "text-delete", "segment-create", "remove", "heading-remove"]],
    ["standalone mark and inline-markdown policy", ["mark"]],
    ["standalone ordinary and prefix-isolation split policy", ["split", "split-before"]],
    ["standalone join policy", ["join"]],
    ["standalone structural clipboard and record policy", ["restore", "segment-move", "heading-create", "record-create", "record-set"]],
    ["standalone heading finalization policy", ["heading-finalize"]],
    ["standalone paragraph and retained-record fields", ["scalar"]],
    ["shared classification of partial-source/cross-scene clipboard policy", ["move-in-shared-session", "cross-scene-structural-paste"]],
    ["standalone application only; no shared plan, optional selection, null/caret-only/refused/no-change", []]
  ]],
  ["flowCommand", "structure", "text-insert,text-delete,mark,segment-create,split,split-before,join,remove,restore,segment-move,heading-create,heading-finalize,heading-remove,record-create,record-set,scalar | move-in-shared-session,cross-scene-structural-paste", [
    ["typing and arbitrary range-replacement outcomes", ["text-insert", "text-delete", "segment-create", "remove", "heading-remove"]],
    ["observed mark and inline-markdown outcomes", ["mark"]],
    ["ordinary and prefix-isolation split outcomes", ["split", "split-before"]],
    ["joinWithPrevious outcomes", ["join"]],
    ["structural clipboard restore/move/header and record outcomes", ["restore", "segment-move", "heading-create", "record-create", "record-set"]],
    ["heading finalization outcomes", ["heading-finalize"]],
    ["paragraph/retained-record field edits", ["scalar"]],
    ["partial-source/cross-scene structural clipboard guards", ["move-in-shared-session", "cross-scene-structural-paste"]],
    ["removed comment words stay in recovery / optional selection / null/caret-only/refused/no-change", []]
  ]]
] as const;

export const flowOperationCoverage = [
  ["typeWithMarks", "known", "text-insert", [
    ["insert text with explicit attributes", ["text-insert"]],
    ["normalized-empty typing still serializes its touched cell", ["text-insert"]],
    ["non-beat/missing row", []]
  ]],
  ["replaceRange", "known", "text-insert,text-delete,segment-create,remove,heading-remove,scalar", [
    ["partial beat or heading edits", ["text-insert", "text-delete"]],
    ["whole observed beats", ["remove"]],
    ["removeWholeStart creates a fresh replacement id", ["segment-create", "text-insert"]],
    ["heading becomes empty", ["heading-remove"]],
    ["surviving paragraph flags", ["scalar"]],
    ["orphan heading or empty script needs a blank beat", ["segment-create"]],
    ["empty endpoint excluded / heading length guard / derived scene anchors", []]
  ]],
  ["setMarkAcross", "known", "mark,scalar", [
    ["set mixed or clear all-on observed per-beat ranges", ["mark"]],
    ["a no-effect identity-mark attempt can canonicalize the touched HTML", ["scalar"]],
    ["empty/heading-only range", []]
  ]],
  ["enterAt", "known", "text-delete,segment-create,remove,split,heading-remove,scalar", [
    ["selection clears observed characters", ["text-delete"]],
    ["selection drops whole beats or headings", ["remove", "heading-remove"]],
    ["clearing repairs an orphan/empty script or caret inserts a blank", ["segment-create"]],
    ["caret in the middle of a beat", ["split"]],
    ["paragraph flag changes and surviving heading anchor repairs", ["scalar"]],
    ["second Enter removes an empty separator", ["remove"]],
    ["non-beat/missing/no-op", []]
  ]],
  ["startParagraph", "known", "split,segment-create,scalar", [
    ["end flags an existing successor; start flags current beat; blank-before reanchors a heading", ["scalar"]],
    ["new blank before or after", ["segment-create"]],
    ["middle split", ["split"]],
    ["derived scene anchor / empty/non-beat/missing guards", []]
  ]],
  ["lineBreakAt", "known", "text-insert,text-delete,segment-create,remove,heading-remove,scalar", [
    ["collapsed inserts a line break with insertion attributes", ["text-insert"]],
    ["selection replaces observed characters", ["text-delete", "text-insert"]],
    ["selection drops whole beats/headings", ["remove", "heading-remove"]],
    ["selection repairs an orphan heading/empty script", ["segment-create"]],
    ["selection changes surviving paragraph flags and heading anchors", ["scalar"]],
    ["non-beat/missing row", []]
  ]],
  ["backspaceAt", "known", "text-delete,join,heading-remove,remove,scalar", [
    ["heading start demotes its name or drops an empty header", ["heading-remove"]],
    ["blank current/previous beat removal", ["remove"]],
    ["paragraph flag clear or repair after removal and surviving heading anchor repairs", ["scalar"]],
    ["tick join option", ["join"]],
    ["tick delete option removes previous last character", ["text-delete"]],
    ["scene boundary / previous visual / offset/first/missing guards", []]
  ]],
  ["deleteForwardAt", "known", "text-delete,remove,scalar", [
    ["blank current/next beat removal", ["remove"]],
    ["next paragraph flag clear or repair after removal and surviving heading anchor repairs", ["scalar"]],
    ["delete next first character", ["text-delete"]],
    ["heading/scene/visual-only successor caret-only; not at end/last/missing guards", []]
  ]],
  ["joinWithPrevious", "known", "join", [
    ["join narration/glue and retain visual/gallery origins", ["join"]],
    ["derived gallery folding/status rank; first/missing/header/gallery-limit guards", []]
  ]],
  ["renameHeading", "lost", "whole-field today, needs package 9", [
    ["whole native heading name", ["whole-field today, needs package 9"]],
    ["empty/length guards or selection only", []]
  ]],
  ["enterInHeading", "known", "split,segment-create,scalar", [
    ["offset zero creates a blank before", ["segment-create"]],
    ["middle heading tail becomes a beat", ["split"]],
    ["existing first beat gains a paragraph flag and heading tail split reanchors the header", ["scalar"]],
    ["derived first-beat anchor / end caret-only / non-heading/missing scene", []]
  ]],
  ["finalizeHeading", "known", "text-delete,heading-finalize,remove,segment-create,scalar", [
    ["empty/tagged/commented/run-on/overlong name removes marker only", ["text-delete"]],
    ["convert name and retain narration tail or visual", ["heading-finalize"]],
    ["name-only source beat is softly removed", ["remove"]],
    ["no reusable follower or existing header needs a separate blank anchor", ["segment-create"]],
    ["existing retained beat/follower paragraph flag changes and pre-existing heading anchor repairs", ["scalar"]],
    ["missing/not-pending guard", []]
  ]],
  ["inlineMarkdown", "surface", "text-delete,mark", [
    ["delete observed bold/strike/italic delimiters", ["text-delete"]],
    ["format the observed words between them", ["mark"]],
    ["protected tags/atoms, line boundaries, invalid markers, live-cell recheck and pending mark", []]
  ]],
  ["removeEmptyHeading", "known", "heading-remove,scalar", [
    ["delete the full heading range", ["heading-remove"]],
    ["protect the first surviving paragraph", ["scalar"]],
    ["above/below/kept selection or missing heading", []]
  ]],
  ["pasteText", "known", "text-insert,text-delete,segment-create,split,remove,heading-remove,scalar", [
    ["first paragraph replaces arbitrary selected characters", ["text-insert", "text-delete"]],
    ["selection drops whole beats/headings", ["remove", "heading-remove"]],
    ["selection repairs orphan/empty script; later heading paragraph inserts a blank", ["segment-create"]],
    ["later beat paragraphs split, including at edges", ["split"]],
    ["surviving paragraph flags", ["scalar"]],
    ["empty paragraph or existing refusal", []]
  ]],
  ["pasteFlowRange", "known", "text-insert,text-delete,segment-create,split,remove,heading-create,heading-remove,record-create,scalar", [
    ["plain text fallback / replace selected characters", ["text-insert", "text-delete"]],
    ["selected whole beats/headings or generated placeholder removed", ["remove", "heading-remove"]],
    ["supplied row ids or header-only/trailing/colliding-anchor blanks", ["segment-create", "text-insert"]],
    ["insert into the middle of a beat or heading", ["split"]],
    ["carried headers", ["heading-create", "text-insert"]],
    ["initial visual/gallery components; comment/tag/link anchors ride inserted text", ["record-create"]],
    ["surviving paragraph flags and existing header anchor repair", ["scalar"]],
    ["registry copying and structural cut restoration belong to the clipboard caller", []]
  ]],
  ["replaceFlowMatches", "known", "text-insert,text-delete,heading-remove,scalar", [
    ["replace visual or single/multiple-beat search matches, keeping rows", ["text-insert", "text-delete"]],
    ["replace a search match inside one heading with an empty name", ["heading-remove"]],
    ["empty heading protects its first surviving paragraph", ["scalar"]],
    ["reverse match order / missing visual/no matches/refusal", []]
  ]],
  ["setVisualForRange", "known", "split,split-before,text-insert,scalar,record-create,record-set | whole-field today, needs package 9", [
    ["suffix/interior isolation", ["split"]],
    ["prefix isolation retains the original beat on the suffix", ["split-before"]],
    ["isolation changes retained paragraph flags", ["scalar"]],
    ["independently clamped slices can duplicate a surrogate pair at an interior endpoint", ["text-insert"]],
    ["new visual component", ["record-create"]],
    ["whole visual HTML on collapsed, whole-beat or isolated selection", ["record-set", "whole-field today, needs package 9"]],
    ["cross-beat/non-beat guards", []]
  ]],
  ["sentenceParagraphs", "known", "scalar", [
    ["sentence-ending predecessor starts a paragraph", ["scalar"]],
    ["already has flags / first beat / existing scene boundary", []]
  ]],
  ["selectionToOwnBeat", "known", "split,split-before,text-insert,scalar", [
    ["suffix or interior isolation", ["split"]],
    ["prefix gets a fresh beat while original id/visual keep the suffix", ["split-before"]],
    ["retained original suffix loses its paragraph flag", ["scalar"]],
    ["independently clamped slices can duplicate a surrogate pair at an interior endpoint", ["text-insert"]],
    ["whole beat unchanged / derived scene anchor / collapsed/cross-beat/non-beat/missing guards", []]
  ]],
  ["insertBeats", "known", "text-insert,segment-create,split,record-create,scalar", [
    ["inserted fresh rows and their narration", ["segment-create", "text-insert"]],
    ["inserted nonempty visual/gallery components", ["record-create", "text-insert"]],
    ["middle of destination beat or heading", ["split"]],
    ["retained row paragraph flags at insertion boundaries", ["scalar"]],
    ["before/after/empty affinity and derived anchors; empty/duplicate/missing guards", []]
  ]],
  ["startBeat", "known-unused", "split,segment-create", [
    ["middle split", ["split"]],
    ["end creates a blank", ["segment-create"]],
    ["start/empty/non-beat/missing guards", []]
  ]],
  ["moveBeats", "known-unused", "segment-move,split,scalar,heading-remove | move-in-shared-session", [
    ["move whole source segments before/after destination", ["segment-move"]],
    ["middle of destination beat or heading", ["split"]],
    ["retained source/follower/destination flags and moved-row normalization", ["scalar"]],
    ["source scene loses its last anchor", ["heading-remove"]],
    ["source occupies part of segment", ["move-in-shared-session"]],
    ["empty-beat affinity / derived anchors / missing/self/nonconsecutive guards", []]
  ]],
  ["replaceAll", "known-unused", "text-insert,text-delete,heading-remove,scalar", [
    ["replace narration matches, keeping all rows including emptied ones", ["text-insert", "text-delete"]],
    ["replace a match inside one heading with an empty name", ["heading-remove"]],
    ["empty heading protects its first surviving paragraph", ["scalar"]],
    ["reverse matches / no matches/refusal", []]
  ]]
] as const;

export const sharedRefusalCoverage = [
  { refusal: "move-in-shared-session", source: "8-schema-hypotheses.md §1 Candidate B: Move part of a segment; structure-results.md MOVE concurrent; issue #1414 assumed rule 40: every move" },
  { refusal: "cross-scene-structural-paste", source: "8-schema-hypotheses.md §3 MOVE cut-paste; structure-results.md MOVE cut-paste" }
] as const;
