# Antigravity Swap ⚡

**Antigravity Swap** is a high-performance extension for **Antigravity IDE** that enables **seamless multi-account switching without reloading the IDE window** and provides **real-time per-model quota tracking** along with **overall combined quota statistics across all accounts**.

---

## ✨ Key Features

- 🔄 **Zero-Reload Fast Account Switching**: Switch between multiple Google / Antigravity accounts instantly without reloading or restarting your IDE window.
- ⚡ **1-Click Import from Antigravity**: Auto-detects and imports the currently logged-in account and active session tokens directly from Antigravity IDE state database.
- 📊 **Real-time Per-Model Quota Tracking**: View live remaining balance (%) and countdown reset timers for every model (Gemini 3.7 Flash High/Low, Gemini 3 Flash, Claude 3.7 Sonnet / Opus Thinking, GPT-OSS 120B, etc.).
- ⏱ **5-Hour Rolling & Weekly Quota Support**: Displays distinct 5-Hour rolling window and Weekly plan balance breakdowns for Pro / Enterprise accounts.
- 🛡️ **Account Health & Ban Detection**: Monitors Google TOS ban/suspension status, credential expiry, and provides 1-click **Re-login / Reconnect**.
- 🌐 **Overall Aggregate Quota**: Real-time radial SVG gauge computing your combined capacity across every registered account.
- 🤖 **Auto-Switch on Low Quota**: Automatically switches to another healthy account when your active account reaches a low balance threshold.
- 💓 **Silent Background Heartbeat**: Automatic polling runs quietly under the hood to ensure background account health and prompt auto-switching.
- 🎨 **Ultra-Modern Cyberpunk / Glassmorphic UI**: Beautiful sidebar dashboard with radial SVG gauges, animated gradient progress bars, active account cards, and quick action bars.
- 💡 **Status Bar Widget & Quick Menu**: Accurate active account status and quota in the status bar with 1-click QuickPick menu.

---

## 🛠 Available Commands

| Command | Title | Description |
| :--- | :--- | :--- |
| `antigravitySwap.switchAccount` | **Switch Active Account** | Switch between accounts instantly without reloading |
| `antigravitySwap.importCurrentAntigravity` | **Import Active Antigravity Account** | 1-click import of the active session from Antigravity IDE |
| `antigravitySwap.reloginAccount` | **Re-login / Reconnect Account** | Re-authenticate or update credentials for an account |
| `antigravitySwap.addAccount` | **Add Account (Google OAuth)** | Connect a new account via Google OAuth web flow |
| `antigravitySwap.addAccountManual` | **Add Account Manually** | Paste Access Token / Refresh Token manually |
| `antigravitySwap.refreshQuotas` | **Refresh All Account Quotas** | Fetch fresh quota balances from cloud server |
| `antigravitySwap.openDashboard` | **Open Quota Dashboard** | Open the rich sidebar dashboard |
| `antigravitySwap.importExistingAccounts` | **Import Detected Accounts** | Auto-detect accounts from local IDE database |

---

## ⚙️ Configuration Settings

- `antigravitySwap.autoRefreshIntervalMinutes`: (Default: `3`) Interval in minutes to automatically poll quota updates.
- `antigravitySwap.autoSwitchWhenQuotaLow`: (Default: `false`) Automatically switch to another account when current active quota is exhausted.
- `antigravitySwap.lowQuotaThresholdPercent`: (Default: `10`) Percentage threshold to consider an account low on quota.

---

## 🔒 Security & Privacy

All OAuth tokens and credentials are encrypted and stored inside VS Code's native secure storage (`SecretStorage`), which uses OS-level DPAPI / Keytar encryption.

---

## 🏗️ Development & Build

### Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9
- **Antigravity IDE** (VS Code-compatible, engine `^1.90.0`)

### Setup

```bash
git clone https://github.com/antigravity-community/antigravity-swap
cd antigravity-swap
npm install
```

### Build

```bash
# Build both the webview (React/Vite) and extension host (esbuild)
npm run build
```

| Script | What it does |
| :--- | :--- |
| `npm run build` | Full build: webview + extension |
| `npm run build:webview` | Vite build only — outputs `dist/webview/index.html` (single-file bundle) |
| `npm run build:extension` | esbuild only — outputs `dist/extension.js` |

### Package as `.vsix`

```bash
# Requires @vscode/vsce (already in devDependencies)
npx @vscode/vsce package --no-dependencies
```

This produces `antigravity-swap-1.0.0.vsix` in the project root.

### Install locally

```bash
code --install-extension antigravity-swap-1.0.0.vsix --force
```

Then reload the IDE window: `Ctrl+Shift+P` → **Developer: Reload Window**.

### Project Structure

```
antigravity_swap/
├─ src/
│  ├─ extension.ts          # Extension entry point
│  ├─ webviewProvider.ts    # Sidebar webview host
│  ├─ accountManager.ts     # Multi-account state & switching
│  ├─ heartbeatService.ts   # Background quota polling
│  └─ webview/              # React app (Vite + Tailwind)
│     └─ src/
│        ├─ main.tsx
│        ├─ App.tsx
│        ├─ index.css
│        └─ components/
├─ dist/                    # Build output (gitignored)
│  ├─ extension.js
│  └─ webview/index.html    # Single-file inlined bundle
├─ vite.config.ts
└─ package.json
```

