# Antigravity Swap — Refresh & Auto-Switch Architecture & Flow Diagrams

This document details the exact operational flow and distributed architecture of **Antigravity Swap** across four core mechanisms:
1. **Global Refresh** (Batch Chunking & Distributed Pacing)
2. **Single Account Refresh** (Rate Limiting, OAuth Token Refresh & Quota Scraping)
3. **Background Refresh** (Heartbeat Tick & Oldest-Account / LRU Rotation)
4. **Auto-Switch** (Threshold Evaluation, Candidate Ranking & Atomic Switching)

---

## 1. Overview Architecture Diagram

```mermaid
flowchart TB
    subgraph Triggers["Triggers & Events"]
        T1["User clicks 'Refresh All'"]
        T2["User clicks Card Refresh"]
        T3["Heartbeat Timer (every 30s)"]
    end

    subgraph LockManager["Distributed Lease Manager (File-based Lock)"]
        DL["tryAcquireRefreshLease()"]
        RL["renewRefreshLease()"]
        RelL["releaseRefreshLease()"]
    end

    subgraph CoreEngine["AccountManager Execution Core"]
        GR["refreshAllQuotas()<br/>• Active first<br/>• Batch Size: 3<br/>• 100ms pacing delay"]
        SR["refreshAccountQuota()<br/>• 15s Cooldown check<br/>• Token refresh if expired<br/>• Quota API fetch"]
        BR["runHeartbeatTick()<br/>• Check IDE Session<br/>• Pick oldest lastRefreshedAt<br/>• Refresh 1 single account"]
        AS["checkAutoSwitch()<br/>• Target: Gemini / Claude / Total<br/>• Threshold check (e.g. <= 2%)<br/>• Best candidate rank & switch"]
    end

    subgraph StorageLayer["Persistence & IDE State"]
        JSON[("accounts.json / state_refresh_lease.json")]
        KEYTAR[("SecretStorage (OAuth Tokens)")]
        IDEDB[("IDE state.vscdb & In-Memory USS")]
        WEBVIEW["Webview UI (React)"]
    end

    T1 -->|Force = true| GR
    T2 -->|Force = true| SR
    T3 -->|Force = false| BR

    GR --> DL
    BR --> DL
    GR -->|Batch chunk parallel| SR
    BR -->|Single oldest candidate| SR

    GR --> RL
    GR --> AS
    BR --> AS
    SR --> JSON
    SR --> KEYTAR
    SR --> WEBVIEW
    GR --> RelL
    BR --> RelL
    AS -->|If Depleted / Auth Failed| IDEDB
```

---

## 2. Global Refresh Flow

Triggered when the user clicks **"Refresh All"** in the Controller Bar or runs the VS Code command `antigravity-swap.refreshQuotas`.

```mermaid
sequenceDiagram
    autonumber
    actor User as User / Webview
    participant AM as AccountManager (refreshAllQuotas)
    participant Lock as Storage Lease (state_refresh_lease.json)
    participant SR as Single Refresh (refreshAccountQuota)
    participant API as Google Cloud Code API
    participant AS as AutoSwitch Engine

    User->>AM: Trigger Global Refresh (force = true)
    AM->>Lock: tryAcquireRefreshLease(force = true)
    alt Lease Busy & Not Overridable
        Lock-->>AM: Lease Denied (Locked by another instance)
        AM->>AM: reloadFromStorage() (sync accounts.json)
        AM-->>User: Refresh Skipped (shared data reloaded)
    else Lease Acquired
        Lock-->>AM: Lease Granted (PID + timestamp recorded)
        AM->>AM: Order accounts: [Active Account, ...Other Accounts]
        
        loop For Each Batch of 3 Accounts (REFRESH_BATCH_SIZE)
            par Refresh up to 3 accounts in parallel
                AM->>SR: refreshAccountQuota(acc1.email)
                SR->>API: Fetch Quotas
                API-->>SR: Quota Result
            and
                AM->>SR: refreshAccountQuota(acc2.email)
                SR->>API: Fetch Quotas
                API-->>SR: Quota Result
            and
                AM->>SR: refreshAccountQuota(acc3.email)
                SR->>API: Fetch Quotas
                API-->>SR: Quota Result
            end
            
            AM->>Lock: renewRefreshLease() (extend TTL)
            AM->>AM: Wait 100ms Pacing Delay (BATCH_PACING_DELAY_MS)
            AM-->>User: Report onProgress(completed, total, email)
        end

        AM->>AS: checkAutoSwitch()
        AM->>Lock: releaseRefreshLease() (set status = IDLE)
        AM-->>User: Fire onDidChangeState (Webview re-rendered)
    end
```

