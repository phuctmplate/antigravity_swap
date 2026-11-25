import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { QuotaGroup, QuotaBucket } from '../types';
import { calculateModulatedInstantQuota } from './quotaCalculator';
import { is5HourBucket, isWeeklyBucket } from './quotaClassifier';
import { formatCountdown, parseCountdownFromDescription } from './quotaFormatters';
import { SAFE_WEEKLY_THRESHOLDS, MODEL_WEIGHTS } from '../constants';

export interface LocalAgyHubInfo {
  port: number;
  csrfToken: string;
  lsVersion?: string;
  commandLine?: string;
}

export interface IdeQuotaFetchOptions {
  expectedEmail?: string;
  cacheTtlMs?: number;
  cacheFilePath?: string;
  bypassSharedCache?: boolean;
}

interface SharedIdeQuotaCacheEntry {
  email?: string;
  timestamp?: number;
  data?: IdeActiveQuotaResult;
}

interface IdeQuotaLockFile {
  pid: number;
  expiresAt: number;
}

const SHARED_IDE_QUOTA_CACHE_TTL_MS = 25_000;
const inFlightLocalQueries = new Map<string, Promise<IdeActiveQuotaResult | null>>();

function getDefaultSharedIdeCachePath(): string {
  return path.join(os.homedir(), '.antigravity-swap', '.ide-quota-cache.json');
}

function getLockFilePath(cachePath: string): string {
  return `${cachePath}.lock`;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/**
 * Atomically acquires an exclusive lock file (O_CREAT | O_EXCL via 'wx').
 * Self-recovers automatically if an existing lock is expired or held by a dead PID.
 */
export function tryAcquireIdeQuotaLock(
  lockPath: string,
  ttlMs: number,
  currentPid: number = process.pid
): boolean {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  const writeExclusive = (): boolean => {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        const payload: IdeQuotaLockFile = { pid: currentPid, expiresAt: Date.now() + ttlMs };
        fs.writeFileSync(fd, JSON.stringify(payload), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err: any) {
      if (err?.code === 'EEXIST') return false;
      return false;
    }
  };

  if (writeExclusive()) return true;

  // Lock exists: check if it is stale (expired TTL or orphaned by crashed/closed IDE instance)
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(raw) as Partial<IdeQuotaLockFile>;
    const isExpired = typeof lock.expiresAt !== 'number' || Date.now() > lock.expiresAt;
    const isDead = typeof lock.pid !== 'number' || !isProcessAlive(lock.pid);
    if (isExpired || isDead) {
      try { fs.unlinkSync(lockPath); } catch {}
      return writeExclusive();
    }
  } catch {
    // Unparseable/corrupt lock file: recover cleanly
    try { fs.unlinkSync(lockPath); } catch {}
    return writeExclusive();
  }

  return false;
}

