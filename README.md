<div align="center">
  <img src="media/icon.png" width="128" height="128" alt="Antigravity Swap Logo" />
  <h1>Antigravity Swap</h1>
  <p><b>Seamless multi-account hot-switching and real-time per-model quota tracking for Antigravity IDE</b></p>
</div>

---

**Antigravity Swap** is a high-performance extension for **Antigravity IDE** that enables **seamless multi-account switching without reloading the IDE window**, provides **real-time per-model quota tracking**, and features **intelligent auto-switching** to keep you in the flow.

---

## Preview

### Sidebar Integration, Auto-Switch & Status Bar
Integrated directly into the Antigravity IDE sidebar with Instant & Total Pool gauges, per-window 5-hour / Weekly quota breakdowns, configurable Auto-Switch target, and real-time Status Bar telemetry:

<img src="media/preview-sidebar.png" width="100%" alt="Antigravity Swap Sidebar Preview" />

### Wide Quota Dashboard & Per-Model Breakdown
Full dashboard view with responsive side-by-side account management, Instant quota health gauges, and real-time per-model monitors:

<img src="media/preview-dashboard.png" width="100%" alt="Antigravity Swap Dashboard Preview" />

---

## Key Features

- **Zero-Reload Seamless Switching**: Switch between multiple accounts instantly with zero window reload or IDE restart.
- **Explicit Account Control**: Stay in full control of your active account without unexpected automatic imports.
- **Real-Time Quota Tracking**: Monitor live quota balances across all connected accounts directly in the sidebar dashboard and status bar.
- **Decoupled Quota Windows**: Accurately tracks 5-hour rolling limits and 7-day weekly capacity across Gemini, Claude & GPT, and Argon model families.
- **Instant Quota Health**: Calculates usable burst capacity (`Account Instant`, `Gemini Instant`, `Claude & GPT Instant`) modulated by weekly reserves to keep your workflow uninterrupted.
- **Smart Auto-Switch on Low Quota**: Automatically fails over to the best available healthy account when your active quota runs low.
- **Real-Time Multi-Instance Sync**: Synchronizes active accounts and quota status across multiple open IDE windows in real time.
- **Detachable Floating Dashboard**: Pop out the dashboard into an independent native floating window to monitor quotas alongside your workspace.

---

## Available Commands

| Command | Description |
| :--- | :--- |
| **Open Quota & Account Dashboard**<br>`antigravitySwap.openDashboard` | Open the rich dashboard in the sidebar |
| **Pop Out Dashboard (Detach Window)**<br>`antigravitySwap.popOutDashboard` | Detach the dashboard into a native floating window |
| **Switch Active Account**<br>`antigravitySwap.switchAccount` | Switch between accounts instantly without reloading |
| **Re-login / Reconnect Account**<br>`antigravitySwap.reloginAccount` | Re-authenticate or recover a session marked Not Verified |
| **Add Account (Google OAuth)**<br>`antigravitySwap.addAccount` | Connect a new account via Google OAuth web flow |
| **Add Account (Paste Refresh/Access Token)**<br>`antigravitySwap.addAccountManual` | Add or update an account using an Access / Refresh Token |
| **Refresh All Account Quotas**<br>`antigravitySwap.refreshQuotas` | Fetch fresh quota balances from cloud services |
| **Restore Original Antigravity IDE Extension**<br>`antigravitySwap.restoreOriginalIdeExtension` | Revert legacy IDE extension patch back to pristine backup |
| **Enable Antigravity IDE Extension Patch**<br>`antigravitySwap.enableIdeExtensionPatch` | Re-enable legacy zero-reload extension patch where applicable |

---

## Configuration Settings

Configure these options in your VS Code / Antigravity IDE `settings.json`:

- `antigravitySwap.enableIdeExtensionPatch`: (Default: `true`) Enables self-healing session synchronization for seamless zero-reload switching.
- `antigravitySwap.autoSwitchWhenQuotaLow`: (Default: `false`) Automatically switch to another healthy account when current active quota is exhausted.
- `antigravitySwap.lowQuotaThresholdPercent`: (Default: `5`) Percentage threshold (0-100%) at or below which auto-switch is triggered.
- `antigravitySwap.autoSwitchTarget`: (Default: `"gemini"`) Quota target to monitor for auto-switching:
  - `"instant"`: Overall account usable burst quota across all models.
  - `"gemini"`: Gemini Instant Quota (5-hour window modulated by weekly capacity).
  - `"claude"`: Claude & GPT Instant Quota (5-hour window modulated by weekly capacity).

---

## IDE Session Integration & Manual Restoration

### How Does Zero-Reload Hot-Switching Work?
Antigravity IDE was originally designed for a single static login session. When dynamically switching accounts, the default session listener would normally require a full window reload.

Antigravity Swap integrates seamlessly with Antigravity IDE:
- **Instant Live Switching**: Updates the active account credentials and session state in real time so the IDE immediately adopts the new account with **zero window reload**.
- **Session Verification & Rollback**: Verifies the switched session cleanly and protects your workflow against expired or unverified credentials.
- **No Interruption**: Continue editing code and chatting with the AI agent immediately with no IDE restart.

### Pristine Backup & Restoration Guide
Before applying session optimization, an untouched pristine backup (`extension.js.bak`) is **always created automatically**.

**Default Backup Paths:**
- **Windows**:
  ```plaintext
  %LOCALAPPDATA%\Programs\Antigravity IDE\resources\app\extensions\antigravity\dist\extension.js.bak
  ```
- **macOS / Linux**:
  ```plaintext
  ~/.local/share/antigravity/resources/app/extensions/antigravity/dist/extension.js.bak
  ```

**How to restore original files:**
1. **1-Click (Recommended)**: Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`), run **`Antigravity Swap: Restore Original IDE Extension`**, then reload window.
2. **Manual Restoration**: Navigate to the directory above, delete `extension.js`, and rename `extension.js.bak` back to `extension.js`.

---

## Security & Privacy

All OAuth tokens and credentials are encrypted and stored inside native OS secure storage (`SecretStorage` via DPAPI / Keytar). Direct quota requests connect strictly over authenticated HTTPS. No sensitive tokens or private configurations are ever sent to third parties or written unencrypted to disk.

---

## Disclaimer & Limitation of Liability

> [!CAUTION]
> **Use at Your Own Discretion**
> 
> - **Antigravity Swap** is an independent, community-developed third-party extension and is **not affiliated with, endorsed by, sponsored by, or officially supported by Google, DeepMind, or Codeium**.
> - This software is provided **"as is"**, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, or non-infringement.
> - The developers and contributors of this extension **assume NO responsibility or liability** for:
>   1. Any account restrictions, suspensions, rate limits, or bans imposed by service providers.
>   2. Any unintended behavior, data loss, IDE crashes, or system instability resulting from modifying local preferences or multi-account usage.
> - You are solely responsible for complying with the respective Terms of Service, Acceptable Use Policies, and rate limits of Google and Antigravity.