---

## 3. Single Account Refresh Flow

Triggered individually per account card, or internally invoked by Global/Background refresh.

```mermaid
flowchart TD
    Start(["refreshAccountQuota(email, force)"]) --> FindAcc["Look up account in memory"]
    FindAcc --> AccExists{"Account exists?"}
    AccExists -- No --> Exit(["Return"])
    AccExists -- Yes --> CheckCooldown{"force == false AND<br/>(now - lastRefreshedAt) < 15s?"}
    
    CheckCooldown -- Yes --> Exit
    CheckCooldown -- No --> MarkInFlight["Set acc.lastRefreshedAt = now<br/>(prevents concurrent double-trigger)"]
    
    MarkInFlight --> GetTokens["Retrieve OAuth Tokens from SecretStorage"]
    GetTokens --> HasTokens{"Valid Access Token?"}
    
    HasTokens -- No --> SetAuthFailed["Set acc.status = 'auth_failed'<br/>Clear quotas & Notify UI"]
    SetAuthFailed --> SaveFailed["Save to accounts.json & Exit"]
    
    HasTokens -- Yes --> CallAPI["QuotaService.fetchAccountQuotas()"]
    
    CallAPI --> TokenExpired{"Token Expired (401)?"}
    TokenExpired -- Yes --> RefreshOAuth["Exchange refresh_token for new access_token"]
    RefreshOAuth --> SaveTokens["Save updated tokens to SecretStorage"]
    SaveTokens --> RetryAPI["Retry Quota API Request"]
    TokenExpired -- No --> ProcessQuotas["Process Quota Response"]
    RetryAPI --> ProcessQuotas
    
    ProcessQuotas --> CalculateMetrics["Calculate Metrics:<br/>• Gemini & Claude/GPT group breakdown<br/>• 5-Hour & Weekly Rolling Windows<br/>• Tier Badges & Reset Countdowns<br/>• Account Average / Target Quota"]
    
    CalculateMetrics --> UpdateDates["Set acc.lastRefreshedAt = now<br/>Set acc.lastHeartbeatAt = now"]
    UpdateDates --> SaveStorage["Save accounts.json & Fire State Change Event"]
    SaveStorage --> Done(["Completed"])
```

---

## 4. Background Refresh Flow (Heartbeat Tick)

Runs periodically via `HeartbeatService` (default: every **30 seconds**). Unlike Global Refresh, it uses an **LRU / Oldest-Unrefreshed Account** selection mechanism to minimize network load and API rate consumption.

```mermaid
flowchart TD
    Tick(["Heartbeat Timer Fired (every 30s)"]) --> SyncIDE["checkExternalIdeSession()<br/>(Sync with external IDE login/logout)"]
    SyncIDE --> TryLease{"tryAcquireRefreshLease(force = false)"}
    
    TryLease -- Busy / Locked by another window --> ReloadShared["reloadFromStorage()<br/>(Reload accounts.json)"]
    ReloadShared --> CheckAS1["checkAutoSwitch()"] --> ExitTick(["End Tick"])
    
    TryLease -- Lease Acquired --> FilterCandidates["Filter eligible candidate accounts:<br/>• !isBanned<br/>• status != 'banned'<br/>• status != 'auth_failed'"]
    
    FilterCandidates --> HasCandidates{"Candidate count > 0?"}
    HasCandidates -- No --> CheckAS2["checkAutoSwitch()"]
    
    HasCandidates -- Yes --> SortLRU["Sort candidates by lastRefreshedAt ascending:<br/>• null / undefined first<br/>• oldest timestamp first"]
    
    SortLRU --> PickSingle["Select target = sorted[0]<br/>(1 single account with oldest refresh)"]
    PickSingle --> CallSingleRefresh["await refreshAccountQuota(target.email)"]
    CallSingleRefresh --> CheckAS2
    
    CheckAS2 --> ReleaseLease["storage.releaseRefreshLease()"]
    ReleaseLease --> EmitHeartbeat["Emit onHeartbeat event (UI status indicator)"]
    EmitHeartbeat --> DoneTick(["End Tick"])
```