export function releaseIdeQuotaLock(lockPath: string, currentPid: number = process.pid): void {
  try {
    if (!fs.existsSync(lockPath)) return;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(raw) as Partial<IdeQuotaLockFile>;
    if (lock.pid === currentPid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function readSharedIdeQuotaCache(cachePath: string): SharedIdeQuotaCacheEntry | null {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeSharedIdeQuotaCache(cachePath: string, entry: SharedIdeQuotaCacheEntry): void {
  try {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = path.join(dir, `.ide-quota-cache.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(entry), 'utf8');
    try {
      fs.renameSync(tmpPath, cachePath);
    } catch {
      fs.writeFileSync(cachePath, JSON.stringify(entry), 'utf8');
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  } catch {}
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
 * Reads the daemon hub discovery JSON file (~/.gemini/<appDataDir>/daemon/hub_<port>.json)
 * to retrieve the CSRF token and Language Server version for newer IDE builds that omit --csrf_token from CLI args.
 */
export function readHubDiscoveryFile(
  port: number,
  appDataDir = 'antigravity',
  geminiBaseDir?: string
): { csrfToken?: string; lsVersion?: string; httpPort?: number } | null {
  try {
    const baseDir = geminiBaseDir || path.join(os.homedir(), '.gemini');
    const hubJsonPath = path.join(baseDir, appDataDir, 'daemon', `hub_${port}.json`);
    if (!fs.existsSync(hubJsonPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(hubJsonPath, 'utf8'));
    return {
      csrfToken: typeof parsed?.csrfToken === 'string' ? parsed.csrfToken : undefined,
      lsVersion: typeof parsed?.lsVersion === 'string' ? parsed.lsVersion : undefined,
      httpPort: typeof parsed?.httpPort === 'number' ? parsed.httpPort : undefined
    };
  } catch {
    return null;
  }
}

/**
 * Parses `agy.exe` / `agy` command lines into LocalAgyHubInfo records, resolving CSRF tokens
 * from inline `--csrf_token=` flags (legacy) or daemon `hub_<port>.json` files (IDE 2.x+).
 */
export function parseAgyHubCommandLines(lines: string[], geminiBaseDir?: string): LocalAgyHubInfo[] {
  const candidateHubs: LocalAgyHubInfo[] = [];

  for (const line of lines) {
    const portMatch = line.match(/--hub-port=(\d+)/);
    if (!portMatch) continue;

    const port = parseInt(portMatch[1], 10);
    const csrfMatch = line.match(/--csrf_token=([a-f0-9-]+)/i);
    const appDirMatch = line.match(/--app_data_dir=([^\s"]+)/i);
    const appDataDir = appDirMatch ? appDirMatch[1] : 'antigravity';

    let csrfToken = csrfMatch?.[1];
    let lsVersion: string | undefined;

    if (!csrfToken) {
      const discovery = readHubDiscoveryFile(port, appDataDir, geminiBaseDir);
      csrfToken = discovery?.csrfToken;
      lsVersion = discovery?.lsVersion;
    }

    if (csrfToken) {
      candidateHubs.push({
        port,
        csrfToken,
        lsVersion,
        commandLine: line
      });
    }
  }

  return candidateHubs;
}

/**
 * Discovers the local agy hub port and CSRF token from running process command line arguments
 * and daemon discovery files.
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
    const candidateHubs = parseAgyHubCommandLines(lines);

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
 * Returns fresh cached IDE quota for the expected email if available and not expired.
 */
export function getFreshSharedIdeQuotaCache(
  options?: IdeQuotaFetchOptions
): IdeActiveQuotaResult | null {
  if (options?.bypassSharedCache) return null;
  const cachePath = options?.cacheFilePath || getDefaultSharedIdeCachePath();
  const cacheTtlMs = options?.cacheTtlMs ?? SHARED_IDE_QUOTA_CACHE_TTL_MS;
  const expectedEmail = options?.expectedEmail?.trim().toLowerCase();

  const cached = readSharedIdeQuotaCache(cachePath);
  if (
    cached?.data &&
    typeof cached.timestamp === 'number' &&
    Date.now() - cached.timestamp < cacheTtlMs
  ) {
    if (!expectedEmail || cached.data.email.toLowerCase() === expectedEmail) {
      return cached.data;
    }
  }
  return null;
}

/**
 * Fetches the active account's real-time quota and profile directly from the local running IDE (agy).
 * Coordinates across multiple IDE instances using an exclusive OS lock file (.ide-quota-cache.lock)
 * with dead-PID / TTL self-recovery and same-process in-flight deduplication.
 * Returns null if the IDE or agy is not running or if requests fail.
 */
export async function fetchActiveAccountQuotaFromIde(
  timeoutMs = 2500,
  forceRefresh = true,
  options?: IdeQuotaFetchOptions
): Promise<IdeActiveQuotaResult | null> {
  const cachePath = options?.cacheFilePath || getDefaultSharedIdeCachePath();

  // 1. Reuse fresh shared cache written by any IDE window (zero upstream calls)
  const freshCached = getFreshSharedIdeQuotaCache(options);
  if (freshCached) {
    return freshCached;
  }

  // 2. Deduplicate concurrent calls within the same IDE extension host process
  if (!options?.bypassSharedCache) {
    const inFlight = inFlightLocalQueries.get(cachePath);
    if (inFlight) {
      return inFlight;
    }
  }

  const runFetch = async (): Promise<IdeActiveQuotaResult | null> => {
    const lockPath = getLockFilePath(cachePath);
    const lockTtlMs = timeoutMs + 1000;
    const expectedEmail = options?.expectedEmail?.trim().toLowerCase();
    let acquiredLock = false;

    if (!options?.bypassSharedCache) {
      acquiredLock = tryAcquireIdeQuotaLock(lockPath, lockTtlMs);
      if (!acquiredLock) {
        // Another live IDE instance holds the exclusive lock: wait briefly and check shared cache
        for (let attempt = 0; attempt < 2; attempt++) {
          await new Promise((r) => setTimeout(r, 450));
          const updated = getFreshSharedIdeQuotaCache(options);
          if (updated) {
            return updated;
          }
          // Retry acquiring lock in case the leader crashed/closed abruptly or finished with error
          acquiredLock = tryAcquireIdeQuotaLock(lockPath, lockTtlMs);
          if (acquiredLock) break;
        }
        if (!acquiredLock) {
          const fallbackCached = readSharedIdeQuotaCache(cachePath);
          if (
            fallbackCached?.data &&
            (!expectedEmail || fallbackCached.data.email.toLowerCase() === expectedEmail)
          ) {
            return fallbackCached.data;
          }
          return null;
        }
      }
    }

    try {
      const hubInfo = getLocalAgyHubInfo();
      if (!hubInfo) return null;

      // 3. Fetch RetrieveUserQuotaSummary (with forceRefresh to bypass agy's internal cache)
      const summaryRes = await callLocalAgyRpc(hubInfo, 'RetrieveUserQuotaSummary', { forceRefresh }, timeoutMs);
      const rawGroups: any[] = summaryRes?.response?.groups || summaryRes?.groups || [];
      if (!rawGroups || rawGroups.length === 0) {
        return null;
      }

      // 4. Fetch GetUserStatus for active email & tier
      let userStatus: any = {};
      try {
        const statusRes = await callLocalAgyRpc(hubInfo, 'GetUserStatus', {}, timeoutMs);
        userStatus = statusRes?.userStatus || {};
      } catch {}

      const email = (userStatus.email || '').trim().toLowerCase();
      if (!email) {
        return null;
      }

      if (expectedEmail && email !== expectedEmail) {
        // IDE hub is still switching accounts; do not pollute shared cache with previous account metrics
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

      const weeklyBucketRaw = g.buckets?.find((b: any) => isWeeklyBucket(b.window, b.bucketId, b.displayName));
      const fiveHourBucketRaw = g.buckets?.find((b: any) => is5HourBucket(b.window, b.bucketId, b.displayName));

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

    const result: IdeActiveQuotaResult = {
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

    if (!options?.bypassSharedCache) {
      writeSharedIdeQuotaCache(cachePath, {
        email,
        timestamp: Date.now(),
        data: result
      });
    }

    return result;
    } catch {
      return null;
    } finally {
      if (acquiredLock) {
        releaseIdeQuotaLock(lockPath);
      }
    }
  };

  if (options?.bypassSharedCache) {
    return runFetch();
  }

  const promise = runFetch().finally(() => {
    inFlightLocalQueries.delete(cachePath);
  });
  inFlightLocalQueries.set(cachePath, promise);
  return promise;
}
