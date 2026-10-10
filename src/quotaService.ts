import * as https from 'https';
import {
  ModelQuota,
  AccountInfo,
  OverallQuotaSummary,
  OAuthTokens,
  AccountStatus,
  AccountTierType,
  QuotaWindowType,
  QuotaBucket,
  QuotaGroup
} from './types';
import { OAuthService } from './oauthService';
import { API_ENDPOINTS, TIER_WEIGHTS, MODEL_WEIGHTS, EXTENSION_DEFAULTS } from './constants';


export interface QuotaFetchResult {
  quotas: ModelQuota[];
  quotaGroups?: QuotaGroup[];
  geminiGroup?: QuotaGroup;
  claudeGptGroup?: QuotaGroup;
  averagePercentage: number;
  fiveHourPercentage?: number;
  weeklyPercentage?: number;
  fiveHourResetTime?: string;
  fiveHourResetCountdown?: string;
  weeklyResetTime?: string;
  weeklyResetCountdown?: string;
  hasWeeklyQuota: boolean;
  has5HourQuota: boolean;
  accountType: string;
  tierBadge: AccountTierType;
  status: AccountStatus;
  isBanned: boolean;
  statusMessage?: string;
}

/**
 * Calculates the usable instant burst quota for a rolling window (5h)
 * modulated by remaining weekly fuel capacity.
 * - Above 40% weekly (safe burst boundary): rolling window is 100% usable (HealthFactor = 1.0).
 * - Below 40% weekly: weekly fuel attenuates 5h via smooth square-root decay (Math.sqrt(Weekly / 40)).
 */
