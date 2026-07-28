; Custom NSIS header. electron-builder includes build/installer.nsh by default
; (nsis.include), inserting it at the customHeader hook in its installer.nsi —
; which is AFTER common.nsh, so anything set here wins.
;
; WHY: the installer never said which version it was installing. The download is
; served from a stable, unversioned URL (ScarmVoice-Setup.exe — that filename is
; load-bearing, it is what releases/latest/download resolves to, so the version
; cannot go in the name), and a one-click install shows no wizard pages to put it
; on. So the only two places left are the title bar and the branding strip, and
; the title bar is the one people actually see.
;
; ${VERSION} and ${PRODUCT_NAME} are defined by electron-builder itself —
; common.nsh already builds BrandingText out of the same two.

!macro customHeader
  ; Guarded: this same script is run a second time with BUILD_UNINSTALLER
  ; defined to produce the uninstaller stub, and calling that window "Setup"
  ; would be a lie in the one place a user is least amused by one.
  !ifndef BUILD_UNINSTALLER
    Caption "${PRODUCT_NAME} ${VERSION} Setup"
  !endif
!macroend
