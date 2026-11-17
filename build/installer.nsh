; electron-builder's fileAssociations option makes the app the registered default
; for each type, and doesn't restore the previous value on uninstall. Notaboek should
; never take over .txt, so this only lists it under "Open with".
;
; Applications\Notaboek.exe alone isn't enough: for a type with a protected default,
; such as .txt, Windows then sends Open with to its own picker. A document type
; named under OpenWithProgids launches directly, and leaves the default alone.
;
; The default folder is kept in a file beside the user's settings, which the app
; reads and changes too. It's the user's, so uninstalling leaves it and the folder.

!include nsDialogs.nsh

!define NOTABOEK_DOCUMENT "Notaboek.Document"
!define NOTABOEK_CAPABILITIES "Software\Notaboek\Capabilities"
!define NOTABOEK_FOLDER_FILE "$APPDATA\Notaboek\default-folder.txt"
!define OLD_FOLDER_FILE "$APPDATA\Folio\default-folder.txt"

!ifndef BUILD_UNINSTALLER
  Var NotaboekDefaultFolder
  Var NotaboekFolderBox
!endif

; $APPDATA and $DOCUMENTS follow the install mode, but these belong to the person
; installing. SHELL_CONTEXT follows it too, so it has to go back afterwards.
!macro notaboekRestoreInstallMode
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom notaboekFolderPage notaboekFolderLeave

  Function notaboekFolderPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}

    ; Back and Next show this page again, and shouldn't undo a choice.
    ${If} $NotaboekDefaultFolder == ""
      SetShellVarContext current
      StrCpy $NotaboekDefaultFolder "$DOCUMENTS\Notaboek"
      ClearErrors
      FileOpen $0 "${NOTABOEK_FOLDER_FILE}" r
      ; Someone coming from the previous app keeps the folder they chose back then.
      ${If} ${Errors}
        ClearErrors
        FileOpen $0 "${OLD_FOLDER_FILE}" r
      ${EndIf}
      ${IfNot} ${Errors}
        FileReadUTF16LE $0 $1
        FileClose $0
        ${If} $1 != ""
          StrCpy $NotaboekDefaultFolder $1
        ${EndIf}
      ${EndIf}
      !insertmacro notaboekRestoreInstallMode
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "Choose a default folder" "This is where Notaboek keeps your new pages."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 34u "New pages that aren't part of a folder you've opened are saved here. Click Browse to pick a different folder. You can change this later in Notaboek."
    Pop $0
    ${NSD_CreateText} 0 42u 236u 13u $NotaboekDefaultFolder
    Pop $NotaboekFolderBox
    ${NSD_CreateBrowseButton} 242u 41u 58u 15u "Browse..."
    Pop $0
    ${NSD_OnClick} $0 notaboekFolderBrowse
    nsDialogs::Show
  FunctionEnd

  ; nsDialogs only offers the old folder tree. The picker that looks like File
  ; Explorer has to be reached through COM, so the numbers are IFileOpenDialog and
  ; IShellItem method slots.
  Function notaboekFolderBrowse
    Pop $0
    ${NSD_GetText} $NotaboekFolderBox $3
    System::Call 'ole32::CoCreateInstance(g "{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}", p 0, i 1, g "{D57C7288-D4AD-4768-BE02-9D969532D960}", *p .r1) i .r0'
    ${If} $0 != 0
      nsDialogs::SelectFolderDialog "Choose a default folder" $3
      Pop $0
      ${If} $0 != error
        ${NSD_SetText} $NotaboekFolderBox $0
      ${EndIf}
      Return
    ${EndIf}

    System::Call '$1->10(*i .r0)' ; GetOptions
    IntOp $0 $0 | 0x60 ; FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    System::Call '$1->9(i r0)' ; SetOptions
    System::Call '$1->17(w "Choose a default folder")' ; SetTitle
    System::Call 'shell32::SHCreateItemFromParsingName(w r3, p 0, g "{43826D1E-E718-42EE-BC55-A1E261C37BFE}", *p .r2) i .r0'
    ${If} $0 = 0
      System::Call '$1->12(p r2)' ; SetFolder
      System::Call '$2->2()' ; Release
    ${EndIf}

    System::Call '$1->3(p $HWNDPARENT) i .r0' ; Show
    ${If} $0 = 0
      System::Call '$1->20(*p .r2) i .r0' ; GetResult
      ${If} $0 = 0
        System::Call '$2->5(i 0x80058000, *p .r3) i .r0' ; GetDisplayName, SIGDN_FILESYSPATH
        ${If} $0 = 0
          System::Call '*$3(&w${NSIS_MAX_STRLEN} .r0)'
          ${NSD_SetText} $NotaboekFolderBox $0
          System::Call 'ole32::CoTaskMemFree(p r3)'
        ${EndIf}
        System::Call '$2->2()' ; Release
      ${EndIf}
    ${EndIf}
    System::Call '$1->2()' ; Release
  FunctionEnd

  ; Creating the folder is the only real test of a typed path. The install starts
  ; straight after this page, so an accepted folder can't be left unused.
  Function notaboekFolderLeave
    ${NSD_GetText} $NotaboekFolderBox $NotaboekDefaultFolder
    StrCpy $0 $NotaboekDefaultFolder 2 1
    StrCpy $1 $NotaboekDefaultFolder 2
    ClearErrors
    ${If} $0 == ":\"
    ${OrIf} $1 == "\\"
      CreateDirectory $NotaboekDefaultFolder
    ${Else}
      SetErrors
    ${EndIf}
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Notaboek can't use that folder. Choose a full path, such as C:\Notes, that you're allowed to write to."
      Abort
    ${EndIf}
  FunctionEnd
