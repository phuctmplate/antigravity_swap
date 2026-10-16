# Agent Guidelines & Rules

## Git & Version Control Rules
- **No Automatic Git Commits**: Do NOT automatically stage or commit changes to git unless the user explicitly requests to "make commit", "make commits", "commit", or similar explicit instructions for the current change. Prior permission does NOT carry over to subsequent edits.
- **No Automatic Git Push or Tagging**: Do NOT automatically run `git push` or create/push `git tag` unless the user explicitly asks to "push", "git push", "push tags", or similar explicit instructions for the current state. Never push automatically even if earlier edits were pushed. Always wait for the user's explicit instruction every single time.
- **Mandatory Pre-Commit Sensitive Data Scan & Approval**: Before executing any `git commit`, the agent MUST ALWAYS perform a pre-commit audit scan for sensitive personal data (real personal email addresses, personal names, custom domains, OAuth access/refresh tokens, API keys, credentials, or private configuration) across all staged and changed files:
  - **If ANY potential sensitive personal data is detected**: The agent MUST report the exact findings to the user and **STOP immediately without committing**, waiting for the user's explicit review and approval or sanitization instructions.
  - **If and ONLY if the scan confirms 100% that NO sensitive personal data is present** (all values are clean, anonymized sample values like `user@example.com`, `pro.active@gmail.com`, or `Alex Rivera`), the agent may proceed with the commit normally as requested.

## Notification & UI Messaging Architecture
- **In-Webview / Dashboard Actions**: Any user-initiated interaction originating from within the Webview / Dashboard UI (such as clicking to switch accounts, manual quota refresh, batch refreshing selected accounts, deleting accounts, toggling auto-switch settings, etc.) MUST trigger **in-UI Toast notifications** (via `sonner` / `{ type: 'toast', message, level }` postMessage bridge). Redundant IDE native notifications (`vscode.window.show*`) MUST be suppressed or silenced for these in-webview operations.
- **Background Periodic Heartbeat / Polling**: Background quota refreshes (periodic timer ticks, distributed lease polling) MUST run **100% silently** without triggering any in-UI toast or IDE popup notifications. Quota data updates state quietly in memory and propagates via `stateUpdate`.
- **External & Background Auto-Switch Actions**: Critical events triggered outside the Webview (such as background automatic account switches when an account runs out of quota, Command Palette commands `Ctrl+Shift+P`, Status Bar item clicks, or external IDE authentication session changes) MUST use **native IDE notifications** (`vscode.window.showInformationMessage`, `showWarningMessage`, `showErrorMessage`).

## Language & Localization Standards
- **100% English Codebase**: All source code, user-facing UI strings, toast notifications, dialog prompts, console logs, docstrings, and comments MUST be written strictly in **English**. Never mix Vietnamese or non-English text into code or resources.