---

## 5. Auto-Switch Flow

Triggered immediately after any quota refresh operation or external account sync.

```mermaid
flowchart TD
    StartAS(["checkAutoSwitch()"]) --> CheckEnabled{"isAutoSwitchEnabled() == true?"}
    CheckEnabled -- No --> EndAS(["Return"])
    
    CheckEnabled -- Yes --> GetActive["Get active account"]
    GetActive --> HasActive{"Active account exists?"}
    HasActive -- No --> EndAS
    
    HasActive -- Yes --> CheckReady{"Account ready?<br/>(isAuthFailed OR isBanned OR has quotas loaded)"}
    CheckReady -- No --> EndAS
    
    CheckReady -- Yes --> ResolveTarget["Resolve Target Quota:<br/>• target = 'gemini' | 'claude' | 'total'<br/>• Read target percentage"]
    
    ResolveTarget --> CheckDepleted{"activeQuota <= threshold (e.g. <= 2%)<br/>OR status == 'auth_failed'<br/>OR isBanned == true?"}
    
    CheckDepleted -- No --> EndAS
    
    CheckDepleted -- Yes --> FindCandidates["Find fallback candidates:<br/>• email != active.email<br/>• !isBanned & status == 'active'<br/>• targetQuota > threshold"]
    
    FindCandidates --> HasFallback{"Candidate found?"}
    HasFallback -- No --> WarnNoAcc["No healthy account available to switch"] --> EndAS
    
    HasFallback -- Yes --> RankBest["Sort candidates descending by target quota<br/>Pick candidate = candidates[0] (highest quota)"]
    
    RankBest --> NotifyUser["Show VS Code Warning Notification:<br/>'Account X has low quota / auth failed.<br/>Auto-switching to Y (Quota: Z% left)...'"]
    
    NotifyUser --> DoSwitch["switchAccount(candidate.email):<br/>1. Patch in-memory Unified State Sync (preserve custom models)<br/>2. Patch state.vscdb SQLite database<br/>3. Update accounts.json & active email<br/>4. Sync SecretStorage credentials<br/>5. Fire onDidChangeState"]
    
    DoSwitch --> Finish(["Auto-Switch Completed"])
```

---

## 6. Summary Comparison Table

| Feature | Global Refresh | Single Refresh | Background Refresh (Heartbeat) | Auto-Switch |
| :--- | :--- | :--- | :--- | :--- |
| **Invocation** | User clicks "Refresh All" or Command | User clicks card refresh or API hook | Periodic interval timer (`30s`) | Triggered post-refresh automatically |
| **Lease Lock** | `tryAcquireRefreshLease(true)` | Per-account cooldown (`15s`) | `tryAcquireRefreshLease(false)` | In-memory evaluation |
| **Target Scope** | **All** registered accounts | **1 specific** targeted account | **1 single oldest** unrefreshed account (LRU) | Switches active session to highest-quota account |
| **Concurrency** | Parallel batches of **3 accounts** (`REFRESH_BATCH_SIZE`) | Single execution | Single execution | Single atomic switch |
| **Pacing / Rate Limit** | `100ms` delay between batch chunks | `15s` silent skip cooldown | Spaced out by heartbeat interval (`30s`) | N/A |
| **Impact on IDE** | Quota gauges updated | Quota card updated | Seamless continuous quota rotation | In-memory USS + SQLite `state.vscdb` patched live |
