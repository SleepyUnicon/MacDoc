; Build with scripts/build-installer.ps1. Install only the runtime allowlist.
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef PackageDir
  #error PackageDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif

[Setup]
AppId={{A5613067-949D-4D26-B81D-8FD6328D8A7A}
AppName=MacDoc
AppVersion={#AppVersion}
AppPublisher=MacDoc
AppPublisherURL=https://github.com/SleepyUnicon/MacDoc
AppSupportURL=https://github.com/SleepyUnicon/MacDoc/issues
DefaultDirName={localappdata}\Programs\MacDoc
DefaultGroupName=MacDoc
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
WizardStyle=modern dark
SetupIconFile=..\tray\Assets\MacDoc.ico
UninstallDisplayIcon={app}\MacDocTray.exe
UninstallDisplayName=MacDoc
OutputDir={#OutputDir}
OutputBaseFilename=MacDocSetup
Compression=lzma2
SolidCompression=yes
SetupMutex=Local\MacDoc.Setup
AppMutex=Local\MacDoc.Tray
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoDescription=MacDoc Setup

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"; Flags: unchecked
Name: autostart; Description: "Start MacDoc when I sign in to Windows"; Flags: unchecked

[Files]
Source: "{#PackageDir}\MacDocTray.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PackageDir}\MacDocHelper.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PackageDir}\node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PackageDir}\server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PackageDir}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PackageDir}\package-lock.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PackageDir}\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "config.json,*.log,*.pdb"
Source: "{#PackageDir}\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "*.apk,config.json,*.log,*.pdb"
Source: "{#PackageDir}\node_modules\ws\*"; DestDir: "{app}\node_modules\ws"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\MacDoc"; Filename: "{app}\MacDocTray.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\MacDoc"; Filename: "{app}\MacDocTray.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "MacDoc"; ValueData: """{app}\MacDocTray.exe"""; Flags: uninsdeletevalue; Tasks: autostart
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "MacDoc"; Flags: deletevalue; Tasks: not autostart

[Run]
Filename: "{app}\MacDocTray.exe"; Description: "Open MacDoc"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Messages]
FinishedHeadingLabel=MacDoc is ready.
FinishedLabel=Find MacDoc in your Windows system tray. Choose Show connection info to pair your phone, then make the dock your own.
