; electron-builder NSIS customization for Splitpage
;
; electron-builder calls this after reading standard nsis config.
; We add a second Start Menu shortcut for --host mode (shared session).
;
; Documentation:
; - electron-builder macro reference:
;   https://www.electron.build/configuration/nsis
; - NSIS reference:
;   https://nsis.sourceforge.io/Reference
;
; Note: electron-builder provides these for us:
;   $INSTDIR          = installation directory
;   ${APP_EXECUTABLE_FILENAME}  = Splitpage.exe
;   $SMPROGRAMS       = Start Menu Programs folder

; This file is included in the script header, before electron-builder's own
; templates pull LogicLib in (multiUser.nsh -> UAC.nsh). LogicLib guards
; itself, so including it here as well is harmless.
!include LogicLib.nsh

; --- Splitpage 1.0.x (PowerShell installer) -> 2.0 (Electron) --------------
;
; Runs from .onInit (app-builder-lib templates/nsis/installer.nsi, after
; initMultiUser and outside the BUILD_UNINSTALLER branch), i.e. before any
; page is shown and before a single file is written.
;
; 1.0.x installed itself into %LOCALAPPDATA%\Programs\Splitpage, the same
; folder this installer uses, and registered "Uninstall\Splitpage" in HKCU.
;
; Case B (checked first): a portable copy registered in place. install.ps1
;   -InPlace writes "<folder>\.splitpage-registered" (install.ps1:582) and its
;   Add/Remove entry runs "<folder>\installer\install.ps1 -Unregister", which
;   deliberately deletes nothing (install.ps1:47-80) because the user's
;   documents may sit in data\ beside it. We never delete such a folder; we
;   ask the user to unregister it and stop.
; Case A: an installed copy. install.ps1 put uninstall.ps1 at the install
;   root (package.mjs:240-253, install.ps1:585-587). We run it with -Silent,
;   then wait for its detached "rmdir /s /q" (uninstall.ps1:75-76, ~2 s after
;   PowerShell exits) to finish before electron-builder writes into the same
;   folder (HANDOFF invariant #50).
;
; Uses the literal legacy path, never $INSTDIR (the directory page has not
; run yet). Never RMDir /r. Never touches %LOCALAPPDATA%\Splitpage\data.
; %LOCALAPPDATA% is read from the environment, so the result does not depend
; on the SetShellVarContext state electron-builder left behind.
!macro customInit
  Push $R0
  Push $R1
  Push $R2
  Push $R3

  ReadEnvStr $R0 LOCALAPPDATA
  StrCpy $R0 "$R0\Programs\Splitpage"

  ; --- Case B: registered-in-place portable copy -------------------------
  ; In the legacy folder itself, or wherever the 1.0.x Add/Remove entry
  ; points (a portable unzip can live anywhere; it would still collide with
  ; this installer's Start Menu shortcut and Add/Remove entry).
  StrCpy $R2 ""
  ${If} ${FileExists} "$R0\.splitpage-registered"
  ${AndIf} ${FileExists} "$R0\installer\install.ps1"
    StrCpy $R2 "$R0"
  ${Else}
    ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Splitpage" "InstallLocation"
    ${If} $R1 != ""
    ${AndIf} ${FileExists} "$R1\.splitpage-registered"
    ${AndIf} ${FileExists} "$R1\installer\install.ps1"
      StrCpy $R2 "$R1"
    ${EndIf}
  ${EndIf}

  ${If} $R2 != ""
    DetailPrint "Splitpage 1.0 portable copy registered in place: $R2"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Splitpage 1.0 is registered from the folder$\r$\n$\r$\n$R2$\r$\n$\r$\nRemove it first: open Settings > Apps > Installed apps (Add/Remove Programs) and uninstall $\"Splitpage$\". That only removes its shortcuts and its entry; the folder and any documents in it are left alone.$\r$\n$\r$\nThen run Setup again." /SD IDOK
    DetailPrint "Setup stopped: remove the registered 1.0 copy first."
    SetErrorLevel 2
    Abort
  ${EndIf}

  ; --- Case A: installed 1.0.x copy --------------------------------------
  ${If} ${FileExists} "$R0\start.bat"
  ${AndIf} ${FileExists} "$R0\uninstall.ps1"
    DetailPrint "Found Splitpage 1.0 in $R0"
    ReadEnvStr $R3 LOCALAPPDATA
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Splitpage 1.0 is installed in $R0. Setup will remove it first. Your shared-session documents in $R3\Splitpage\data are kept." /SD IDOK IDOK splitpageLegacyRemove
      DetailPrint "Setup cancelled: Splitpage 1.0 was left installed."
      Abort
    splitpageLegacyRemove:

    DetailPrint "Removing Splitpage 1.0 (uninstall.ps1 -Silent)..."
    ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$R0\uninstall.ps1" -Silent' $R1
    DetailPrint "uninstall.ps1 exited with code $R1"

    ; uninstall.ps1 hands the folder to a detached "rmdir /s /q" ~2 s after it
    ; exits. Wait (every 500 ms, 30 s in all) for start.bat to go; then, in
    ; what is left of the same budget, for the folder itself, so nothing is
    ; still deleting when electron-builder starts writing.
    DetailPrint "Waiting for the old folder to be deleted..."
    StrCpy $R2 0
    ${Do}
      ${IfNot} ${FileExists} "$R0\start.bat"
        ${Break}
      ${EndIf}
      ${If} $R2 >= 60
        ${Break}
      ${EndIf}
      Sleep 500
      IntOp $R2 $R2 + 1
    ${Loop}

    ${If} ${FileExists} "$R0\start.bat"
      DetailPrint "Splitpage 1.0 is still present after 30 s: $R0\start.bat"
      MessageBox MB_OK|MB_ICONSTOP "Could not remove the old version - close Splitpage and any command window using it, then run Setup again." /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}

    ${Do}
      ${IfNot} ${FileExists} "$R0\*.*"
        ${Break}
      ${EndIf}
      ${If} $R2 >= 60
        ${Break}
      ${EndIf}
      Sleep 500
      IntOp $R2 $R2 + 1
    ${Loop}
    Sleep 1000

    ${If} ${FileExists} "$R0\*.*"
      DetailPrint "Old launcher removed; some leftover files remain in $R0 and will be installed over."
    ${Else}
      DetailPrint "Splitpage 1.0 removed."
    ${EndIf}
  ${EndIf}

  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customInstall
  ; Create "Splitpage (shared session)" shortcut in Start Menu.
  ;
  ; "--pin" (no value) tells main.js to generate a random 6-digit PIN at
  ; launch (see its own argHas/argValueOf handling) instead of leaving
  ; JOIN_PIN empty. An empty JOIN_PIN makes server.js skip authentication
  ; entirely (authRequired:false) — this shortcut starts the server bound to
  ; 0.0.0.0 (HOSTING), so without a PIN, double-clicking it from the Start
  ; Menu handed anyone on the LAN full read/write access to whatever
  ; project is open, with nothing in the UI making that obvious (see
  ; renderDesktopShareInfo() in src/js/20f-desktop.js, which now also warns
  ; explicitly on the rare occasion a session really is PIN-less).
  CreateDirectory "$SMPROGRAMS\Splitpage"
  CreateShortCut "$SMPROGRAMS\Splitpage\Splitpage (shared session).lnk" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME}" \
    "--host --pin" \
    "$INSTDIR\${APP_EXECUTABLE_FILENAME}" \
    0 \
    SW_SHOWNORMAL
  DetailPrint "Created Splitpage (shared session) shortcut"
