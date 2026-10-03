import * as https from 'https';
import { ModelQuota, AccountInfo, OverallQuotaSummary, OAuthTokens, AccountStatus, AccountTierType, QuotaWindowType } from './types';
import { OAuthService } from './oauthService';

export interface QuotaFetchResult {
  quotas: ModelQuota[];
  averagePercentage: number;
  fiveHourPercentage?: number;
  weeklyPercentage?: number;
  hasWeeklyQuota: boolean;
  has5HourQuota: boolean;
  accountType: string;
  tierBadge: AccountTierType;
  status: AccountStatus;
  isBanned: boolean;
  statusMessage?: string;
}

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
            quotas: [],
            averagePercentage: 0,
            hasWeeklyQuota: false,
            has5HourQuota: false,
            accountType: 'Standard Free',
            tierBadge: 'STANDARD FREE',
            status: 'auth_failed',
            isBanned: false,
            statusMessage: 'Refresh token expired or revoked. Please re-login.'
          };
        }
      }
    }

    try {
      const quotaData = await this.fetchLiveQuotaData(currentTokens.accessToken);
      let parsedQuotas = this.parseQuotaResponse(quotaData);

      const { accountType, tierBadge } = this.determineAccountTier(quotaData, parsedQuotas);
      const isFree = tierBadge === 'STANDARD FREE';

      // If API returned no quota data for this authenticated account,
      // generate placeholder quotas for the standard free tier models.
      // Free tier in Antigravity provides daily/rolling access to Gemini Flash models.
      if (parsedQuotas.length === 0) {
        console.log(`[QuotaService] No quota data returned for ${account.email}. Generating free-tier placeholder quotas.`);
        parsedQuotas = this.generateFreeTierPlaceholders();
      }

      const avgPercent = this.calculateAveragePercentage(parsedQuotas);

      // Separate 5h vs Weekly quotas (Free accounts do NOT have 5h rolling windows)
      const fiveHourQuotas = isFree ? [] : parsedQuotas.filter((q) => q.windowType === '5h');
      const weeklyQuotas = parsedQuotas.filter((q) => q.windowType === 'weekly');

      const fiveHourPct = fiveHourQuotas.length > 0 ? this.calculateAveragePercentage(fiveHourQuotas) : undefined;
      const weeklyPct = weeklyQuotas.length > 0 ? this.calculateAveragePercentage(weeklyQuotas) : undefined;
      const isLow = avgPercent < 15 && avgPercent > 0;

      return {
        quotas: parsedQuotas,
        averagePercentage: avgPercent,
        fiveHourPercentage: fiveHourPct,
        weeklyPercentage: weeklyPct,
        has5HourQuota: fiveHourQuotas.length > 0,
        hasWeeklyQuota: weeklyQuotas.length > 0,
        accountType,
        tierBadge,
        status: isLow ? 'low_balance' : 'active',
        isBanned: false,
        statusMessage: isLow ? 'Low quota warning' : undefined
      };
    } catch (err: any) {
      const errMsg = err.message || '';

      // Only mark banned if account is explicitly suspended / disabled by Google
      if (
        errMsg.includes('USER_SUSPENDED') ||
        errMsg.includes('ACCOUNT_DISABLED') ||
        errMsg.includes('TOS_VIOLATION') ||
        errMsg.includes('Google Account disabled')
      ) {
        return {
          quotas: [],
          averagePercentage: 0,
          hasWeeklyQuota: false,
          has5HourQuota: false,
          accountType: 'Standard Free',
          tierBadge: 'STANDARD FREE',
          status: 'banned',
          isBanned: true,
          statusMessage: 'Account disabled or suspended by Google Terms of Service'
        };
      }

      // If 401 and refresh token available, attempt refresh once
      if ((errMsg.includes('401') || errMsg.includes('UNAUTHENTICATED')) && currentTokens.refreshToken) {
        try {
          currentTokens = await this.oauthService.refreshAccessToken(currentTokens.refreshToken);
          if (onTokenRefreshed) {
            await onTokenRefreshed(currentTokens);
          }
          const quotaData = await this.fetchLiveQuotaData(currentTokens.accessToken);
          const parsedQuotas = this.parseQuotaResponse(quotaData);
          const avgPercent = this.calculateAveragePercentage(parsedQuotas);

          const { accountType, tierBadge } = this.determineAccountTier(quotaData, parsedQuotas);
          const isFree = tierBadge === 'STANDARD FREE';

          const fiveHourQuotas = isFree ? [] : parsedQuotas.filter((q) => q.windowType === '5h');
          const weeklyQuotas = parsedQuotas.filter((q) => q.windowType === 'weekly');
          const fiveHourPct = fiveHourQuotas.length > 0 ? this.calculateAveragePercentage(fiveHourQuotas) : undefined;
          const weeklyPct = weeklyQuotas.length > 0 ? this.calculateAveragePercentage(weeklyQuotas) : undefined;
          const isLow = avgPercent < 15 && avgPercent > 0;

          return {
            quotas: parsedQuotas,
            averagePercentage: avgPercent,
            fiveHourPercentage: fiveHourPct,
            weeklyPercentage: weeklyPct,
            has5HourQuota: fiveHourQuotas.length > 0,
            hasWeeklyQuota: weeklyQuotas.length > 0,
            accountType,
            tierBadge,
            status: isLow ? 'low_balance' : 'active',
            isBanned: false,
            statusMessage: isLow ? 'Low quota warning' : undefined
          };
        } catch (retryErr: any) {
          const isAuthExpired = retryErr.message?.includes('AUTH_EXPIRED') || retryErr.message?.includes('invalid_grant');
          return {
            quotas: [],
            averagePercentage: 0,
            hasWeeklyQuota: false,
            has5HourQuota: false,
            accountType: 'Standard Free',
            tierBadge: 'STANDARD FREE',
            status: isAuthExpired ? 'auth_failed' : 'active',
            isBanned: false,
            statusMessage: isAuthExpired ? 'Credentials expired. Re-login required.' : retryErr.message
          };
        }
      }

      return {
        quotas: [],
        averagePercentage: 0,
        fiveHourPercentage: undefined,
        weeklyPercentage: undefined,
        has5HourQuota: false,
        hasWeeklyQuota: false,
        accountType: 'Standard Free',
        tierBadge: 'STANDARD FREE',
        status: errMsg.includes('401') ? 'auth_failed' : 'active',
        isBanned: false,
        statusMessage: errMsg.includes('401') ? 'Credentials expired. Re-login required.' : undefined
      };
    }
  }

  /**
   * Multi-strategy live quota fetching against Cloud Code PA backend.
   */
  private async fetchLiveQuotaData(accessToken: string): Promise<any> {
    let projectId: string | undefined;
    let tierData: any = {};

    // 1. Try primary and fallback loadCodeAssist endpoints to discover project ID and subscription tier
    const codeAssistEndpoints = [
      { host: 'cloudcode-pa.googleapis.com', path: '/v1internal:loadCodeAssist', body: { metadata: { ideType: 'ANTIGRAVITY' } } },
      { host: 'daily-cloudcode-pa.googleapis.com', path: '/v1internal:loadCodeAssist', body: { metadata: { ide_type: 'ANTIGRAVITY', ide_version: '1.22.2', ide_name: 'antigravity' } } }
    ];

    for (const ep of codeAssistEndpoints) {
      try {
        const res = await this.callCloudCodePost(accessToken, ep.host, ep.path, ep.body);
        if (res) {
          if (res.cloudaicompanionProject) {
            projectId = res.cloudaicompanionProject;
          }
          tierData = { ...tierData, ...res };
          console.log(`[QuotaService] loadCodeAssist response keys: ${Object.keys(res).join(', ')}`);
          console.log(`[QuotaService] paidTier=${JSON.stringify(res.paidTier)}, currentTier=${JSON.stringify(res.currentTier)}, userTier=${JSON.stringify(res.userTier)}`);
          // Some responses embed model info directly in loadCodeAssist
          if (res.models || res.response?.groups || res.groups) {
            console.log('[QuotaService] Found model data in loadCodeAssist response!');
            return { ...tierData, ...res };
          }
          break;
        }
      } catch (err: any) {
        console.warn(`[QuotaService] loadCodeAssist failed: ${err.message}`);
      }
    }

    // 2. Fetch available model quotas across candidate URLs
    const modelCandidates = [
      { host: 'daily-cloudcode-pa.sandbox.googleapis.com', path: '/v1internal:fetchAvailableModels' },
      { host: 'daily-cloudcode-pa.googleapis.com', path: '/v1internal:fetchAvailableModels' },
      { host: 'cloudcode-pa.googleapis.com', path: '/v1internal:fetchAvailableModels' },
      { host: 'cloudcode-pa.googleapis.com', path: '/v1internal:retrieveUserQuotaSummary' }
    ];

    for (const cand of modelCandidates) {
      try {
        const body = projectId ? { project: projectId } : {};
        const res = await this.callCloudCodePost(accessToken, cand.host, cand.path, body);
        console.log(`[QuotaService] ${cand.host}${cand.path} → keys: ${Object.keys(res || {}).join(', ')}`);
        if (res && (res.models || res.response?.groups || res.groups)) {
          return { ...tierData, ...res };
        }
      } catch (err: any) {
        console.warn(`[QuotaService] ${cand.host}${cand.path} failed: ${err.message}`);
      }
    }

    console.warn('[QuotaService] No model quota data found from any endpoint. Returning tier-only data.');
    return tierData;
  }

  private callCloudCodePost(accessToken: string, hostname: string, path: string, body: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request(
        {
          hostname,
          port: 443,
          path,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/1.22.2 windows',
            'Content-Length': Buffer.byteLength(data)
          },
          timeout: 8000
        },
        (res) => {
          let resData = '';
          res.on('data', (chunk) => (resData += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(resData));
              } catch (e) {
                reject(new Error(`Failed to parse response: ${resData}`));
              }
            } else if (res.statusCode === 403) {
              reject(new Error(`403 PERMISSION_DENIED: ${resData}`));
            } else if (res.statusCode === 401) {
              reject(new Error(`401 UNAUTHENTICATED: ${resData}`));
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${resData}`));
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  /**
   * Parses model quotas from the API response:
   * - Extracts real percentages from models / groups
   * - Filters out tab fast autocomplete
   * - Filters out thinking effort / budget entries
   * - Keeps fixed, deterministic Antigravity IDE order
   */
  public parseQuotaResponse(rawResponse: any): ModelQuota[] {
    const list: ModelQuota[] = [];
    const seenIds = new Set<string>();

    // Helper to check if a model should be ignored
    const shouldIgnoreModel = (id: string, name: string): boolean => {
      const s = (id + ' ' + name).toLowerCase();
      return (
        s.includes('tab_') ||
        s.includes('tab-') ||
        s.includes('autocomplete') ||
        s.includes('tab completion') ||
        s.includes('thinking effort') ||
        s.includes('thinking_effort') ||
        s.includes('thinking-effort') ||
        s.includes('thinking budget') ||
        s.includes('thinking_budget') ||
        s.includes('thinking-budget') ||
        s.includes('thinking_slider') ||
        s.includes('thinking-slider') ||
        s.includes('thinking_') ||
        s.startsWith('chat_') ||
        s.startsWith('chat-') ||
        /^chat_\d+/.test(s) ||
        /^chat \d+/.test(s)
      );
    };

    // 1. Check direct models map (from fetchAvailableModels)
    if (rawResponse && rawResponse.models) {
      for (const [modelId, modelData] of Object.entries<any>(rawResponse.models)) {
        const displayName = this.formatModelDisplayName(modelId, modelData.displayName);
        if (shouldIgnoreModel(modelId, displayName)) {
          continue;
        }

        const normId = this.normalizeModelKey(modelId);
        if (seenIds.has(normId)) continue;
        seenIds.add(normId);

        const quotaInfo = modelData.quotaInfo || {};
        let fraction = 0;
        if (typeof quotaInfo.remainingFraction === 'number') {
          fraction = quotaInfo.remainingFraction;
        } else if (typeof quotaInfo.fraction === 'number') {
          fraction = quotaInfo.fraction;
        } else if (typeof quotaInfo.remainingQuota === 'number') {
          fraction = quotaInfo.remainingQuota;
        }

        fraction = Math.max(0, Math.min(1, fraction));
        const percentage = Math.round(fraction * 100);
        const resetTime = quotaInfo.resetTime;
        const resetCountdown = resetTime ? this.formatCountdown(resetTime) : undefined;
        const { windowType, windowLabel } = this.classifyQuotaWindow(modelId, displayName, resetTime, modelData.description);

        list.push({
          id: modelId,
          displayName,
          description: modelData.description,
          remainingFraction: fraction,
          percentage,
          resetTime,
          resetCountdown,
          windowType,
          windowLabel,
          disabled: modelData.disabled ?? false
        });
      }
    }

    // 2. Check grouped quota buckets (from retrieveUserQuotaSummary)
    const groups = rawResponse?.response?.groups || rawResponse?.groups || [];
    for (const group of groups) {
      const buckets = group.buckets || [];
      for (const bucket of buckets) {
        if (!bucket.displayName && !bucket.bucketId) continue;
        const rawId = bucket.bucketId || bucket.displayName;
        const displayName = this.formatModelDisplayName(rawId, bucket.displayName);

        if (shouldIgnoreModel(rawId, displayName)) {
          continue;
        }

        const normId = this.normalizeModelKey(rawId);
        if (seenIds.has(normId)) continue;
        seenIds.add(normId);

        let fraction = 0;
        if (bucket.remaining?.case === 'remainingFraction') {
          fraction = typeof bucket.remaining.value === 'number' ? bucket.remaining.value : 0;
        } else if (typeof bucket.remainingFraction === 'number') {
          fraction = bucket.remainingFraction;
        } else if (typeof bucket.fraction === 'number') {
          fraction = bucket.fraction;
        }

        fraction = Math.max(0, Math.min(1, fraction));
        const percentage = Math.round(fraction * 100);
        const resetTime = bucket.quotaInfo?.resetTime || bucket.resetTime || bucket.quotaResetUTCTimestamp;
        const resetCountdown = resetTime ? this.formatCountdown(resetTime) : undefined;
        const { windowType, windowLabel } = this.classifyQuotaWindow(rawId, displayName, resetTime, bucket.description || group.displayName);

        list.push({
          id: rawId,
          displayName,
          description: bucket.description || group.displayName,
          remainingFraction: fraction,
          percentage,
          resetTime,
          resetCountdown,
          windowType,
          windowLabel,
          disabled: bucket.disabled ?? false,
          refreshText: bucket.refreshText || bucket.description
        });
      }
    }

    return QuotaService.sortModelQuotas(list);
  }

  /**
   * Generates placeholder quota entries for standard free accounts when the API
   * returns no quota breakdown (free tier endpoints return no model quota data).
   * Shows all models accessible in Antigravity IDE with a "Free Tier" indicator.
   */
  public generateFreeTierPlaceholders(): ModelQuota[] {
    // All models available in Antigravity IDE model picker (matches IDE exactly)
    const freeTierModels = [
      { id: 'gemini-3.8-flash',    displayName: 'Gemini 3.8 Flash',  windowType: '5h'     as const },
      { id: 'gemini-3.7-flash',    displayName: 'Gemini 3.7 Flash',  windowType: '5h'     as const },
      { id: 'gemini-3.6-flash',    displayName: 'Gemini 3.6 Flash',  windowType: '5h'     as const },
      { id: 'gemini-3.1-flash',    displayName: 'Gemini 3.1 Flash',  windowType: '5h'     as const },
      { id: 'claude-sonnet-4-6',   displayName: 'Claude Sonnet 4.6', windowType: 'weekly' as const },
      { id: 'claude-opus-4-6',     displayName: 'Claude Opus 4.6',   windowType: 'weekly' as const },
      { id: 'gpt-oss-120b',        displayName: 'GPT-OSS 120B',      windowType: 'weekly' as const },
    ];

    const description = 'Free Tier — quota not available via API';
    return freeTierModels.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      description,
      remainingFraction: -1, // Sentinel: means "not measurable via API"
      percentage: -1,        // Displayed as "Free Tier" in UI
      windowType: m.windowType,
      windowLabel: 'Free Tier Usage',
      disabled: false,
      refreshText: description
    }));
  }


  /**
   * Normalizes model ID key to prevent duplicate tiers (e.g. high/low variations)
   */
  private normalizeModelKey(id: string): string {
    return id
      .toLowerCase()
      .replace(/-high|-medium|-low|-tiered|-extra-low/g, '');
  }

  /**
   * Formats model display names to match the Antigravity IDE model picker exactly:
   * Gemini 3.8 / 3.7 / 3.6 / 3.1 Flash, Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B.
   */
  public formatModelDisplayName(id: string, apiDisplayName?: string): string {
    const lower = id.toLowerCase();

    // 1. Claude Sonnet
    if (lower.includes('claude-sonnet-4-6') || lower.includes('sonnet-4-6') || lower.includes('claude-3-7-sonnet') || lower.includes('claude-3.7-sonnet')) {
      return 'Claude Sonnet 4.6';
    }
    if (lower.includes('claude-3-5-sonnet') || lower.includes('claude-3.5-sonnet')) {
      return 'Claude Sonnet 3.5';
    }
    if (lower.includes('claude-sonnet')) return 'Claude Sonnet 4.6';

    // 2. Claude Opus
    if (lower.includes('claude-opus-4-6') || lower.includes('opus-4-6') || lower.includes('claude-3-opus') || lower.includes('claude-3.7-opus')) {
      return 'Claude Opus 4.6';
    }
    if (lower.includes('claude-opus')) return 'Claude Opus 4.6';

    // 3. GPT-OSS
    if (lower.includes('gpt-oss') || lower.includes('gpt_oss')) {
      return 'GPT-OSS 120B';
    }

    // 4. Gemini models — extract version number from ID (e.g. gemini-3.8-flash → Gemini 3.8 Flash)
    const verMatch = id.match(/gemini-(\d+(?:\.\d+)?)-([a-z]+)/i);
    if (verMatch) {
      const version = verMatch[1];
      const type = verMatch[2].charAt(0).toUpperCase() + verMatch[2].slice(1).toLowerCase();
      return `Gemini ${version} ${type}`;
    }

    if (apiDisplayName && !apiDisplayName.toLowerCase().includes('thinking')) {
      return apiDisplayName;
    }

    return id
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/Gpt Oss/i, 'GPT-OSS');
  }

  /**
   * Enforces a fixed, deterministic order matching Antigravity IDE standard model picker:
   * 1. Gemini 3.8 Flash
   * 2. Gemini 3.7 Flash
   * 3. Gemini 3.6 Flash
   * 4. Gemini 3.5 Flash
   * IDE model picker order:
   * 1. Gemini 3.8 Flash
   * 2. Gemini 3.7 Flash
   * 3. Gemini 3.6 Flash
   * 4. Gemini 3.1 Flash
   * 5. Claude Sonnet 4.6
   * 6. Claude Opus 4.6
   * 7. GPT-OSS 120B
   */
  public static sortModelQuotas(quotas: ModelQuota[]): ModelQuota[] {
    const getRank = (q: ModelQuota): number => {
      const s = (q.id + ' ' + (q.displayName || '')).toLowerCase();

      // Gemini 3.8 Flash
      if (s.includes('3.8-flash') || s.includes('3.8 flash')) return 10;
      // Gemini 3.7 Flash
      if (s.includes('3.7-flash') || s.includes('3.7 flash')) return 20;
      // Gemini 3.6 Flash
      if (s.includes('3.6-flash') || s.includes('3.6 flash')) return 30;
      // Gemini 3.1 Flash
      if (s.includes('3.1-flash') || s.includes('3.1 flash')) return 40;
      // Gemini 3.5 Flash (fallback if API returns it)
      if (s.includes('3.5-flash') || s.includes('3.5 flash')) return 45;
      // Other Gemini Flash
      if (s.includes('gemini-3-flash') || s.includes('gemini 3 flash') || s.includes('gemini-3.0-flash')) return 50;
      if (s.includes('gemini') && s.includes('flash')) return 60;
      if (s.includes('gemini') && s.includes('pro')) return 70;
      if (s.includes('gemini')) return 80;

      // Claude Sonnet
      if (s.includes('claude') && (s.includes('sonnet-4-6') || s.includes('sonnet 4.6') || s.includes('sonnet'))) return 100;

      // Claude Opus
      if (s.includes('claude') && (s.includes('opus-4-6') || s.includes('opus 4.6') || s.includes('opus'))) return 110;
      if (s.includes('claude')) return 130;

      // GPT-OSS
      if (s.includes('gpt-oss') || s.includes('gpt_oss') || s.includes('gpt oss')) return 200;

      return 500;
    };

    return [...quotas].sort((a, b) => getRank(a) - getRank(b));
  }

  /**
   * Classifies a model quota into 5h rolling window vs weekly plan quota.
   */
  public classifyQuotaWindow(
    id: string,
    displayName: string,
    resetTime?: string,
    description?: string
  ): { windowType: QuotaWindowType; windowLabel: string } {
    const idLower = (id + ' ' + displayName + ' ' + (description || '')).toLowerCase();

    // Check reset time duration
    if (resetTime) {
      try {
        const diffMs = new Date(resetTime).getTime() - Date.now();
        const diffHours = diffMs / (1000 * 60 * 60);

        if (diffHours > 24) {
          return { windowType: 'weekly', windowLabel: 'Weekly Plan Quota' };
        } else if (diffHours > 0 && diffHours <= 6) {
          return { windowType: '5h', windowLabel: '5-Hour Rolling Window' };
        }
      } catch {}
    }

    // Model-based heuristic
    if (
      idLower.includes('claude') ||
      idLower.includes('opus') ||
      idLower.includes('sonnet') ||
      idLower.includes('gpt-oss') ||
      idLower.includes('gemini-2.5-pro') ||
      idLower.includes('weekly') ||
      idLower.includes('pro-agent')
    ) {
      return { windowType: 'weekly', windowLabel: 'Weekly Plan Quota' };
    }

    return { windowType: '5h', windowLabel: '5-Hour Rolling Window' };
  }

  /**
   * Determines account subscription tier strictly based on Google account subscription data.
   * Standard free accounts will always receive 'STANDARD FREE' without Pro badge.
   */
  public determineAccountTier(rawResponse: any, _quotas: ModelQuota[]): { accountType: string; tierBadge: AccountTierType } {
    const paidTierName = (rawResponse?.paidTier?.name || '').toLowerCase();
    const currentTierName = (rawResponse?.currentTier?.name || '').toLowerCase();
    const userTierDesc = (
      rawResponse?.userTier?.description ||
      rawResponse?.userTier?.tierDisplayName ||
      ''
    ).toLowerCase();
    const allTierStr = `${paidTierName} ${currentTierName} ${userTierDesc}`;

    if (allTierStr.includes('enterprise')) {
      return { accountType: 'Antigravity Enterprise', tierBadge: 'ENTERPRISE' };
    }
    if (allTierStr.includes('ultra')) {
      return { accountType: 'Google One Ultra', tierBadge: 'AI PREMIUM' };
    }
    if (
      allTierStr.includes('ai premium') ||
      allTierStr.includes('ai_premium') ||
      allTierStr.includes('gemini advanced') ||
      allTierStr.includes('premium')
    ) {
      return { accountType: 'Google One AI Premium', tierBadge: 'AI PREMIUM' };
    }
    if (/\b(pro|google_one_pro|tier_pro)\b/.test(allTierStr)) {
      return { accountType: 'Google One Pro', tierBadge: 'PRO' };
    }

    return { accountType: 'Standard Free', tierBadge: 'STANDARD FREE' };
  }

  /**
   * Computes overall aggregate percentage across all healthy accounts.
   */
  public calculateOverallSummary(accounts: AccountInfo[]): OverallQuotaSummary {
    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        overallPercentage: 0,
        overall5HourPercentage: 0,
        overallWeeklyPercentage: 0,
        averageActiveAccountPercentage: 0,
        highestAccountQuotaPercentage: 0,
        accountsWithHealthyQuota: 0,
        accountsLowOrDepleted: 0,
        accountsWithErrors: 0,
        proAccountsCount: 0,
        lastUpdated: new Date().toISOString()
      };
    }

    const activeAcc = accounts.find((a) => a.isActive) || accounts[0];
    let sumPercentages = 0;
    let sum5hPercentages = 0;
    let count5h = 0;
    let sumWeeklyPercentages = 0;
    let countWeekly = 0;
    let maxPercentage = 0;
    let healthyCount = 0;
    let lowCount = 0;
    let errorCount = 0;
    let proCount = 0;

    for (const acc of accounts) {
      if (acc.tierBadge === 'PRO' || acc.tierBadge === 'AI PREMIUM' || acc.tierBadge === 'ENTERPRISE') {
        proCount++;
      }

      if (acc.isBanned || acc.status === 'auth_failed' || acc.status === 'banned') {
        errorCount++;
        continue;
      }

      healthyCount++;

      const p = acc.averageQuotaPercentage || 0;
      sumPercentages += p;
      if (p > maxPercentage) maxPercentage = p;
      if (p < 20) {
        lowCount++;
      }

      if (acc.fiveHourQuotaPercentage !== undefined) {
        sum5hPercentages += acc.fiveHourQuotaPercentage;
        count5h++;
      }
      if (acc.weeklyQuotaPercentage !== undefined) {
        sumWeeklyPercentages += acc.weeklyQuotaPercentage;
        countWeekly++;
      }
    }

    const validCount = Math.max(1, accounts.length - errorCount);
    const overallPct = Math.round(sumPercentages / validCount);
    const overall5hPct = count5h > 0 ? Math.round(sum5hPercentages / count5h) : undefined;
    const overallWeeklyPct = countWeekly > 0 ? Math.round(sumWeeklyPercentages / countWeekly) : undefined;
    const activePct = activeAcc ? activeAcc.averageQuotaPercentage || 0 : 0;

    return {
      totalAccounts: accounts.length,
      activeAccountEmail: activeAcc?.email,
      overallPercentage: errorCount === accounts.length ? 0 : overallPct,
      overall5HourPercentage: overall5hPct ?? 0,
      overallWeeklyPercentage: overallWeeklyPct ?? 0,
      averageActiveAccountPercentage: activePct,
      highestAccountQuotaPercentage: maxPercentage,
      accountsWithHealthyQuota: healthyCount,
      accountsLowOrDepleted: lowCount,
      accountsWithErrors: errorCount,
      proAccountsCount: proCount,
      lastUpdated: new Date().toISOString()
    };
  }

  public calculateAveragePercentage(quotas: ModelQuota[]): number {
    if (!quotas || quotas.length === 0) return 0;
    // Exclude disabled quotas AND free-tier placeholder sentinels (percentage === -1)
    const valid = quotas.filter((q) => !q.disabled && q.percentage >= 0);
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
        const remHours = hours % 24;
        return `${days}d ${remHours}h`;
      }
      if (hours > 0) {
        return `${hours}h ${mins}m`;
      }
      return `${mins}m`;
    } catch {
      return 'Soon';
    }
  }
}
