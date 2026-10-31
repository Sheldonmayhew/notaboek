; electron-builder's fileAssociations option makes the app the registered default
; for each type, and doesn't restore the previous value on uninstall. Folio should
; never take over .txt, so this only lists it under "Open with".
;
; Applications\Folio.exe alone isn't enough: for a type with a protected default,
; such as .txt, Windows then sends Open with to its own picker. A document type
; named under OpenWithProgids launches directly, and leaves the default alone.
;
; The default folder is kept in a file beside the user's settings, which the app
; reads and changes too. It's the user's, so uninstalling leaves it and the folder.

!include nsDialogs.nsh

!define FOLIO_DOCUMENT "Folio.Document"
!define FOLIO_FOLDER_FILE "$APPDATA\Folio\default-folder.txt"

!ifndef BUILD_UNINSTALLER
  Var FolioDefaultFolder
  Var FolioFolderBox
!endif

; $APPDATA and $DOCUMENTS follow the install mode, but these belong to the person
; installing. SHELL_CONTEXT follows it too, so it has to go back afterwards.
!macro folioRestoreInstallMode
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom folioFolderPage folioFolderLeave

  Function folioFolderPage
    ${If} ${isUpdated}
      Abort
    ${EndIf}

    ; Back and Next show this page again, and shouldn't undo a choice.
    ${If} $FolioDefaultFolder == ""
      SetShellVarContext current
      StrCpy $FolioDefaultFolder "$DOCUMENTS\Folio"
      ClearErrors
      FileOpen $0 "${FOLIO_FOLDER_FILE}" r
      ${IfNot} ${Errors}
        FileReadUTF16LE $0 $1
        FileClose $0
        ${If} $1 != ""
          StrCpy $FolioDefaultFolder $1
        ${EndIf}
      ${EndIf}
      !insertmacro folioRestoreInstallMode
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "Choose a default folder" "This is where Folio keeps your new pages."
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 34u "New pages that aren't part of a folder you've opened are saved here. Click Browse to pick a different folder. You can change this later in Folio."
    Pop $0
    ${NSD_CreateText} 0 42u 236u 13u $FolioDefaultFolder
    Pop $FolioFolderBox
    ${NSD_CreateBrowseButton} 242u 41u 58u 15u "Browse..."
    Pop $0
    ${NSD_OnClick} $0 folioFolderBrowse
    nsDialogs::Show
  FunctionEnd

  ; nsDialogs only offers the old folder tree. The picker that looks like File
  ; Explorer has to be reached through COM, so the numbers are IFileOpenDialog and
  ; IShellItem method slots.
  Function folioFolderBrowse
    Pop $0
    ${NSD_GetText} $FolioFolderBox $3
    System::Call 'ole32::CoCreateInstance(g "{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}", p 0, i 1, g "{D57C7288-D4AD-4768-BE02-9D969532D960}", *p .r1) i .r0'
    ${If} $0 != 0
      nsDialogs::SelectFolderDialog "Choose a default folder" $3
      Pop $0
      ${If} $0 != error
        ${NSD_SetText} $FolioFolderBox $0
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
          ${NSD_SetText} $FolioFolderBox $0
          System::Call 'ole32::CoTaskMemFree(p r3)'
        ${EndIf}
        System::Call '$2->2()' ; Release
      ${EndIf}
    ${EndIf}
    System::Call '$1->2()' ; Release
  FunctionEnd

  ; Creating the folder is the only real test of a typed path. The install starts
  ; straight after this page, so an accepted folder can't be left unused.
  Function folioFolderLeave
    ${NSD_GetText} $FolioFolderBox $FolioDefaultFolder
    StrCpy $0 $FolioDefaultFolder 2 1
    StrCpy $1 $FolioDefaultFolder 2
    ClearErrors
    ${If} $0 == ":\"
    ${OrIf} $1 == "\\"
      CreateDirectory $FolioDefaultFolder
    ${Else}
      SetErrors
    ${EndIf}
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Folio can't use that folder. Choose a full path, such as C:\Notes, that you're allowed to write to."
      Abort
    ${EndIf}
  FunctionEnd
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "Folio"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".md" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".markdown" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".txt" ""

  WriteRegStr SHELL_CONTEXT "Software\Classes\${FOLIO_DOCUMENT}" "" "Text document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FOLIO_DOCUMENT}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FOLIO_DOCUMENT}\shell\open" "FriendlyAppName" "Folio"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${FOLIO_DOCUMENT}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids" "${FOLIO_DOCUMENT}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.markdown\OpenWithProgids" "${FOLIO_DOCUMENT}"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.txt\OpenWithProgids" "${FOLIO_DOCUMENT}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ; Empty when the page didn't run, as in a silent install. The app then uses
  ; whatever was chosen before, or Documents\Folio.
  ${If} $FolioDefaultFolder != ""
    Push $0
    SetShellVarContext current
    CreateDirectory "$APPDATA\Folio"
    ClearErrors
    FileOpen $0 "${FOLIO_FOLDER_FILE}" w
    ${IfNot} ${Errors}
      FileWriteUTF16LE /BOM $0 $FolioDefaultFolder
      FileClose $0
    ${EndIf}
    !insertmacro folioRestoreInstallMode
    Pop $0
  ${EndIf}
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"

  DeleteRegValue SHELL_CONTEXT "Software\Classes\.md\OpenWithProgids" "${FOLIO_DOCUMENT}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.markdown\OpenWithProgids" "${FOLIO_DOCUMENT}"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.txt\OpenWithProgids" "${FOLIO_DOCUMENT}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${FOLIO_DOCUMENT}"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
