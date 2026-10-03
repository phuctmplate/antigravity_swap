# Antigravity Swap ⚡

**Antigravity Swap** is a high-performance extension for **Antigravity IDE** that enables **seamless multi-account switching without reloading the IDE window** and provides **real-time per-model quota tracking** along with **overall combined quota statistics across all accounts**.

---

## ✨ Key Features

- 🔄 **Zero-Reload Fast Account Switching**: Switch between multiple Google / Antigravity accounts instantly without reloading or restarting your IDE window.
- 📊 **Real-time Per-Model Quota Tracking**: View live remaining balance (%) and countdown reset timers for every model (Gemini 3.7 Flash High/Low, Gemini 3 Flash, Claude 3.7 Sonnet / Opus Thinking, GPT-OSS 120B, etc.).
- 🌐 **Overall Quota Across All Accounts**: Real-time gauge computing your combined aggregate quota capacity across every registered account.
- ⚡ **Automated Background Token Refresh**: Handles OAuth access token expiration in the background without interrupting your workflow.
- 🤖 **Auto-Switch on Low Quota**: Automatically switches to another healthy account when your active account reaches a low balance threshold.
- 🎨 **Ultra-Modern Cyberpunk / Glassmorphic UI**: Beautiful sidebar dashboard with radial SVG gauges, animated gradient progress bars, active account cards, and quick action bars.
- 💡 **Status Bar Widget & Quick Menu**: Monitor active account quota and overall quota at a glance right in the status bar with 1-click QuickPick switching.
- 🔍 **Auto-Discovery**: Detects and imports previously logged in accounts from your local Antigravity IDE configuration automatically.

---

## 🚀 Installation & Building

```bash
cd "antigravity_swap"

# 1. Install dependencies
npm install

# 2. Build the extension bundle
npm run build

# 3. (Optional) Package to .vsix
npx @vscode/vsce package
```

To install directly in Antigravity IDE for development:
- Press `F5` inside Antigravity IDE to launch the Extension Development Host, or
- Copy the folder into `~/.antigravity-ide/extensions/antigravity-swap-1.0.0` or install the generated `.vsix` file via `Extensions: Install from VSIX...`.

---

## 🛠 Available Commands

| Command | Title | Description |
| :--- | :--- | :--- |
| `antigravitySwap.switchAccount` | **Switch Active Account** | Switch between accounts instantly without reloading |
| `antigravitySwap.addAccount` | **Add Account (Google OAuth)** | Connect a new account via Google OAuth web flow |
| `antigravitySwap.addAccountManual` | **Add Account Manually** | Paste Access Token / Refresh Token manually |
| `antigravitySwap.refreshQuotas` | **Refresh All Account Quotas** | Fetch fresh quota balances from cloud server |
| `antigravitySwap.openDashboard` | **Open Quota Dashboard** | Open the rich sidebar dashboard |
| `antigravitySwap.importExistingAccounts` | **Import Detected Accounts** | Auto-detect existing accounts from local IDE database |

---

## ⚙️ Configuration Settings

- `antigravitySwap.autoRefreshIntervalMinutes`: (Default: `3`) Interval in minutes to automatically poll quota updates.
- `antigravitySwap.autoSwitchWhenQuotaLow`: (Default: `false`) Automatically switch to another account when current active quota is exhausted.
- `antigravitySwap.lowQuotaThresholdPercent`: (Default: `10`) Percentage threshold to consider an account low on quota.

---

## 🔒 Security & Privacy

All OAuth tokens and credentials are encrypted and stored inside VS Code's native secure storage (`SecretStorage`), which uses OS-level DPAPI / Keytar encryption.
