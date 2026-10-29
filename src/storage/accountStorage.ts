import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { AccountInfo, OAuthTokens, AutoSwitchTarget } from '../types';
import { STORAGE_KEYS, CONFIG_KEYS, EXTENSION_DEFAULTS } from '../constants';

export class AccountStorage {
  private lastLocalSaveTime = 0;
  private thresholdConfigDebounceTimer?: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: vscode.SecretStorage
  ) {}

  public getLastLocalSaveTime(): number {
    return this.lastLocalSaveTime;
  }

  public getAccountsFilePath(): string {
    const dir = path.join(os.homedir(), '.antigravity-swap');
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {}
    }
    return path.join(dir, 'accounts.json');
  }

  public getAccounts(): AccountInfo[] {
    const filePath = this.getAccountsFilePath();
    let accounts: AccountInfo[] = [];
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          accounts = parsed;
        }
      }
    } catch {}

    if (accounts.length === 0) {
      const stateAccounts = this.context.globalState.get<AccountInfo[]>(STORAGE_KEYS.ACCOUNTS, []);
      if (stateAccounts.length > 0) {
        accounts = stateAccounts;
        try {
          fs.writeFileSync(filePath, JSON.stringify(stateAccounts, null, 2), 'utf-8');
        } catch {}
      }
    }
    return this.normalizeExpiredQuotas(accounts);
  }

  private normalizeExpiredQuotas(accounts: AccountInfo[]): AccountInfo[] {
    const now = Date.now();
    return accounts.map((acc) => {
      let accModified = false;
      let geminiGroup = acc.geminiGroup;
      let claudeGptGroup = acc.claudeGptGroup;
      let argonGroup = acc.argonGroup;
      let statusMessage = acc.statusMessage;
      const isPro = acc.tierBadge === 'PRO' || acc.tierBadge === 'AI PREMIUM';

      const normalizeBucket = (b?: any) => {
        if (!b) return b;
        if (b.resetTime && new Date(b.resetTime).getTime() <= now) {
          accModified = true;
          return {
            ...b,
            remainingFraction: 1.0,
            percentage: 100,
            resetTime: undefined,
            resetCountdown: 'Ready'
          };
        }
        return b;
      };

      if (geminiGroup) {
        const new5h = normalizeBucket(geminiGroup.fiveHour);
        const newWk = normalizeBucket(geminiGroup.weekly);
        if (new5h !== geminiGroup.fiveHour || newWk !== geminiGroup.weekly) {
          geminiGroup = {
            ...geminiGroup,
            fiveHour: new5h,
            weekly: newWk,
            buckets: [new5h, newWk].filter(Boolean)
          };
        }
      }

      if (claudeGptGroup) {
        const new5h = normalizeBucket(claudeGptGroup.fiveHour);
        const newWk = normalizeBucket(claudeGptGroup.weekly);
        if (new5h !== claudeGptGroup.fiveHour || newWk !== claudeGptGroup.weekly) {
          claudeGptGroup = {
            ...claudeGptGroup,
            fiveHour: new5h,
            weekly: newWk,
            buckets: [new5h, newWk].filter(Boolean)
          };
        }
      }

      if (!isPro && argonGroup) {
        argonGroup = undefined;
        accModified = true;
      } else if (isPro && argonGroup) {
        const newWk = normalizeBucket(argonGroup.weekly);
        if (argonGroup.fiveHour !== undefined || newWk !== argonGroup.weekly) {
          accModified = true;
          argonGroup = {
            ...argonGroup,
            fiveHour: undefined,
            weekly: newWk,
            buckets: [newWk].filter(Boolean)
          };
        }
      }

      if (accModified) {
        const gWk = geminiGroup?.weekly?.percentage;
        const cWk = claudeGptGroup?.weekly?.percentage;
        const g5h = geminiGroup?.fiveHour?.percentage;
        const c5h = claudeGptGroup?.fiveHour?.percentage;

        let weeklyPercentage = acc.weeklyQuotaPercentage;
        if (gWk !== undefined && cWk !== undefined) {
          weeklyPercentage = Math.round(gWk * 0.85 + cWk * 0.15);
        } else if (gWk !== undefined) {
          weeklyPercentage = gWk;
        } else if (cWk !== undefined) {
          weeklyPercentage = cWk;
        }

        let fiveHourPercentage = acc.fiveHourQuotaPercentage;
        if (g5h !== undefined && c5h !== undefined) {
          fiveHourPercentage = Math.round(g5h * 0.85 + c5h * 0.15);
        } else if (g5h !== undefined) {
          fiveHourPercentage = g5h;
        } else if (c5h !== undefined) {
          fiveHourPercentage = c5h;
        }

        const isHealthy = (gWk === undefined || gWk > 0) && (cWk === undefined || cWk > 0) && (g5h === undefined || g5h > 0) && (c5h === undefined || c5h > 0);
        if (isHealthy && (statusMessage || '').includes('depleted')) {
          statusMessage = undefined;
        }

        return {
          ...acc,
          geminiGroup,
          claudeGptGroup,
          argonGroup,
          weeklyQuotaPercentage: weeklyPercentage,
          fiveHourQuotaPercentage: fiveHourPercentage,
          averageQuotaPercentage: weeklyPercentage ?? fiveHourPercentage ?? acc.averageQuotaPercentage,
          status: isHealthy && acc.status === 'low_balance' ? 'healthy' : acc.status,
          statusMessage
        };
      }

      return acc;
    });
  }

  public async saveAccounts(accounts: AccountInfo[]): Promise<void> {
    this.lastLocalSaveTime = Date.now();
    await this.context.globalState.update(STORAGE_KEYS.ACCOUNTS, accounts);
    const filePath = this.getAccountsFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }
    const tmpPath = path.join(dir, `.accounts.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(accounts, null, 2), 'utf-8');
      try {
        fs.renameSync(tmpPath, filePath);
      } catch {
        // Fallback for Windows environments if destination file handle is momentarily locked
        fs.copyFileSync(tmpPath, filePath);
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    } catch (e) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      console.warn('[AccountStorage] Failed to atomically write accounts.json:', e);
    }
  }

  public getActiveAccountEmail(): string | undefined {
    return this.context.globalState.get<string>(STORAGE_KEYS.ACTIVE_ACCOUNT);
  }

  public async setActiveAccountEmail(email: string | undefined): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.ACTIVE_ACCOUNT, email);
  }

  public getAutoSwitchEnabled(): boolean {
    const config = vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION);
    const configVal = config.get<boolean>(CONFIG_KEYS.AUTO_SWITCH_WHEN_LOW);
    if (typeof configVal === 'boolean') {
      return configVal;
    }
    return this.context.globalState.get<boolean>(STORAGE_KEYS.AUTO_SWITCH, EXTENSION_DEFAULTS.DEFAULT_AUTO_SWITCH_ENABLED);
  }

  public async setAutoSwitchEnabled(enabled: boolean): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.AUTO_SWITCH, enabled);
    try {
      const config = vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION);
      await config.update(CONFIG_KEYS.AUTO_SWITCH_WHEN_LOW, enabled, vscode.ConfigurationTarget.Global);
    } catch {}
  }

  public getAutoSwitchTarget(): AutoSwitchTarget {
    const config = vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION);
    const configTarget = config.get<string>(CONFIG_KEYS.AUTO_SWITCH_TARGET);
    if (configTarget === 'instant' || configTarget === 'total') return 'instant';
    if (configTarget === 'gemini' || configTarget === 'claude') return configTarget;
    const stored = this.context.globalState.get<string>(STORAGE_KEYS.AUTO_SWITCH_TARGET, EXTENSION_DEFAULTS.DEFAULT_AUTO_SWITCH_TARGET);
    if (stored === 'total') return 'instant';
    if (stored === 'gemini' || stored === 'claude' || stored === 'instant') return stored;
    return EXTENSION_DEFAULTS.DEFAULT_AUTO_SWITCH_TARGET;
  }

  public async setAutoSwitchTarget(target: AutoSwitchTarget): Promise<void> {
    await this.context.globalState.update(STORAGE_KEYS.AUTO_SWITCH_TARGET, target);
    try {
      const config = vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION);
      await config.update(CONFIG_KEYS.AUTO_SWITCH_TARGET, target, vscode.ConfigurationTarget.Global);
    } catch {}
  }

  public getAutoSwitchThreshold(): number {
    const stateVal = this.context.globalState.get<number>(STORAGE_KEYS.LOW_QUOTA_THRESHOLD);
    if (typeof stateVal === 'number' && !isNaN(stateVal) && stateVal >= 0 && stateVal <= 100) {
      return Math.round(stateVal);
    }
    const config = vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION);
    const configVal = config.get<number>(CONFIG_KEYS.LOW_QUOTA_THRESHOLD);
    if (typeof configVal === 'number' && !isNaN(configVal) && configVal >= 0 && configVal <= 100) {
      return Math.round(configVal);
    }
    return EXTENSION_DEFAULTS.DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT;
  }

  public async setAutoSwitchThreshold(threshold: number): Promise<void> {
    const num = typeof threshold === 'number' && !isNaN(threshold) && isFinite(threshold)
      ? threshold
      : EXTENSION_DEFAULTS.DEFAULT_LOW_QUOTA_THRESHOLD_PERCENT;
    const clamped = Math.max(0, Math.min(100, Math.round(num)));
    await this.context.globalState.update(STORAGE_KEYS.LOW_QUOTA_THRESHOLD, clamped);

    // Debounce persisting to VS Code settings.json to avoid excessive file writes
    if (this.thresholdConfigDebounceTimer) {
      clearTimeout(this.thresholdConfigDebounceTimer);
    }
    this.thresholdConfigDebounceTimer = setTimeout(async () => {
      try {
        const config = vscode.workspace.getConfiguration(CONFIG_KEYS.SECTION);
        await config.update(CONFIG_KEYS.LOW_QUOTA_THRESHOLD, clamped, vscode.ConfigurationTarget.Global);
      } catch {}
    }, 600);
  }

  public async getAccountTokens(email: string): Promise<OAuthTokens | null> {
    if (!email) return null;
    const raw = await this.secrets.get(`antigravitySwap.tokens.${email.trim().toLowerCase()}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch {
      return null;
    }
  }

  public async saveAccountTokens(email: string, tokens: OAuthTokens): Promise<void> {
    if (!email) return;
    await this.secrets.store(`antigravitySwap.tokens.${email.trim().toLowerCase()}`, JSON.stringify(tokens));
  }

  public async removeAccountTokens(email: string): Promise<void> {
    if (!email) return;
    await this.secrets.delete(`antigravitySwap.tokens.${email.trim().toLowerCase()}`);
  }
}
