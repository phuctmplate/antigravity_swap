import {
  AccountInfo,
  AccountStatus,
  AccountTierType,
  ModelQuota,
  QuotaBucket,
  QuotaGroup
} from '../types';
import { MODEL_WEIGHTS } from '../constants';
import {
  is5HourBucket,
  isWeeklyBucket,
  classifyQuotaWindow,
  determineAccountTier
} from './quotaClassifier';
import {
  extractFraction,
  formatCountdown,
  parseCountdownFromDescription,
  synthesizeResetTimeFromDescription,
  formatModelDisplayName,
  normalizeModelKey,
  sortModelQuotas
} from './quotaFormatters';
import { calculateAveragePercentage } from './quotaCalculator';

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

export class QuotaParser {
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

    const { accountType, tierBadge } = determineAccountTier(quotaData, account);
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
        const is5h = is5HourBucket(b.window, b.bucketId, b.displayName);
        const isWeekly = isWeeklyBucket(b.window, b.bucketId, b.displayName);

        const windowType: '5h' | 'weekly' = is5h ? '5h' : 'weekly';
        const remainingFraction = extractFraction(b);
        const percentage = Math.round(remainingFraction * 100);
        const descCountdown = parseCountdownFromDescription(b.description);
        let resetTime = b.resetTime || b.quotaInfo?.resetTime || b.quotaResetUTCTimestamp;
        if (!resetTime && b.description) {
          resetTime = synthesizeResetTimeFromDescription(b.description);
        }
        const resetCountdown = descCountdown || (resetTime ? formatCountdown(resetTime) : undefined);

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

      // Safe fallback if bucket naming didn't explicitly match keywords
      if (buckets.length > 0) {
        if (!group5h && !groupWeekly) {
          if (isFree) {
            groupWeekly = buckets[0];
          } else {
            group5h = buckets[0];
          }
        }
      }

      // Free tier accounts never have a 5-hour rolling limit window
      if (isFree) {
        group5h = undefined;
      }

      const qg: QuotaGroup = {
        id: groupId,
        name: gDisplayName || (isGemini ? 'Gemini Models' : 'Claude and GPT models'),
        description: g.description,
        fiveHour: isFree ? undefined : group5h,
        weekly: groupWeekly,
        buckets
      };

