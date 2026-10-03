import React from 'react';
import { Account } from '../types';
import { AccountCard } from './AccountCard';
import { getVsCodeApi } from '../vscode';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Plus, Zap, LogIn } from 'lucide-react';

interface AccountListProps {
  accounts: Account[];
  activeAccount: Account | null;
  selectedEmail: string | null;
  onSelectAccount: (email: string) => void;
}

export const AccountList: React.FC<AccountListProps> = ({
  accounts,
  activeAccount,
  selectedEmail,
  onSelectAccount
}) => {
  const vscode = getVsCodeApi();

  const handleAddManual = () => {
    vscode.postMessage({ command: 'addManual' });
  };

  const handleImport = () => {
    vscode.postMessage({ command: 'importCurrentAntigravity' });
  };

  const handleSignIn = () => {
    vscode.postMessage({ command: 'addOAuth' });
  };

  return (
    <div className="flex flex-col gap-2 mb-3">
      {/* Section Header */}
      <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        <span>Accounts & Fast Switch</span>
        <Button
          onClick={handleAddManual}
          size="xs"
          variant="outline"
          title="Add account via token"
        >
          <Plus className="w-3 h-3" />
          <span>Manual</span>
        </Button>
      </div>

      {/* Account Grid */}
      {accounts.length === 0 ? (
        <Card className="border-dashed bg-card/40">
          <CardContent className="flex flex-col items-center justify-center p-6 text-center">
            <Zap className="w-8 h-8 text-primary mb-2" />
            <div className="text-xs text-foreground font-medium mb-3">
              No accounts connected. Import from current Antigravity or sign in!
            </div>
            <div className="flex flex-col gap-2">
              <Button
                onClick={handleImport}
                size="sm"
                variant="default"
              >
                <Zap className="w-3.5 h-3.5 fill-current" />
                <span>Import</span>
              </Button>
              <Button
                onClick={handleSignIn}
                size="sm"
                variant="secondary"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>Google Sign In</span>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
          {accounts.map((acc) => (
            <AccountCard
              key={acc.email}
              account={acc}
              isActive={!!activeAccount && activeAccount.email === acc.email}
              isSelected={selectedEmail === acc.email}
              onSelect={onSelectAccount}
            />
          ))}
        </div>
      )}
    </div>
  );
};
