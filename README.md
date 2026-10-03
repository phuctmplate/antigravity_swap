# Antigravity Swap ⚡

**Antigravity Swap** is a high-performance extension for **Antigravity IDE** that enables **seamless multi-account switching without reloading the IDE window**, provides **real-time per-model quota tracking**, and displays **overall combined capacity across all accounts**.

---

## ✨ Key Features

- 🔄 **Zero-Reload Fast Account Switching**: Switch between multiple Google / Antigravity accounts instantly without reloading or restarting your IDE window.
- ⚡ **1-Click Import from Antigravity**: Auto-detects and imports the currently logged-in account and active session tokens directly from Antigravity IDE's local storage.
- 📊 **Real-Time Per-Model Quota Tracking**: View live remaining balance (%) and countdown reset timers for every model (Gemini 2.5/3.0, Claude 3.7 Sonnet / Opus, GPT models, etc.).
- ⏱ **5-Hour Rolling & Weekly Quota Support**: Displays distinct 5-Hour rolling window and Weekly plan balance breakdowns for Pro / Enterprise accounts.
- 🗂️ **Smart Tier & Alphabetical Sorting**: Default view intelligently prioritizes Ultra &rarr; Pro &rarr; Free tiers (with alphabetical ordering within each tier), with instant toggle for pure alphabetical sorting (A-Z / Z-A).
- 🪟 **Pop-Out Floating Dashboard**: Detach the dashboard into a native floating auxiliary OS window with one click to monitor quotas side-by-side with your code editor.
- 🖥️ **Responsive Wide-Screen Layout**: On wide displays, account cards and model quota breakdowns sit side-by-side with a responsive multi-column model grid.
- 🔍 **Search, Filter & Batch Management**: Filter accounts by status/tier, search in real-time, and batch-select multiple accounts for 1-click removal.
- 🛡️ **Account Health & Ban Detection**: Monitors Google TOS ban/suspension status, credential expiry, and provides 1-click **Re-login / Reconnect**.
- 🌐 **Overall Aggregate Capacity**: Real-time radial SVG gauge calculating your total capacity across every registered account.
- 🤖 **Auto-Switch on Low Quota**: Automatically switches to another healthy account when your active account reaches a low balance threshold.
- 💓 **Silent Background Heartbeat & Rate Limiting**: Intelligent background polling keeps account health fresh with debounce protection against rapid manual refreshes.
- 💡 **Status Bar Widget & Quick Menu**: Clean active account status and quota balance in the status bar with a 1-click QuickPick menu.

---

## 🛠 Available Commands

| Command | Title | Description |
| :--- | :--- | :--- |
| `antigravitySwap.openDashboard` | **Open Quota Dashboard** | Open the rich dashboard in the sidebar |
| `antigravitySwap.popOutDashboard` | **Pop Out Dashboard** | Detach the dashboard into a native floating window |
| `antigravitySwap.switchAccount` | **Switch Active Account** | Switch between accounts instantly without reloading |
| `antigravitySwap.importCurrentAntigravity` | **Import Active Antigravity Account** | 1-click import of the active session from Antigravity IDE |
| `antigravitySwap.reloginAccount` | **Re-login / Reconnect Account** | Re-authenticate or reconnect an expired account |
| `antigravitySwap.addAccount` | **Add Account (Google OAuth)** | Connect a new account via Google OAuth web flow |
| `antigravitySwap.addAccountManual` | **Add Account Manually** | Paste Access Token / Refresh Token manually |
| `antigravitySwap.refreshQuotas` | **Refresh All Account Quotas** | Fetch fresh quota balances from cloud server |
| `antigravitySwap.importExistingAccounts` | **Import Detected Accounts** | Auto-detect accounts from local IDE database |

---

## ⚙️ Configuration Settings

- `antigravitySwap.heartbeatIntervalSeconds`: (Default: `30`) Heartbeat interval in seconds to poll quota health and detect expired/banned accounts.
- `antigravitySwap.autoSwitchWhenQuotaLow`: (Default: `false`) Automatically switch to another account when current active quota is exhausted.
- `antigravitySwap.lowQuotaThresholdPercent`: (Default: `5`) Percentage threshold below which the active account triggers auto-switching to another healthy account.

---

## 🔒 Security & Privacy

All OAuth tokens and credentials are encrypted and stored inside VS Code's native secure storage (`SecretStorage`), which uses OS-level DPAPI / Keytar encryption. No sensitive tokens are exposed or written to disk in plain text.

---

## 🏗️ Development & Build

### Prerequisites

- **Node.js** &ge; 18
- **npm** &ge; 9
- **Antigravity IDE** (VS Code-compatible, engine `^1.90.0`)

### Setup

```bash
git clone https://github.com/phuctmplate/antigravity_swap
cd antigravity_swap
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
| `npm run build:webview` | Vite build only &mdash; outputs single-file `dist/webview/index.html` |
| `npm run build:extension` | esbuild only &mdash; outputs `dist/extension.js` |

### Package as `.vsix`

```bash
npx @vscode/vsce package --no-dependencies
```

This generates `antigravity-swap-1.0.0.vsix` in the project root.

### Install locally

```bash
code --install-extension antigravity-swap-1.0.0.vsix --force
```

Then reload the IDE window: `Ctrl+Shift+P` &rarr; **Developer: Reload Window**.

---

## 📁 Project Structure

```
antigravity_swap/
├── src/
│   ├── extension.ts            # Extension entry point & command registration
│   ├── webviewProvider.ts      # Webview panel & sidebar provider
│   ├── accountManager.ts       # Multi-account state & token switching
│   ├── quotaService.ts         # Google Cloud Code quota API parser & polling
│   ├── storage.ts              # SecretStorage & local state persistence
│   ├── constants.ts            # Client credentials & application constants
│   ├── heartbeatService.ts     # Background quota health checker
│   ├── statusBar.ts            # Status bar item & quick menu
│   └── webview/                # Modern React webview app (Vite + Tailwind)
│       └── src/
│           ├── App.tsx
│           ├── components/     # UI components (AccountList, ModelQuotas, Card, etc.)
│           └── lib/            # Quota color helpers & formatters
├── dist/                       # Compiled production bundles
├── package.json
└── vite.config.ts
```

