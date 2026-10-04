import React, { useState, useEffect, useRef } from 'react';
import { WebviewState } from './types';
import { Header } from './components/Header';
import { ControllerBar } from './components/ControllerBar';
import { AccountList } from './components/AccountList';
import { ModelQuotas } from './components/ModelQuotas';
import { Toaster } from './components/ui/sonner';
import { getVsCodeApi } from './vscode';

const defaultState: WebviewState = {
  accounts: [],
  activeAccount: null,
  overall: {
    totalAccounts: 0,
    overallPercentage: 0,
    averageActiveAccountPercentage: 0,
    highestAccountQuotaPercentage: 0,
    accountsWithHealthyQuota: 0,
    accountsLowOrDepleted: 0,
    accountsWithErrors: 0,
    proAccountsCount: 0,
    lastUpdated: new Date().toISOString()
  },
  autoSwitchEnabled: false,
  autoSwitchTarget: 'total'
};

function getInitialState(): WebviewState {
  try {
    const rootEl = document.getElementById('root');
    const rawB64 = rootEl?.getAttribute('data-initial-state');
    if (rawB64) {
      const json = decodeURIComponent(escape(atob(rawB64)));
      const parsed = JSON.parse(json);
      if (parsed && Array.isArray(parsed.accounts)) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('[Antigravity Swap] Could not parse data-initial-state:', e);
  }

  const cached = getVsCodeApi().getState() as WebviewState | undefined;
  if (cached && Array.isArray(cached.accounts)) {
    return cached;
  }

  return defaultState;
}

export const AppContent: React.FC = () => {
  const [state, setState] = useState<WebviewState>(getInitialState);

  const [selectedEmail, setSelectedEmail] = useState<string | null>(() => {
    return state.activeAccount?.email || state.accounts[0]?.email || null;
  });
  // Use a ref so the message handler always sees the latest selectedEmail
  // without needing to be in the useEffect dependency array
  const selectedEmailRef = useRef<string | null>(null);
  selectedEmailRef.current = selectedEmail;

  useEffect(() => {
    // Notify extension host that webview is ready for live stream updates
    getVsCodeApi().postMessage({ command: 'ready' });

    const handleMessage = (event: MessageEvent) => {
      try {
        const data = event.data;
        if (data && data.type === 'stateUpdate') {
          const accounts = data.accounts || [];
          const activeAccount = data.activeAccount || null;

          // Preserve existing selection if valid, else pick active or first account
          const current = selectedEmailRef.current;
          const nextSelected = (current && accounts.some((a: any) => a.email === current))
            ? current
            : (activeAccount?.email || accounts[0]?.email || null);

          setSelectedEmail(nextSelected);
          const nextState: WebviewState = {
            accounts,
            activeAccount,
            overall: data.overall,
            heartbeat: data.heartbeat,
            autoSwitchEnabled: data.autoSwitchEnabled !== false,
            autoSwitchTarget: data.autoSwitchTarget || 'total'
          };
          setState(nextState);
          getVsCodeApi().setState(nextState);
        }
      } catch (err) {
        console.error('[Antigravity Swap] handleMessage error:', err);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleToggleAutoSwitch = (enabled: boolean) => {
    setState((prev) => ({ ...prev, autoSwitchEnabled: enabled }));
  };

  const handleSelectAutoSwitchTarget = (target: any) => {
    setState((prev) => ({ ...prev, autoSwitchTarget: target }));
    getVsCodeApi().postMessage({ command: 'setAutoSwitchTarget', target });
  };

  const selectedAcc =
    state.accounts.find((a) => a.email === selectedEmail) || state.activeAccount || state.accounts[0] || null;

  return (
    <div className="flex flex-col min-h-screen max-w-7xl mx-auto">
      {/* Header Section */}
      <Header overall={state.overall} accounts={state.accounts} />

      {/* Controller Action Bar */}
      <ControllerBar
        autoSwitchEnabled={state.autoSwitchEnabled ?? false}
        onToggleAutoSwitch={handleToggleAutoSwitch}
        autoSwitchTarget={state.autoSwitchTarget ?? 'total'}
        onSelectAutoSwitchTarget={handleSelectAutoSwitchTarget}
      />

      {/* Main Content Area: Responsive side-by-side on wide screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-[1.1fr_1fr] 2xl:grid-cols-[1.15fr_1fr] gap-4 items-start">
        {/* Accounts & Fast Switch Section */}
        <div className="min-w-0">
          <AccountList
            accounts={state.accounts}
            activeAccount={state.activeAccount}
            selectedEmail={selectedEmail}
            onSelectAccount={setSelectedEmail}
          />
        </div>

        {/* Model Quotas Section (Sticky on wide screens) */}
        <div className="min-w-0 lg:sticky lg:top-2">
          <ModelQuotas
            selectedAccount={selectedAcc}
            activeAccount={state.activeAccount}
          />
        </div>
      </div>
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <>
      <AppContent />
      <Toaster />
    </>
  );
};
