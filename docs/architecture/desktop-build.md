# Why the desktop packaging configuration looks the way it does

`desktop/electron-builder.yml` carries no comments
([plan](../IMPLEMENTATION-PLAN.md) section 2; `npm run check:comments` enforces
it). This page explains each of its settings whose reason is not visible in the
file, under the key that holds it. [DEPLOY.md §6](../../DEPLOY.md#6-desktop-installers-windows)
covers building the installers, and [ci.md](ci.md#githubworkflowsreleaseyml)
covers the release workflow that runs `npm run dist:win`.

## `files`

Everything listed here goes inside the asar.

| Entry | Why |
| --- | --- |
| `main.js`, `preload.js`, `tabstrip-preload.js`, `drafts.js` | `main.js` requires `./drafts` at load and loads both preloads by path. If one is missing from the asar, the packaged app crashes on startup. |
| `ipc-channels.js` | The IPC channel table. `main.js` requires it at startup, and both preloads read it over `splitpage:ipc-table-sync`, so a packaged build without it has no bridge at all. |
| `prompter-share.js` | The teleprompter's loopback listener (#86). |
| `google-drive.js` | Google Drive through a loopback OAuth redirect (#10). |
| `bind-host.js` | Which address the document server listens on: every interface under `--host`, loopback otherwise and always in a test run, so test runs cause no firewall prompts. |
| `close-keep.js` | The close-time checks for a tab whose file is gone: a file check with a one-second limit, so an unreachable drive can't freeze a close (#497), and whether a kept copy really reached the draft folder (#496). It also runs the close check's question rounds (`runCloseCheck`, with main's tabs and helpers passed in) and decides what closing a window that is the last one at "close" settles (`lastWindowClose`, #531). |
| `quit-watchdog.js` | The update restart's 3 s quit timer, which waits while the quit is still asking the user and starts again once they answer. |
| `blob-store.js` | The content-addressed folder where images live (#82). |
| `voice-helper.js` | Follow My Voice's listener process (#8). The PowerShell script it runs (`desktop/voice/listen.ps1`) cannot be read from inside the asar, so `stage.mjs` stages it into `resources/splitpage/voice` instead. |
| `chromium-browsers.js` | Finds an installed Chromium browser for "Use Chromium Speech Recognition" (#123). |
| `history-fs-backend.js` | Version history on disk (#83): the file-system backend the shared history store runs over in the main process. It requires `./blob-store.js` itself. |

From `ipc-channels.js` down, `main.js` requires each of these modules at
startup, so each must ship for the same reason `drafts.js` does. A new
`./module` that `main.js` requires has to be added to this list:
`desktop/test/google-drive.test.mjs` fails if one is missing.

Two things `main.js` needs at startup are deliberately left out of `files`:

- **The tab strip's three files** (`desktop/tabstrip/index.html`,
  `tabstrip.js`, `tabstrip.css`). `protocol.handle` reads them off disk, so they
  are served from `resources/splitpage/tabstrip`. `stage.mjs` stages them and
  `extraResources` ships them.
- **`shared/`** (#76). It lives at the repository root, one level above
  `desktop/`. `main.js` finds it through `APP_ROOT`, which is the repository root
  in development and `resources/splitpage` when packaged. `stage.mjs` copies it
  there with the rest, so one path expression works in both layouts. Requiring a
  plain file from outside the asar works like any other `require`. Taking
  `shared/` out of `stage.mjs` would stop the app launching, not just break one
  feature.

## `extraResources`

`.stage/splitpage` → `resources/splitpage` is the folder `stage.mjs` fills: the
built app, `server/`, `shared/`, `tabstrip/` and `voice/`. Everything that
`main.js` reaches through `APP_ROOT` comes from here, not from the asar.

## `win.target`

Both architectures, x64 and arm64, are pinned here. Without the pin,
electron-builder builds only for the architecture of the machine running it.
On the maintainer's Snapdragon machine that means ARM64 only. The old IExpress
setups fell into the same trap: 1.0.1's "x64" setup came out as an ARM64 binary
that no x64 PC could start. `npm run dist:win` also passes `--x64 --arm64`, then
runs `verify-dist.mjs`. That script reads the PE machine field of each binary
the build produced and fails the build on a mismatch (DEPLOY.md §6).

## `nsis`

| Setting | Why |
| --- | --- |
| `useZip: true` with `differentialPackage: false` | The app payload ships as a ZIP rather than a 7z archive. Differential packaging has to be off for that, because it forces 7z back on whatever `useZip` says: app-builder-lib's `NsisTarget.js` picks the format from `!isBuildDifferentialAware && options.useZip` (line 78 in electron-builder 26.15.3). See the 7z note below. |
| `menuCategory: Splitpage` | Puts the main Start Menu shortcut in the same `Splitpage` subfolder where `installer.nsh`'s `customInstall` macro creates the "Splitpage (shared session)" shortcut. Otherwise the main shortcut lands loose at the Start Menu root, next to a `Splitpage` folder holding only the second shortcut, which is easy to miss or take for a duplicate. |
| `include: build/installer.nsh` | The installer's own macros: removing a Splitpage 1.0 install first (`customInit`), the shared-session shortcut (`customInstall`, `customUnInstall`), and the check for a running app that never force-closes one showing an unsaved-changes question (`customCheckAppRunning`, #198). |

Why 7z is a problem: 7-Zip applies an architecture-specific BCJ filter to
executables. The differential path builds the archive non-solid (`dictSize` 1,
`solid` false), so the filter lands on each PE file separately. Whatever
unpacks the payload inside NSIS cannot decode the ARM64 variant. The 2.0.1
ARM64 setup unpacked every `.pak`, `.dat`, `.bin` and `.html` file correctly
but silently dropped all seven top-level binaries, `Splitpage.exe` among them.
It then wrote the shortcuts and the uninstaller and exited 0, so the user saw
Windows looking for a `Splitpage.exe` that was never written. The x64 setup
built on the same machine in the same minute was fine, because the x64 BCJ
filter is old and every unpacker understands it. `verify-dist.mjs` now unpacks
each installer's payload to catch this ([ci.md](ci.md#githubworkflowsreleaseyml),
step `Desktop installers`).

Turning differential packaging off costs nothing here. Blockmaps are not
published (DEPLOY.md §7 publishes the zip, the two per-architecture setups and
`SHA256SUMS.txt`), and the updater downloads whole installers.

## `mac` and `linux`

Configured but never built or published. Only the Windows installers ship
(DEPLOY.md §6, "What's NOT verified").
