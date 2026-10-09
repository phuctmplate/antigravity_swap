export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  window: '5h' | 'weekly';
  remainingFraction: number; // 0.0 to 1.0
  percentage: number; // 0 to 100
  resetTime?: string; // ISO string
  resetCountdown?: string; // e.g. "in 2h 15m" or "6d 21h"
  description?: string;
  disabled?: boolean;
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

// Must mirror ModelQuota in src/types.ts (sent from the extension host).
export interface ModelQuota {
  id: string;
  displayName: string;
  groupName?: string;
  description?: string;
  remainingFraction: number; // 0.0 to 1.0
  percentage: number; // 0 to 100, -1 = unlimited/placeholder
  resetTime?: string; // ISO string
  resetCountdown?: string; // e.g. "in 2h 15m"
  windowType: '5h' | 'weekly' | 'tab' | 'general';
  windowLabel?: string;
  disabled?: boolean;
  refreshText?: string;
}

export interface Account {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  isActive: boolean;
  addedAt: string;
  lastUsedAt?: string;
  lastRefreshedAt?: string;
  lastHeartbeatAt?: string;
  accountType?: string;
  tierBadge?: string;
  status: 'healthy' | 'active' | 'low_balance' | 'auth_failed' | 'banned';
  isBanned?: boolean;
  banReason?: string;
  statusMessage?: string;
  quotas?: ModelQuota[];
  quotaGroups?: QuotaGroup[];
  geminiGroup?: QuotaGroup;
  claudeGptGroup?: QuotaGroup;
  averageQuotaPercentage?: number;
  fiveHourQuotaPercentage?: number;
  weeklyQuotaPercentage?: number;
  fiveHourResetTime?: string;
  fiveHourResetCountdown?: string;
  weeklyResetTime?: string;
  weeklyResetCountdown?: string;
  hasWeeklyQuota?: boolean;
  has5HourQuota?: boolean;
}

export interface OverallQuotaSummary {
  totalAccounts: number;
  activeAccountEmail?: string;
  instantPercentage?: number;
  overallPercentage: number;
  
  // Separated Group Aggregate Percentages
  gemini5HourPercentage?: number;
  geminiWeeklyPercentage?: number;
  claude5HourPercentage?: number;
  claudeWeeklyPercentage?: number;

  overall5HourPercentage?: number;
  overallWeeklyPercentage?: number;
  averageActiveAccountPercentage: number;
  highestAccountQuotaPercentage: number;
  accountsWithHealthyQuota: number;
  accountsLowOrDepleted: number;
  accountsWithErrors: number;
  proAccountsCount: number;
  lastUpdated: string;
}

export type AutoSwitchTarget = 'total' | 'gemini' | 'claude';

export interface WebviewState {
  accounts: Account[];
  activeAccount: Account | null;
  overall: OverallQuotaSummary;
  heartbeat?: {
    lastHeartbeat: string;
    intervalSeconds: number;
  };
  isBackgroundRefreshing?: boolean;
  autoSwitchEnabled?: boolean;
  autoSwitchTarget?: AutoSwitchTarget;
  autoSwitchThreshold?: number;
}