!macroend

!macro customUnInstall
  ; Remove "Splitpage (shared session)" shortcut
  Delete "$SMPROGRAMS\Splitpage\Splitpage (shared session).lnk"
  ; Try to remove the folder if empty
  RMDir "$SMPROGRAMS\Splitpage"
  DetailPrint "Removed Splitpage (shared session) shortcut"
!macroend

; --- Running-app check (replaces electron-builder's default) ---------------
;
; CHECK_APP_RUNNING (allowOnlyOneInstallerInstance.nsh) picks one of two
; implementations, and they do not agree. The tasklist branch matches the app
; by executable name and excludes the calling process:
;
;   taskkill /IM "Splitpage.exe" /FI "PID ne $pid" /FI "USERNAME eq %USERNAME%"
;
; The PowerShell branch — the one that runs on any machine with a working
; Get-CimInstance, i.e. effectively all of them — matches by INSTALL-DIRECTORY
; PREFIX and drops the PID exclusion entirely:
;
;   Get-CimInstance Win32_Process |
;     ? { $_.Path -and $_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } |
;     % { Stop-Process -Id $_.ProcessId }
;
; Two consequences, both of which end with Setup disappearing after the user
; clicks OK on "Splitpage is running":
;
;   1. Nothing excludes the caller, so a Setup run from inside $INSTDIR stops
;      itself.
;   2. A path prefix is not a process identity, and FIND_PROCESS uses the same
;      filter. Anything still running under $INSTDIR keeps the retry loop
;      finding "the app", so after two passes the loop reaches
;      "$(appCannotBeClosed)" — a MessageBox whose silent default is IDCANCEL,
;      and Cancel is a bare `Quit`. The window closes with no explanation and
;      no install.
;
; Matching by executable name avoids both. Splitpage.exe covers the main
; process and every Electron child (they share the exe), while Setup is
; SplitpageDesktopSetup-<version>-<arch>.exe and the uninstaller is
; Un_A.exe/old-uninstaller.exe, so this can never match the process running
; it. $CmdPath is set by CHECK_APP_RUNNING before it inserts this macro.
;
; --- Never force-close an app that may be asking a question (#198) ---------
;
; The polite taskkill posts WM_CLOSE, and a window with unsaved work answers
; it with a modal "You have unsaved changes" dialog (main.js, win.on("close")).
; The original shape forced `taskkill /F` ~1.3 s later, while that dialog was
; still up, and the work was lost. Now what the installer does next depends
; on what the app is showing, re-read every 500 ms:
;
;   gone                       -> carry on.
;   a dialog is up             -> the user is being asked something: wait, for
;                                 as long as it takes. No forcing, no second
;                                 WM_CLOSE (that would dismiss the dialog as
;                                 Cancel/Stay and ask again).
;   a window, but no dialog    -> the user chose Stay/Cancel, or the app is on
;                                 its way out. After 5 s of that: the
;                                 "cannot be closed" Retry/Cancel box. Never /F.
;   no window at all           -> nothing can be asking. Allow 10 s to finish
;                                 quitting (will-quit stops the document server
;                                 and flushes drafts), then /F.
;
; "Window" means a VISIBLE top-level window of class Chrome_WidgetWin_1 (every
; Electron BrowserWindow) or #32770 (MessageBox, Electron's TaskDialog, the
; common file dialogs) owned by any process whose image is
; ${APP_EXECUTABLE_FILENAME}; "dialog" means one of the #32770 ones. Only those
; two classes are looked at because walking every top-level window is far too
; slow to poll: a desktop with Edge open can have thousands (4,560 on the
; machine this was written on, ~1.5 s a pass through System::Call). A
; minimised or other-desktop window is still WS_VISIBLE, so it still counts.
;
; The signal is read from the windows themselves, not from anything the app
; publishes, on purpose: the app this macro has to close is the one ALREADY
; installed, i.e. an older build that knows nothing about this installer.
;
; Retry re-checks. If a dialog is up it just goes back to waiting; otherwise it
; sends one more polite close (which brings the unsaved-changes question back)
; and starts over. Cancel is the template's `Quit`.
;
; Silent runs (/S, and the old uninstaller the new installer runs with /S
; --updated) cannot wait forever for a question nobody may be there to
; answer: after 60 s of an unanswered dialog they reach the same box, whose
; silent default is IDCANCEL, so Setup stops and the app, its dialog and its
; unsaved work are left exactly as they were. ${isUpdated} still skips the
; "Splitpage is running" OK/Cancel box and gives the app a second to go by
; itself first, as the template does.

; Milliseconds, measured with GetTickCount from the moment the app entered its
; current state (each poll also spends ~250 ms in tasklist, so counting polls
; would drift): window-without-dialog before the Retry box; no-window before
; /F; unanswered dialog before a SILENT run gives up.
!define /ifndef SP_POLL_MS 500
!define /ifndef SP_STAYED_MS 5000
!define /ifndef SP_NOWINDOW_MS 10000
!define /ifndef SP_SILENT_ASK_MS 60000
!define /ifndef SP_APP_WINDOW_CLASS "Chrome_WidgetWin_1"

; One pass over the visible top-level windows of class _CLASS. Sets _WIN to 1
; if one of them belongs to ${APP_EXECUTABLE_FILENAME}. Works in $R4-$R9 as
; splitpageScanWindows sets them up; no labels, so it can be inserted freely.
!macro splitpageScanClass _CLASS _WIN
  StrCpy $R4 0
  ${Do}
    FindWindow $R4 "${_CLASS}" "" "" $R4
    ${If} $R4 == 0
      ${Break}
    ${EndIf}
    System::Call 'user32::IsWindowVisible(p r14) i.r16'
    ${If} $R6 != 0
      StrCpy $R5 0
      System::Call 'user32::GetWindowThreadProcessId(p r14, *i .r15)'
      ${If} $R5 != $R7
        ; Look each pid up once per pass.
        StrCpy $R7 $R5
        StrCpy $R8 0
        System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r15) p.r16'
        ${If} $R6 != 0
          StrCpy $R9 ""
          System::Call 'kernel32::QueryFullProcessImageNameW(p r16, i 0, w .r19, *i ${NSIS_MAX_STRLEN}) i.s'
          System::Call 'kernel32::CloseHandle(p r16)'
          Pop $R6
          ${If} $R6 != 0
            StrLen $R6 "\${APP_EXECUTABLE_FILENAME}"
            IntOp $R6 0 - $R6
            StrCpy $R9 $R9 "" $R6
            ${If} $R9 == "\${APP_EXECUTABLE_FILENAME}"
              StrCpy $R8 1
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ${If} $R8 == 1
        StrCpy ${_WIN} 1
        ${Break}
      ${EndIf}
    ${EndIf}
  ${Loop}
