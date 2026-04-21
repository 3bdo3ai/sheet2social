!macro customInstall
  ; Remove legacy shortcut names from older installer versions.
  Delete "$DESKTOP\\Sheet2Social.lnk"
  Delete "$SMPROGRAMS\\Sheet2Social.lnk"
  Delete "$SMPROGRAMS\\Sheet2Social\\Sheet2Social.lnk"
!macroend

!macro customUnInstall
  ; Remove legacy shortcut names during uninstall as well.
  Delete "$DESKTOP\\Sheet2Social.lnk"
  Delete "$SMPROGRAMS\\Sheet2Social.lnk"
  Delete "$SMPROGRAMS\\Sheet2Social\\Sheet2Social.lnk"
!macroend