!macroend

; Every extension Notaboek opens as a page, as listed in src/shared/fileTypes.ts.
!macro notaboekForEachType ACTION
  !insertmacro ${ACTION} ".md"
  !insertmacro ${ACTION} ".markdown"
  !insertmacro ${ACTION} ".mdown"
  !insertmacro ${ACTION} ".mkd"
  !insertmacro ${ACTION} ".mkdn"
  !insertmacro ${ACTION} ".mdwn"
  !insertmacro ${ACTION} ".mdtext"
  !insertmacro ${ACTION} ".mdtxt"
  !insertmacro ${ACTION} ".rmd"
  !insertmacro ${ACTION} ".qmd"
  !insertmacro ${ACTION} ".txt"
  !insertmacro ${ACTION} ".text"
  !insertmacro ${ACTION} ".csv"
  !insertmacro ${ACTION} ".tsv"
  !insertmacro ${ACTION} ".taskpaper"
  !insertmacro ${ACTION} ".pdf"
  !insertmacro ${ACTION} ".docx"
!macroend

!macro notaboekRegisterType EXT
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${EXT}" ""
  WriteRegNone SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "${NOTABOEK_DOCUMENT}"
  WriteRegStr SHELL_CONTEXT "${NOTABOEK_CAPABILITIES}\FileAssociations" "${EXT}" "${NOTABOEK_DOCUMENT}"
!macroend

!macro notaboekUnregisterType EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "${NOTABOEK_DOCUMENT}"
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Notaboek"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr SHELL_CONTEXT "Software\Classes\${NOTABOEK_DOCUMENT}" "" "Text document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${NOTABOEK_DOCUMENT}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${NOTABOEK_DOCUMENT}\shell\open" "FriendlyAppName" "Notaboek"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${NOTABOEK_DOCUMENT}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; Puts the app in Settings > Apps > Default apps, where someone can choose it.
  ; This only offers it. The defaults themselves stay as they are.
  WriteRegStr SHELL_CONTEXT "${NOTABOEK_CAPABILITIES}" "ApplicationName" "Notaboek"
  WriteRegStr SHELL_CONTEXT "${NOTABOEK_CAPABILITIES}" "ApplicationDescription" "A calm, block-style editor for Markdown, text, CSV and TaskPaper files, with PDF markup and Word editing."
  WriteRegStr SHELL_CONTEXT "${NOTABOEK_CAPABILITIES}" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  !insertmacro notaboekForEachType notaboekRegisterType
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "Notaboek" "${NOTABOEK_CAPABILITIES}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; Empty when the page didn't run, as in a silent install. The app then uses
  ; whatever was chosen before, or Documents\Notaboek.
  ${If} $NotaboekDefaultFolder != ""
    Push $0
    SetShellVarContext current
    CreateDirectory "$APPDATA\Notaboek"
    ClearErrors
    FileOpen $0 "${NOTABOEK_FOLDER_FILE}" w
    ${IfNot} ${Errors}
      FileWriteUTF16LE /BOM $0 $NotaboekDefaultFolder
      FileClose $0
    ${EndIf}
    !insertmacro notaboekRestoreInstallMode
    Pop $0
  ${EndIf}
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"

  !insertmacro notaboekForEachType notaboekUnregisterType
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${NOTABOEK_DOCUMENT}"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Notaboek"
  DeleteRegKey SHELL_CONTEXT "Software\Notaboek"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
