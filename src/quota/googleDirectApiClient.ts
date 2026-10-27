import * as https from 'https';
import { API_ENDPOINTS, EXTENSION_DEFAULTS, OAUTH_CONFIG } from '../constants';
import { is5HourBucket, isWeeklyBucket, isResetTimeWithin5Hours, isResetTimeBeyond5Hours } from './quotaClassifier';
import { getIdeRuntimeMetadata } from './ideRuntimeMetadata';

function refreshGoogleAccessToken(refreshToken: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const postData = new URLSearchParams({
      client_id: OAUTH_CONFIG.CLIENT_ID,
      client_secret: OAUTH_CONFIG.CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString();

    const req = https.request(
      {
        hostname: API_ENDPOINTS.OAUTH_TOKEN_HOST,
        port: 443,
        path: '/token',
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 6000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.access_token);
          } catch {
            resolve(undefined);
          }
        });
      }
    );
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
    req.write(postData);
    req.end();
  });
}

export interface JitProbeResult {
  ok: boolean;
  isDepleted: boolean;
  fiveHourPercentage?: number;
  weeklyPercentage?: number;
  resetTime?: string;
  error?: string;
  rawData?: any;
}

/**
 * Enriches quota groups with real-time model quota metrics and reset times.
 * Differentiates cleanly between Free Tier (weekly only) and Paid Pro/Ultra (5h rolling + weekly + Claude/GPT).
 */