!macroend

; _WIN = 1 if the app has a visible window, else 0; _ASK = 1 if one of them is
; a dialog, else 0 (see above). Pass registers outside $R4-$R9 (they are saved
; and used here; System's r14-r19). No labels, so it can be inserted any number
; of times in one function or section.
!macro splitpageScanWindows _WIN _ASK
  Push $R4 ; hwnd
  Push $R5 ; its pid
  Push $R6 ; scratch
  Push $R7 ; the pid last looked up
  Push $R8 ; 1 if that pid is ${APP_EXECUTABLE_FILENAME}
  Push $R9 ; image path
  StrCpy $R7 -1
  StrCpy $R8 0
  StrCpy ${_ASK} 0
  !insertmacro splitpageScanClass "#32770" ${_ASK}
  StrCpy ${_WIN} ${_ASK}
  ${If} ${_WIN} == 0
    !insertmacro splitpageScanClass "${SP_APP_WINDOW_CLASS}" ${_WIN}
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
!macroend

!macro splitpageFindApp _RET
  nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
  Pop ${_RET}
!macroend

!macro customCheckAppRunning
  Push $R0 ; exit code of the last tasklist/taskkill; ms spent in the state
  Push $R1 ; GetTickCount when the app entered its current state
  Push $R2 ; the app has a visible window
  Push $R3 ; the app has a dialog up
  Push $R4 ; its state at the last poll: 2 dialog, 1 window, 0 neither

  !insertmacro splitpageFindApp $R0
  ${if} $R0 == 0
    ${if} ${isUpdated}
      ; An update restarts the app itself; give it a moment to go on its own.
      Sleep 1000
      Goto spDoStopProcess
    ${endIf}

    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK spDoStopProcess
    Quit

    spDoStopProcess:
      DetailPrint "$(appClosing)"

    spAskToClose:
      ; The one polite close per attempt. A second WM_CLOSE while the app's
      ; own dialog is up would dismiss that dialog as Cancel.
      nsExec::Exec `"$CmdPath" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
      Pop $R0
      DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
      StrCpy $R4 -1

    spWait:
      Sleep ${SP_POLL_MS}
      !insertmacro splitpageFindApp $R0
      ${if} $R0 != 0
        Goto spNotRunning
      ${endIf}
      !insertmacro splitpageScanWindows $R2 $R3
      ${if} $R3 == 1
        StrCpy $R0 2
      ${elseIf} $R2 == 1
        StrCpy $R0 1
      ${else}
        StrCpy $R0 0
      ${endIf}
      ${if} $R0 != $R4
        StrCpy $R4 $R0
        System::Call 'kernel32::GetTickCount() i.r11'
      ${endIf}
      System::Call 'kernel32::GetTickCount() i.r10'
      IntOp $R0 $R0 - $R1

      ${if} $R4 == 2
        ; The app is asking the user something (unsaved changes, stop
        ; sharing, a Save dialog). Wait for the answer, however long it takes.
        ${if} ${Silent}
        ${andIf} $R0 >= ${SP_SILENT_ASK_MS}
          Goto spCannotClose
        ${endIf}
        Goto spWait
      ${endIf}

      ${if} $R4 == 1
        ; A window but no question: the answer was Stay/Cancel, or the app is
        ; about to go. Never forced: a window can put a question back up.
        ${if} $R0 >= ${SP_STAYED_MS}
          Goto spCannotClose
        ${endIf}
        Goto spWait
      ${endIf}

      ; No window at all, so nothing can be asking. Give quitting time to
      ; finish, then force whatever is left (a stuck quit, an orphaned
      ; document server).
      ${if} $R0 >= ${SP_NOWINDOW_MS}
        DetailPrint `"${PRODUCT_NAME}" has no window open but is still running; ending it.`
        nsExec::Exec `"$CmdPath" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
        Pop $R0
        Sleep 1000
        !insertmacro splitpageFindApp $R0
        ${if} $R0 != 0
          Goto spNotRunning
        ${endIf}
        ; Still there after a forced kill: elevated, or not ours to stop.
        Goto spCannotClose
      ${endIf}
      Goto spWait

    spCannotClose:
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY spRetry
      Quit

    spRetry:
      !insertmacro splitpageFindApp $R0
      ${if} $R0 != 0
        Goto spNotRunning
      ${endIf}
      !insertmacro splitpageScanWindows $R2 $R3
      ${if} $R3 == 1
        ; Its question is still up: go back to waiting for the answer.
        StrCpy $R4 -1
        Goto spWait
      ${endIf}
      Goto spAskToClose

    spNotRunning:
  ${endIf}

  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
