import {
  ModelQuota,
  AccountInfo,
  OverallQuotaSummary,
  OAuthTokens,
  AccountTierType,
  QuotaWindowType
} from '../types';
import { OAuthService } from '../auth';
import { EXTENSION_DEFAULTS } from '../constants';
import { QuotaApiClient } from './quotaApiClient';
import { QuotaParser, QuotaFetchResult } from './quotaParser';
import { JitProbeResult } from './googleDirectApiClient';
import {
  calculateModulatedInstantQuota,
  calculateOverallSummary,
  calculateAveragePercentage,
  findSoonestResetTime
} from './quotaCalculator';
import {
  is5HourBucket,
  isWeeklyBucket,
  classifyQuotaWindow,
  determineAccountTier
} from './quotaClassifier';
import {
  formatCountdown,
  parseCountdownFromDescription,
  synthesizeResetTimeFromDescription,
  formatModelDisplayName,
  sortModelQuotas
} from './quotaFormatters';

export {
  QuotaFetchResult,
  calculateModulatedInstantQuota,
  parseCountdownFromDescription,
  synthesizeResetTimeFromDescription
};

/**
 * QuotaService
 * Coordinates quota fetching, parsing, classification, and capacity calculation
 * across modular sub-services.
 */
export class QuotaService {
  private readonly apiClient: QuotaApiClient;
  private readonly parser: QuotaParser;

  public static readonly is5HourBucket = is5HourBucket;
  public static readonly isWeeklyBucket = isWeeklyBucket;
  public static readonly sortModelQuotas = sortModelQuotas;
  public static readonly parseCountdownFromDescription = parseCountdownFromDescription;
  public static readonly synthesizeResetTimeFromDescription = synthesizeResetTimeFromDescription;

  constructor(private readonly oauthService: OAuthService) {
    this.apiClient = new QuotaApiClient();
    this.parser = new QuotaParser();
  }

  /**
   * Invalidates cached Language Server connection to force rediscovery.
   * Useful after account switching or language server restarts.
   */
  public invalidateLanguageServerConnection(): void {
    this.apiClient.invalidateCache();
  }

  /**
   * Returns the email address of the active account in the running Language Server.
   */
  public async getLiveLanguageServerEmail(): Promise<string | undefined> {
    return undefined;
  }

  /**
   * JIT Pre-Switch Candidate Verification:
   * Fast, targeted single-shot probe to verify candidate has not been burned on another machine.
   */
  public async probeJitCandidate(
    account: AccountInfo,
    tokens: OAuthTokens,
    onTokenRefreshed?: (newTokens: OAuthTokens) => Promise<void>,
    timeoutMs: number = EXTENSION_DEFAULTS.JIT_TIMEOUT_MS
  ): Promise<JitProbeResult> {
    let currentTokens = tokens;
    if (currentTokens.expiresAt && Date.now() > currentTokens.expiresAt - 120000 && currentTokens.refreshToken) {
      try {
        currentTokens = await this.oauthService.refreshAccessToken(currentTokens.refreshToken);
        if (onTokenRefreshed) {
          await onTokenRefreshed(currentTokens);
        }
      } catch (err: any) {
        return { ok: false, isDepleted: true, error: err.message || 'Token refresh failed during JIT probe' };
      }
    }
    return this.apiClient.probeJitCandidate(currentTokens.accessToken, account.email, timeoutMs);
  }

  public dispose(): void {
    this.apiClient.dispose();
  }

  /**
   * Checks if an account's quota information is stale (older than freshness threshold).
   */
  public isAccountStale(account: AccountInfo, thresholdMs: number = EXTENSION_DEFAULTS.ACCOUNT_FRESHNESS_THRESHOLD_MS): boolean {
    if (!account.lastRefreshedAt) return true;
    const last = new Date(account.lastRefreshedAt).getTime();
    if (isNaN(last)) return true;
    return (Date.now() - last) >= thresholdMs;
  }

