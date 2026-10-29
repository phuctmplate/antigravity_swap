import * as vscode from 'vscode';
import { AccountInfo, OAuthTokens, AutoSwitchTarget } from '../types';
import { DiscoveredAccount } from './accountDiscovery';
import { AccountStorage } from './accountStorage';
import { DistributedSyncManager } from './distributedSync';
import { IdeStateDbService } from './ideStateDb';
import { AccountDiscoveryService } from './accountDiscovery';
import { UssHotSwitchService } from './ussHotSwitch';

export { DiscoveredAccount };

/**
 * StorageService
 * Coordinates persistent storage, secret tokens, distributed multi-window locking,
 * and IDE hot-switching across modular sub-services.
 */
export class StorageService {
  private readonly _onDidAccountsChange = new vscode.EventEmitter<void>();
  public readonly onDidAccountsChange = this._onDidAccountsChange.event;
  private readonly _onDidExternalOAuthComplete = new vscode.EventEmitter<{ email: string; timestamp: number }>();
  public readonly onDidExternalOAuthComplete = this._onDidExternalOAuthComplete.event;

  private readonly accountStorage: AccountStorage;
  private readonly distributedSync: DistributedSyncManager;
  private readonly ideStateDb: IdeStateDbService;
  private readonly discoveryService: AccountDiscoveryService;
  private readonly ussHotSwitch: UssHotSwitchService;

  constructor(
    context: vscode.ExtensionContext,
    secrets: vscode.SecretStorage
  ) {
    this.accountStorage = new AccountStorage(context, secrets);
    this.ideStateDb = new IdeStateDbService();
    this.discoveryService = new AccountDiscoveryService(this.ideStateDb);
    this.ussHotSwitch = new UssHotSwitchService();

    this.distributedSync = new DistributedSyncManager(
      secrets,
      () => this._onDidAccountsChange.fire(),
      (data) => this._onDidExternalOAuthComplete.fire(data),
      () => this.accountStorage.getLastLocalSaveTime(),
      () => this.accountStorage.getAccountsFilePath()
    );
  }

  // ── Multi-Window Event & Lease Delegation ──

  public getOAuthEventFilePath(): string {
    return this.distributedSync.getOAuthEventFilePath();
  }

  public broadcastOAuthCompleted(email: string): void {
    this.distributedSync.broadcastOAuthCompleted(email);
  }

  public checkExternalOAuthEvent(): void {
    this.distributedSync.checkExternalOAuthEvent();
  }

  public initFileWatcher(): vscode.Disposable {
    return this.distributedSync.initFileWatcher();
  }

  public getHeartbeatIntervalSeconds(): number {
    return this.distributedSync.getHeartbeatIntervalSeconds();
  }

  public tryAcquireRefreshLease(force = false): boolean {
    return this.distributedSync.tryAcquireRefreshLease(force);
  }

  public renewRefreshLease(): void {
    this.distributedSync.renewRefreshLease();
  }

  public async renewRefreshLeaseAsync(): Promise<void> {
    return this.distributedSync.renewRefreshLeaseAsync();
  }

  public releaseRefreshLease(): void {
    this.distributedSync.releaseRefreshLease();
  }

  // ── Account Storage & Secret Delegation ──

  public getAccountsFilePath(): string {
    return this.accountStorage.getAccountsFilePath();
  }

  public getAccounts(): AccountInfo[] {
    return this.accountStorage.getAccounts();
  }

  public async saveAccounts(accounts: AccountInfo[]): Promise<void> {
    return this.accountStorage.saveAccounts(accounts);
  }

  public getActiveAccountEmail(): string | undefined {
    return this.accountStorage.getActiveAccountEmail();
  }

  public async setActiveAccountEmail(email: string | undefined): Promise<void> {
    return this.accountStorage.setActiveAccountEmail(email);
  }

  public getAutoSwitchEnabled(): boolean {
    return this.accountStorage.getAutoSwitchEnabled();
  }

  public async setAutoSwitchEnabled(enabled: boolean): Promise<void> {
    return this.accountStorage.setAutoSwitchEnabled(enabled);
  }

  public getAutoSwitchTarget(): AutoSwitchTarget {
    return this.accountStorage.getAutoSwitchTarget();
  }

  public async setAutoSwitchTarget(target: AutoSwitchTarget): Promise<void> {
    return this.accountStorage.setAutoSwitchTarget(target);
  }

  public getAutoSwitchThreshold(): number {
    return this.accountStorage.getAutoSwitchThreshold();
  }

  public async setAutoSwitchThreshold(threshold: number): Promise<void> {
    return this.accountStorage.setAutoSwitchThreshold(threshold);
  }

  public async getAccountTokens(email: string): Promise<OAuthTokens | null> {
    return this.accountStorage.getAccountTokens(email);
  }

  public async saveAccountTokens(email: string, tokens: OAuthTokens): Promise<void> {
    return this.accountStorage.saveAccountTokens(email, tokens);
  }

  public async removeAccountTokens(email: string): Promise<void> {
    return this.accountStorage.removeAccountTokens(email);
  }

  // ── SQLite & IDE State DB Delegation ──

  public getSqliteDb(dbPath: string): any {
    return this.ideStateDb.getSqliteDb(dbPath);
  }

  public async execSqliteUpsert(dbPath: string, key: string, value: string): Promise<boolean> {
    return this.ideStateDb.execSqliteUpsert(dbPath, key, value);
  }

  public async injectAccountStateAndRelaunch(
    account: AccountInfo,
    tokens: OAuthTokens,
    allAccounts: AccountInfo[]
  ): Promise<boolean> {
    return this.ideStateDb.injectAccountStateAndRelaunch(account, tokens, allAccounts);
  }

  public async syncToIdeStateDb(account: AccountInfo, tokens: OAuthTokens, skipUssKeys = false): Promise<boolean> {
    return this.ideStateDb.syncToIdeStateDb(account, tokens, skipUssKeys);
  }

  public async syncToCloudAccountsDb(email: string): Promise<boolean> {
    return this.ideStateDb.syncToCloudAccountsDb(email);
  }

  // ── Account Discovery Delegation ──

  public isValidEmail(email?: string): boolean {
    return this.discoveryService.isValidEmail(email);
  }

  public async getCurrentAntigravityAccount(): Promise<DiscoveredAccount | null> {
    return this.discoveryService.getCurrentAntigravityAccount();
  }

  public async discoverExistingAccounts(): Promise<DiscoveredAccount[]> {
    return this.discoveryService.discoverExistingAccounts();
  }

  public async syncGoogleAccountsJson(email: string): Promise<boolean> {
    return this.discoveryService.syncGoogleAccountsJson(email);
  }

  public async verifyIdeActiveAccount(expectedEmail: string): Promise<{ verified: boolean; actualEmail?: string }> {
    const current = await this.getCurrentAntigravityAccount().catch(() => null);
    if (!current?.email) {
      return { verified: false, actualEmail: undefined };
    }
    const actualEmail = current.email.trim().toLowerCase();
    const exp = expectedEmail.trim().toLowerCase();
    return {
      verified: actualEmail === exp,
      actualEmail
    };
  }

  // ── USS In-Memory Hot Switching ──

  public async liveSwitchOAuthToken(account: AccountInfo, tokens: OAuthTokens): Promise<boolean> {
    return this.ussHotSwitch.liveSwitchOAuthToken(account, tokens);
  }
}
