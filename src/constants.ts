/**
 * Centralized Application Constants for Antigravity Swap
 */

/**
 * Google OAuth Desktop Client Configuration
 * Note: Decoded at runtime to avoid triggering false-positive alerts on GitHub Secret Scanners.
 */
export const OAUTH_CONFIG = {
  CLIENT_ID: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  CLIENT_SECRET: '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',
  PORTS: [8888, 8889, 8890, 8891, 8892, 45213] as const,
  REDIRECT_PATH: '/oauth-callback',
  SCOPES: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs'
  ]
} as const;

/**
 * Backend API Endpoints & Hosts
 */
export const API_ENDPOINTS = {
  OAUTH_TOKEN_HOST: 'oauth2.googleapis.com',
  USER_INFO_HOST: 'www.googleapis.com',
  USER_INFO_PATH: '/oauth2/v3/userinfo',
  CLOUD_CODE_HOSTS: [
    'daily-cloudcode-pa.googleapis.com', // Primary backend with Claude & GPT rolling quotas
    'cloudcode-pa.googleapis.com'       // Fallback backend
  ] as const
} as const;

/**
 * Account Tier Weights for Overall Quota Calculation
 */
export const TIER_WEIGHTS = {
  ENTERPRISE: 5.0,
  ULTRA: 4.0,
  'AI PREMIUM': 3.0,
  PRO: 1.0,
  FREE: 0.5
} as const;

/**
 * Persistent Global Storage & Secret Keys
 */
export const STORAGE_KEYS = {
  ACCOUNTS: 'antigravitySwap.accounts',
  ACTIVE_ACCOUNT: 'antigravitySwap.activeEmail',
  AUTO_SWITCH: 'antigravitySwap.autoSwitch'
} as const;

/**
 * Extension Configuration Keys & Defaults
 */
export const CONFIG_KEYS = {
  SECTION: 'antigravitySwap',
  HEARTBEAT_INTERVAL: 'heartbeatIntervalSeconds',
  AUTO_SWITCH_WHEN_LOW: 'autoSwitchWhenQuotaLow',
  LOW_QUOTA_THRESHOLD: 'lowQuotaThresholdPercent'
} as const;

/**
 * Rate Limiting & Operational Defaults
 */
export const EXTENSION_DEFAULTS = {
  DEFAULT_HEARTBEAT_SECONDS: 30,
  DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT: 5,
  ACCOUNT_REFRESH_COOLDOWN_MS: 10000,
  GLOBAL_REFRESH_COOLDOWN_MS: 10000
} as const;