export function enrichQuotaGroupsWithModels(
  groups: any[],
  modelsData: Record<string, any>,
  isFreeAccount: boolean = false
): any[] {
  const resultGroups = (groups || []).map((g: any) => ({
    ...g,
    buckets: (g.buckets || []).map((b: any) => ({ ...b }))
  }));

  // If the account is Free Tier, it NEVER has 5-hour rolling windows or Claude/GPT models.
  if (isFreeAccount) {
    let minWeeklyFraction = 1.0;
    let geminiWeeklyResetTime: string | undefined;

    for (const [id, m] of Object.entries(modelsData)) {
      const frac = m.quotaInfo?.remainingFraction;
      const rTime = m.quotaInfo?.resetTime;
      if (typeof frac === 'number' && frac < minWeeklyFraction) {
        minWeeklyFraction = frac;
      }
      if (rTime) {
        if (!geminiWeeklyResetTime || new Date(rTime).getTime() > new Date(geminiWeeklyResetTime).getTime()) {
          geminiWeeklyResetTime = rTime;
        }
      }
    }

    let geminiGroup = resultGroups.find(
      (g: any) => (g.displayName || '').toLowerCase().includes('gemini')
    );

    if (!geminiGroup) {
      geminiGroup = {
        displayName: 'Gemini Models',
        description: 'Antigravity Starter Quota',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            remainingFraction: minWeeklyFraction,
            resetTime: geminiWeeklyResetTime
          }
        ]
      };
      resultGroups.unshift(geminiGroup);
    } else {
      // Ensure only weekly bucket exists for Free Tier
      const existingWeekly = geminiGroup.buckets.find((b: any) => isWeeklyBucket(b.window, b.bucketId, b.displayName)) || geminiGroup.buckets[0];
      geminiGroup.buckets = [
        {
          bucketId: 'gemini-weekly',
          displayName: 'Weekly Limit Remaining',
          window: 'weekly',
          remainingFraction: typeof existingWeekly?.remainingFraction === 'number'
            ? existingWeekly.remainingFraction
            : minWeeklyFraction,
          resetTime: existingWeekly?.resetTime || geminiWeeklyResetTime
        }
      ];
    }

    // Filter out any 3P Claude/GPT groups for free accounts
    return resultGroups.filter((g: any) => {
      const title = (g.displayName || '').toLowerCase();
      return !title.includes('claude') && !title.includes('gpt');
    });
  }

  // === PAID ACCOUNTS (PRO / ULTRA) ===
  const is3pModel = (id: string) => {
    const lower = id.toLowerCase();
    return lower.includes('claude') || lower.includes('gpt') || lower.includes('opus') || lower.includes('sonnet');
  };

  // 1. Enrich Gemini models (strictly exclude Claude, GPT, Opus, Sonnet 3P models)
  const flashModelEntries = Object.entries(modelsData).filter(
    ([id]) =>
      !is3pModel(id) &&
      (id.includes('flash') ||
       id.includes('gemini') ||
       id.includes('exp'))
  );

  let geminiGroup = resultGroups.find(
    (g: any) =>
      (g.displayName || '').toLowerCase().includes('gemini') &&
      !is3pModel(g.displayName || '')
  );

  if (flashModelEntries.length > 0) {
    let min5hFraction = 1.0;
    let has5hActiveLimit = false;
    let gemini5hResetTime: string | undefined;

    let minWeeklyFraction = 1.0;
    let hasWeeklyActiveLimit = false;
    let geminiWeeklyResetTime: string | undefined;

    for (const [id, m] of flashModelEntries) {
      const frac = m.quotaInfo?.remainingFraction;
      const rTime = m.quotaInfo?.resetTime;
      if (typeof frac === 'number') {
        const idLower = id.toLowerCase();
        const isProOrUltra = /\bpro\b|[-_.]pro\b|\bpro[-_.]/i.test(idLower) || /\bultra\b|[-_.]ultra\b/i.test(idLower);

        if (rTime && isResetTimeWithin5Hours(rTime)) {
          if (!isProOrUltra) {
            has5hActiveLimit = true;
            if (frac < min5hFraction) min5hFraction = frac;
            if (!gemini5hResetTime || new Date(rTime).getTime() < new Date(gemini5hResetTime).getTime()) {
              gemini5hResetTime = rTime;
            }
          }
        } else if (rTime && isResetTimeBeyond5Hours(rTime)) {
          hasWeeklyActiveLimit = true;
          if (frac < minWeeklyFraction) minWeeklyFraction = frac;
          if (!geminiWeeklyResetTime || new Date(rTime).getTime() < new Date(geminiWeeklyResetTime).getTime()) {
            geminiWeeklyResetTime = rTime;
          }
        }
      }
    }

    const effective5hFraction = has5hActiveLimit ? min5hFraction : 1.0;
    const effectiveWeeklyFraction = hasWeeklyActiveLimit ? minWeeklyFraction : 1.0;

    if (!geminiGroup) {
      const synthBuckets: any[] = [];
      if (has5hActiveLimit) {
        synthBuckets.push({
          bucketId: 'gemini-5h',
          displayName: 'Five Hour Limit Remaining',
          window: '5h',
          remainingFraction: effective5hFraction,
          resetTime: gemini5hResetTime
        });
      }
      if (hasWeeklyActiveLimit) {
        synthBuckets.push({
          bucketId: 'gemini-weekly',
          displayName: 'Weekly Limit Remaining',
          window: 'weekly',
          remainingFraction: effectiveWeeklyFraction,
          resetTime: geminiWeeklyResetTime
        });
      }
      geminiGroup = {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini Flash, Gemini Pro',
        buckets: synthBuckets
      };
      resultGroups.unshift(geminiGroup);
    } else {
      geminiGroup.buckets = geminiGroup.buckets || [];
      const existing5h = geminiGroup.buckets.find((b: any) => is5HourBucket(b.window, b.bucketId, b.displayName));
      if (existing5h) {
        // Authoritative group bucket from Google retrieveUserQuotaSummary takes precedence.
        // Only backfill if remainingFraction is undefined.
        if (typeof existing5h.remainingFraction !== 'number' && has5hActiveLimit) {
          existing5h.remainingFraction = min5hFraction;
        }
        if (!existing5h.resetTime && gemini5hResetTime) {
          existing5h.resetTime = gemini5hResetTime;
        } else if (existing5h.resetTime && isResetTimeBeyond5Hours(existing5h.resetTime)) {
          delete existing5h.resetTime;
        }
      } else if (has5hActiveLimit) {
        geminiGroup.buckets.push({
          bucketId: 'gemini-5h',
          displayName: 'Five Hour Limit Remaining',
          window: '5h',
          remainingFraction: effective5hFraction,
          resetTime: gemini5hResetTime
        });
      }

      const existingWeekly = geminiGroup.buckets.find((b: any) => isWeeklyBucket(b.window, b.bucketId, b.displayName));
      if (existingWeekly) {
        // Authoritative group bucket from Google retrieveUserQuotaSummary takes precedence.
        if (typeof existingWeekly.remainingFraction !== 'number' && hasWeeklyActiveLimit) {
          existingWeekly.remainingFraction = minWeeklyFraction;
        }
        if (!existingWeekly.resetTime && geminiWeeklyResetTime) {
          existingWeekly.resetTime = geminiWeeklyResetTime;
        }
      } else if (hasWeeklyActiveLimit) {
        geminiGroup.buckets.push({
          bucketId: 'gemini-weekly',
          displayName: 'Weekly Limit Remaining',
          window: 'weekly',
          remainingFraction: effectiveWeeklyFraction,
          resetTime: geminiWeeklyResetTime
        });
      }
    }
  }

  // 2. Enrich Claude and GPT 3P models
  const claudeGroup = resultGroups.find(
    (g: any) =>
      (g.displayName || '').toLowerCase().includes('claude') ||
      (g.displayName || '').toLowerCase().includes('gpt')
  );
  const claudeModelEntries = Object.entries(modelsData).filter(
    ([id]) => is3pModel(id)
  );

  if (claudeGroup && claudeModelEntries.length > 0) {
    let min3p5hFraction = 1.0;
    let has5hModelConsumption = false;
    let min3p5hResetTime: string | undefined;

    let min3pWeeklyFraction = 1.0;
    let hasWeeklyModelConsumption = false;
    let min3pWeeklyResetTime: string | undefined;

    for (const [, m] of claudeModelEntries) {
      const frac = m.quotaInfo?.remainingFraction;
      const rTime = m.quotaInfo?.resetTime;

      if (typeof frac === 'number') {
        if (rTime && isResetTimeWithin5Hours(rTime)) {
          has5hModelConsumption = true;
          if (frac < min3p5hFraction) min3p5hFraction = frac;
          if (!min3p5hResetTime || new Date(rTime).getTime() < new Date(min3p5hResetTime).getTime()) {
            min3p5hResetTime = rTime;
          }
        } else if (rTime && isResetTimeBeyond5Hours(rTime)) {
          hasWeeklyModelConsumption = true;
          if (frac < min3pWeeklyFraction) min3pWeeklyFraction = frac;
          if (!min3pWeeklyResetTime || new Date(rTime).getTime() < new Date(min3pWeeklyResetTime).getTime()) {
            min3pWeeklyResetTime = rTime;
          }
        } else {
          // If resetTime is unspecified or ambiguous, Claude & GPT default to weekly plan quota
          hasWeeklyModelConsumption = true;
          if (frac < min3pWeeklyFraction) min3pWeeklyFraction = frac;
        }
      }
    }

    claudeGroup.buckets = claudeGroup.buckets || [];
    const existing3pWk = claudeGroup.buckets.find((b: any) => isWeeklyBucket(b.window, b.bucketId, b.displayName));
    if (existing3pWk) {
      // Authoritative group bucket from Google retrieveUserQuotaSummary takes precedence.
      if (typeof existing3pWk.remainingFraction !== 'number' && hasWeeklyModelConsumption) {
        existing3pWk.remainingFraction = min3pWeeklyFraction;
      }
      if (!existing3pWk.resetTime && min3pWeeklyResetTime) {
        existing3pWk.resetTime = min3pWeeklyResetTime;
      }
    }

    const existing3p5h = claudeGroup.buckets.find((b: any) => is5HourBucket(b.window, b.bucketId, b.displayName));
    if (existing3p5h) {
      // Authoritative group bucket from Google retrieveUserQuotaSummary takes precedence.
      if (typeof existing3p5h.remainingFraction !== 'number' && has5hModelConsumption) {
        existing3p5h.remainingFraction = min3p5hFraction;
      }
      if (!existing3p5h.resetTime && min3p5hResetTime) {
        existing3p5h.resetTime = min3p5hResetTime;
      } else if (existing3p5h.resetTime && isResetTimeBeyond5Hours(existing3p5h.resetTime)) {
        delete existing3p5h.resetTime;
      }
    }
  }

  return resultGroups;
}