  /**
   * Fetches the quota breakdown for an account using its access token.
   * If expired and a refresh token is available, automatically refreshes the token.
   */
  public async fetchAccountQuotas(
    account: AccountInfo,
    tokens: OAuthTokens,
    onTokenRefreshed?: (newTokens: OAuthTokens) => Promise<void>
  ): Promise<QuotaFetchResult> {
    let currentTokens = tokens;

    // Check token expiration buffer (refresh 2 min before expiration)
    if (currentTokens.expiresAt && Date.now() > currentTokens.expiresAt - 120000 && currentTokens.refreshToken) {
      try {
        currentTokens = await this.oauthService.refreshAccessToken(currentTokens.refreshToken);
        if (onTokenRefreshed) {
          await onTokenRefreshed(currentTokens);
        }
      } catch (err: any) {
        console.warn(`[QuotaService] Token auto-refresh failed for ${account.email}:`, err);
        if (err.message && (err.message.includes('AUTH_EXPIRED') || err.message.includes('invalid_grant'))) {
          return {
            quotas: account.quotas && account.quotas.length > 0 ? account.quotas : [],
            quotaGroups: account.quotaGroups,
            geminiGroup: account.geminiGroup,
            claudeGptGroup: account.claudeGptGroup,
            averagePercentage: account.averageQuotaPercentage ?? 0,
            hasWeeklyQuota: account.hasWeeklyQuota ?? false,
            has5HourQuota: account.has5HourQuota ?? false,
            accountType: account.accountType || 'Google Account',
            tierBadge: account.tierBadge || 'STANDARD FREE',
            status: 'auth_failed',
            isBanned: false,
            statusMessage: 'Refresh token expired or revoked. Please re-login.'
          };
        }
      }
    }

    try {
      const liveLsEmail = await this.getLiveLanguageServerEmail().catch(() => undefined);
      const isLiveActive = (liveLsEmail && account.email.trim().toLowerCase() === liveLsEmail.trim().toLowerCase()) || (account.isActive ?? false);

      let quotaData = await this.apiClient.fetchLiveQuotaData(
        currentTokens.accessToken,
        isLiveActive,
        account.email,
        currentTokens.refreshToken
      );

      const hasGroups = (quotaData?.response?.groups || quotaData?.groups || []).length > 0;
      const hasModels = Object.keys(quotaData?.models || {}).length > 0;
      const hasTierData = !!(quotaData?.paidTier || quotaData?.userTier || quotaData?.currentTier || quotaData?.cloudaicompanionProject);

      if (!hasGroups && !hasModels && !hasTierData) {
        if (currentTokens.refreshToken) {
          try {
            currentTokens = await this.oauthService.refreshAccessToken(currentTokens.refreshToken);
            if (onTokenRefreshed) {
              await onTokenRefreshed(currentTokens);
            }
          } catch {}
        }
        const retryDelayMs = EXTENSION_DEFAULTS.TOKEN_PROPAGATION_RETRY_DELAY_MS;
        console.log(`[QuotaService] First quota probe returned empty for ${account.email}, retrying after ${retryDelayMs}ms...`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
        try {
          const retryData = await this.apiClient.fetchLiveQuotaData(
            currentTokens.accessToken,
            isLiveActive,
            account.email,
            currentTokens.refreshToken
          );
          if ((retryData?.groups || retryData?.response?.groups || []).length > 0 || Object.keys(retryData?.models || {}).length > 0) {
            quotaData = retryData;
          }
        } catch {}
      }


      const parsedResult = this.parser.processQuotaData(quotaData, account);

      // Detailed debug log of fetched quotas and resets time requested by user
      const modelsSummary = (parsedResult.quotas || [])
        .map((q) => `${q.displayName} (${q.windowType}): ${q.percentage}% (resets ${q.resetCountdown || 'ready'})`)
        .join(', ');

      console.log(
        `[QuotaService] Refreshed ${account.email} (${parsedResult.tierBadge}): Instant=${parsedResult.averagePercentage}%, 5h=${parsedResult.fiveHourPercentage !== undefined ? parsedResult.fiveHourPercentage + '%' : 'N/A'} (resets ${parsedResult.fiveHourResetCountdown || 'N/A'}, ${parsedResult.fiveHourResetTime || 'N/A'}), Weekly=${parsedResult.weeklyPercentage !== undefined ? parsedResult.weeklyPercentage + '%' : 'N/A'} (resets ${parsedResult.weeklyResetCountdown || 'N/A'}, ${parsedResult.weeklyResetTime || 'N/A'}), Status=${parsedResult.status}. Models: [${modelsSummary}]`
      );

      return parsedResult;
    } catch (err: any) {
      const errMsg = err.message || '';

      if (
        errMsg.includes('USER_SUSPENDED') ||
        errMsg.includes('ACCOUNT_DISABLED') ||
        errMsg.includes('TOS_VIOLATION') ||
        errMsg.includes('Google Account disabled')
      ) {
        return {
          quotas: account.quotas && account.quotas.length > 0 ? account.quotas : [],
          quotaGroups: account.quotaGroups,
          geminiGroup: account.geminiGroup,
          claudeGptGroup: account.claudeGptGroup,
          averagePercentage: account.averageQuotaPercentage ?? 0,
          fiveHourPercentage: account.fiveHourQuotaPercentage,
          weeklyPercentage: account.weeklyQuotaPercentage,
          fiveHourResetTime: account.fiveHourResetTime,
          fiveHourResetCountdown: account.fiveHourResetCountdown,
          weeklyResetTime: account.weeklyResetTime,
          weeklyResetCountdown: account.weeklyResetCountdown,
          has5HourQuota: account.has5HourQuota ?? false,
          hasWeeklyQuota: account.hasWeeklyQuota ?? false,
          accountType: account.accountType || 'Google Account',
          tierBadge: account.tierBadge || 'STANDARD FREE',
          status: 'banned',
          isBanned: true,
          statusMessage: 'Account suspended by Google Terms of Service.'
        };
      }

      return {
        quotas: account.quotas && account.quotas.length > 0 ? account.quotas : [],
        quotaGroups: account.quotaGroups,
        geminiGroup: account.geminiGroup,
        claudeGptGroup: account.claudeGptGroup,
        averagePercentage: account.averageQuotaPercentage ?? 0,
        fiveHourPercentage: account.fiveHourQuotaPercentage,
        weeklyPercentage: account.weeklyQuotaPercentage,
        fiveHourResetTime: account.fiveHourResetTime,
        fiveHourResetCountdown: account.fiveHourResetCountdown,
        weeklyResetTime: account.weeklyResetTime,
        weeklyResetCountdown: account.weeklyResetCountdown,
        has5HourQuota: account.has5HourQuota ?? false,
        hasWeeklyQuota: account.hasWeeklyQuota ?? false,
        accountType: account.accountType || 'Google Account',
        tierBadge: account.tierBadge || 'STANDARD FREE',
        status: errMsg.includes('401') ? 'auth_failed' : (account.status || 'healthy'),
        isBanned: false,
        statusMessage: errMsg.includes('401') ? 'Credentials expired. Re-login required.' : 'Unable to fetch latest metrics from Google API (temporary).'
      };
    }
  }

  public processQuotaData(quotaData: any, account: AccountInfo): QuotaFetchResult {
    return this.parser.processQuotaData(quotaData, account);
  }

  public findSoonestResetTime(quotas: ModelQuota[]): string | undefined {
    return findSoonestResetTime(quotas);
  }

  public parseQuotaResponse(rawResponse: any): ModelQuota[] {
    return this.parser.parseQuotaResponse(rawResponse);
  }

  public generateFreeTierPlaceholders(): ModelQuota[] {
    return this.parser.generateFreeTierPlaceholders();
  }

  public formatModelDisplayName(id: string, apiDisplayName?: string): string {
    return formatModelDisplayName(id, apiDisplayName);
  }

  public classifyQuotaWindow(
    id: string,
    displayName: string,
    resetTime?: string,
    description?: string,
    knownWeeklyResetTime?: string,
    known5HourResetTime?: string,
    isFreeAccount?: boolean
  ): { windowType: QuotaWindowType; windowLabel: string } {
    return classifyQuotaWindow(id, displayName, resetTime, description, knownWeeklyResetTime, known5HourResetTime, isFreeAccount);
  }

  public determineAccountTier(rawResponse: any, account?: AccountInfo): { accountType: string; tierBadge: AccountTierType } {
    return determineAccountTier(rawResponse, account);
  }

  public calculateOverallSummary(accounts: AccountInfo[]): OverallQuotaSummary {
    return calculateOverallSummary(accounts);
  }

  public calculateAveragePercentage(quotas: ModelQuota[]): number {
    return calculateAveragePercentage(quotas);
  }

  public formatCountdown(isoString: string): string {
    return formatCountdown(isoString);
  }
}
