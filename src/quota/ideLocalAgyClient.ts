import * as http from 'http';
import { execSync } from 'child_process';
import { QuotaGroup, QuotaBucket, ModelQuota } from '../types';
import { calculateModulatedInstantQuota } from './quotaCalculator';
import { formatCountdown, parseCountdownFromDescription } from './quotaFormatters';
import { SAFE_WEEKLY_THRESHOLDS, MODEL_WEIGHTS } from '../constants';

export interface LocalAgyHubInfo {
  port: number;
  csrfToken: string;
  commandLine?: string;
}

export interface IdeActiveQuotaResult {
  email: string;
  name?: string;
  userTier?: { id?: string; name?: string; description?: string };
  geminiGroup?: QuotaGroup;
  claudeGptGroup?: QuotaGroup;
  argonGroup?: QuotaGroup;
  geminiInstantPercentage: number;
  claudeInstantPercentage: number;
  accountInstantPercentage: number;
  overallQuotaPercentage: number;
  rawGroups: any[];
}

let cachedHubInfo: { info: LocalAgyHubInfo | null; timestamp: number } | null = null;
const HUB_CACHE_TTL_MS = 15000; // 15 seconds

/**
 * Discovers the local agy hub port and CSRF token from running process command line arguments.
 */
export function getLocalAgyHubInfo(forceRefresh = false): LocalAgyHubInfo | null {
  const now = Date.now();
  if (!forceRefresh && cachedHubInfo && (now - cachedHubInfo.timestamp < HUB_CACHE_TTL_MS)) {
    return cachedHubInfo.info;
  }

  let info: LocalAgyHubInfo | null = null;

  try {
    let stdout = '';
    if (process.platform === 'win32') {
      stdout = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'agy.exe\'\\" | Select-Object -ExpandProperty CommandLine"',
        { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }
      );
    } else {
      stdout = execSync('ps aux | grep agy | grep -- --hub-port', {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore']
      });
    }

    const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const candidateHubs: LocalAgyHubInfo[] = [];

    for (const line of lines) {
      const portMatch = line.match(/--hub-port=(\d+)/);
      const csrfMatch = line.match(/--csrf_token=([a-f0-9-]+)/i);
      if (portMatch && csrfMatch) {
        candidateHubs.push({
          port: parseInt(portMatch[1], 10),
          csrfToken: csrfMatch[1],
          commandLine: line
        });
      }
    }

    if (candidateHubs.length > 0) {
      // Prioritize the hub matching the active workspace if vscode is available
      let matchedHub: LocalAgyHubInfo | undefined;
      try {
        const vscode = require('vscode');
        const workspaceFolders = vscode?.workspace?.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          const workspacePaths: string[] = workspaceFolders.map((f: any) =>
            (f.uri?.fsPath || '').toLowerCase()
          );
          matchedHub = candidateHubs.find((h) => {
            const cl = (h.commandLine || '').toLowerCase();
            return workspacePaths.some((wp) => wp && cl.includes(wp));
          });
        }
      } catch {}

      info = matchedHub || candidateHubs[0];
    }
  } catch {
    info = null;
  }

  cachedHubInfo = { info, timestamp: now };
  return info;
}

/**
 * Sends a Connect-RPC JSON POST to the local agy LanguageServerService.
 */
