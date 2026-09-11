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
