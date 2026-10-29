# Changelog

## 2.1.0 (2026-10-29)

- **Seamless Switching for New Antigravity IDE**: Fixed and restored zero-reload seamless account switching for the new Antigravity IDE versions.
- **Reliable Auto-Switch**: Smarter candidate failover with automatic verification and rollback.

## 2.0.1 (2026-10-28)

- **Quota Accuracy**: Fix quota calculation

## 2.0.0 (2026-10-21)

- **Performance & Reliability**: Re-engineered core engine architecture to deliver improved responsiveness, lower resource usage, and rock-solid operational stability.
- **Multi-Window Synchronization**: Enhanced real-time synchronization across multiple open IDE windows, ensuring seamless and conflict-free account management.
- **Smart Background Sync**: Optimized automatic quota refreshing by prioritizing the active account and skipping redundant network requests when accounts are already up-to-date across IDE instances.
- **Configuration Hardening**: Removed the configurable heartbeat interval setting (`antigravitySwap.heartbeatIntervalSeconds`) to lock periodic health checks to an optimal, rate-limit-safe internal cadence.

## 1.3.2 (2026-10-16)

- **Quota Synchronization & 5-Hour Retention**: Fixed missing 5-hour rolling limits and inaccurate depletion warnings by prioritizing production endpoints and resolving batch refresh race conditions.
- **Pool & Metric Reliability**: Hardened account tier detection and prevented uninitialized metrics from skewing capacity pools.
- **Responsive Layout**: Enabled adaptive vertical wrapping for hero gauges and model overview cards on narrow sidebar viewports.

## 1.3.1 (2026-10-14)

- **Quota Modulation**: Calibrated model-specific safe weekly thresholds for Gemini and Claude & GPT.
- **UI**: Fix dialog overflow, simplified pool quota text.

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