export function callLocalAgyRpc(
  hubInfo: LocalAgyHubInfo,
  method: string,
  body: any = {},
  timeoutMs = 1500
): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: hubInfo.port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': hubInfo.csrfToken,
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: timeoutMs
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 401) {
            cachedHubInfo = null;
            return reject(new Error(`[LocalAgyClient] 401 CSRF token invalid`));
          }
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`[LocalAgyClient] HTTP ${res.statusCode} on ${method}`));
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
      reject(new Error(`[LocalAgyClient] Timeout (${timeoutMs}ms) calling ${method}`));
    });

    req.on('error', (err) => {
      cachedHubInfo = null;
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Fetches the active account's real-time quota and profile directly from the local running IDE (agy).
 * Returns null if the IDE or agy is not running or if requests fail.
 */
export async function fetchActiveAccountQuotaFromIde(
  timeoutMs = 1500
): Promise<IdeActiveQuotaResult | null> {
  const hubInfo = getLocalAgyHubInfo();
  if (!hubInfo) return null;

  try {
    // 1. Fetch RetrieveUserQuotaSummary
    const summaryRes = await callLocalAgyRpc(hubInfo, 'RetrieveUserQuotaSummary', {}, timeoutMs);
    const rawGroups: any[] = summaryRes?.response?.groups || summaryRes?.groups || [];
    if (!rawGroups || rawGroups.length === 0) {
      return null;
    }

    // 2. Fetch GetUserStatus for active email & tier
    let userStatus: any = {};
    try {
      const statusRes = await callLocalAgyRpc(hubInfo, 'GetUserStatus', {}, timeoutMs);
      userStatus = statusRes?.userStatus || {};
    } catch {}

    const email = (userStatus.email || '').trim().toLowerCase();
    if (!email) {
      return null;
    }

    let geminiGroup: QuotaGroup | undefined;
    let claudeGptGroup: QuotaGroup | undefined;
    let argonGroup: QuotaGroup | undefined;

    for (const g of rawGroups) {
      const title = (g.displayName || '').toLowerCase();
      const isArgon = title.includes('argon');
      const isGemini = title.includes('gemini') && !isArgon;
      const isClaude = title.includes('claude') || title.includes('gpt');

      const weeklyBucketRaw = g.buckets?.find((b: any) => b.window === 'weekly');
      const fiveHourBucketRaw = g.buckets?.find((b: any) => b.window === '5h');

      const weekly: QuotaBucket | undefined = weeklyBucketRaw
        ? {
            bucketId: weeklyBucketRaw.bucketId,
            displayName: weeklyBucketRaw.displayName || 'Weekly Limit Remaining',
            window: 'weekly',
            percentage: Math.round((weeklyBucketRaw.remainingFraction ?? 0) * 100),
            remainingFraction: weeklyBucketRaw.remainingFraction ?? 0,
            resetTime: weeklyBucketRaw.resetTime,
            resetCountdown:
              parseCountdownFromDescription(weeklyBucketRaw.description) ||
              (weeklyBucketRaw.resetTime ? formatCountdown(weeklyBucketRaw.resetTime) : undefined)
          }
        : undefined;

      const fiveHour: QuotaBucket | undefined = fiveHourBucketRaw
        ? {
            bucketId: fiveHourBucketRaw.bucketId,
            displayName: fiveHourBucketRaw.displayName || 'Five Hour Limit Remaining',
            window: '5h',
            percentage: Math.round((fiveHourBucketRaw.remainingFraction ?? 0) * 100),
            remainingFraction: fiveHourBucketRaw.remainingFraction ?? 0,
            resetTime: fiveHourBucketRaw.resetTime,
            resetCountdown:
              parseCountdownFromDescription(fiveHourBucketRaw.description) ||
              (fiveHourBucketRaw.resetTime ? formatCountdown(fiveHourBucketRaw.resetTime) : undefined)
          }
        : undefined;

      const groupObj: QuotaGroup = {
        id: isGemini ? 'gemini' : isClaude ? 'claude_gpt' : isArgon ? 'argon' : g.displayName,
        name: g.displayName,
        description: g.description,
        weekly,
        fiveHour,
        buckets: [weekly, fiveHour].filter((b): b is QuotaBucket => Boolean(b))
      };

      if (isGemini) geminiGroup = groupObj;
      else if (isClaude) claudeGptGroup = groupObj;
      else if (isArgon) argonGroup = groupObj;
    }

    // Calculate instant quotas modulated by weekly capacity
    let geminiInstant = 0;
    if (geminiGroup?.fiveHour && geminiGroup?.weekly) {
      geminiInstant = calculateModulatedInstantQuota(
        geminiGroup.fiveHour.percentage,
        geminiGroup.weekly.percentage,
        SAFE_WEEKLY_THRESHOLDS.GEMINI
      );
    } else if (geminiGroup?.fiveHour) {
      geminiInstant = geminiGroup.fiveHour.percentage;
    } else if (geminiGroup?.weekly) {
      geminiInstant = geminiGroup.weekly.percentage;
    }

    let claudeInstant = 0;
    if (claudeGptGroup?.fiveHour && claudeGptGroup?.weekly) {
      claudeInstant = calculateModulatedInstantQuota(
        claudeGptGroup.fiveHour.percentage,
        claudeGptGroup.weekly.percentage,
        SAFE_WEEKLY_THRESHOLDS.CLAUDE_GPT
      );
    } else if (claudeGptGroup?.fiveHour) {
      claudeInstant = claudeGptGroup.fiveHour.percentage;
    } else if (claudeGptGroup?.weekly) {
      claudeInstant = claudeGptGroup.weekly.percentage;
    }

    const accountInstant = Math.round(
      geminiInstant * MODEL_WEIGHTS.GEMINI + claudeInstant * MODEL_WEIGHTS.CLAUDE
    );

    const weeklyAvg =
      geminiGroup?.weekly && claudeGptGroup?.weekly
        ? Math.round(
            (geminiGroup.weekly.percentage * MODEL_WEIGHTS.GEMINI) +
            (claudeGptGroup.weekly.percentage * MODEL_WEIGHTS.CLAUDE)
          )
        : (geminiGroup?.weekly?.percentage ?? claudeGptGroup?.weekly?.percentage ?? accountInstant);

    return {
      email,
      name: userStatus.name,
      userTier: userStatus.userTier,
      geminiGroup,
      claudeGptGroup,
      argonGroup,
      geminiInstantPercentage: geminiInstant,
      claudeInstantPercentage: claudeInstant,
      accountInstantPercentage: accountInstant,
      overallQuotaPercentage: weeklyAvg,
      rawGroups
    };
  } catch {
    return null;
  }
}
