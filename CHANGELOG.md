# Changelog

## 1.3.0 (2026-10-13)

- **Instant Quota Concept**: Introduced the Instant Quota architecture representing immediately usable burst capacity right now, combining the 5-hour rolling burst window with weekly capacity modulation to prevent lockout.
- **UI Rebalancing**: Refined twin half-circle gauges, chart contrast, softened active card colors, and updated shadow opacity.

## 1.2.3 (2026-10-10)

- **Status Bar Tooltip**: Refined layout and displayed more accurate session quota details.
- **Account Initialization**: Fixed newly added accounts displaying 0% Total Quota before metrics are fetched, preventing uninitialized accounts from skewing pool gauges.

## 1.2.2 (2026-10-10)

- **Instant Quota Logic**: Improved calculation accuracy and responsiveness for session quotas.
- **Notification Behavior**: Refined notification delivery and in-app feedback interactions.
- **Overview Gauges**: Enhanced layout spacing, gauge scaling, and status tooltips.

## 1.2.1 (2026-10-10)

- **OAuth Lifecycle**: Optimized token management and multi-instance authentication handling.
- **Responsive Layout**: Improved sidebar adaptability for narrow viewport widths.
- **UI/UX Polishing**: Refined component styling, borders, and interaction states.
- **Account Import**: Enhanced detection feedback and stability during batch imports.

## 1.2.0 (2026-10-08)

- **Weekly Quota Protection**: Automatically switches accounts before weekly quota runs out to prevent lockout even if 5-hour rolling quota remains.
- **Candidate Ranking**: Prioritizes healthy accounts with both sufficient rolling window and weekly reserves.
- **Threshold Input**: Fixed auto-switch percentage input flickering.
- **Background Refresh**: Optimized periodic quota heartbeat polling.
- **Account Cards**: Refined card visuals, status indicators, and badges.

## 1.1.0 (2026-10-05)

- **State Synchronization**: Enabled real-time multi-instance state syncing across open IDE windows.
- **Dual Gauges**: Introduced dual circular gauges for Instant Quota (5-hour window) and Overall Quota (weekly plan).
- **Settings Sync**: Added bidirectional synchronization with VS Code workspace configuration.
- **Auto-Switch Defaults**: Set default auto-switch target to Gemini and threshold to 2%.
- **Dashboard Refinements**: Polished layout spacing, action buttons, and component styling.

## 1.0.0 (2026-10-03)

- **Zero-Reload Switching**: Seamless multi-account management without reloading the IDE window.
- **Quota Tracking**: Real-time per-model quota tracking and countdown reset timers.
- **Authentication**: Added Google OAuth login and manual token authentication support.
- **Automated Switching**: Customizable auto-switch policies on quota depletion.
