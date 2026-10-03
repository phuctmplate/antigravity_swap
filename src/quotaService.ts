import * as https from 'https';
import { ModelQuota, AccountInfo, OverallQuotaSummary, OAuthTokens } from './types';
import { OAuthService } from './oauthService';

export class QuotaService {
  constructor(private readonly oauthService: OAuthService) {}

  /**
   * Fetches the quota breakdown for an account using its access token.
   * If expired and a refresh token is available, automatically refreshes the token.
   */
  public async fetchAccountQuotas(
    account: AccountInfo,
    tokens: OAuthTokens,
    onTokenRefreshed?: (newTokens: OAuthTokens) => Promise<void>
  ): Promise<{ quotas: ModelQuota[]; averagePercentage: number }> {
    let currentTokens = tokens;

    // Check token expiration buffer (refresh 2 min before expiration)
    if (currentTokens.expiresAt && Date.now() > currentTokens.expiresAt - 120000 && currentTokens.refreshToken) {
      try {
        currentTokens = await this.oauthService.refreshAccessToken(currentTokens.refreshToken);
        if (onTokenRefreshed) {
          await onTokenRefreshed(currentTokens);
        }
      } catch (err) {
        console.warn(`[QuotaService] Token auto-refresh failed for ${account.email}:`, err);
      }
    }

    try {
      const quotaData = await this.callRetrieveUserQuotaSummary(currentTokens.accessToken);
      const parsedQuotas = this.parseQuotaResponse(quotaData);
      const avgPercent = this.calculateAveragePercentage(parsedQuotas);
      return { quotas: parsedQuotas, averagePercentage: avgPercent };
    } catch (err: any) {
      // If 401 and refresh token available, attempt refresh once
      if (err.message && err.message.includes('401') && currentTokens.refreshToken) {
        try {
          currentTokens = await this.oauthService.refreshAccessToken(currentTokens.refreshToken);
          if (onTokenRefreshed) {
            await onTokenRefreshed(currentTokens);
          }
          const quotaData = await this.callRetrieveUserQuotaSummary(currentTokens.accessToken);
          const parsedQuotas = this.parseQuotaResponse(quotaData);
          const avgPercent = this.calculateAveragePercentage(parsedQuotas);
          return { quotas: parsedQuotas, averagePercentage: avgPercent };
        } catch (retryErr) {
          console.error(`[QuotaService] Retry after refresh failed for ${account.email}:`, retryErr);
        }
      }

      // Return default cached/fallback quotas if API is unreachable
      if (account.quotas && account.quotas.length > 0) {
        return {
          quotas: account.quotas,
          averagePercentage: account.averageQuotaPercentage || 0
        };
      }

      return {
        quotas: this.getDefaultModelQuotas(),
        averagePercentage: 0
      };
    }
  }

