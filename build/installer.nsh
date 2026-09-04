!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Set up AI Usage"
  !define MUI_WELCOMEPAGE_TEXT "Install AI Usage for your Windows account.$\r$\n$\r$\nAfter installation, the app guides you through Claude Code installation, signing into your Claude subscription, and your first refresh.$\r$\n$\r$\nClaude Code is downloaded from Anthropic only when you choose to install it. Internet access is required for installation and account sign-in. You can skip Claude setup and complete it later in Settings.$\r$\n$\r$\nExisting AI Usage data is kept when upgrading."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!define MUI_FINISHPAGE_RUN_TEXT "Open AI Usage and set up usage tracking"
