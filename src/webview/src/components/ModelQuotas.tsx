import React, { useState } from 'react';
import { Account } from '../types';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import { Search, ShieldAlert, AlertTriangle, Gauge, RotateCw } from 'lucide-react';
import { quotaFillClass, quotaTextClass } from '../lib/quota';

interface ModelQuotasProps {
  selectedAccount: Account | null;
  activeAccount: Account | null;
}

export const ModelQuotas: React.FC<ModelQuotasProps> = ({
  selectedAccount,
  activeAccount
}) => {
  const [filterText, setFilterText] = useState('');

  const targetAcc = selectedAccount || activeAccount;

  if (!targetAcc) {
    return null;
  }

  const isBanned = targetAcc.isBanned || targetAcc.status === 'banned';
  const isAuthFailed = targetAcc.status === 'auth_failed';
  const quotas = targetAcc.quotas || [];

  const quotaLabel = (q: { displayName?: string; id?: string }) => q.displayName || q.id || 'Unknown model';

  const filteredQuotas = quotas.filter((q) =>
    quotaLabel(q).toLowerCase().includes(filterText.toLowerCase())
  );

  const getFillClass = quotaFillClass;
  const getTextColor = quotaTextClass;

  const isSelectedActive = activeAccount && selectedAccount && activeAccount.email === selectedAccount.email;

  return (
    <div className="flex flex-col gap-2">
      {/* Section Header with Search Input */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <Gauge className="w-3.5 h-3.5 text-muted-foreground" />
          <span>Model Quotas</span>
          <span className="text-[10px] font-semibold text-foreground/80 normal-case">
            ({targetAcc.email} {isSelectedActive ? '• Active' : ''})
          </span>
        </div>

        {quotas.length > 4 && (
          <div className="relative w-36">
            <Search className="absolute left-2 top-1.5 w-3 h-3 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search model..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="h-6 pl-6 text-[10px]"
            />
          </div>
        )}
      </div>

      {/* Models List or Status Banners */}
      {isBanned ? (
        <Card className="border-destructive/40 bg-destructive/10">
          <CardContent className="flex items-center justify-center gap-2 p-4 text-center text-xs font-medium text-destructive">
            <ShieldAlert className="w-4 h-4" />
            <span>Quota metrics unavailable because this account is suspended or disabled by Google Terms of Service.</span>
          </CardContent>
        </Card>
      ) : isAuthFailed ? (
        <Card className="border-amber-500/40 bg-amber-500/10">
          <CardContent className="flex items-center justify-center gap-2 p-4 text-center text-xs font-medium text-amber-300">
            <AlertTriangle className="w-4 h-4" />
            <span>Authentication expired for this account. Click <b>Re-login</b> on the account card above to refresh quota balances.</span>
          </CardContent>
        </Card>
      ) : quotas.length === 0 ? (
        <Card className="bg-card/50">
          <CardContent className="p-4 text-center text-xs text-muted-foreground">
            No quota data found for this account. Click <b className="inline-flex items-center gap-0.5"><RotateCw className="w-3 h-3" />Refresh Quotas</b> to poll balances.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
          {filteredQuotas.map((q, idx) => {
            const isUnlimited = q.percentage === -1;
            const pct = isUnlimited ? 100 : Math.max(0, Math.min(100, q.percentage || 0));

            return (
              <Card
                key={`${q.id || quotaLabel(q)}-${idx}`}
                className="bg-card/70 border-transparent hover:bg-card transition-colors"
              >
                <CardContent className="flex flex-col p-2.5">
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <span className="font-semibold text-xs text-foreground truncate">{quotaLabel(q)}</span>
                    <span className={`text-[10px] font-bold ${isUnlimited ? 'text-sky-400' : getTextColor(pct)}`}>
                      {isUnlimited ? 'Unlimited' : `${pct}%`}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <Progress
                    value={pct}
                    indicatorClassName={isUnlimited ? 'bg-sky-500' : getFillClass(pct)}
                    className="h-1.5 mb-1.5"
                  />

                  {/* Footer metadata: remaining & window type */}
                  <div className="flex items-center justify-between text-[9px] text-muted-foreground">
                    <span>{q.windowLabel || q.windowType}</span>
                    {q.resetCountdown && <span className="text-muted-foreground/80">Resets {q.resetCountdown}</span>}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
};
