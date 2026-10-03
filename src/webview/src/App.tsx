import React, { useState, useEffect, useRef } from 'react';
import { WebviewState } from './types';
import { Header } from './components/Header';
import { ControllerBar } from './components/ControllerBar';
import { AccountList } from './components/AccountList';
import { ModelQuotas } from './components/ModelQuotas';
import { getVsCodeApi } from './vscode';

export const App: React.FC = () => {
  const [state, setState] = useState<WebviewState>({
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
    autoSwitchEnabled: false
  });

  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  // Use a ref so the message handler always sees the latest selectedEmail
  // without needing to be in the useEffect dependency array (which caused
  // the listener to detach/reattach on every account selection).
  const selectedEmailRef = useRef<string | null>(null);
  selectedEmailRef.current = selectedEmail;

  useEffect(() => {
    // Notify extension host that webview is ready
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
          setState({
            accounts,
            activeAccount,
            overall: data.overall,
            heartbeat: data.heartbeat,
            autoSwitchEnabled: data.autoSwitchEnabled !== false
          });
        }
      } catch (err) {
        console.error('[Antigravity Swap] handleMessage error:', err);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []); // stable — no deps needed thanks to ref

  const handleToggleAutoSwitch = (enabled: boolean) => {
    setState((prev) => ({ ...prev, autoSwitchEnabled: enabled }));
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
      />

      {/* Accounts & Fast Switch Section */}
      <AccountList
        accounts={state.accounts}
        activeAccount={state.activeAccount}
        selectedEmail={selectedEmail}
        onSelectAccount={setSelectedEmail}
      />

      {/* Model Quotas Section */}
      <ModelQuotas
        selectedAccount={selectedAcc}
        activeAccount={state.activeAccount}
      />
    </div>
  );
};
