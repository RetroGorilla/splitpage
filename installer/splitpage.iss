; Splitpage — Windows installer (Inno Setup 6).
;
; BUILD IT:
;   1. node package.mjs                     (from the repo root; makes dist\)
;   2. Install Inno Setup 6 — https://jrsoftware.org/isdl.php
;   3. iscc installer\splitpage.iss         (or open this file in the IDE, F9)
;
; Output: dist\SplitpageSetup-<version>.exe
;
; WHY IT INSTALLS PER-USER. Splitpage is one person's writing tool, not a
; machine-wide service, and a per-user install needs no administrator and no
; UAC prompt. It also means the app folder stays writable, which matters:
; --library keeps documents next to the app by default, and that would fail
; under Program Files.
;
; WHAT IT DOES NOT DO. It does not install Node. It does not have to —
; start.bat falls back to the bundled PowerShell server when Node is absent,
; which is enough to serve the app so the browser will offer "Install app"
; and hand the teleprompter a microphone. With Node present you additionally
; get --library and a rebuild on launch.

#define AppName "Splitpage"
#define Publisher "Adam Sondergard"
#define AppExe "start.bat"

; Read the version from the same VERSION file package.mjs uses, so the
; installer can never disagree with the payload it is wrapping.
#define VerFile FileOpen("..\VERSION")
#define AppVersion Trim(FileRead(VerFile))
#expr FileClose(VerFile)
#if AppVersion == ""
  #error VERSION is empty — run this from the repo, and run package.mjs first.
#endif

[Setup]
; Never change AppId: it is how Windows recognises an upgrade rather than a
; second copy, and how the uninstaller finds what it installed.
AppId={{8F3B1C6E-4D2A-4E58-9A71-5C0E7B2D9A14}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=SplitpageSetup-{#AppVersion}
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; The app is a page in a browser, so there is nothing sensible to show for a
; 32-bit/64-bit split beyond where it lands.
AppReadmeFile={app}\README.md

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"
Name: "libraryicon"; Description: "Also add a ""document library"" shortcut (keeps scripts in one folder instead of separate files)"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; Everything comes from the staged release, so the installer and the portable
; zip can never drift apart.
Source: "..\dist\splitpage-{#AppVersion}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "icon.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "Open Splitpage in your browser"
Name: "{group}\Splitpage (document library)"; Filename: "{app}\{#AppExe}"; Parameters: "--library --data ""{localappdata}\Splitpage\data"""; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Comment: "Keep scripts in one folder instead of separate files"; Tasks: libraryicon
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Description: "Start {#AppName} now"; Flags: nowait postinstall skipifsilent

; NO [UninstallDelete] SECTION, deliberately. The obvious candidate is
; {app}\data, and it is a trap: the library shortcut points somewhere else
; ({localappdata}\Splitpage\data), but anyone who runs `start.bat --library`
; by hand gets their scripts in {app}\data, and an uninstaller that tidies
; that away deletes their writing. Uninstalling an editor must never do that,
; so the folder is left standing and the user can delete it themselves.

[Messages]
FinishedLabel=Splitpage is installed.%n%nStarting it opens a small server window and your browser. In Chrome or Edge, click the install icon in the address bar to give Splitpage its own app window and a taskbar entry. Leave the server window open while you work.
