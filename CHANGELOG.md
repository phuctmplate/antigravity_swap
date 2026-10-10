# Changelog

## 1.2.3 (2026-10-10)

- Refined status bar tooltip with a clearer layout and more accurate session quota details.
- Fixed newly added accounts displaying 0% Total Quota before metrics are fetched, preventing uninitialized accounts from skewing Instant and Overall pool gauges.

## 1.2.2 (2026-10-10)

- Improved instant quota calculation logic for better accuracy and responsiveness.
- Refined notification delivery and in-app feedback behavior.
- Enhanced header overview gauges, layout spacing, and tooltip descriptions for clearer status visibility.

## 1.2.1 (2026-10-10)

- Optimized OAuth session lifecycle and multi-instance authentication handling.
- Improved responsive layout for narrow sidebar widths.
- UI/UX refinements and polished component styling.
- Enhanced account import feedback and stability.

## 1.2.0 (2026-10-08)

- Weekly Quota Protection: Automatically switches accounts before weekly model quota runs out to prevent lockout even if 5-hour rolling quota is still available.
- Smarter Candidate Ranking: Prioritizes healthy accounts with both sufficient rolling window and weekly quota reserves.
- Fixed auto-switch threshold input flickering.
- Optimized background quota refresh.
- Improved account cards.

## 1.1.0 (2026-10-05)

- Real-time multi-instance state synchronization across open IDE windows.
- Introduce Instant Quota (5-hour window) and Overall Quota (weekly plan) dual circular gauges.
- Bidirectional settings synchronization with VS Code configuration.
- Set default auto-switch target to Gemini and threshold to 2%.
- UI/UX refinements and improved dashboard layout.

## 1.0.0 (2026-10-03)

- Multi-account management with zero-reload switching.
- Real-time per-model quota tracking and countdown reset timers.
- Google OAuth login and manual token authentication.
- Customizable auto-switching on quota depletion.