/**
 * GoogleDirectApiClient
 * Authoritative, high-speed client directly querying Google's official Cloud Code PA APIs over HTTPS.
 * Completely eliminates local Language Server child processes and Connect-RPC IPC bridges,
 * providing accurate tier detection, real-time quota fractions, and reset times.
 */
export class GoogleDirectApiClient {
  private readonly agent: https.Agent;
  private lastRateLimitTimestamp = 0;
  private memoryCache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly cacheTtlMs = 45000;

  constructor() {
    this.agent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 15000,
      maxSockets: 4,
      timeout: 8000,
      family: 4
    });
  }

  /**
   * Invalidates cached quota for a specific email or all accounts.
   */
  public invalidateCache(email?: string): void {
    if (email) {
      this.memoryCache.delete(email.trim().toLowerCase());
    } else {
      this.memoryCache.clear();
    }
  }

  /**
   * Helper to execute an HTTPS POST with authentic Antigravity IDE headers
   * and shared connection pooling directly to Google Cloud Code PA endpoints.
   */
  public async postJson(
    host: string,
    apiPath: string,
    token: string,
    body: any = {},
    timeoutMs = 6000
  ): Promise<any> {
    const now = Date.now();
    if (this.lastRateLimitTimestamp && now - this.lastRateLimitTimestamp < EXTENSION_DEFAULTS.RATE_LIMIT_BACKOFF_BASE_MS) {
      const waitRemaining = Math.round((EXTENSION_DEFAULTS.RATE_LIMIT_BACKOFF_BASE_MS - (now - this.lastRateLimitTimestamp)) / 1000);
      throw new Error(`[GoogleDirectApiClient] Google rate limit cooldown active (${waitRemaining}s remaining).`);
    }

    const payload = JSON.stringify(body);
    const meta = getIdeRuntimeMetadata();

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: host,
          port: 443,
          path: apiPath,
          method: 'POST',
          family: 4,
          agent: this.agent,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': meta.userAgent,
            'X-Goog-Api-Client': meta.googApiClient,
            'Content-Length': Buffer.byteLength(payload)
          },
          timeout: timeoutMs
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode === 429) {
              this.lastRateLimitTimestamp = Date.now();
              return reject(new Error(`[GoogleDirectApiClient] Google Rate Limit (429) on ${host}${apiPath}`));
            }

            if (res.statusCode === 401 || res.statusCode === 403) {
              return reject(new Error(`[GoogleDirectApiClient] Authentication failed (${res.statusCode}) on ${host}${apiPath}`));
            }

            if (res.statusCode && res.statusCode >= 400) {
              return reject(new Error(`[GoogleDirectApiClient] HTTP ${res.statusCode} on ${host}${apiPath}: ${data.slice(0, 200)}`));
            }

            try {
              resolve(JSON.parse(data));
            } catch {
              resolve({ raw: data });
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`[GoogleDirectApiClient] Timeout (${timeoutMs}ms) requesting ${host}${apiPath}`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Fetches full quota and tier metrics for an account directly from Google's official endpoints.
   */
  public async fetchStandbyQuota(
    accessToken: string,
    email?: string,
    timeoutMs: number = 6000,
    refreshToken?: string
  ): Promise<any> {
    let effEmail = email;
    let effTimeoutMs = typeof timeoutMs === 'number' ? timeoutMs : 6000;
    let effRefreshToken = refreshToken;

    if (email && email.startsWith('1//') && !effRefreshToken) {
      effRefreshToken = email;
      effEmail = undefined;
    }

    const cacheKey = effEmail ? effEmail.trim().toLowerCase() : accessToken.slice(0, 20);

    // 1. Check in-memory cache
    const cached = this.memoryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }

    let activeToken = accessToken;
    if (effRefreshToken) {
      try {
        const fresh = await refreshGoogleAccessToken(effRefreshToken);
        if (fresh) {
          activeToken = fresh;
        }
      } catch {}
    }

    const result = await this.fetchViaDirectApi(activeToken, effEmail, effTimeoutMs, effRefreshToken);
    this.memoryCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  }

  /**
   * Primary pipeline: fetches authentic quota and tier via HTTPS endpoints directly from Google Cloud Code PA.
   */
  public async fetchViaDirectApi(
    accessToken: string,
    email?: string,
    timeoutMs: number = 6000,
    refreshToken?: string
  ): Promise<any> {
    let activeToken = accessToken;
    let projectId: string | undefined;
    let tierData: any = {};
    const meta = getIdeRuntimeMetadata();

    const HOST_PROD = 'cloudcode-pa.googleapis.com';
    const HOST_DAILY = 'daily-cloudcode-pa.googleapis.com';

    // 1. Query loadCodeAssist to determine user subscription tier and companion project
    try {
      const lcaProd = await this.postJson(
        HOST_PROD,
        '/v1internal:loadCodeAssist',
        activeToken,
        {
          metadata: {
            ide_type: 'ANTIGRAVITY',
            ide_version: meta.ideVersion,
            ide_name: meta.ideName
          }
        },
        timeoutMs
      );
      if (lcaProd) {
        projectId = lcaProd.cloudaicompanionProject;
        tierData = { ...lcaProd };
      }
    } catch (lcaErr: any) {
      if (lcaErr.message && (lcaErr.message.includes('Authentication failed') || lcaErr.message.includes('401'))) {
        if (refreshToken) {
          const fresh = await refreshGoogleAccessToken(refreshToken);
          if (fresh) {
            activeToken = fresh;
            try {
              const lcaRetry = await this.postJson(
                HOST_PROD,
                '/v1internal:loadCodeAssist',
                activeToken,
                {
                  metadata: {
                    ide_type: 'ANTIGRAVITY',
                    ide_version: meta.ideVersion,
                    ide_name: meta.ideName
                  }
                },
                timeoutMs
              );
              if (lcaRetry) {
                projectId = lcaRetry.cloudaicompanionProject;
                tierData = { ...lcaRetry };
              }
            } catch {}
          }
        }
      }
      if (!projectId && Object.keys(tierData).length === 0) {
        try {
          const lcaDaily = await this.postJson(
            HOST_DAILY,
            '/v1internal:loadCodeAssist',
            activeToken,
            {
              metadata: { ideType: 'ANTIGRAVITY' }
            },
            timeoutMs
          );
          if (lcaDaily) {
            projectId = lcaDaily.cloudaicompanionProject;
            tierData = { ...lcaDaily };
          }
        } catch {}
      }
    }

    const isFreeAccount = (
      tierData?.paidTier?.id === 'free-tier' ||
      (typeof tierData?.paidTier?.name === 'string' && tierData.paidTier.name.toLowerCase().includes('starter')) ||
      (typeof tierData?.paidTier?.id === 'string' && tierData.paidTier.id.toLowerCase().includes('free'))
    );

    const isPooled = !projectId || projectId === 'aicode-consumers';
    const body = isPooled ? {} : { project: projectId };

    const modelsData: Record<string, any> = {};

    // 2. retrieveUserQuota: Source for real-time model consumption and reset times
    try {
      const rawQuotaProd = await this.postJson(
        HOST_PROD,
        '/v1internal:retrieveUserQuota',
        activeToken,
        body,
        timeoutMs
      );
      if (rawQuotaProd && rawQuotaProd.buckets) {
        for (const b of rawQuotaProd.buckets) {
          if (b.modelId) {
            modelsData[b.modelId] = {
              displayName: b.modelId,
              quotaInfo: {
                remainingFraction: b.remainingFraction,
                resetTime: b.resetTime
              }
            };
          }
        }
      }
    } catch {
      try {
        const rawQuotaDaily = await this.postJson(
          HOST_DAILY,
          '/v1internal:retrieveUserQuota',
          activeToken,
          body,
          timeoutMs
        );
        if (rawQuotaDaily && rawQuotaDaily.buckets) {
          for (const b of rawQuotaDaily.buckets) {
            if (b.modelId) {
              modelsData[b.modelId] = {
                displayName: b.modelId,
                quotaInfo: {
                  remainingFraction: b.remainingFraction,
                  resetTime: b.resetTime
                }
              };
            }
          }
        }
      } catch {}
    }

    // 3. retrieveUserQuotaSummary: Authoritative group buckets for paid Pro/Ultra accounts
    let groupsData: any = null;
    if (!isFreeAccount) {
      try {
        groupsData = await this.postJson(
          HOST_PROD,
          '/v1internal:retrieveUserQuotaSummary',
          activeToken,
          body,
          timeoutMs
        );
      } catch {
        if (projectId) {
          try {
            groupsData = await this.postJson(
              HOST_PROD,
              '/v1internal:retrieveUserQuotaSummary',
              activeToken,
              {},
              timeoutMs
            );
          } catch {}
        }
        if (!groupsData) {
          try {
            groupsData = await this.postJson(
              HOST_DAILY,
              '/v1internal:retrieveUserQuotaSummary',
              activeToken,
              body,
              timeoutMs
            );
          } catch {}
        }
      }
    }

    // 4. fetchAvailableModels: Model labels, display names, and fallback model quotas
    try {
      const famProd = await this.postJson(
        HOST_PROD,
        '/v1internal:fetchAvailableModels',
        activeToken,
        body,
        timeoutMs
      );
      if (famProd && famProd.models) {
        for (const [id, m] of Object.entries<any>(famProd.models)) {
          if (modelsData[id]) {
            modelsData[id].displayName = m.displayName || m.label || id;
          } else {
            modelsData[id] = m;
          }
        }
      }
    } catch {
      try {
        const famDaily = await this.postJson(
          HOST_DAILY,
          '/v1internal:fetchAvailableModels',
          activeToken,
          body,
          timeoutMs
        );
        if (famDaily && famDaily.models) {
          for (const [id, m] of Object.entries<any>(famDaily.models)) {
            if (modelsData[id]) {
              modelsData[id].displayName = m.displayName || m.label || id;
            } else {
              modelsData[id] = m;
            }
          }
        }
      } catch {}
    }

    const groups: any[] = groupsData?.response?.groups || groupsData?.groups || [];
    const enrichedGroups = enrichQuotaGroupsWithModels(groups, modelsData, isFreeAccount);

    return {
      ...tierData,
      models: modelsData,
      groups: enrichedGroups,
      response: { groups: enrichedGroups }
    };
  }

  /**
   * JIT Pre-Switch Probe:
   * Fast, targeted single-shot probe over HTTPS (default 1000ms)
   * to ensure an auto-switch candidate has not been depleted on another machine.
   */
  public async probeJitCandidate(
    accessToken: string,
    email?: string,
    timeoutMs: number = EXTENSION_DEFAULTS.JIT_TIMEOUT_MS,
    refreshToken?: string
  ): Promise<JitProbeResult> {
    try {
      const quotaData = await this.fetchStandbyQuota(accessToken, email, timeoutMs, refreshToken);
      const groups = quotaData?.response?.groups || quotaData?.groups || [];

      let fiveHourRemaining: number | undefined;
      let weeklyRemaining: number | undefined;
      let soonestReset: string | undefined;

      for (const g of groups) {
        for (const b of g.buckets || []) {
          if (is5HourBucket(b.window, b.bucketId, b.displayName)) {
            if (typeof b.remainingFraction === 'number') {
              fiveHourRemaining =
                fiveHourRemaining !== undefined
                  ? Math.min(fiveHourRemaining, b.remainingFraction)
                  : b.remainingFraction;
              if (b.resetTime) soonestReset = b.resetTime;
            }
          }
          if (isWeeklyBucket(b.window, b.bucketId, b.displayName)) {
            if (typeof b.remainingFraction === 'number') {
              weeklyRemaining =
                weeklyRemaining !== undefined
                  ? Math.min(weeklyRemaining, b.remainingFraction)
                  : b.remainingFraction;
            }
          }
        }
      }

      const fiveHourPct = fiveHourRemaining !== undefined ? Math.round(fiveHourRemaining * 100) : undefined;
      const weeklyPct = weeklyRemaining !== undefined ? Math.round(weeklyRemaining * 100) : undefined;

      const isDepleted = (fiveHourPct !== undefined && fiveHourPct <= 5) || (weeklyPct !== undefined && weeklyPct === 0);

      return {
        ok: true,
        isDepleted,
        fiveHourPercentage: fiveHourPct,
        weeklyPercentage: weeklyPct,
        resetTime: soonestReset,
        rawData: quotaData
      };
    } catch (err: any) {
      return {
        ok: false,
        isDepleted: true,
        error: err.message
      };
    }
  }

  public dispose(): void {
    this.memoryCache.clear();
    this.agent.destroy();
  }
}

// Backwards-compatible alias for existing consumers and tests
export const MicroLanguageServerClient = GoogleDirectApiClient;
export type MicroLanguageServerClient = GoogleDirectApiClient;