  /**
   * Calls https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
   */
  private callRetrieveUserQuotaSummary(accessToken: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({});
      const req = https.request(
        {
          hostname: 'cloudcode-pa.googleapis.com',
          port: 443,
          path: '/v1internal:retrieveUserQuotaSummary',
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'AntigravitySwap/1.0',
            'Content-Length': Buffer.byteLength(data)
          }
        },
        (res) => {
          let resData = '';
          res.on('data', (chunk) => (resData += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(resData));
              } catch (e) {
                reject(new Error(`Failed to parse quota JSON response: ${resData}`));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${resData}`));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * Parses the raw quota summary response into a clean list of ModelQuota objects.
   */
  public parseQuotaResponse(rawResponse: any): ModelQuota[] {
    const list: ModelQuota[] = [];
    const groups = rawResponse?.response?.groups || rawResponse?.groups || [];

    for (const group of groups) {
      const buckets = group.buckets || [];
      for (const bucket of buckets) {
        if (!bucket.displayName && !bucket.bucketId) continue;

        let fraction = 1.0;
        if (bucket.remaining?.case === 'remainingFraction') {
          fraction = typeof bucket.remaining.value === 'number' ? bucket.remaining.value : 1.0;
        } else if (typeof bucket.remainingFraction === 'number') {
          fraction = bucket.remainingFraction;
        } else if (typeof bucket.fraction === 'number') {
          fraction = bucket.fraction;
        }

        fraction = Math.max(0, Math.min(1, fraction));
        const percentage = Math.round(fraction * 100);

        const resetTime = bucket.quotaInfo?.resetTime || bucket.resetTime || bucket.quotaResetUTCTimestamp;
        const resetCountdown = resetTime ? this.formatCountdown(resetTime) : undefined;

        list.push({
          id: bucket.bucketId || bucket.displayName,
          displayName: bucket.displayName || bucket.bucketId,
          description: bucket.description || group.displayName,
          remainingFraction: fraction,
          percentage,
          resetTime,
          resetCountdown,
          disabled: bucket.disabled ?? false,
          refreshText: bucket.refreshText || bucket.description
        });
      }
    }

    if (list.length === 0) {
      return this.getDefaultModelQuotas();
    }

    return list;
  }

  /**
   * Computes overall aggregate percentage across all accounts.
   */
  public calculateOverallSummary(accounts: AccountInfo[]): OverallQuotaSummary {
    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        overallPercentage: 0,
        averageActiveAccountPercentage: 0,
        highestAccountQuotaPercentage: 0,
        accountsWithHealthyQuota: 0,
        accountsLowOrDepleted: 0,
        lastUpdated: new Date().toISOString()
      };
    }

    const activeAcc = accounts.find((a) => a.isActive) || accounts[0];
    let sumPercentages = 0;
    let maxPercentage = 0;
    let healthyCount = 0;
    let lowCount = 0;

    for (const acc of accounts) {
      const p = acc.averageQuotaPercentage || 0;
      sumPercentages += p;
      if (p > maxPercentage) maxPercentage = p;
      if (p >= 20) {
        healthyCount++;
      } else {
        lowCount++;
      }
    }

    const overallPct = Math.round(sumPercentages / accounts.length);
    const activePct = activeAcc ? activeAcc.averageQuotaPercentage || 0 : 0;

    return {
      totalAccounts: accounts.length,
      activeAccountEmail: activeAcc?.email,
      overallPercentage: overallPct,
      averageActiveAccountPercentage: activePct,
      highestAccountQuotaPercentage: maxPercentage,
      accountsWithHealthyQuota: healthyCount,
      accountsLowOrDepleted: lowCount,
      lastUpdated: new Date().toISOString()
    };
  }

  public calculateAveragePercentage(quotas: ModelQuota[]): number {
    if (!quotas || quotas.length === 0) return 0;
    const valid = quotas.filter((q) => !q.disabled);
    if (valid.length === 0) return 0;
    const sum = valid.reduce((acc, q) => acc + q.percentage, 0);
    return Math.round(sum / valid.length);
  }

  public formatCountdown(isoString: string): string {
    try {
      const target = new Date(isoString).getTime();
      const diff = target - Date.now();
      if (diff <= 0) return 'Ready';
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      if (hours > 24) {
        const days = Math.floor(hours / 24);
        return `${days}d ${hours % 24}h`;
      }
      if (hours > 0) {
        return `${hours}h ${mins}m`;
      }
      return `${mins}m`;
    } catch {
      return 'Soon';
    }
  }

  public getDefaultModelQuotas(): ModelQuota[] {
    return [
      { id: 'gemini-3.7-flash-high', displayName: 'Gemini 3.7 Flash High', remainingFraction: 1.0, percentage: 100 },
      { id: 'gemini-3-flash', displayName: 'Gemini 3 Flash', remainingFraction: 1.0, percentage: 100 },
      { id: 'claude-sonnet-4-6', displayName: 'Claude 3.7 Sonnet', remainingFraction: 1.0, percentage: 100 },
      { id: 'claude-opus-4-6', displayName: 'Claude Opus Thinking', remainingFraction: 1.0, percentage: 100 },
      { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B', remainingFraction: 1.0, percentage: 100 }
    ];
  }
}
