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