export function calculateModulatedInstantQuota(p5h: number, pWeekly?: number): number {
  if (pWeekly === undefined) {
    return p5h;
  }
  const SAFE_WEEKLY_THRESHOLD = 40;
  const healthFactor =
    pWeekly >= SAFE_WEEKLY_THRESHOLD
      ? 1.0
      : Math.sqrt(Math.max(0, pWeekly) / SAFE_WEEKLY_THRESHOLD);
  return Math.round(p5h * healthFactor);
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
      let quotaData = await this.fetchLiveQuotaData(currentTokens.accessToken);

      const hasGroups = (quotaData?.response?.groups || quotaData?.groups || []).length > 0;
      const hasModels = Object.keys(quotaData?.models || {}).length > 0;
      const hasTierData = !!(quotaData?.paidTier || quotaData?.userTier || quotaData?.currentTier || quotaData?.cloudaicompanionProject);

      // If initial fetch returned empty (e.g. freshly issued OAuth token propagating on Google backend), retry once with safe backoff
      if (!hasGroups && !hasModels && !hasTierData) {
        const retryDelayMs = EXTENSION_DEFAULTS.TOKEN_PROPAGATION_RETRY_DELAY_MS;
        console.log(`[QuotaService] First quota probe returned empty for ${account.email}, retrying after ${retryDelayMs}ms...`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
        try {
          const retryData = await this.fetchLiveQuotaData(currentTokens.accessToken);
          if ((retryData?.groups || retryData?.response?.groups || []).length > 0 || Object.keys(retryData?.models || {}).length > 0) {
            quotaData = retryData;
          }
        } catch {}
      }

      // Debug: log top-level keys and tier fields so we can diagnose misdetection
      console.log(`[QuotaService] Raw response keys for ${account.email}: ${Object.keys(quotaData || {}).join(', ')}`);
      console.log(`[QuotaService] paidTier=${JSON.stringify(quotaData?.paidTier)}, currentTier=${JSON.stringify(quotaData?.currentTier)}, userTier=${JSON.stringify(quotaData?.userTier)}`);
      console.log(`[QuotaService] models keys: ${Object.keys(quotaData?.models || {}).join(', ') || '(none)'}`);
      console.log(`[QuotaService] groups count: ${(quotaData?.groups || quotaData?.response?.groups || []).length}`);

      return this.processQuotaData(quotaData, account);
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
          accountType: account.accountType || 'Standard Free',
          tierBadge: account.tierBadge || 'STANDARD FREE',
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
          return this.processQuotaData(quotaData, account);
        } catch (retryErr: any) {
          const isAuthExpired = retryErr.message?.includes('AUTH_EXPIRED') || retryErr.message?.includes('invalid_grant');
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
            status: isAuthExpired ? 'auth_failed' : (account.status || 'healthy'),
            isBanned: false,
            statusMessage: isAuthExpired ? 'Credentials expired. Re-login required.' : retryErr.message
          };
        }
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

  /**
   * Processes raw quota API response into normalized QuotaFetchResult.
   * Keeps Gemini Models and Claude & GPT models in separate QuotaGroups.
   * Keeps 5h rolling window and Weekly plan quota separated without mashing them together.
   */
  public processQuotaData(quotaData: any, account: AccountInfo): QuotaFetchResult {
    const hasGroups = (quotaData?.response?.groups || quotaData?.groups || []).length > 0;
    const hasModels = Object.keys(quotaData?.models || {}).length > 0;
    const hasTierData = !!(quotaData?.paidTier || quotaData?.userTier || quotaData?.currentTier || quotaData?.cloudaicompanionProject);

    // If Google API failed to return any groups, models, or tier data at all, preserve existing state
    if (!hasGroups && !hasModels && !hasTierData) {
      console.warn(`[QuotaService] Empty/failed API response for ${account.email}. Preserving existing account state & tier.`);
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
        status: account.status || 'healthy',
        isBanned: account.isBanned || false,
        statusMessage: 'Unable to fetch latest metrics from Google API (temporary).'
      };
    }

    const { accountType, tierBadge } = this.determineAccountTier(quotaData, account);
    const isFree = tierBadge === 'STANDARD FREE';
    console.log(`[QuotaService] Tier detected: ${tierBadge} (${accountType}) for ${account.email}`);

    const groups = quotaData?.response?.groups || quotaData?.groups || [];
    const quotaGroups: QuotaGroup[] = [];
    let parsedQuotas: ModelQuota[] = [];

    let geminiGroup: QuotaGroup | undefined;
    let claudeGptGroup: QuotaGroup | undefined;

    for (const g of groups) {
      const gDisplayName = g.displayName || '';
      const gNameLower = gDisplayName.toLowerCase();
      const isGemini = gNameLower.includes('gemini');
      const isClaudeGpt = gNameLower.includes('claude') || gNameLower.includes('gpt') || gNameLower.includes('3p');
      const groupId = isGemini ? 'gemini' : isClaudeGpt ? 'claude_gpt' : gDisplayName.toLowerCase().replace(/\s+/g, '_');

      let group5h: QuotaBucket | undefined;
      let groupWeekly: QuotaBucket | undefined;
      const buckets: QuotaBucket[] = [];

      for (const b of (g.buckets || [])) {
        const bWindow = (b.window || '').toLowerCase();
        const bId = (b.bucketId || '').toLowerCase();
        const bNameLower = (b.displayName || '').toLowerCase();
        const is5h = bWindow === '5h' || bId.includes('5h') || bNameLower.includes('5-hour') || bNameLower.includes('five hour');
        const isWeekly = bWindow === 'weekly' || bId.includes('weekly') || bNameLower.includes('weekly');

        const windowType: '5h' | 'weekly' = is5h ? '5h' : 'weekly';
        const remainingFraction = this.extractFraction(b);
        const percentage = Math.round(remainingFraction * 100);
        const resetTime = b.resetTime || b.quotaInfo?.resetTime || b.quotaResetUTCTimestamp;
        const resetCountdown = resetTime ? this.formatCountdown(resetTime) : undefined;

        const bucket: QuotaBucket = {
          bucketId: b.bucketId || `${groupId}-${windowType}`,
          displayName: b.displayName || (windowType === '5h' ? 'Five Hour Limit Remaining' : 'Weekly Limit Remaining'),
          window: windowType,
          remainingFraction,
          percentage,
          resetTime,
          resetCountdown,
          description: b.description,
          disabled: false
        };

        buckets.push(bucket);
        if (is5h && !group5h) group5h = bucket;
        if (isWeekly && !groupWeekly) groupWeekly = bucket;
      }

      const qg: QuotaGroup = {
        id: groupId,
        name: gDisplayName || (isGemini ? 'Gemini Models' : 'Claude and GPT models'),
        description: g.description,
        fiveHour: group5h,
        weekly: groupWeekly,
        buckets
      };

      quotaGroups.push(qg);
      if (isGemini) geminiGroup = qg;
      if (isClaudeGpt) claudeGptGroup = qg;
    }

    // Dynamically populate model quotas from live API response (fetchAvailableModels)
    const rawModels = quotaData?.models || {};
    const seenIds = new Set<string>();

    const shouldIgnoreModel = (id: string, name: string): boolean => {
      const s = (id + ' ' + name).toLowerCase();
      return (
        s.startsWith('tab_') ||
        s.startsWith('tab-') ||
        s.startsWith('chat_') ||
        s.startsWith('chat-') ||
        s.includes('autocomplete') ||
        s.includes('preview') ||
        s.includes('thinking effort') ||
        s.includes('thinking_effort') ||
        s.includes('thinking budget') ||
        s.includes('thinking_budget')
      );
    };

    if (Object.keys(rawModels).length > 0) {
      for (const [modelId, modelData] of Object.entries<any>(rawModels)) {
        const displayName = this.formatModelDisplayName(modelId, modelData.displayName);
        if (shouldIgnoreModel(modelId, displayName)) continue;

        const normId = this.normalizeModelKey(modelId);
        if (seenIds.has(normId)) continue;
        seenIds.add(normId);

        const idLower = (modelId + ' ' + displayName).toLowerCase();
        const isGemini = idLower.includes('gemini') || idLower.includes('flash');
        const isPro = idLower.includes('pro');
        const isClaudeGpt = idLower.includes('claude') || idLower.includes('gpt') || idLower.includes('opus') || idLower.includes('sonnet');

        let targetBucket: QuotaBucket | undefined;
        let windowType: '5h' | 'weekly' = 'weekly';
        let windowLabel = 'Weekly Quota';

        if (isGemini) {
          if (isPro) {
            targetBucket = geminiGroup?.weekly || geminiGroup?.fiveHour;
            windowType = 'weekly';
            windowLabel = 'Weekly Quota';
          } else {
            targetBucket = geminiGroup?.fiveHour || geminiGroup?.weekly;
            windowType = geminiGroup?.fiveHour ? '5h' : 'weekly';
            windowLabel = geminiGroup?.fiveHour ? '5-Hour Window' : 'Weekly Quota';
          }
        } else if (isClaudeGpt) {
          targetBucket = claudeGptGroup?.fiveHour || claudeGptGroup?.weekly || claudeGptGroup?.buckets[0];
          windowType = claudeGptGroup?.fiveHour ? '5h' : 'weekly';
          windowLabel = claudeGptGroup?.fiveHour ? '5-Hour Window' : 'Weekly Quota';
        }

        const remainingFraction = targetBucket ? targetBucket.remainingFraction : this.extractFraction(modelData);
        const percentage = targetBucket ? targetBucket.percentage : Math.round(remainingFraction * 100);
        const resetTime = targetBucket?.resetTime || modelData.quotaInfo?.resetTime || modelData.resetTime;
        const resetCountdown = targetBucket?.resetCountdown || (resetTime ? this.formatCountdown(resetTime) : undefined);

        parsedQuotas.push({
          id: modelId,
          displayName,
          groupName: isGemini ? 'Gemini Models' : isClaudeGpt ? 'Claude and GPT models' : (targetBucket?.displayName || 'Other Models'),
          description: targetBucket?.description || modelData.description,
          remainingFraction,
          percentage,
          resetTime,
          resetCountdown,
          windowType,
          windowLabel,
          disabled: targetBucket?.disabled ?? false
        });
      }
    }

    if (parsedQuotas.length === 0 && (geminiGroup || claudeGptGroup)) {
      if (geminiGroup) {
        const g5h = geminiGroup.fiveHour;
        const gWk = geminiGroup.weekly;
        parsedQuotas.push({
          id: 'gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          groupName: 'Gemini Models',
          description: g5h?.description || 'Fast multimodal model for rapid iterations',
          remainingFraction: g5h ? g5h.remainingFraction : (gWk ? gWk.remainingFraction : 1.0),
          percentage: g5h ? g5h.percentage : (gWk ? gWk.percentage : 100),
          resetTime: g5h?.resetTime || gWk?.resetTime,
          resetCountdown: g5h?.resetCountdown || gWk?.resetCountdown,
          windowType: g5h ? '5h' : 'weekly',
          windowLabel: g5h ? '5-Hour Window' : 'Weekly Quota',
          disabled: g5h?.disabled ?? false
        });
        parsedQuotas.push({
          id: 'gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          groupName: 'Gemini Models',
          description: gWk?.description || 'Advanced reasoning and complex coding model',
          remainingFraction: gWk ? gWk.remainingFraction : (g5h ? g5h.remainingFraction : 1.0),
          percentage: gWk ? gWk.percentage : (g5h ? g5h.percentage : 100),
          resetTime: gWk?.resetTime || g5h?.resetTime,
          resetCountdown: gWk?.resetCountdown || g5h?.resetCountdown,
          windowType: 'weekly',
          windowLabel: 'Weekly Quota',
          disabled: gWk?.disabled ?? false
        });
      }
      if (claudeGptGroup) {
        const c5h = claudeGptGroup.fiveHour;
        const cWk = claudeGptGroup.weekly;
        parsedQuotas.push({
          id: 'claude-3-7-sonnet',
          displayName: 'Claude 3.7 Sonnet',
          groupName: 'Claude and GPT models',
          description: c5h?.description || cWk?.description || 'Hybrid reasoning and state-of-the-art coding',
          remainingFraction: c5h ? c5h.remainingFraction : (cWk ? cWk.remainingFraction : 1.0),
          percentage: c5h ? c5h.percentage : (cWk ? cWk.percentage : 100),
          resetTime: c5h?.resetTime || cWk?.resetTime,
          resetCountdown: c5h?.resetCountdown || cWk?.resetCountdown,
          windowType: c5h ? '5h' : 'weekly',
          windowLabel: c5h ? '5-Hour Window' : 'Weekly Quota',
          disabled: c5h?.disabled ?? false
        });
        parsedQuotas.push({
          id: 'claude-3-5-sonnet',
          displayName: 'Claude 3.5 Sonnet',
          groupName: 'Claude and GPT models',
          description: cWk?.description || 'Intelligent coding and analysis',
          remainingFraction: cWk ? cWk.remainingFraction : 1.0,
          percentage: cWk ? cWk.percentage : 100,
          resetTime: cWk?.resetTime,
          resetCountdown: cWk?.resetCountdown,
          windowType: 'weekly',
          windowLabel: 'Weekly Quota',
          disabled: cWk?.disabled ?? false
        });
      }
    }

    // Sort parsed model quotas deterministically (highest version first)
    parsedQuotas = QuotaService.sortModelQuotas(parsedQuotas);

    // Compute window properties and group metrics
    const has5Hour = !!geminiGroup?.fiveHour || !!claudeGptGroup?.fiveHour;
    const hasWeekly = !!geminiGroup?.weekly || !!claudeGptGroup?.weekly;

    const fiveHourResetTime = geminiGroup?.fiveHour?.resetTime || claudeGptGroup?.fiveHour?.resetTime;
    const fiveHourResetCountdown = geminiGroup?.fiveHour?.resetCountdown || claudeGptGroup?.fiveHour?.resetCountdown;

    const weeklyResetTime = geminiGroup?.weekly?.resetTime || claudeGptGroup?.weekly?.resetTime;
    const weeklyResetCountdown = geminiGroup?.weekly?.resetCountdown || claudeGptGroup?.weekly?.resetCountdown;

    // Group-level weekly percentages
    const geminiWk = (geminiGroup?.weekly && !geminiGroup.weekly.disabled && geminiGroup.weekly.percentage >= 0)
      ? geminiGroup.weekly.percentage
      : undefined;
    const claudeWk = (claudeGptGroup?.weekly && !claudeGptGroup.weekly.disabled && claudeGptGroup.weekly.percentage >= 0)
      ? claudeGptGroup.weekly.percentage
      : undefined;

    // Combined Weekly percentage (Capacity metric) with weighted model ratio (Gemini 70%, Claude 30%)
    let weeklyPercentage: number | undefined;
    if (geminiWk !== undefined && claudeWk !== undefined) {
      weeklyPercentage = Math.round((geminiWk * MODEL_WEIGHTS.GEMINI + claudeWk * MODEL_WEIGHTS.CLAUDE) / (MODEL_WEIGHTS.GEMINI + MODEL_WEIGHTS.CLAUDE));
    } else if (geminiWk !== undefined) {
      weeklyPercentage = geminiWk;
    } else if (claudeWk !== undefined) {
      weeklyPercentage = claudeWk;
    }

    // Group-level 5-hour rolling window percentages
    const gemini5h = (geminiGroup?.fiveHour && !geminiGroup.fiveHour.disabled && geminiGroup.fiveHour.percentage >= 0)
      ? geminiGroup.fiveHour.percentage
      : undefined;
    const claude5h = (claudeGptGroup?.fiveHour && !claudeGptGroup.fiveHour.disabled && claudeGptGroup.fiveHour.percentage >= 0)
      ? claudeGptGroup.fiveHour.percentage
      : undefined;

    // Combined 5-hour percentage with weighted model ratio (Gemini 70%, Claude 30%)
    let fiveHourPercentage: number | undefined;
    if (gemini5h !== undefined && claude5h !== undefined) {
      fiveHourPercentage = Math.round((gemini5h * MODEL_WEIGHTS.GEMINI + claude5h * MODEL_WEIGHTS.CLAUDE) / (MODEL_WEIGHTS.GEMINI + MODEL_WEIGHTS.CLAUDE));
    } else if (gemini5h !== undefined) {
      fiveHourPercentage = gemini5h;
    } else if (claude5h !== undefined) {
      fiveHourPercentage = claude5h;
    }

    // Check model availability per group
    const geminiAvailable = (geminiWk ?? 0) > 0 && (gemini5h === undefined || gemini5h > 0);
    const claudeAvailable = (claudeWk ?? 0) > 0 && (claude5h === undefined || claude5h > 0);

    let status: AccountStatus = 'healthy';
    let statusMessage: string | undefined;

    if (!geminiAvailable && !claudeAvailable) {
      status = 'low_balance';
      statusMessage = 'All model quotas depleted';
    } else if (!geminiAvailable && claudeAvailable) {
      statusMessage = 'Gemini depleted · Claude available';
    } else if (geminiAvailable && !claudeAvailable) {
      statusMessage = 'Claude depleted · Gemini available';
    }

    // Total Quota of each Account is determined strictly by its Weekly Plan Quota
    // (5h window is an instant rate limit, not overall capacity)
    const averagePercentage = weeklyPercentage ?? this.calculateAveragePercentage(parsedQuotas);

    return {
      quotas: parsedQuotas,
      quotaGroups,
      geminiGroup,
      claudeGptGroup,
      averagePercentage,
      fiveHourPercentage,
      weeklyPercentage,
      fiveHourResetTime,
      fiveHourResetCountdown,
      weeklyResetTime,
      weeklyResetCountdown,
      has5HourQuota: has5Hour,
      hasWeeklyQuota: hasWeekly,
      accountType,
      tierBadge,
      status,
      isBanned: false,
      statusMessage
    };
  }

  /**
   * Finds the soonest upcoming reset time from a list of model quotas.
   */
  public findSoonestResetTime(quotas: ModelQuota[]): string | undefined {
    const valid = quotas.filter((q) => !!q.resetTime);
    if (valid.length === 0) return undefined;
    const now = Date.now();
    const future = valid
      .map((q) => ({ time: q.resetTime!, ms: new Date(q.resetTime!).getTime() }))
      .filter((item) => !isNaN(item.ms) && item.ms > now)
      .sort((a, b) => a.ms - b.ms);
    if (future.length > 0) {
      return future[0].time;
    }
    return valid[0].resetTime;
  }

  /**
   * Multi-strategy live quota fetching against Cloud Code PA backend.
   * Uses daily-cloudcode-pa.googleapis.com first (primary Antigravity backend with Claude & GPT)
   * with fallback to cloudcode-pa.googleapis.com.
   */
  private async fetchLiveQuotaData(accessToken: string): Promise<any> {
    let projectId: string | undefined;
    let tierData: any = {};
    let lastAuthError: Error | null = null;
    let anyEndpointSucceeded = false;

    const hosts = API_ENDPOINTS.CLOUD_CODE_HOSTS;

    // 1. Discover project ID and subscription tier via loadCodeAssist
    const codeAssistBodies = [
      {
        metadata: {
          ide_type: 'ANTIGRAVITY',
          ide_version: '1.22.2',
          ide_name: 'antigravity'
        }
      },
      {
        metadata: {
          ideType: 'ANTIGRAVITY',
          ideVersion: '1.22.2',
          ideName: 'antigravity',
          platform: 'WINDOWS',
          pluginType: 'GEMINI'
        }
      },
      {
        metadata: { ideType: 'ANTIGRAVITY' }
      },
      {}
    ];

    for (const host of hosts) {
      for (const body of codeAssistBodies) {
        try {
          const res = await this.callCloudCodePost(accessToken, host, '/v1internal:loadCodeAssist', body);
          if (res) {
            anyEndpointSucceeded = true;
            if (res.cloudaicompanionProject) {
              projectId = res.cloudaicompanionProject;
            }
            tierData = { ...tierData, ...res };
            break;
          }
        } catch (err: any) {
          if (err.message && (err.message.includes('401') || err.message.includes('UNAUTHENTICATED'))) {
            lastAuthError = err;
          }
        }
      }
      if (projectId || Object.keys(tierData).length > 0) break;
    }

    // 2. Fetch available quota groups (retrieveUserQuotaSummary) and dynamic models (fetchAvailableModels)
    const body = projectId ? { project: projectId } : {};
    let groupsData: any = null;
    let modelsData: any = null;

    for (const host of hosts) {
      if (!groupsData) {
        try {
          groupsData = await this.callCloudCodePost(accessToken, host, '/v1internal:retrieveUserQuotaSummary', body);
          if (groupsData) anyEndpointSucceeded = true;
        } catch (err: any) {
          if (err.message && (err.message.includes('401') || err.message.includes('UNAUTHENTICATED'))) {
            lastAuthError = err;
          }
          if (projectId) {
            try {
              groupsData = await this.callCloudCodePost(accessToken, host, '/v1internal:retrieveUserQuotaSummary', {});
              if (groupsData) anyEndpointSucceeded = true;
            } catch {}
          }
        }
      }

      if (!modelsData) {
        try {
          modelsData = await this.callCloudCodePost(accessToken, host, '/v1internal:fetchAvailableModels', body);
          if (modelsData) anyEndpointSucceeded = true;
        } catch (err: any) {
          if (err.message && (err.message.includes('401') || err.message.includes('UNAUTHENTICATED'))) {
            lastAuthError = err;
          }
          if (projectId) {
            try {
              modelsData = await this.callCloudCodePost(accessToken, host, '/v1internal:fetchAvailableModels', {});
              if (modelsData) anyEndpointSucceeded = true;
            } catch {}
          }
        }
      }

      if (groupsData && modelsData) break;
    }

    // If nothing succeeded and we encountered 401, throw so fetchAccountQuotas can refresh token or mark auth_failed
    if (!anyEndpointSucceeded && lastAuthError) {
      throw lastAuthError;
    }

    return {
      ...tierData,
      ...(groupsData || {}),
      models: modelsData?.models || groupsData?.models || tierData?.models || {},
      response: groupsData?.response || groupsData
    };
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

  private extractFraction(data: any): number {
    if (!data) return 0.0;
    const q = data.quotaInfo || data.quota || data.userQuota || data;
    if (!q) return 0.0;


    // Direct fraction numbers
    if (typeof q.remainingFraction === 'number') return Math.max(0, Math.min(1, q.remainingFraction));
    if (typeof data.remainingFraction === 'number') return Math.max(0, Math.min(1, data.remainingFraction));
    if (typeof q.fraction === 'number') return Math.max(0, Math.min(1, q.fraction));
    if (typeof data.fraction === 'number') return Math.max(0, Math.min(1, data.fraction));
    if (typeof q.remainingQuota === 'number') return Math.max(0, Math.min(1, q.remainingQuota));

    // Nested remaining object (proto3 oneof or wrapped value)
    if (q.remaining && typeof q.remaining === 'object') {
      if (typeof q.remaining.value === 'number') return Math.max(0, Math.min(1, q.remaining.value));
      if (typeof q.remaining.remainingFraction === 'number') return Math.max(0, Math.min(1, q.remaining.remainingFraction));
      if (typeof q.remaining.fraction === 'number') return Math.max(0, Math.min(1, q.remaining.fraction));
    }
    if (data.remaining && typeof data.remaining === 'object') {
      if (typeof data.remaining.value === 'number') return Math.max(0, Math.min(1, data.remaining.value));
      if (typeof data.remaining.remainingFraction === 'number') return Math.max(0, Math.min(1, data.remaining.remainingFraction));
      if (typeof data.remaining.fraction === 'number') return Math.max(0, Math.min(1, data.remaining.fraction));
    }

    if (typeof q.remaining === 'number') return Math.max(0, Math.min(1, q.remaining));

    // Percentage values (0-100)
    if (typeof q.remainingPercentage === 'number') return Math.max(0, Math.min(1, q.remainingPercentage / 100));
    if (typeof q.percentage === 'number') return Math.max(0, Math.min(1, q.percentage / 100));

    // Used / consumed fraction inversion
    if (typeof q.usedFraction === 'number') return Math.max(0, Math.min(1, 1 - q.usedFraction));
    if (typeof q.consumedFraction === 'number') return Math.max(0, Math.min(1, 1 - q.consumedFraction));
    if (typeof data.usedFraction === 'number') return Math.max(0, Math.min(1, 1 - data.usedFraction));

    // In proto3 JSON serialization, default float 0.0 is omitted!
    // Therefore, if quotaInfo or resetTime is present but remainingFraction is missing,
    // the quota has been completely depleted (0% remaining).
    if (data.quotaInfo || q.resetTime || data.resetTime) {
      return 0.0;
    }

    return 0.0;
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

    // 1. Check grouped quota buckets (from retrieveUserQuotaSummary - canonical source)
    const groups = rawResponse?.response?.groups || rawResponse?.groups || [];
    if (groups.length > 0) {
      for (const group of groups) {
        const groupName = (group.displayName || '').toLowerCase();
        const buckets: any[] = group.buckets || [];

        // Find 5h and weekly buckets within the group
        const bucket5h = buckets.find((b: any) =>
          (b.window && b.window.toLowerCase() === '5h') ||
          (b.bucketId && b.bucketId.toLowerCase().includes('5h')) ||
          (b.displayName && (b.displayName.toLowerCase().includes('5-hour') || b.displayName.toLowerCase().includes('five hour')))
        );
        const bucketWeekly = buckets.find((b: any) =>
          (b.window && b.window.toLowerCase() === 'weekly') ||
          (b.bucketId && b.bucketId.toLowerCase().includes('weekly')) ||
          (b.displayName && b.displayName.toLowerCase().includes('weekly'))
        );

        if (groupName.includes('gemini')) {
          const has5h = !!bucket5h;
          // Gemini Flash models: governed by the 5-Hour Rolling Window bucket if present (paid plans), else weekly (free tier)
          const flashBucket = bucket5h || bucketWeekly || buckets[0] || {};
          const flashFraction = this.extractFraction(flashBucket);
          const flashPct = Math.round(flashFraction * 100);
          const flashResetTime = flashBucket.quotaInfo?.resetTime || flashBucket.resetTime || flashBucket.quotaResetUTCTimestamp;
          const flashCountdown = flashResetTime ? this.formatCountdown(flashResetTime) : undefined;

          // Gemini Pro models: governed by the Weekly Plan Quota bucket
          const proBucket = bucketWeekly || bucket5h || buckets[0] || {};
          const proFraction = this.extractFraction(proBucket);
          const proPct = Math.round(proFraction * 100);
          const proResetTime = proBucket.quotaInfo?.resetTime || proBucket.resetTime || proBucket.quotaResetUTCTimestamp;
          const proCountdown = proResetTime ? this.formatCountdown(proResetTime) : undefined;

          const geminiFlashModels = [
            { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
            { id: 'gemini-3.7-flash', displayName: 'Gemini 3.7 Flash' },
            { id: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash' },
            { id: 'gemini-3.1-flash', displayName: 'Gemini 3.1 Flash' }
          ];
          for (const m of geminiFlashModels) {
            if (seenIds.has(m.id)) continue;
            seenIds.add(m.id);
            list.push({
              id: m.id,
              displayName: m.displayName,
              description: flashBucket.description || group.description,
              remainingFraction: flashFraction,
              percentage: flashPct,
              resetTime: flashResetTime,
              resetCountdown: flashCountdown,
              windowType: has5h ? '5h' : 'weekly',
              windowLabel: has5h ? '5-Hour Rolling Window' : 'Weekly Plan Quota',
              disabled: flashBucket.disabled ?? false
            });
          }


          const geminiProModels = [
            { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
            { id: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro' }
          ];
          for (const m of geminiProModels) {
            if (seenIds.has(m.id)) continue;
            seenIds.add(m.id);
            list.push({
              id: m.id,
              displayName: m.displayName,
              description: proBucket.description || group.description,
              remainingFraction: proFraction,
              percentage: proPct,
              resetTime: proResetTime,
              resetCountdown: proCountdown,
              windowType: 'weekly',
              windowLabel: 'Weekly Plan Quota',
              disabled: proBucket.disabled ?? false
            });
          }
        } else if (groupName.includes('claude') || groupName.includes('gpt') || groupName.includes('3p')) {
          // Third-party models (Claude Sonnet, Claude Opus, GPT-OSS) are governed by the Weekly Plan Quota bucket
          const thirdPartyBucket = bucketWeekly || bucket5h || buckets[0] || {};
          const fraction = this.extractFraction(thirdPartyBucket);
          const percentage = Math.round(fraction * 100);
          const resetTime = thirdPartyBucket.quotaInfo?.resetTime || thirdPartyBucket.resetTime || thirdPartyBucket.quotaResetUTCTimestamp;
          const resetCountdown = resetTime ? this.formatCountdown(resetTime) : undefined;

          const thirdPartyModels = [
            { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
            { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
            { id: 'gpt-oss-120b', displayName: 'GPT-OSS 120B' }
          ];
          for (const m of thirdPartyModels) {
            if (seenIds.has(m.id)) continue;
            seenIds.add(m.id);
            list.push({
              id: m.id,
              displayName: m.displayName,
              description: thirdPartyBucket.description || group.description,
              remainingFraction: fraction,
              percentage,
              resetTime,
              resetCountdown,
              windowType: 'weekly',
              windowLabel: 'Weekly Plan Quota',
              disabled: thirdPartyBucket.disabled ?? false
            });
          }
        }
      }
    }

    // 2. Check direct models map (from fetchAvailableModels)
    if (rawResponse && rawResponse.models) {
      for (const [modelId, modelData] of Object.entries<any>(rawResponse.models)) {
        const displayName = this.formatModelDisplayName(modelId, modelData.displayName);
        if (shouldIgnoreModel(modelId, displayName)) {
          continue;
        }

        const normId = this.normalizeModelKey(modelId);
        if (seenIds.has(normId)) continue;
        seenIds.add(normId);

        const fraction = this.extractFraction(modelData);
        const percentage = Math.round(fraction * 100);
        const resetTime = modelData.quotaInfo?.resetTime || modelData.resetTime;
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
    const extractVersion = (s: string): number => {
      const match = s.match(/(\d+(?:\.\d+)?)/);
      return match ? parseFloat(match[1]) : 0;
    };

    const getRank = (q: ModelQuota): number => {
      const s = (q.id + ' ' + (q.displayName || '')).toLowerCase();
      const isGemini = s.includes('gemini') || s.includes('flash');
      const isClaude = s.includes('claude') || s.includes('opus') || s.includes('sonnet') || s.includes('haiku');
      const isGpt = s.includes('gpt');

      const ver = extractVersion(s);

      if (isGemini) {
        // Higher version = higher priority (e.g. 3.8 > 3.7 > 3.6 > 3.5 > 3.1 > 3.0 > 2.5)
        const typeBonus = s.includes('pro') ? 0.05 : 0;
        return 1000 - (ver * 100 + typeBonus);
      }

      if (isClaude) {
        // Higher version = higher priority (e.g. 5.5 > 4.6 > 3.7 > 3.5)
        const typeBonus = s.includes('opus') ? 0.1 : s.includes('sonnet') ? 0.05 : 0;
        return 2000 - (ver * 100 + typeBonus);
      }

      if (isGpt) {
        return 3000 - ver;
      }

      return 4000;
    };

    return [...quotas].sort((a, b) => {
      const rankA = getRank(a);
      const rankB = getRank(b);
      if (rankA !== rankB) return rankA - rankB;
      return (a.displayName || a.id).localeCompare(b.displayName || b.id);
    });
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

    // 1. Model-family heuristic: Claude, GPT, Gemini Pro are ALWAYS weekly plan quotas in Antigravity
    if (
      idLower.includes('claude') ||
      idLower.includes('opus') ||
      idLower.includes('sonnet') ||
      idLower.includes('gpt-oss') ||
      idLower.includes('gpt_oss') ||
      idLower.includes('gpt') ||
      idLower.includes('gemini-2.5-pro') ||
      idLower.includes('gemini-3-pro') ||
      idLower.includes('gemini-pro') ||
      idLower.includes('weekly') ||
      idLower.includes('plan quota') ||
      idLower.includes('pro-agent')
    ) {
      return { windowType: 'weekly', windowLabel: 'Weekly Plan Quota' };
    }

    // 2. Gemini Flash models are ALWAYS 5h rolling window
    if (idLower.includes('flash') || idLower.includes('5h')) {
      return { windowType: '5h', windowLabel: '5-Hour Rolling Window' };
    }

    // 3. Check reset time duration for dynamic models
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

    return { windowType: '5h', windowLabel: '5-Hour Rolling Window' };
  }

  /**
   * Determines account subscription tier strictly based on Google account subscription data.
   * Standard free accounts will always receive 'STANDARD FREE' without Pro badge.
   */
  public determineAccountTier(rawResponse: any, account?: AccountInfo): { accountType: string; tierBadge: AccountTierType } {
    if (!rawResponse) {
      return {
        accountType: account?.accountType || 'Standard Free',
        tierBadge: account?.tierBadge || 'STANDARD FREE'
      };
    }

    const checkStringForPaidTier = (val: string): AccountTierType | null => {
      if (!val || typeof val !== 'string') return null;
      const s = val.toLowerCase();
      if (s.includes('enterprise') || s.includes('corporate') || s.includes('workspace_enterprise')) return 'ENTERPRISE';
      if (s.includes('ultra') || s.includes('gemini_ultra') || s.includes('ai_ultra') || s.includes('g1-ultra')) return 'ULTRA';
      if (s.includes('ai_premium') || s.includes('ai premium') || s.includes('gemini advanced') || s.includes('google_one_premium') || s.includes('g1-premium')) return 'AI PREMIUM';
      if (s.includes('user_tier_pro') || s.includes('tier_pro') || s.includes('google_one_pro') || s.includes('pro_tier') || s.includes('g1-pro') || s.includes('google ai pro') || /\bpro\b/.test(s)) {
        return 'PRO';
      }
      return null;
    };

    // 1. Check paidTier FIRST (This is Google's canonical field for paid Google AI / Google One subscriptions)
    if (rawResponse.paidTier) {
      if (typeof rawResponse.paidTier === 'object') {
        const id = (rawResponse.paidTier.id || '').toLowerCase();
        const name = (rawResponse.paidTier.name || '').toLowerCase();
        const desc = (rawResponse.paidTier.description || '').toLowerCase();
        const combined = `${id} ${name} ${desc}`;

        const t = checkStringForPaidTier(combined);
        if (t) return this.mapBadgeToResult(t);

        // If paidTier is explicitly free-tier / starter quota (e.g. "free-tier" "Antigravity Starter Quota")
        if (id === 'free-tier' || name.includes('starter') || combined.includes('free-tier')) {
          if (!rawResponse.userTier || !checkStringForPaidTier(typeof rawResponse.userTier === 'string' ? rawResponse.userTier : JSON.stringify(rawResponse.userTier))) {
            return { accountType: 'Standard Free', tierBadge: 'STANDARD FREE' };
          }
        }
      } else if (typeof rawResponse.paidTier === 'string') {
        const t = checkStringForPaidTier(rawResponse.paidTier);
        if (t) return this.mapBadgeToResult(t);
        if (rawResponse.paidTier.toLowerCase().includes('free')) {
          return { accountType: 'Standard Free', tierBadge: 'STANDARD FREE' };
        }
      }
    }

    // 2. Check userTier (Antigravity's internal user subscription tier)
    if (rawResponse.userTier) {
      if (typeof rawResponse.userTier === 'object') {
        const combined = `${rawResponse.userTier.id || ''} ${rawResponse.userTier.name || ''} ${rawResponse.userTier.description || ''}`;
        const t = checkStringForPaidTier(combined);
        if (t) return this.mapBadgeToResult(t);
      } else if (typeof rawResponse.userTier === 'string') {
        const t = checkStringForPaidTier(rawResponse.userTier);
        if (t) return this.mapBadgeToResult(t);
      }
    }

    // 3. Check explicit plan / subscription fields
    const planObj = rawResponse.plan || rawResponse.subscription || rawResponse.userSubscription || rawResponse.accountPlan;
    if (planObj) {
      const s = typeof planObj === 'string' ? planObj : JSON.stringify(planObj);
      const t = checkStringForPaidTier(s);
      if (t) return this.mapBadgeToResult(t);
    }

    // 4. Check retrieveUserQuotaSummary buckets:
    // In Google Cloud Code PA, ONLY paid Google AI accounts (Pro/Ultra) receive 5-hour rolling limit buckets ("Five Hour Limit Remaining" / window: "5h").
    // Standard Free accounts ONLY have Weekly Limit Remaining.
    const groups = rawResponse?.response?.groups || rawResponse?.groups || [];
    const has5hBucket = groups.some((g: any) =>
      (g.buckets || []).some((b: any) => {
        const win = (b.window || '').toLowerCase();
        const bId = (b.bucketId || '').toLowerCase();
        const dName = (b.displayName || '').toLowerCase();
        return win === '5h' || bId.includes('5h') || dName.includes('5-hour') || dName.includes('five hour');
      })
    );
    if (has5hBucket) {
      return { accountType: 'Google AI Pro', tierBadge: 'PRO' };
    }

    // 5. Check if currentTier explicitly indicates a paid plan (excluding "free-tier" which is just the IDE client tier)
    if (rawResponse.currentTier) {
      if (typeof rawResponse.currentTier === 'object') {
        const id = (rawResponse.currentTier.id || '').toLowerCase();
        const name = (rawResponse.currentTier.name || '').toLowerCase();
        if (id !== 'free-tier' && !id.includes('free')) {
          const t = checkStringForPaidTier(`${id} ${name}`);
          if (t) return this.mapBadgeToResult(t);
        }
      } else if (typeof rawResponse.currentTier === 'string') {
        if (!rawResponse.currentTier.toLowerCase().includes('free')) {
          const t = checkStringForPaidTier(rawResponse.currentTier);
          if (t) return this.mapBadgeToResult(t);
        }
      }
    }

    // Preserve existing known paid tier if response didn't specify
    if (account?.tierBadge && account.tierBadge !== 'STANDARD FREE') {
      return {
        accountType: account.accountType || this.mapBadgeToResult(account.tierBadge).accountType,
        tierBadge: account.tierBadge
      };
    }

    return { accountType: 'Standard Free', tierBadge: 'STANDARD FREE' };
  }


  private mapBadgeToResult(tier: AccountTierType): { accountType: string; tierBadge: AccountTierType } {
    switch (tier) {
      case 'ENTERPRISE':
        return { accountType: 'Antigravity Enterprise', tierBadge: 'ENTERPRISE' };
      case 'ULTRA':
        return { accountType: 'Google AI Ultra', tierBadge: 'ULTRA' };
      case 'AI PREMIUM':
        return { accountType: 'Google AI Premium', tierBadge: 'AI PREMIUM' };
      case 'PRO':
        return { accountType: 'Google AI Pro', tierBadge: 'PRO' };
      case 'STANDARD FREE':
      default:
        return { accountType: 'Standard Free', tierBadge: 'STANDARD FREE' };
    }
  }

  /**
   * Computes capacity-weighted overall aggregate percentage across all healthy accounts.
   * Accounts with higher tier allocations (Enterprise > Ultra > AI Premium > Pro > Free) contribute proportionately:
   * - Enterprise: 5.0x weight
   * - Ultra: 4.0x weight
   * - AI Premium: 3.0x weight
   * - Pro: 1.0x weight
   * - Free: 0.5x baseline weight (at 100% standard access) for overall; 0x weight for weekly & 5h windows.
   */
  public calculateOverallSummary(accounts: AccountInfo[]): OverallQuotaSummary {
    if (accounts.length === 0) {
      return {
        totalAccounts: 0,
        instantPercentage: 0,
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

    const getTierWeight = (tier: AccountTierType): number => {
      switch (tier) {
        case 'ENTERPRISE':
          return TIER_WEIGHTS.ENTERPRISE;
        case 'ULTRA':
          return TIER_WEIGHTS.ULTRA;
        case 'AI PREMIUM':
          return TIER_WEIGHTS['AI PREMIUM'];
        case 'PRO':
          return TIER_WEIGHTS.PRO;
        case 'STANDARD FREE':
        default:
          return TIER_WEIGHTS.FREE;
      }
    };

    const activeAcc = accounts.find((a) => a.isActive) || accounts[0];
    let sumOverallWeighted = 0;
    let totalOverallWeight = 0;

    let sumInstantWeighted = 0;
    let totalInstantWeight = 0;

    let sum5hWeighted = 0;
    let total5hWeight = 0;

    let sumWeeklyWeighted = 0;
    let totalWeeklyWeight = 0;

    let sumGemini5h = 0, totalGemini5hWeight = 0;
    let sumGeminiWeekly = 0, totalGeminiWeeklyWeight = 0;
    let sumClaude5h = 0, totalClaude5hWeight = 0;
    let sumClaudeWeekly = 0, totalClaudeWeeklyWeight = 0;

    let maxPercentage = 0;
    let healthyCount = 0;
    let lowCount = 0;
    let errorCount = 0;
    let proCount = 0;

    for (const acc of accounts) {
      const isFree = !acc.tierBadge || acc.tierBadge === 'STANDARD FREE';
      if (!isFree) {
        proCount++;
      }

      if (acc.isBanned || acc.status === 'auth_failed' || acc.status === 'banned') {
        errorCount++;
        continue;
      }

      // Skip accounts that have no quota data yet (e.g. newly added, first fetch pending)
      const hasQuotaData =
        (Array.isArray(acc.quotas) && acc.quotas.length > 0) ||
        acc.geminiGroup != null ||
        acc.claudeGptGroup != null ||
        (Array.isArray(acc.quotaGroups) && acc.quotaGroups.length > 0) ||
        acc.weeklyQuotaPercentage !== undefined ||
        acc.fiveHourQuotaPercentage !== undefined ||
        (acc.lastRefreshedAt !== undefined && acc.averageQuotaPercentage !== undefined);

      if (!hasQuotaData) {
        continue;
      }

      healthyCount++;

      // Weekly / Capacity percentage of this account (Gemini 70% + Claude 30%)
      const pWeekly = acc.weeklyQuotaPercentage ?? acc.averageQuotaPercentage ?? 0;
      if (pWeekly > maxPercentage) maxPercentage = pWeekly;
      if (pWeekly < 20) {
        lowCount++;
      }

      const weight = getTierWeight(acc.tierBadge);

      // 1. Overall capacity: weighted sum of weekly plan quotas across all healthy accounts
      sumOverallWeighted += pWeekly * weight;
      totalOverallWeight += weight;

      // 2. Instant quota: usable burst quota in current session.
      // - For Free accounts: Weekly plan quota is the only available window.
      // - For Paid accounts: 5-Hour rolling window is modulated by safe weekly capacity.
      //   Above 40% weekly (safe burst boundary), 5h is 100% usable (HealthFactor = 1.0).
      //   Below 40% weekly, weekly fuel attenuates 5h via smooth square-root decay (Math.sqrt(Weekly / 40)).
      let pInstant = pWeekly;
      if (!isFree) {
        let p5h: number | undefined = acc.fiveHourQuotaPercentage;
        if (p5h === undefined && acc.geminiGroup?.fiveHour && !acc.geminiGroup.fiveHour.disabled && acc.geminiGroup.fiveHour.percentage >= 0) {
          const g5h = acc.geminiGroup.fiveHour.percentage;
          const c5h = (acc.claudeGptGroup?.fiveHour && !acc.claudeGptGroup.fiveHour.disabled && acc.claudeGptGroup.fiveHour.percentage >= 0)
            ? acc.claudeGptGroup.fiveHour.percentage
            : undefined;
          p5h = c5h !== undefined ? Math.round((g5h * MODEL_WEIGHTS.GEMINI + c5h * MODEL_WEIGHTS.CLAUDE) / (MODEL_WEIGHTS.GEMINI + MODEL_WEIGHTS.CLAUDE)) : g5h;
        }
        if (p5h !== undefined) {
          pInstant = calculateModulatedInstantQuota(p5h, pWeekly);
        }
      }
      sumInstantWeighted += pInstant * weight;
      totalInstantWeight += weight;

      // 3. 5-Hour Rolling Window aggregates
      const has5h = acc.fiveHourQuotaPercentage !== undefined || (acc.geminiGroup?.fiveHour && !acc.geminiGroup.fiveHour.disabled);
      if (has5h) {
        const val5h = acc.fiveHourQuotaPercentage ?? acc.geminiGroup?.fiveHour?.percentage ?? acc.claudeGptGroup?.fiveHour?.percentage ?? 0;
        sum5hWeighted += val5h * weight;
        total5hWeight += weight;
      }

      // 4. Weekly Plan Quota aggregates
      const hasWk = acc.weeklyQuotaPercentage !== undefined || (acc.geminiGroup?.weekly && !acc.geminiGroup.weekly.disabled);
      if (hasWk) {
        const valWk = acc.weeklyQuotaPercentage ?? acc.geminiGroup?.weekly?.percentage ?? acc.claudeGptGroup?.weekly?.percentage ?? 0;
        sumWeeklyWeighted += valWk * weight;
        totalWeeklyWeight += weight;
      }

      // Gemini Separated Aggregates
      const g5h = acc.geminiGroup?.fiveHour;
      if (g5h && !g5h.disabled && g5h.percentage >= 0) {
        sumGemini5h += g5h.percentage * weight;
        totalGemini5hWeight += weight;
      }
      const gWk = acc.geminiGroup?.weekly;
      if (gWk && !gWk.disabled && gWk.percentage >= 0) {
        sumGeminiWeekly += gWk.percentage * weight;
        totalGeminiWeeklyWeight += weight;
      }

      // Claude & GPT Separated Aggregates
      const c5h = acc.claudeGptGroup?.fiveHour;
      if (c5h && !c5h.disabled && c5h.percentage >= 0) {
        sumClaude5h += c5h.percentage * weight;
        totalClaude5hWeight += weight;
      }
      const cWk = acc.claudeGptGroup?.weekly;
      if (cWk && !cWk.disabled && cWk.percentage >= 0) {
        sumClaudeWeekly += cWk.percentage * weight;
        totalClaudeWeeklyWeight += weight;
      }
    }

    const overallPct = totalOverallWeight > 0 ? Math.round(sumOverallWeighted / totalOverallWeight) : 0;
    const instantPct = totalInstantWeight > 0 ? Math.round(sumInstantWeighted / totalInstantWeight) : 0;
    const overall5hPct = total5hWeight > 0 ? Math.round(sum5hWeighted / total5hWeight) : undefined;
    const overallWeeklyPct = totalWeeklyWeight > 0 ? Math.round(sumWeeklyWeighted / totalWeeklyWeight) : undefined;
    const gemini5hPct = totalGemini5hWeight > 0 ? Math.round(sumGemini5h / totalGemini5hWeight) : undefined;
    const geminiWkPct = totalGeminiWeeklyWeight > 0 ? Math.round(sumGeminiWeekly / totalGeminiWeeklyWeight) : undefined;
    const claude5hPct = totalClaude5hWeight > 0 ? Math.round(sumClaude5h / totalClaude5hWeight) : undefined;
    const claudeWkPct = totalClaudeWeeklyWeight > 0 ? Math.round(sumClaudeWeekly / totalClaudeWeeklyWeight) : undefined;
    const activePct = activeAcc ? (activeAcc.averageQuotaPercentage || 0) : 0;

    return {
      totalAccounts: accounts.length,
      activeAccountEmail: activeAcc?.email,
      instantPercentage: errorCount === accounts.length ? 0 : instantPct,
      overallPercentage: errorCount === accounts.length ? 0 : overallPct,
      gemini5HourPercentage: gemini5hPct,
      geminiWeeklyPercentage: geminiWkPct,
      claude5HourPercentage: claude5hPct,
      claudeWeeklyPercentage: claudeWkPct,
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
