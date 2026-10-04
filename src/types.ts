export type QuotaWindowType = '5h' | 'weekly' | 'tab' | 'general';

export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  window: '5h' | 'weekly';
  remainingFraction: number; // 0.0 to 1.0
  percentage: number; // 0 to 100
  resetTime?: string; // ISO string
  resetCountdown?: string; // Formatted "in 2h 15m" or "6d 21h"
  description?: string;
  disabled?: boolean;
  /** Bucket never consumed: API returns 100% with a rolling resetTime (= now + window). No real countdown. */
  notStarted?: boolean;
}

export interface QuotaGroup {
  id: string; // 'gemini' | 'claude_gpt'
  name: string; // 'Gemini Models' | 'Claude and GPT models'
  description?: string;
  fiveHour?: QuotaBucket;
  weekly?: QuotaBucket;
  buckets: QuotaBucket[];
}

export interface ModelQuota {
  id: string;
  displayName: string;
  groupName?: string; // 'Gemini Models' | 'Claude and GPT models'
  description?: string;
  remainingFraction: number; // 0.0 to 1.0
  percentage: number; // 0 to 100
  resetTime?: string; // ISO string
  resetCountdown?: string; // Formatted "in 2h 15m"
  windowType: QuotaWindowType; // 5h, weekly, tab, general
  windowLabel: string; // '5-Hour Window', 'Weekly Quota', etc.
  disabled?: boolean;
  refreshText?: string;
}

export type AccountStatus = 'active' | 'low_balance' | 'auth_failed' | 'banned' | 'expired' | 'error';
export type AccountTierType = 'ULTRA' | 'PRO' | 'ENTERPRISE' | 'AI PREMIUM' | 'STANDARD FREE' | 'CUSTOM';

export interface AccountInfo {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  plan?: string;
  accountType: string; // e.g. "Google One AI Premium", "Google AI Pro", "Standard Free"
  tierBadge: AccountTierType;
  isActive: boolean;
  addedAt: string;
  lastUsedAt?: string;
  status: AccountStatus;
  statusMessage?: string;
  isBanned?: boolean;
  banReason?: string;
  quotas: ModelQuota[];

  // Separated Quota Groups (Gemini Models vs Claude and GPT models)
  quotaGroups?: QuotaGroup[];
  geminiGroup?: QuotaGroup;
  claudeGptGroup?: QuotaGroup;

  averageQuotaPercentage: number;
  fiveHourQuotaPercentage?: number;
  weeklyQuotaPercentage?: number;
  fiveHourResetTime?: string;
  fiveHourResetCountdown?: string;
  weeklyResetTime?: string;
  weeklyResetCountdown?: string;
  hasWeeklyQuota: boolean;
  has5HourQuota: boolean;
  lastRefreshedAt?: string;
  lastHeartbeatAt?: string;
}

export interface OverallQuotaSummary {
  totalAccounts: number;
  activeAccountEmail?: string;
  overallPercentage: number; // Combined % across all accounts
  
  // Separated Group Aggregate Percentages
  gemini5HourPercentage?: number;
  geminiWeeklyPercentage?: number;
  claude5HourPercentage?: number;
  claudeWeeklyPercentage?: number;

  overall5HourPercentage: number;
  overallWeeklyPercentage: number;
  averageActiveAccountPercentage: number;
  highestAccountQuotaPercentage: number;
  accountsWithHealthyQuota: number;
  accountsLowOrDepleted: number;
  accountsWithErrors: number;
  proAccountsCount: number;
  lastUpdated: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  tokenType?: string;
}

export interface HeartbeatInfo {
  lastTick: string;
  intervalSeconds: number;
  isRunning: boolean;
  activeAccountHealth: 'healthy' | 'warning' | 'error';
}

export type AutoSwitchTarget = 'total' | 'gemini' | 'claude';

export interface WebviewStateMessage {
  type: 'stateUpdate';
  accounts: AccountInfo[];
  overall: OverallQuotaSummary;
  activeAccount?: AccountInfo;
  isLoading: boolean;
  autoSwitchEnabled: boolean;
  autoSwitchTarget?: AutoSwitchTarget;
  autoSwitchThreshold?: number;
  heartbeat?: HeartbeatInfo;
}
