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

A video file dropped in the desktop app keeps its path on its link, so it opens again after a restart. The path comes from the preload's `webUtils.getPathForFile` (`videoFilePath` on the bridge, `pathOf` on `DesktopVideo`), and `readClipboardFiles` puts it on the attachment. The link stores it as `location: { kind: "path", path }`; the browser build has no path and stores none. `kind` leaves room for a bundled form, a path kept relative to a folder beside the script.

Opening a file link tries this session's token first, then the stored path through `openPath` (`splitpage:video-path-open`). A script is untrusted input, so main checks the path itself before anything touches the disk, with `videoPathProblem` in `shared/video-path.ts`: a local drive path on Windows or an absolute path elsewhere, no UNC or device path, no `.` or `..` part, no character or name Windows would reinterpret, and a video extension from the same allowlist as a grant. `openableVideoPath` in `shared/video-embed.ts` then resolves links with `realpath`, checks the extension again on the real path, and requires a regular file. A file that is gone answers `GONE`, which gives the existing "no longer where it was" notice; anything refused answers `REFUSED`, which gives the existing "Could not open" notice.

The core normalizer keeps a location only on a file link and only when it is a valid path in either style, so a script moved between Windows and macOS keeps it. The location is not part of a link's identity (`videoLinkKey`): dropping the same file again records its new path on the link it already has. It is part of the gallery fields' equality key, so a change of location alone is merged and undone like any other gallery change. SplitShare drops every location; the other exports never wrote a link's fields beyond its name.

The `open-picture-link` action retains its ID, registration position, availability and input validation. The build entry stays `_entry.js`; only its retired initializer is replaced by the explicit feature mount.

## Verification

The first commit adds six characterization tests that passed on base `9b3df215ba72e1a6576d21ad98132e3da0f8d218` before production code moved. They retain the old URL-cache, retained-grant, warning, token and native-failure behavior after repointing. Additional isolated feature tests cover link routing and owner disposal, and a wiring test covers explicit mount/remount/stop. Existing application opener, document-replacement and action-order tests remain in place. The rows load manifest replaces `06-rows.js` with the feature and wiring targets; configuration spies cover the new mount.

Legacy metrics move from 33 numbered files / 18,967 lines to 32 / 18,881. Runtime loop metrics remain 11 modules / 29 links, and global `S` usage stays zero. The dependency baseline only removes the retired file and its import of `safeHref`; no exception is added.
