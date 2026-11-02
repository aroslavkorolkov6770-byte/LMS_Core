!macro customUnInstall
  nsExec::ExecToLog '"$INSTDIR\resources\tools\node\node.exe" "$INSTDIR\resources\stop-desktop.cjs"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "LMS Core: close the application and stop its local services, then retry. Your data has not been deleted."
    Abort
  ${EndIf}
!macroend
