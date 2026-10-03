// Must mirror ModelQuota in src/types.ts (sent from the extension host).
export interface ModelQuota {
  id: string;
  displayName: string;
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
  status: 'active' | 'low_balance' | 'auth_failed' | 'banned';
  isBanned?: boolean;
  banReason?: string;
  statusMessage?: string;
  quotas?: ModelQuota[];
  averageQuotaPercentage?: number;
  fiveHourQuotaPercentage?: number;
  weeklyQuotaPercentage?: number;
  hasWeeklyQuota?: boolean;
  has5HourQuota?: boolean;
}

export interface OverallQuotaSummary {
  totalAccounts: number;
  activeAccountEmail?: string;
  overallPercentage: number;
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

export interface WebviewState {
  accounts: Account[];
  activeAccount: Account | null;
  overall: OverallQuotaSummary;
  heartbeat?: {
    lastHeartbeat: string;
    intervalSeconds: number;
  };
  autoSwitchEnabled?: boolean;
}
