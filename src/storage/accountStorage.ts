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
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      }
    } catch {}

    const stateAccounts = this.context.globalState.get<AccountInfo[]>(STORAGE_KEYS.ACCOUNTS, []);
    if (stateAccounts.length > 0) {
      try {
        fs.writeFileSync(filePath, JSON.stringify(stateAccounts, null, 2), 'utf-8');
      } catch {}
    }
    return stateAccounts;
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
    const raw = await this.secrets.get(`antigravitySwap.tokens.${email}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch {
      return null;
    }
  }

  public async saveAccountTokens(email: string, tokens: OAuthTokens): Promise<void> {
    await this.secrets.store(`antigravitySwap.tokens.${email}`, JSON.stringify(tokens));
  }

  public async removeAccountTokens(email: string): Promise<void> {
    await this.secrets.delete(`antigravitySwap.tokens.${email}`);
  }
}