      quotaGroups.push(qg);
      if (isGemini) geminiGroup = qg;
      if (isClaudeGpt) claudeGptGroup = qg;
    }

    // Merge/preserve previous data from account if new response is missing any group or bucket
    const prevGemini = account.geminiGroup || account.quotaGroups?.find((g) => g.id === 'gemini' || g.name.toLowerCase().includes('gemini'));
    const prevClaude = account.claudeGptGroup || account.quotaGroups?.find((g) => g.id === 'claude_gpt' || g.name.toLowerCase().includes('claude') || g.name.toLowerCase().includes('gpt'));

    if (!geminiGroup && prevGemini) {
      geminiGroup = {
        ...prevGemini,
        fiveHour: isFree ? undefined : prevGemini.fiveHour
      };
      quotaGroups.push(geminiGroup);
    } else if (geminiGroup && prevGemini) {
      if (!geminiGroup.fiveHour && !isFree && prevGemini.fiveHour) {
        geminiGroup.fiveHour = prevGemini.fiveHour;
      }
      if (!geminiGroup.weekly && prevGemini.weekly) {
        geminiGroup.weekly = prevGemini.weekly;
      }
    }

    if (!claudeGptGroup && prevClaude) {
      claudeGptGroup = {
        ...prevClaude,
        fiveHour: isFree ? undefined : prevClaude.fiveHour
      };
      quotaGroups.push(claudeGptGroup);
    } else if (claudeGptGroup && prevClaude) {
      if (!claudeGptGroup.fiveHour && !isFree && prevClaude.fiveHour) {
        claudeGptGroup.fiveHour = prevClaude.fiveHour;
      }
      if (!claudeGptGroup.weekly && prevClaude.weekly) {
        claudeGptGroup.weekly = prevClaude.weekly;
      }
    }

    // Critical: If account downgraded from Pro/Ultra to Free tier, strictly purge 5h buckets
    if (isFree) {
      if (geminiGroup) geminiGroup.fiveHour = undefined;
      if (claudeGptGroup) claudeGptGroup.fiveHour = undefined;
      for (const qg of quotaGroups) {
        qg.fiveHour = undefined;
      }
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
        const displayName = formatModelDisplayName(modelId, modelData.displayName);
        if (shouldIgnoreModel(modelId, displayName)) continue;

        const normId = normalizeModelKey(modelId);
        if (seenIds.has(normId)) continue;
        seenIds.add(normId);

        const idLower = (modelId + ' ' + displayName).toLowerCase();
        const isGemini = idLower.includes('gemini') || idLower.includes('flash');
        const isClaudeGpt = idLower.includes('claude') || idLower.includes('gpt') || idLower.includes('opus') || idLower.includes('sonnet');

        const knownWeeklyReset = isGemini ? geminiGroup?.weekly?.resetTime : isClaudeGpt ? claudeGptGroup?.weekly?.resetTime : undefined;
        const known5HourReset = isGemini ? geminiGroup?.fiveHour?.resetTime : isClaudeGpt ? claudeGptGroup?.fiveHour?.resetTime : undefined;
        const resetTimeCandidate = modelData.quotaInfo?.resetTime || modelData.resetTime;
        const { windowType, windowLabel } = classifyQuotaWindow(
          modelId,
          displayName,
          resetTimeCandidate,
          modelData.description,
          knownWeeklyReset,
          known5HourReset,
          isFree
        );

        let targetBucket: QuotaBucket | undefined;
        if (isGemini) {
          targetBucket = windowType === '5h' ? (geminiGroup?.fiveHour || geminiGroup?.weekly) : (geminiGroup?.weekly || geminiGroup?.fiveHour);
        } else if (isClaudeGpt) {
          targetBucket = windowType === '5h' ? (claudeGptGroup?.fiveHour || claudeGptGroup?.weekly) : (claudeGptGroup?.weekly || claudeGptGroup?.fiveHour);
        }

        const modelFraction = extractFraction(modelData);
        const hasModelQuota = modelData.quotaInfo && typeof modelData.quotaInfo.remainingFraction === 'number';

        let remainingFraction: number;
        let resetTime: string | undefined;

        if (hasModelQuota) {
          const modelQuotaFrac = Math.max(0, Math.min(1, modelData.quotaInfo.remainingFraction));
          remainingFraction = targetBucket ? Math.min(modelQuotaFrac, targetBucket.remainingFraction) : modelQuotaFrac;
          // Prioritize model's authentic resetTime; only fall back to targetBucket resetTime
          resetTime = modelData.quotaInfo.resetTime || targetBucket?.resetTime;
        } else if (targetBucket) {
          remainingFraction = targetBucket.remainingFraction;
          resetTime = targetBucket.resetTime;
        } else {
          remainingFraction = modelFraction;
          resetTime = modelData.resetTime;
        }

        const percentage = Math.round(remainingFraction * 100);
        let resetCountdown: string | undefined;
        if (resetTime) {
          resetCountdown = formatCountdown(resetTime);
        } else if (targetBucket?.resetCountdown) {
          resetCountdown = targetBucket.resetCountdown;
        }

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
          resetTime: gWk?.resetTime,
          resetCountdown: gWk?.resetCountdown,
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
    parsedQuotas = sortModelQuotas(parsedQuotas);

    // Helper to verify a reset time is genuinely within a 5h rolling window (<= 5.5 hours from now)
    const isWithin5hWindow = (timeStr?: string): boolean => {
      if (!timeStr) return true;
      try {
        const diffHours = (new Date(timeStr).getTime() - Date.now()) / (1000 * 60 * 60);
        return diffHours <= 5.5;
      } catch {
        return false;
      }
    };

    // Synchronize Gemini 5h bucket with live 5h model consumption (only if model consumption is genuinely within 5h window)
    if (!isFree && geminiGroup) {
      const gemini5hModels = parsedQuotas.filter(
        (q) => ((q.groupName || '').toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('flash')) &&
               q.windowType === '5h' && !q.disabled && q.percentage >= 0 &&
               !/\bpro\b|[-_.]pro\b/i.test(q.id + ' ' + q.displayName) &&
               (!geminiGroup.weekly?.resetTime || q.resetTime !== geminiGroup.weekly.resetTime) &&
               isWithin5hWindow(q.resetTime)
      );
      if (gemini5hModels.length > 0) {
        const minGemini5hModel = gemini5hModels.reduce((prev, curr) => (curr.remainingFraction < prev.remainingFraction ? curr : prev));
        if (!geminiGroup.fiveHour || minGemini5hModel.remainingFraction < geminiGroup.fiveHour.remainingFraction || (!geminiGroup.fiveHour.resetTime && minGemini5hModel.resetTime)) {
          const rTime = (minGemini5hModel.resetTime && isWithin5hWindow(minGemini5hModel.resetTime))
            ? minGemini5hModel.resetTime
            : (geminiGroup.fiveHour?.resetTime && isWithin5hWindow(geminiGroup.fiveHour.resetTime) ? geminiGroup.fiveHour.resetTime : undefined);
          const frac = Math.min(minGemini5hModel.remainingFraction, geminiGroup.fiveHour?.remainingFraction ?? minGemini5hModel.remainingFraction);
          geminiGroup.fiveHour = {
            bucketId: geminiGroup.fiveHour?.bucketId || 'gemini-5h',
            displayName: geminiGroup.fiveHour?.displayName || 'Five Hour Limit Remaining',
            window: '5h',
            remainingFraction: frac,
            percentage: Math.round(frac * 100),
            resetTime: rTime,
            resetCountdown: rTime ? formatCountdown(rTime) : undefined,
            description: geminiGroup.fiveHour?.description || 'Rolling 5-hour limit for Gemini models',
            disabled: false
          };
        }
      }
    }

    // Synchronize Claude & GPT 5h bucket with live 5h model consumption (if any)
    if (!isFree && claudeGptGroup) {
      const claude5hModels = parsedQuotas.filter(
        (q) => ((q.groupName || '').toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt')) &&
               q.windowType === '5h' && !q.disabled && q.percentage >= 0 &&
               isWithin5hWindow(q.resetTime)
      );
      if (claude5hModels.length > 0) {
        const minClaude5hModel = claude5hModels.reduce((prev, curr) => (curr.remainingFraction < prev.remainingFraction ? curr : prev));
        if (!claudeGptGroup.fiveHour || minClaude5hModel.remainingFraction < claudeGptGroup.fiveHour.remainingFraction || (!claudeGptGroup.fiveHour.resetTime && minClaude5hModel.resetTime)) {
          const rTime = (minClaude5hModel.resetTime && isWithin5hWindow(minClaude5hModel.resetTime))
            ? minClaude5hModel.resetTime
            : (claudeGptGroup.fiveHour?.resetTime && isWithin5hWindow(claudeGptGroup.fiveHour.resetTime) ? claudeGptGroup.fiveHour.resetTime : undefined);
          const frac = Math.min(minClaude5hModel.remainingFraction, claudeGptGroup.fiveHour?.remainingFraction ?? minClaude5hModel.remainingFraction);
          claudeGptGroup.fiveHour = {
            bucketId: claudeGptGroup.fiveHour?.bucketId || '3p-5h',
            displayName: claudeGptGroup.fiveHour?.displayName || 'Five Hour Limit Remaining',
            window: '5h',
            remainingFraction: frac,
            percentage: Math.round(frac * 100),
            resetTime: rTime,
            resetCountdown: rTime ? formatCountdown(rTime) : undefined,
            description: claudeGptGroup.fiveHour?.description || 'Rolling 5-hour limit for Claude & GPT models',
            disabled: false
          };
        }
      }
    }

    // Synchronize Gemini Weekly bucket with live weekly model consumption (e.g. Gemini 2.5 Pro)
    if (geminiGroup) {
      const geminiWeeklyModels = parsedQuotas.filter(
        (q) => ((q.groupName || '').toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('gemini') || /\bpro\b/i.test(q.id)) &&
               q.windowType === 'weekly' && !q.disabled && q.percentage >= 0
      );
      if (geminiWeeklyModels.length > 0) {
        const minGeminiWeeklyModel = geminiWeeklyModels.reduce((prev, curr) => (curr.remainingFraction < prev.remainingFraction ? curr : prev));
        if (!geminiGroup.weekly || minGeminiWeeklyModel.remainingFraction < geminiGroup.weekly.remainingFraction || (!geminiGroup.weekly.resetTime && minGeminiWeeklyModel.resetTime)) {
          const rTime = minGeminiWeeklyModel.resetTime || geminiGroup.weekly?.resetTime;
          const frac = Math.min(minGeminiWeeklyModel.remainingFraction, geminiGroup.weekly?.remainingFraction ?? minGeminiWeeklyModel.remainingFraction);
          geminiGroup.weekly = {
            bucketId: geminiGroup.weekly?.bucketId || 'gemini-weekly',
            displayName: geminiGroup.weekly?.displayName || 'Weekly Limit Remaining',
            window: 'weekly',
            remainingFraction: frac,
            percentage: Math.round(frac * 100),
            resetTime: rTime,
            resetCountdown: rTime ? formatCountdown(rTime) : undefined,
            description: geminiGroup.weekly?.description || 'Weekly plan limit for Gemini models',
            disabled: false
          };
        }
      }
    }

    // Synchronize Claude & GPT Weekly bucket with live weekly model consumption (e.g. Claude Sonnet / Opus)
    if (claudeGptGroup) {
      const claudeWeeklyModels = parsedQuotas.filter(
        (q) => ((q.groupName || '').toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt')) &&
               q.windowType === 'weekly' && !q.disabled && q.percentage >= 0
      );
      if (claudeWeeklyModels.length > 0) {
        const minClaudeWeeklyModel = claudeWeeklyModels.reduce((prev, curr) => (curr.remainingFraction < prev.remainingFraction ? curr : prev));
        if (!claudeGptGroup.weekly || minClaudeWeeklyModel.remainingFraction < claudeGptGroup.weekly.remainingFraction || (!claudeGptGroup.weekly.resetTime && minClaudeWeeklyModel.resetTime)) {
          const rTime = minClaudeWeeklyModel.resetTime || claudeGptGroup.weekly?.resetTime;
          const frac = Math.min(minClaudeWeeklyModel.remainingFraction, claudeGptGroup.weekly?.remainingFraction ?? minClaudeWeeklyModel.remainingFraction);
          claudeGptGroup.weekly = {
            bucketId: claudeGptGroup.weekly?.bucketId || '3p-weekly',
            displayName: claudeGptGroup.weekly?.displayName || 'Weekly Limit Remaining',
            window: 'weekly',
            remainingFraction: frac,
            percentage: Math.round(frac * 100),
            resetTime: rTime,
            resetCountdown: rTime ? formatCountdown(rTime) : undefined,
            description: claudeGptGroup.weekly?.description || 'Weekly plan limit for Claude & GPT models',
            disabled: false
          };
        }
      }
    }





    // Compute window properties and group metrics
    const has5Hour = !isFree && (!!geminiGroup?.fiveHour || !!claudeGptGroup?.fiveHour);
    const hasWeekly = !!geminiGroup?.weekly || !!claudeGptGroup?.weekly;

    const fiveHourResetTime = !isFree ? (geminiGroup?.fiveHour?.resetTime || claudeGptGroup?.fiveHour?.resetTime) : undefined;
    const fiveHourResetCountdown = !isFree ? (geminiGroup?.fiveHour?.resetCountdown || claudeGptGroup?.fiveHour?.resetCountdown) : undefined;

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

    // Group-level 5-hour rolling window percentages (Free tier is strictly undefined)
    const gemini5h = (!isFree && geminiGroup?.fiveHour && !geminiGroup.fiveHour.disabled && geminiGroup.fiveHour.percentage >= 0)
      ? geminiGroup.fiveHour.percentage
      : undefined;
    const claude5h = (!isFree && claudeGptGroup?.fiveHour && !claudeGptGroup.fiveHour.disabled && claudeGptGroup.fiveHour.percentage >= 0)
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

    // Model availability check:
    const hasGemini = gemini5h !== undefined || geminiWk !== undefined || (geminiGroup?.buckets && geminiGroup.buckets.length > 0) || parsedQuotas.some((q) => q.displayName.toLowerCase().includes('gemini'));
    const isGeminiDepleted = (gemini5h !== undefined && gemini5h <= 0) ||
                             (geminiWk !== undefined && geminiWk <= 0) ||
                             (gemini5h === undefined && geminiWk === undefined && geminiGroup?.buckets?.[0]?.percentage !== undefined && geminiGroup.buckets[0].percentage <= 0);
    const geminiAvailable = hasGemini && !isGeminiDepleted;

    const hasClaude = claude5h !== undefined || claudeWk !== undefined || (claudeGptGroup?.buckets && claudeGptGroup.buckets.length > 0) || parsedQuotas.some((q) => q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt'));
    const isClaudeDepleted = (claude5h !== undefined && claude5h <= 0) || (claudeWk !== undefined && claudeWk <= 0);
    const claudeAvailable = hasClaude && !isClaudeDepleted;

    let status: AccountStatus = 'healthy';
    let statusMessage: string | undefined;

    if (hasGemini && hasClaude) {
      if (!geminiAvailable && !claudeAvailable) {
        status = 'low_balance';
        statusMessage = 'All model quotas depleted';
      } else if (!geminiAvailable && claudeAvailable) {
        statusMessage = 'Gemini depleted · Claude available';
      } else if (geminiAvailable && !claudeAvailable) {
        statusMessage = 'Claude depleted · Gemini available';
      }
    } else if (hasGemini && !hasClaude) {
      if (!geminiAvailable) {
        status = 'low_balance';
        statusMessage = 'Gemini quota depleted';
      }
    } else if (!hasGemini && hasClaude) {
      if (!claudeAvailable) {
        status = 'low_balance';
        statusMessage = 'Claude quota depleted';
      }
    }

    // Total Quota of each Account is determined strictly by its Weekly Plan Quota (or 5h window / bucket / average)
    const averagePercentage = weeklyPercentage ?? fiveHourPercentage ?? (geminiGroup?.buckets?.[0]?.percentage ?? claudeGptGroup?.buckets?.[0]?.percentage) ?? calculateAveragePercentage(parsedQuotas);

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
   * Parses model quotas from the API response
   */
  public parseQuotaResponse(rawResponse: any): ModelQuota[] {
    const list: ModelQuota[] = [];
    const seenIds = new Set<string>();

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

    // 1. Check grouped quota buckets
    const groups = rawResponse?.response?.groups || rawResponse?.groups || [];
    if (groups.length > 0) {
      for (const group of groups) {
        const groupName = (group.displayName || '').toLowerCase();
        const buckets: any[] = group.buckets || [];

        const bucket5h = buckets.find((b: any) =>
          is5HourBucket(b.window, b.bucketId, b.displayName)
        );
        const bucketWeekly = buckets.find((b: any) =>
          isWeeklyBucket(b.window, b.bucketId, b.displayName)
        );

        if (groupName.includes('gemini')) {
          const has5h = !!bucket5h;
          const flashBucket = bucket5h || bucketWeekly || buckets[0] || {};
          const flashFraction = extractFraction(flashBucket);
          const flashPct = Math.round(flashFraction * 100);
          const flashResetTime = flashBucket.quotaInfo?.resetTime || flashBucket.resetTime || flashBucket.quotaResetUTCTimestamp;
          const flashCountdown = flashResetTime ? formatCountdown(flashResetTime) : undefined;

          const proBucket = bucketWeekly || bucket5h || buckets[0] || {};
          const proFraction = extractFraction(proBucket);
          const proPct = Math.round(proFraction * 100);
          const proResetTime = proBucket.quotaInfo?.resetTime || proBucket.resetTime || proBucket.quotaResetUTCTimestamp;
          const proCountdown = proResetTime ? formatCountdown(proResetTime) : undefined;

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
          const thirdPartyBucket = bucketWeekly || bucket5h || buckets[0] || {};
          const fraction = extractFraction(thirdPartyBucket);
          const percentage = Math.round(fraction * 100);
          const resetTime = thirdPartyBucket.quotaInfo?.resetTime || thirdPartyBucket.resetTime || thirdPartyBucket.quotaResetUTCTimestamp;
          const resetCountdown = resetTime ? formatCountdown(resetTime) : undefined;

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

    // 2. Check direct models map
    if (rawResponse && rawResponse.models) {
      for (const [modelId, modelData] of Object.entries<any>(rawResponse.models)) {
        const displayName = formatModelDisplayName(modelId, modelData.displayName);
        if (shouldIgnoreModel(modelId, displayName)) {
          continue;
        }

        const normId = normalizeModelKey(modelId);
        if (seenIds.has(normId)) continue;
        seenIds.add(normId);

        const fraction = extractFraction(modelData);
        const percentage = Math.round(fraction * 100);
        const resetTime = modelData.quotaInfo?.resetTime || modelData.resetTime;
        const resetCountdown = resetTime ? formatCountdown(resetTime) : undefined;
        const { windowType, windowLabel } = classifyQuotaWindow(modelId, displayName, resetTime, modelData.description);

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

    return sortModelQuotas(list);
  }

  /**
   * Generates placeholder quota entries for standard free accounts.
   */
  public generateFreeTierPlaceholders(): ModelQuota[] {
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
      remainingFraction: -1,
      percentage: -1,
      windowType: m.windowType,
      windowLabel: 'Free Tier Usage',
      disabled: false,
      refreshText: description
    }));
  }
}
