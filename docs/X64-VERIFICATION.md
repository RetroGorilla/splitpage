# Splitpage 2.0.0 — x64 verification

This document is read by two audiences on Adam's Windows x64 PC: a Claude
Code session, which does the automated parts, and Adam himself, for the
parts only a human can do (installer prompts, SmartScreen, switching
Windows users, reading aloud, the firewall prompt).

It is copied from the 2.0.0 release plan (`breezy-booping-toucan.md`, Part D)
into the repo so the x64 session reads it from the exact commit it is
testing.

---

## 1. Purpose and scope

This run exists to prove the things that cannot be proven on Adam's ARM64
laptop, because they are arch-dependent or require hardware/state the
laptop doesn't have:

- The **native x64** packaged app actually launches and passes smoke
  (the ARM64 laptop can only run x64 under emulation).
- **NSIS install and uninstall** on a real machine (never done on any
  real machine before this).
- **The upgrade over a real 1.0.x install** — the exact scenario existing
  users hit, including the installer's "remove 1.0 first" step, the
  60-second folder-deletion race (invariant #50), and the offline
  updater path.
- **File association** (double-click a `.splitpage` file in Explorer).
- **Native dialogs** (Open, Save As, About) in a real packaged window.
- **Firewall prompt and LAN hosting** under `--host`.
- **The tunnel** (`--tunnel`) against a real SSH host.
- **Browser-mode voice regression** — confirming Edge's own recognizer
  still works in 2.0.0's browser build, since the desktop voice button is
  disabled this release (Q25).

### What this run deliberately does NOT re-test

Per the standing rule ([`test-only-what-changed`](../.claude/projects) —
"we shouldn't be running tests on code that hasn't changed... needless
testing is a waste"):

- **Every arch-independent suite** — the browser suite (`run-tests.ps1`,
  26 suites), `tools/test-server.mjs`, `desktop/test/drafts.test.mjs`,
  `tools/test-update.mjs` — already passed on this exact commit on the
  ARM64 laptop. Re-running them on x64 proves nothing about the app; it
  would only prove the x64 machine can also run Node, which
  `node build.mjs --check` already proves more cheaply. They are run here
  **only if** a failure in this document points at one of them.
- **Desktop Follow My Voice.** Voice work (V1–V5, track VL) is paused
  (Q24) for this release. The desktop button is disabled with an honest
  message (Q25) and no `SplitpageSpeech.exe` ships. D7 below only checks
  that the disabled state is correct and that the *browser* build's voice
  (Edge's own recognizer, unchanged code) still works — that is not new
  ground, it is a regression check on code this release didn't touch.
- **The ARM64 packaged smoke run** — already green on the laptop, native
  this time instead of emulated; running it again here would test the
  same code on the same architecture as already covered.
- Code review, macOS, and anything else listed under "Explicitly NOT done
  on x64" in the source plan.

---

## 2. Before you start (Adam)

1. **Commit to test.** Check out `<COMMIT — filled in at hand-off>` on
   branch `Splitpage-electron`. Everything below assumes that exact
   commit; the automated Claude Code session should not touch anything
   past `git checkout`.

2. **ARM64 laptop prerequisites** (this is the second device / SSH host
   for D8's tunnel and D5's LAN-join check):
   - OpenSSH Server enabled: Settings ▸ System ▸ Optional features ▸ Add
     a feature ▸ OpenSSH Server. Start the `sshd` service
     (Services, or `Start-Service sshd`) and confirm it's set to start
     automatically.
   - Note the laptop's LAN IP (`ipconfig`) and the Windows account name
     you'll SSH in as. Write both down — the x64 session needs
     `<user>@<laptop-ip>` for D8.

3. **What the x64 PC needs before the session starts:**
   - Claude Code installed and signed in.
   - A working microphone (only used for D7's browser-mode voice check
     and to confirm no mic prompt appears in D8's tunnel case).
   - A real **Splitpage 1.0.x install** already present — this is the
     upgrade test case (D4, D6). If you don't have one, install a 1.0.x
     build first; the whole point of D4/D6 is testing against a genuine
     existing install, not a fresh one.

4. **Create the throwaway local user** used for the clean-install round
   trip (D5), so it exists before the session starts or whenever you get
   to D5:
   Settings ▸ Accounts ▸ Other users ▸ Add account ▸ "I don't have this
   person's sign-in information" ▸ "Add a user without a Microsoft
   account" ▸ name it `splitpage-test`, no password (or one you'll
   remember — you'll sign in and out of it once).

5. **Time budget.** Automated block (bootstrap, build, smoke) is roughly
   2 hours, dominated by `npm install` and `dist:win`. The manual block
   with you present is roughly 1.5 hours. Plan for a session where you
   can be interrupted a handful of times for installer prompts and
   switching users, but don't need to sit through the automated part.

---

## 3. Rules for the x64 Claude Code session

- **Orchestrator + subagents.** Orchestrator role (Fable, or Opus if
  Fable isn't available on this machine): never writes code, never runs
  suites itself — delegates, reads reports, fills in the Results table.
  Opus only when a failure needs a design decision (e.g. a merge conflict
  or a storage bug) or to review a fix touching drafts/history/preload/
  IPC. Sonnet does every diagnosis and every fix. Haiku runs fixed
  commands (bootstrap, build, suites) and fills result-table rows.
- **Every app launch the agent makes** — dev, packaged, or via
  `smoke.mjs` — sets `SPLITPAGE_TEST=1` and a temporary
  `SPLITPAGE_USER_DATA` directory (per-process, not the real profile),
  kills whatever it starts when done, and checks the process's
  `MainWindowHandle` is `0` afterward (nothing was ever left visibly on
  screen). This mirrors what `desktop/test/smoke.mjs` itself already does
  (`desktop/test/smoke.mjs:844-851`).
- **Test only what a failure points at.** If D3's native smoke run fails,
  diagnose from that failure — don't start re-running the browser suite
  or `test-server` speculatively. Only touch an arch-independent suite if
  the specific failure implicates code that suite covers.
- **Fixes are one commit per finding**, on a new branch `x64-verification`
  (branched from the commit under test). Push only that branch — never
  `Splitpage-electron` or `main` (Q22).
- **Never touch the 1.0.x install** except where D4 and D6 explicitly
  say to (offline update test and the live upgrade). It's Adam's real
  install; every other step treats it as read-only.

---

## 4. D1 — Bootstrap

**Who:** Claude Code (Haiku), sequential, ~30 min.

```powershell
git clone https://github.com/RetroGorilla/splitpage.git splitpage_local_development
cd splitpage_local_development
git checkout Splitpage-electron
git checkout <COMMIT>
```

(A `git config core.hooksPath .githooks` step used to be here. `.githooks/`
is gone since #80: `index.html` is no longer tracked, so there is no longer a
committed build output for a hook to keep in step or a committed demo
document for it to protect. Run `npm install && node build.mjs` after the
checkout instead — a fresh clone has no `index.html` at all.)

Every `.mjs` script in this repo needs Node to run at all — including the
scripts that fetch a runtime for *packaging* the app — so if this machine
has no system Node, get a portable one manually first (this mirrors what
`tools/fetch-runtime.mjs` does when it fetches the runtime embedded in the
legacy launcher; it can't be invoked here to bootstrap Node because it is
itself a Node script and needs Node already):

```powershell
$v = "22.22.2"
Invoke-WebRequest "https://nodejs.org/dist/v$v/SHASUMS256.txt" -OutFile sums.txt
Invoke-WebRequest "https://nodejs.org/dist/v$v/node-v$v-win-x64.zip" -OutFile node.zip
$expected = (Select-String "node-v$v-win-x64.zip" sums.txt).Line.Split(" ")[0]
$actual = (Get-FileHash node.zip -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { throw "checksum mismatch: expected $expected got $actual" }
Expand-Archive node.zip -DestinationPath .cache
Rename-Item ".cache\node-v$v-win-x64" ".cache\node-win-x64"
$env:PATH = "$PWD\.cache\node-win-x64;$env:PATH"
node --version   # expect v22.22.2
```

(`v22.22.2` is the version this repo's own portable Node is pinned to —
`tools/fetch-runtime.mjs:38` (`NODE_VERSION` default) and confirmed by
`.cache/node-win-x64/node.exe --version` on the ARM64 laptop, which prints
`v22.22.2`.) If a system Node is already on PATH and is a reasonably
current LTS/current release, skip this and use it instead — the exact
minor version doesn't matter for running these scripts, only for what
gets embedded in the legacy zip's payload (not built in this round).

```powershell
node build.mjs --check
cd desktop
npm install
cd ..
```

**Record**, into the Results table's notes column:
- `[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture`
  (expect `X64`)
- Windows edition and build (`winver` or `Get-ComputerInfo`)
- Edge version (`edge://version`)
- `ssh -V`
- Whether `%LOCALAPPDATA%\Programs\Splitpage\start.bat` exists (the
  1.0.x install) and its `.splitpage-release.json` version
- Whether `gh` is installed (not needed this round, just noted)

**Pass/fail:** pass if `git checkout` lands on the right commit, `npm
install` completes, and `node build.mjs --check` exits 0.

---

## 5. D2 — Arch-independent sanity gate (cut down)

**Who:** Claude Code (Haiku).

Per the test-only-what-changed rule, this is **not** a full suite re-run
— every arch-independent suite already passed on this exact commit on
the ARM64 laptop. Run only:

```powershell
node build.mjs --check
```

**Expected output:** exit 0, no diff reported (`build.mjs --check` exits
1 if `index.html` doesn't match `src/` — see `build.mjs:17`).

**Pass/fail:** pass on exit 0. If it fails, that's an environment problem
(bad checkout, wrong Node), not an app bug — fix the checkout, don't
touch `src/`.

If, and only if, a later step (D3–D8) fails in a way that implicates
`src/**` (browser suite), `desktop/drafts.js` (drafts suite), the document
server (`tools/test-server.mjs`), or `update.mjs`
(`tools/test-update.mjs`), run that one suite here to help diagnose —
name which suite and why in the Results notes.

---

## 6. D3 — Native x64 build and packaged smoke

**Who:** Claude Code runs (Haiku), Sonnet diagnoses any failure. ~45 min.

```powershell
cd desktop
npm run dist:win
```

This runs `node stage.mjs && electron-builder --config electron-builder.yml --win --x64 --arm64 && node verify-dist.mjs --arch both`
(`desktop/package.json:13`). **Expected:** both installers and both
`win-unpacked`/`win-arm64-unpacked` trees are produced, and `verify-dist`
prints ALL PASS for both arches. This is the first time x64 is the *host*
architecture for a build — it confirms the arch pins still hold (the
ARM64 target is still produced and correctly stamped AA64) when built
from an x64 machine instead of ARM64.

**Pass/fail:** pass if `dist:win` exits 0 and verify-dist shows ALL PASS
for both `x64` and `arm64`.

```powershell
node test/smoke.mjs --only-target dev
```

(`--only-target` is an undocumented debugging flag —
`desktop/test/smoke.mjs:48` — that restricts a default run to one target
by name; `dev` is the Electron-from-`node_modules` target.)

**Expected:** ALL PASS. Note the run time versus the emulated x64 number
from the ARM64 laptop (informational only, not pass/fail).

```powershell
node test/smoke.mjs --exe dist/win-unpacked/Splitpage.exe
```

This is the **headline automated result** — the native x64 packaged app,
run for the first time on real x64 hardware instead of emulation
(`--exe` targets one exe directly — `desktop/test/smoke.mjs:44`).

**Pass/fail:** pass on ALL PASS.

`packaged-arm64` is skipped on this machine (it can't run ARM64 native
code) — record "n/a", not "fail".

**Voice helper absence check** (desktop voice is paused this round, so
none should have been staged):

```powershell
Get-ChildItem dist\win-unpacked\resources\splitpage -Filter "SplitpageSpeech*" -ErrorAction SilentlyContinue
Test-Path dist\win-unpacked\resources\splitpage\speech-local
```

**Expected:** both empty/`False` — no `SplitpageSpeech*.exe` and no
`speech-local\` directory shipped. (`verify-dist.mjs` doesn't check this
itself yet — its IL-only-helper check is still a TODO,
`desktop/verify-dist.mjs:127` — so this is a manual/scripted confirmation,
not something verify-dist enforces.)

Finally, confirm nothing was left running:

```powershell
Get-Process Splitpage,electron,document-server -ErrorAction SilentlyContinue
```

**Expected:** empty. **Pass/fail:** pass if empty.

---

## 7. D4 — 1.0.x upgrade path, offline

**Who:** Sonnet sets up, Haiku runs. ~20 min. Before anything is
published; on Adam's account, where 1.0.x is installed.

**Back up the 1.0.x install folder first**, so D4.5/D6 have something
real to restore from — there is no built-in "rollback" command (see the
note under step 5 below):

```powershell
robocopy "$env:LOCALAPPDATA\Programs\Splitpage" "$env:USERPROFILE\splitpage-1.0.x-backup" /MIR
```

1. Build the 2.0.0 portable zip (no `--installer` — that branch is
   deprecated, `package.mjs:8-9`):
   ```powershell
   node package.mjs
   ```
   **Expected:** `dist/splitpage-2.0.0.zip` written (`package.mjs:89`
   names it `splitpage-${VERSION}`).

2. Serve a stub releases API. Save this as `stub-releases.mjs` in a
   scratch location (not committed) and run it:
   ```javascript
   // stub-releases.mjs — a ~20-line stand-in for api.github.com,
   // so D4 can test the updater fully offline.
   import { createServer } from "node:http";
   import { readFileSync, statSync } from "node:fs";
   import { join } from "node:path";

   const PORT = 8991;
   const ZIP = join(process.cwd(), "dist", "splitpage-2.0.0.zip");

   createServer((req, res) => {
     if (req.url === "/latest") {
       res.writeHead(200, { "content-type": "application/json" });
       res.end(JSON.stringify({
         tag_name: "v2.0.0",
         assets: [{
           name: "splitpage-2.0.0.zip",
           browser_download_url: `http://127.0.0.1:${PORT}/splitpage-2.0.0.zip`
         }]
       }));
       return;
     }
     if (req.url === "/splitpage-2.0.0.zip") {
       res.writeHead(200, { "content-length": statSync(ZIP).size });
       res.end(readFileSync(ZIP));
       return;
     }
     res.writeHead(404).end();
   }).listen(PORT, "127.0.0.1", () => console.log(`stub releases API on :${PORT}`));
   ```
   ```powershell
   node stub-releases.mjs
   ```

3. In the 1.0.x install folder (a second PowerShell window, so the stub
   server keeps running):
   ```powershell
   cd "$env:LOCALAPPDATA\Programs\Splitpage"
   $env:SPLITPAGE_UPDATE_API = "http://127.0.0.1:8991/latest"
   node update.mjs check
   node update.mjs
   ```
   `SPLITPAGE_UPDATE_API` is the real env var name, read first in
   `update.mjs:91` (`updateApiUrl()`), and the same resolver `start.mjs`
   uses (`start.mjs:339`). `node update.mjs check` only reports
   (`update.mjs:354` → `check()`); `node update.mjs` with no subcommand
   defaults to `stage` (`update.mjs:41,358`), which downloads, verifies
   checksums against the release's own manifest, and stages under
   `.update/`.
   **Expected:** `check` reports `installed: 1.0.x` / `available: 2.0.0`;
   the bare run reports "staged 2.0.0 ... Restart Splitpage to finish
   installing it."
   ```powershell
   .\start.bat
   ```
   `start.mjs` calls `apply()` before serving anything
   (`update.mjs:251`, "Called by start.mjs before it serves anything").
   **Expected:** app opens as 2.0.0 in browser mode; the update-bar logic
   shows the desktop-app notice bar instead (no update available once
   you're on 2.0.0). Existing `localStorage` data is still present — same
   origin/port as before.

4. **Export app data** from this now-2.0.0 browser instance: File ▸
   Export app data… → saves to
   `%USERPROFILE%\Downloads\splitpage-app-data-*.json`. Keep this file —
   D6 imports it after the live upgrade.

5. **Rollback / restore for D6.** `update.mjs` has **no `rollback`
   subcommand** `(verify: confirmed by reading update.mjs — only "check"
   and "apply" are recognized; anything else, including no argument,
   runs "stage")`. The comment at `update.mjs:339-341` says the backup
   under `.update/backup/` is "kept for a while in case a user manually
   needs to revert," but nothing automates that revert. To get back to a
   clean 1.0.x for D6, restore the folder from the backup you made at the
   top of this step:
   ```powershell
   robocopy "$env:USERPROFILE\splitpage-1.0.x-backup" "$env:LOCALAPPDATA\Programs\Splitpage" /MIR
   ```
   **Expected:** `start.bat` and `uninstall.ps1` are back at the install
   root, `.update\` is gone, and `node update.mjs check` (from that
   folder) reports "installed: 1.0.x" again.

**Pass/fail:** pass if the offline check/stage/apply sequence completes
and the app reopens as 2.0.0 with data intact; note exactly what the
updater printed at each step in the Results table.

---

## 8. D5 — Clean install round trip

**Who:** Manual, Adam present, on the `splitpage-test` local user. ~25
min.

Sign in as `splitpage-test` (already created per section 2). Copy
`SplitpageDesktopSetup-2.0.0-x64.exe` (from `desktop/dist/`, built in D3)
onto that account somehow (a shared folder, a USB stick, or OneDrive —
whatever's easiest; this account has no dev tools).

Checklist — each line pass/fail with a note:

1. SmartScreen appears (the installer is unsigned, Q9/Q15/Q16): "More
   info ▸ Run anyway" works. Record the exact wording shown for README.
2. Installer runs per-user, default folder
   `%LOCALAPPDATA%\Programs\Splitpage`; Desktop and Start Menu shortcuts
   land in a "Splitpage" folder, plus a "Splitpage (shared session)"
   shortcut (created by `customInstall` in `installer.nsh` — confirmed at
   `desktop/build/installer.nsh` under `!macro customInstall`, launching
   `Splitpage.exe --host --pin`).
3. First launch from the Start Menu: window with tab strip, the
   onboarding wizard shows once, taskbar icon/pin/grouping is correct.
4. Native dialogs: Open, Save As (offer `.md` and `.splitpage`), Help ▸
   About.
5. Save a file as `.splitpage`, close the app, double-click that file in
   Explorer → app opens it in a tab. Double-click it again while the app
   is open → switches to that tab, no second window.
6. Click the "Splitpage (shared session)" shortcut: a firewall prompt
   appears once; the app shows LAN URLs and a PIN in-app. From the ARM64
   laptop's browser (over the LAN IP from section 2): join with the wrong
   PIN (expect a clear error), then the right PIN (expect the doc list);
   make a concurrent edit from both sides and confirm a 409/merge banner
   appears.
7. Update bar: with `SPLITPAGE_UPDATE_API` unset, the desktop app's own
   update check hits its real default
   (`https://api.github.com/repos/RetroGorilla/splitpage-releases/releases/latest`,
   `desktop/main.js:2343`) — still at whatever the mirror's actual latest
   tag is at test time, so expect no notice unless that mirror already
   has 2.0.0. Record what you saw either way.
8. Add/Remove Programs (Settings ▸ Apps ▸ Installed apps): entry shows
   "Splitpage" (product name from `desktop/package.json:2`) version
   2.0.0. Uninstall → install folder and shortcuts gone,
   `%LOCALAPPDATA%\Splitpage\data` kept (the `customUnInstall` macro only
   removes the shared-session shortcut and its Start Menu folder —
   `desktop/build/installer.nsh` under `!macro customUnInstall`; the data
   dir is never touched by NSIS's own uninstaller either).
9. Reinstall once more, confirm it still works, then delete the
   `splitpage-test` account (Settings ▸ Accounts ▸ Other users ▸ Remove)
   at the very end of the whole session.

---

## 9. D6 — Upgrade over 1.0.x

**Who:** Manual, Adam's own account, with 1.0.x restored (from D4.5).
~15 min.

1. Confirm the "installed copy" shape U1 handles: `uninstall.ps1` sits
   directly at `%LOCALAPPDATA%\Programs\Splitpage\` (not inside an
   `installer\` subfolder) alongside `start.bat`. This is Case A in
   `installer.nsh`. (A registered-in-place *portable* copy — Case B,
   `.splitpage-registered` + `installer\install.ps1` — is refused by
   design with a message telling you to uninstall it yourself first; you
   shouldn't hit that case here since D4.5 restored a normal install.)

   Run `SplitpageDesktopSetup-2.0.0-x64.exe`. Expect this exact prompt
   (verbatim from `installer.nsh`'s `customInit`, case A):

   > **Splitpage 1.0 is installed in `$LOCALAPPDATA`\Programs\Splitpage.
   > Setup will remove it first. Your shared-session documents in
   > `$LOCALAPPDATA`\Splitpage\data are kept.**

   (OK/Cancel box — `$R3`/`$R0` resolve to the real `%LOCALAPPDATA%`
   path at runtime.) Click **Cancel** once — expect the installer aborts
   cleanly with nothing changed. Run it again and click **OK** to finish
   this time.

   If the old folder somehow doesn't disappear within 30 seconds, expect
   this exact message instead, and the installer stops:

   > **Could not remove the old version - close Splitpage and any
   > command window using it, then run Setup again.**

   Note how long the "waiting for the old folder to be deleted..."
   stage actually took (`DetailPrint` lines are visible in the installer
   log/UI).

2. **Wait 60 seconds after the installer closes**, then confirm
   `Splitpage.exe` still exists in the install folder. This is invariant
   #50: the old `uninstall.ps1`'s own detached `rmdir /s /q` runs about 2
   seconds after *it* exits, into the same folder electron-builder just
   installed into — this check is specifically about that race, not
   about the installer's own 30-second wait loop.
   ```powershell
   Start-Sleep -Seconds 60
   Test-Path "$env:LOCALAPPDATA\Programs\Splitpage\Splitpage.exe"
   ```
   **Expected:** `True`. Also confirm the folder contains only the
   Electron app now (no `start.bat`, no `runtime\`), exactly one
   "Splitpage" entry in Add/Remove Programs, and
   `%LOCALAPPDATA%\Splitpage\data` is intact (open `--host` and confirm
   the old hosted documents are still there).

3. File ▸ Import app data… with the bundle exported in D4.4: confirm
   version history (old snapshots, per document), bookmarks, and the
   author name all arrive; onboarding is not re-shown; importing the
   same bundle a second time adds nothing new (re-run the import and
   confirm the "Imported N snapshots..." toast reports 0 new / all
   skipped, or re-check counts before/after).

---

## 10. D7 — Voice follow on x64 (reduced — desktop voice paused)

**Who:** Manual, Adam. ~5 min.

1. In the packaged desktop app, open the prompter. Follow My Voice
   should be greyed out, with status text: "Follow My Voice isn't
   available in the desktop app yet — it works in the browser version."
   (Q25's exact wording.) Clicking the disabled control should do
   nothing — no microphone prompt, no mic-in-use indicator anywhere.
2. In browser mode (the 2.0.0 build from D4, open in Edge): confirm
   Follow My Voice still works using Edge's own recognizer — a one-minute
   read should follow along; stop and start it once. This code is
   unchanged this release, so this is purely a regression check.

The full desktop voice checks (helper spawn/lifecycle, mic prompts,
error codes) move to the voice track's own verification whenever V1–V5
resume — not part of this release.

---

## 11. D8 — Tunnel

**Who:** Manual, Adam. ~10 min.

```powershell
& "$env:LOCALAPPDATA\Programs\Splitpage\Splitpage.exe" --tunnel <user>@<laptop-ip>
```

Also from the portable copy (built in D4.1):
```powershell
node start.mjs --tunnel <user>@<laptop-ip>
```

Checklist:
- SSH host-key prompt appears and is handled (accept on first connect).
- Port forward comes up; the app opens the tunnelled window.
- No permissions are auto-granted for the tunnelled origin — a
  microphone request (if you trigger one) must still show a real prompt,
  unlike the auto-granted `splitpage://app` origin.
- Closing the app also ends the `ssh.exe` child process — confirm with
  `Get-Process ssh -ErrorAction SilentlyContinue` after quitting.

---

## 12. D9 — Wrap-up

**Who:** Sonnet, ~15 min.

- Fill in the Results table below (§13) for every step D1–D8: pass /
  fail / n-a, duration, notes.
- Each fix made along the way is already its own commit on
  `x64-verification` (§3) — confirm `git log` shows one commit per
  finding, not a squashed pile.
- `git push origin x64-verification` (that branch only).
- Fill in the "Not verified" list (§13) honestly — anything skipped,
  anything that couldn't be reproduced, anything n/a.

---

## 13. Results

| Step | Pass/Fail/N-A | Duration | Notes |
| --- | --- | --- | --- |
| D1 Bootstrap | | | |
| D2 Sanity gate (`build.mjs --check`) | | | |
| D3.1 `dist:win` + verify-dist | | | |
| D3.2 smoke `--only-target dev` | | | |
| D3.3 smoke `--exe win-unpacked\Splitpage.exe` | | | |
| D3.4 `packaged-arm64` | n/a (can't run ARM64 native on x64) | — | |
| D3.5 no speech helper shipped | | | |
| D3.6 no leftover processes | | | |
| D4.1 `node package.mjs` (zip) | | | |
| D4.2 stub releases API | | | |
| D4.3 `update.mjs check` / stage / apply | | | |
| D4.4 export app data | | | |
| D4.5 restore 1.0.x from backup | | | |
| D5 Clean install (`splitpage-test`) | | | |
| D6.1 Upgrade prompt + cancel/retry | | | |
| D6.2 60-second rmdir-race check | | | |
| D6.3 Import app data, no duplication | | | |
| D7.1 Desktop voice disabled correctly | | | |
| D7.2 Browser voice regression | | | |
| D8 Tunnel | | | |

**Not verified (honest list — fill in at D9):**
-

---

## 14. Walkthrough for Adam (plain language)

Roughly what you'll be asked to do, and when, during this session:

1. **Start of session** — nothing from you yet. Claude Code clones the
   repo, checks out the commit, downloads a portable Node if needed, and
   runs the build/smoke steps on its own. This takes the better part of
   an hour; you don't need to watch it.

2. **When it gets to D4 (upgrade path, offline)** — this touches your
   real 1.0.x install. Claude Code backs it up first, then runs the
   updater against a local test server (nothing goes out to the real
   internet for this part). You'll see your 1.0.x app get replaced by
   2.0.0 running in your browser. It'll ask you to click File ▸ Export
   app data… once, which saves a `.json` file to your Downloads folder —
   just click it when asked.

3. **D5, clean install (~25 min, you're driving)** — you'll sign into
   the throwaway `splitpage-test` account you set up beforehand. You'll:
   - See a **SmartScreen warning** (because the installer isn't signed)
     — click "More info" then "Run anyway."
   - Click through the installer normally.
   - Open the app from the Start Menu, try the Open/Save dialogs, save a
     file, then **double-click that file in Explorer** to confirm it
     opens in the app.
   - Click the "Splitpage (shared session)" shortcut — Windows will show
     a **firewall prompt**; allow it. Then, from your ARM64 laptop's
     browser, you'll join that session — once with a wrong PIN (to see
     the error), then the right one.
   - Uninstall from Add/Remove Programs, reinstall once, then delete the
     `splitpage-test` account.

4. **D6, upgrading your real install (~15 min, you're driving)** — your
   1.0.x install gets restored from backup first. Then you'll run the
   2.0.0 installer over it and see a **prompt telling you Splitpage 1.0
   will be removed and your data kept**. You'll click Cancel once (to
   confirm that works), then run it again and let it finish. After it's
   done, you'll wait about a minute, then import the app-data file from
   step 2 back into the new app.

5. **D7, voice check (~5 min)** — you'll look at the prompter in the
   desktop app and confirm the voice button is greyed out with the
   expected message. Then you'll open the *browser* version and **read
   something aloud for about a minute** to confirm the browser's own
   voice-follow still works — this part hasn't changed, it's just a
   sanity check.

6. **D8, tunnel (~10 min)** — you'll run the app with `--tunnel` pointed
   at your ARM64 laptop. You'll be asked to accept an SSH host-key
   prompt the first time, then confirm the tunnelled window opens and
   permissions (like the microphone) aren't silently auto-granted the
   way they are in the normal desktop window.

That's the whole manual part. Everything else — the build, the smoke
tests, the file checks — Claude Code runs and reports on its own.
