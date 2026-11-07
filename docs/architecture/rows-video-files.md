# Session video files after the rows extraction

The former `06-rows.js` module is retired. Its remaining video-file responsibilities live in `src/features/gallery/video-files.ts`, with the shared `VideoFiles` contract in `src/application/media/video-files.ts`. The existing beat operations, beat media, row routing and row editing already have their own owners.

## Ownership and wiring

Bootstrap creates the video-file owner explicitly through `mountVideoFilesFeature()` at the old `init_06_rows()` position, after gallery mounting and before beat mounting. Importing the feature, contract or wiring starts no owner and registers no listener. The forwarding `videoFiles` port follows the current owner and throws before mounting or after stopping. There is no compatibility export from the retired numbered file and no new legacy bridge.

The owner receives the existing document reader, notices, desktop-video and external-link ports. It imports only core helpers for row lookup, link normalization, keys and URL safety. Editor/media wiring grants dropped or pasted files through `videoFiles.grant`; the gallery overlay reads `has` and `url`; picture-link actions receive `openGallery` explicitly instead of importing a numbered module.

| Former export | Owner operation |
| --- | --- |
| `grantVideoFile` | `grant` |
| `hasSessionVideo` | `has` |
| `sessionVideoUrl` | `url` |
| `releaseSessionVideoUrls` | `releaseUrls` |
| `openVideoFile` | `openFile` |
| `openGalleryLink` | `openGallery` |

## Lifetimes and preserved behavior

File grants and opaque desktop tokens last for the page owner's lifetime, across document replacement and application-session rewiring. Replacing a document revokes cached object URLs but keeps the grants, preserving the existing lifecycle tests. URLs are created lazily; granting the same file keeps its URL, and replacing that file revokes its old URL.

The new explicit owner's disposal unsubscribes its document listener, releases cached URLs and file/token references, and prevents delayed grant/open completions from operating on a disposed owner. Remounting builds a separate owner; disposing the old instance cannot change its replacement. Normal opening, warnings, capability checks, token forwarding and HTTP(S)-only browser links are preserved. Tokens are never added to document data or exports.

## Stored paths (#259)

A video file dropped in the desktop app keeps its path on its link, so it opens again after a restart. The path comes from the preload's `webUtils.getPathForFile` (`videoFilePath` on the bridge, `pathOf` on `DesktopVideo`), and `readClipboardFiles` puts it on the attachment. The link stores it as `location: { kind: "path", path }`; the browser build has no path and stores none. The other kind, `bundled`, is described in the next section.

Opening a file link tries this session's token first, then the stored path through `openPath` (`splitpage:video-path-open`). A drop grants its file under the link's name and size and, when it has a path, under that path too (`locatedVideoKey`). A link with a path only uses a token, file or preview granted from that same path, so another script's same-named file elsewhere, or a link put back to an older path by undo, opens from its own stored path. A link without a path keeps matching by name and size, as before. A script is untrusted input, so main checks the path itself before anything touches the disk, with `videoPathProblem` in `shared/video-path.ts`: a local drive path on Windows or an absolute path elsewhere, no UNC or device path, no `.` or `..` part, no character or name Windows would reinterpret, and a video extension from the same allowlist as a grant. `openableVideoPath` in `shared/video-embed.ts` then resolves links with `realpath`, checks the extension again on the real path, and requires a regular file. A file that is gone answers `GONE`, which gives the existing "no longer where it was" notice; anything refused answers `REFUSED`, which gives the existing "Could not open" notice.

The core normalizer keeps a location only on a file link and only when it is a valid path in either style, so a script moved between Windows and macOS keeps it. The location is not part of a link's identity (`videoLinkKey`): dropping the same file again records its new path on the link it already has, together with that drop's first frame and length when it could read them, in one edit. The gallery's player is identified by the link and its path (`locatedVideoKey`), so a change of path, such as an undo, replaces a playing video with the still. It is part of the gallery fields' equality key, so a change of location alone is merged and undone like any other gallery change. SplitShare drops every location; the other exports never wrote a link's fields beyond its name.

## Copies beside the script (#259)

