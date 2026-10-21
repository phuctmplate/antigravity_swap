import {
  AccountInfo,
  AccountStatus,
  AccountTierType,
  ModelQuota,
  QuotaBucket,
  QuotaGroup
} from '../types';
import { MODEL_WEIGHTS, SAFE_WEEKLY_THRESHOLDS } from '../constants';
import {
  is5HourBucket,
  isWeeklyBucket,
  classifyQuotaWindow,
  determineAccountTier,
  isResetTimeWithin5Hours,
  isResetTimeBeyond5Hours
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
import { calculateAveragePercentage, calculateModulatedInstantQuota } from './quotaCalculator';

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

        // PHYSICAL SAFEGUARD: A 5h rolling window by definition CANNOT have a reset time > 5.5 hours away!
        if (windowType === '5h' && resetTime && isResetTimeBeyond5Hours(resetTime)) {
          resetTime = undefined;
        }

        let validDescCountdown = descCountdown && (windowType !== 'weekly' || /\b\d+\s*d\b/i.test(descCountdown)) && (windowType !== '5h' || !/\b\d+\s*d\b/i.test(descCountdown)) ? descCountdown : undefined;
        let resetCountdown = validDescCountdown || (resetTime ? formatCountdown(resetTime) : undefined);
        if (windowType === '5h' && resetCountdown && /\b\d+\s*d\b/i.test(resetCountdown)) {
          resetCountdown = undefined;
        }

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
          // IMPORTANT: Google returns the SAME resetTime for all models in a quota group (shared 5h rolling timestamp).
          // For weekly-classified models we MUST use targetBucket.resetTime (the authentic weekly reset time).
          // For 5h models, use raw model resetTime if it passes the 5h boundary check, otherwise fall back to bucket.
          const rawModelResetTime = modelData.quotaInfo.resetTime;
          if (windowType === 'weekly' && targetBucket?.resetTime) {
            resetTime = targetBucket.resetTime;
          } else if (windowType === '5h' && rawModelResetTime && isResetTimeWithin5Hours(rawModelResetTime)) {
            resetTime = rawModelResetTime;
          } else {
            resetTime = rawModelResetTime || targetBucket?.resetTime;
          }
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
          disabled: targetBucket?.disabled ?? false,
          _rawResetTime: hasModelQuota ? modelData.quotaInfo.resetTime : modelData.resetTime
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
          resetTime: isResetTimeWithin5Hours(g5h?.resetTime) ? g5h?.resetTime : undefined,
          resetCountdown: isResetTimeWithin5Hours(g5h?.resetTime) ? g5h?.resetCountdown : undefined,
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
          resetTime: isResetTimeWithin5Hours(c5h?.resetTime) ? c5h?.resetTime : (cWk ? cWk.resetTime : undefined),
          resetCountdown: isResetTimeWithin5Hours(c5h?.resetTime) ? c5h?.resetCountdown : (cWk ? cWk.resetCountdown : undefined),
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

    // Synchronize Gemini 5h bucket with live 5h model consumption
    if (!isFree) {
      const gemini5hModels = parsedQuotas.filter(
        (q) => ((q.groupName || '').toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('flash')) &&
               q.windowType === '5h' && !q.disabled && q.percentage >= 0 &&
               !/\bpro\b|[-_.]pro\b/i.test(q.id + ' ' + q.displayName)
      );
      if (gemini5hModels.length > 0) {
        if (!geminiGroup) {
          geminiGroup = {
            id: 'gemini',
            name: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: []
          };
          quotaGroups.unshift(geminiGroup);
        }
        const minGemini5hModel = gemini5hModels.reduce((prev, curr) => (curr.remainingFraction < prev.remainingFraction ? curr : prev));
        const modelReset = isResetTimeWithin5Hours(minGemini5hModel.resetTime) ? minGemini5hModel.resetTime : undefined;
        const bucketReset = isResetTimeWithin5Hours(geminiGroup.fiveHour?.resetTime) ? geminiGroup.fiveHour?.resetTime : undefined;
        const rTime = modelReset || bucketReset;

        if (!geminiGroup.fiveHour || minGemini5hModel.remainingFraction < geminiGroup.fiveHour.remainingFraction || (!geminiGroup.fiveHour.resetTime && rTime)) {
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
               q.windowType === '5h' && !q.disabled && q.percentage >= 0
      );
      if (claude5hModels.length > 0) {
        const minClaude5hModel = claude5hModels.reduce((prev, curr) => (curr.remainingFraction < prev.remainingFraction ? curr : prev));
        const modelReset = isResetTimeWithin5Hours(minClaude5hModel.resetTime) ? minClaude5hModel.resetTime : undefined;
        const bucketReset = isResetTimeWithin5Hours(claudeGptGroup.fiveHour?.resetTime) ? claudeGptGroup.fiveHour?.resetTime : undefined;
        const rTime = modelReset || bucketReset;

        if (!claudeGptGroup.fiveHour || minClaude5hModel.remainingFraction < claudeGptGroup.fiveHour.remainingFraction || (!claudeGptGroup.fiveHour.resetTime && rTime)) {
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

    // Synchronize Gemini Weekly bucket with live weekly model consumption (e.g. Gemini 2.5 Pro).
    // CRITICAL: Google often returns the SAME fraction + 5h-style resetTime for ALL Gemini models.
    // We use _rawResetTime (the original quotaInfo.resetTime from Google) to determine if a model's
    // quota data truly represents a weekly consumption signal (resetTime > 5.5h away).
    // Only genuine weekly models (with beyond-5h raw resetTimes) can update the weekly bucket.
    const geminiWeeklyModels = parsedQuotas.filter(
      (q) => ((q.groupName || '').toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('gemini') || /\bpro\b/i.test(q.id)) &&
             q.windowType === 'weekly' && !q.disabled && q.percentage >= 0
    );
    if (geminiWeeklyModels.length > 0 || (geminiGroup && !geminiGroup.weekly && !isFree)) {
      if (!geminiGroup) {
        geminiGroup = {
          id: 'gemini',
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: []
        };
        quotaGroups.unshift(geminiGroup);
      }
      if (geminiWeeklyModels.length > 0) {
        // Filter using _rawResetTime to avoid using 5h-pool data that was re-tagged with weekly resetTime.
        const genuineWeeklyModels = geminiWeeklyModels.filter(
          (q: any) => q._rawResetTime && isResetTimeBeyond5Hours(q._rawResetTime)
        );
        if (genuineWeeklyModels.length > 0) {
          const minGeminiWeeklyModel = genuineWeeklyModels.reduce((prev: any, curr: any) => (curr.remainingFraction < prev.remainingFraction ? curr : prev));
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
        // If no genuine weekly signal (all Pro models have 5h-style raw resetTimes), UQS bucket is authoritative.
        // Ensure weekly bucket exists for paid accounts even if UQS didn't report one.
        if (!geminiGroup.weekly && !isFree) {
          geminiGroup.weekly = {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            remainingFraction: 1.0,
            percentage: 100,
            description: 'Weekly plan limit for Gemini models',
            disabled: false
          };
        }
      } else if (!geminiGroup.weekly && !isFree) {
        geminiGroup.weekly = {
          bucketId: 'gemini-weekly',
          displayName: 'Weekly Limit Remaining',
          window: 'weekly',
          remainingFraction: 1.0,
          percentage: 100,
          description: 'Weekly plan limit for Gemini models',
          disabled: false
        };
      }
    }
    if (geminiGroup) {
      const bList: QuotaBucket[] = [];
      if (geminiGroup.fiveHour) bList.push(geminiGroup.fiveHour);
      if (geminiGroup.weekly) bList.push(geminiGroup.weekly);
      geminiGroup.buckets = bList;
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

    // Group-level weekly percentages
    const geminiWk = (geminiGroup?.weekly && !geminiGroup.weekly.disabled && geminiGroup.weekly.percentage >= 0)
      ? geminiGroup.weekly.percentage
      : undefined;
    const claudeWk = (claudeGptGroup?.weekly && !claudeGptGroup.weekly.disabled && claudeGptGroup.weekly.percentage >= 0)
      ? claudeGptGroup.weekly.percentage
      : undefined;

    // Group-level 5-hour rolling window percentages (Free tier is strictly undefined)
    const gemini5h = (!isFree && geminiGroup?.fiveHour && !geminiGroup.fiveHour.disabled && geminiGroup.fiveHour.percentage >= 0)
      ? geminiGroup.fiveHour.percentage
      : undefined;
    const claude5h = (!isFree && claudeGptGroup?.fiveHour && !claudeGptGroup.fiveHour.disabled && claudeGptGroup.fiveHour.percentage >= 0)
      ? claudeGptGroup.fiveHour.percentage
      : undefined;

    // Pick authentic 5h reset time prioritizing the more depleted group
    // Physical law: A 5h reset time MUST be within 5.5 hours in the future
    let fiveHourResetTime: string | undefined;
    if (!isFree) {
      const g5h = geminiGroup?.fiveHour;
      const c5h = claudeGptGroup?.fiveHour;
      const g5hReset = isResetTimeWithin5Hours(g5h?.resetTime) ? g5h?.resetTime : undefined;
      const c5hReset = isResetTimeWithin5Hours(c5h?.resetTime) ? c5h?.resetTime : undefined;

      if (g5hReset && c5hReset) {
        const g5hFrac = g5h?.remainingFraction;
        const c5hFrac = c5h?.remainingFraction;
        if (typeof g5hFrac === 'number' && typeof c5hFrac === 'number' && g5hFrac < c5hFrac) {
          fiveHourResetTime = g5hReset;
        } else if (typeof g5hFrac === 'number' && typeof c5hFrac === 'number' && c5hFrac < g5hFrac) {
          fiveHourResetTime = c5hReset;
        } else {
          const gTime = new Date(g5hReset).getTime();
          const cTime = new Date(c5hReset).getTime();
          fiveHourResetTime = gTime <= cTime ? g5hReset : c5hReset;
        }
      } else {
        fiveHourResetTime = g5hReset || c5hReset;
      }
    }
    const fiveHourResetCountdown = fiveHourResetTime ? formatCountdown(fiveHourResetTime) : undefined;

    // Pick authentic weekly reset time prioritizing the more depleted group
    let weeklyResetTime: string | undefined;
    const gWkFrac = geminiGroup?.weekly?.remainingFraction;
    const cWkFrac = claudeGptGroup?.weekly?.remainingFraction;
    if (geminiGroup?.weekly?.resetTime && claudeGptGroup?.weekly?.resetTime) {
      if (typeof gWkFrac === 'number' && typeof cWkFrac === 'number' && gWkFrac < cWkFrac) {
        weeklyResetTime = geminiGroup.weekly.resetTime;
      } else if (typeof gWkFrac === 'number' && typeof cWkFrac === 'number' && cWkFrac < gWkFrac) {
        weeklyResetTime = claudeGptGroup.weekly.resetTime;
      } else {
        const gTime = new Date(geminiGroup.weekly.resetTime).getTime();
        const cTime = new Date(claudeGptGroup.weekly.resetTime).getTime();
        weeklyResetTime = gTime <= cTime ? geminiGroup.weekly.resetTime : claudeGptGroup.weekly.resetTime;
      }
    } else {
      weeklyResetTime = geminiGroup?.weekly?.resetTime || claudeGptGroup?.weekly?.resetTime;
    }
    const weeklyResetCountdown = weeklyResetTime ? formatCountdown(weeklyResetTime) : undefined;

    // Combined Weekly percentage (Capacity metric) with weighted model ratio (Gemini 85%, Claude 15%)
    let weeklyPercentage: number | undefined;
    if (geminiWk !== undefined && claudeWk !== undefined) {
      weeklyPercentage = Math.round((geminiWk * MODEL_WEIGHTS.GEMINI + claudeWk * MODEL_WEIGHTS.CLAUDE) / (MODEL_WEIGHTS.GEMINI + MODEL_WEIGHTS.CLAUDE));
    } else if (geminiWk !== undefined) {
      weeklyPercentage = geminiWk;
    } else if (claudeWk !== undefined) {
      weeklyPercentage = claudeWk;
    }

    // Combined 5-hour percentage with weighted model ratio (Gemini 85%, Claude 15%)
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

    // 1. Check direct authentic models map FIRST (from GetAvailableModels or retrieveUserQuota)
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

    // 2. Check grouped quota buckets for any models not already present
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
            const norm = normalizeModelKey(m.id);
            if (seenIds.has(norm)) continue;
            seenIds.add(norm);
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
            const norm = normalizeModelKey(m.id);
            if (seenIds.has(norm)) continue;
            seenIds.add(norm);
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
            const norm = normalizeModelKey(m.id);
            if (seenIds.has(norm)) continue;
            seenIds.add(norm);
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
