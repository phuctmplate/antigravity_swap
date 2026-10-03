export interface ModelQuota {
  id: string;
  displayName: string;
  description?: string;
  remainingFraction: number; // 0.0 to 1.0
  percentage: number; // 0 to 100
  resetTime?: string; // ISO string
  resetCountdown?: string; // Formatted "in 2h 15m"
  disabled?: boolean;
  refreshText?: string;
}

export interface AccountInfo {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  plan?: string;
  tier?: string;
  isActive: boolean;
  addedAt: string;
  lastUsedAt?: string;
  status: 'active' | 'low_balance' | 'expired' | 'error';
  statusMessage?: string;
  quotas: ModelQuota[];
  averageQuotaPercentage: number;
  lastRefreshedAt?: string;
}

export interface OverallQuotaSummary {
  totalAccounts: number;
  activeAccountEmail?: string;
  overallPercentage: number; // Combined % across all accounts
  averageActiveAccountPercentage: number;
  highestAccountQuotaPercentage: number;
  accountsWithHealthyQuota: number;
  accountsLowOrDepleted: number;
  lastUpdated: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  tokenType?: string;
}

export interface WebviewStateMessage {
  type: 'stateUpdate';
  accounts: AccountInfo[];
  overall: OverallQuotaSummary;
  activeAccount?: AccountInfo;
  isLoading: boolean;
  autoSwitchEnabled: boolean;
}