When a video with a path is dropped or pasted onto a beat of a script saved on disk in the desktop app, `src/features/gallery/video-bundles.ts` asks whether to copy it into the script's folder; Copy it is the default button. The folder is `<script name without its extension> files` beside the script (the name rules, `bundledNameProblem` and `bundleFolderName`, are in `shared/video-path.ts`, which core can import; the disk rules, `bundleFolderOf` and `resolveBundledFile`, are in `shared/video-embed.ts` beside `openableVideoPath`, which main already loads; both take the allowed extensions as an argument where they check one, so they hold for any file type). A copied link stores `location: { kind: "bundled", name }`, a single file name in that folder, so the script and its folder can move together. Declining, an unsaved script, the browser build, or a failed copy keeps `{ kind: "path" }`, with a notice when the copy failed or was stopped. Photos are not asked about.

The copy runs in main (`desktop/bundle-copy.ts`) as a stream, with progress on `splitpage:bundle-progress` and Cancel on `splitpage:bundle-cancel`; the page stays usable. Main owns the queue (`desktop/bundle-jobs.ts`): accepting the prompt sends every copy at once, and main runs them one at a time. The renderer never names a file to copy or a folder to copy into. `splitpage:bundle-file` takes the drop's grant token (#1250) and copies only that file: main resolves it with `realpath` and checks the extension again on the real file, so a granted name that is a link to something else is refused, and it copies only into the bundle folder of the script the tab had when the copy was accepted. A queued copy is never pointed at another script later: if the tab has opened an unrelated script by the time it starts, main drops it (`DROPPED`, no notice) and the link keeps its path. A name already in the folder gets a number, `take (2).mp4`; a file there is reused only when its size and, compared as a stream, its bytes match, and nothing is overwritten. Cancel stops every copy of that tab's drops and a carry it is showing. A partial copy is removed. Jobs are keyed by the sender, so one tab cannot cancel another's. When the copy lands, the link change folds into the drop's own undo entry when that is still the last one, so one undo removes the drop; otherwise it is its own gallery edit. Undo never deletes the copied file.

`splitpage:bundled-file-open` takes a name, and main resolves it with `resolveBundledFile`: the name rules (no separator, `..`, drive, stream, control character, reserved device name or trailing dot), the video allowlist, a bundle folder that is a real directory rather than a link or junction, a `realpath` whose folder is that bundle folder, and a regular file. Anything else is `REFUSED` or `GONE`, as for a stored path. The core normalizer keeps a bundled location only when its name passes the same rules.

Save As and Save a copy carry the copies along, and main does it without the renderer. The script save dialog asks with `script: true`; main notes the tab and its script when the dialog is answered, and when that file's first write lands it queues a carry of the old script's folder into the new one's, and adds the new script to every copy of that tab still bound to the old one, so a copy still running is copied on into the new folder under a name valid there. The carry runs even if the tab or its renderer is gone, and reports on `splitpage:bundle-carry` with folder names and counts only. Exports, other dialogs, file ids no script dialog chose, and later writes to the same file start nothing. A file already at the destination with the same bytes is kept, a different one is never overwritten, and a name that cannot be copied is counted in a notice that names the old folder. The links stay bundled, so a copy that did not land opens as `GONE` from the new script.

The renderer relinks only when main's answer arrives and the drop's document is still owned. Save As moves ownership, so `file-saving.ts` asks the gallery for a handover (`beginMove`) just before it retargets; answers that arrive meanwhile wait. When the write lands and the job still owns the document, `landed` hands those copies the new owner and folder name and applies what waited; a failed or cancelled save, or a replacement while it writes, calls `abandoned`, and only answers whose old owner still holds apply. An unrelated document never takes the handover.

The `open-picture-link` action retains its ID, registration position, availability and input validation. The build entry stays `_entry.js`; only its retired initializer is replaced by the explicit feature mount.

## Verification

The first commit adds six characterization tests that passed on base `9b3df215ba72e1a6576d21ad98132e3da0f8d218` before production code moved. They retain the old URL-cache, retained-grant, warning, token and native-failure behavior after repointing. Additional isolated feature tests cover link routing and owner disposal, and a wiring test covers explicit mount/remount/stop. Existing application opener, document-replacement and action-order tests remain in place. The rows load manifest replaces `06-rows.js` with the feature and wiring targets; configuration spies cover the new mount.

Legacy metrics move from 33 numbered files / 18,967 lines to 32 / 18,881. Runtime loop metrics remain 11 modules / 29 links, and global `S` usage stays zero. The dependency baseline only removes the retired file and its import of `safeHref`; no exception is added.
