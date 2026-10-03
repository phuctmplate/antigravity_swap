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
        <Card className="bg-card/50 border-border/80">
          <CardContent className="flex flex-col items-center justify-center gap-1.5 p-4 text-center text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5 text-amber-400 font-medium">
              <RotateCw className="w-3.5 h-3.5 animate-spin" />
              <span>Unable to load live models from Google API.</span>
            </div>
            <span>Extension will automatically retry fetching in background. You can also click <b>Refresh Quotas</b> to poll now.</span>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {['Gemini Models', 'Claude and GPT models'].map((groupTitle) => {
            const isGem = groupTitle.includes('Gemini');
            const groupModels = filteredQuotas.filter((q) => {
              const gName = (q.groupName || '').toLowerCase();
              if (isGem) {
                return gName.includes('gemini') || q.displayName.toLowerCase().includes('gemini') || q.displayName.toLowerCase().includes('flash');
              } else {
                return gName.includes('claude') || gName.includes('gpt') || q.displayName.toLowerCase().includes('claude') || q.displayName.toLowerCase().includes('gpt');
              }
            });

            if (groupModels.length === 0) return null;

            return (
              <div key={groupTitle} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-foreground">
                  <span className={`w-2 h-2 rounded-full ${isGem ? 'bg-blue-500' : 'bg-amber-500'}`} />
                  <span>{groupTitle}</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
                  {groupModels.map((q, idx) => {
                    const isPlaceholder = q.percentage === -1;
                    const pct = isPlaceholder ? 100 : Math.max(0, Math.min(100, q.percentage || 0));

                    return (
                      <Card
                        key={`${q.id || quotaLabel(q)}-${idx}`}
                        className="bg-card/70 border-border/80 hover:border-border transition-colors"
                      >
                        <CardContent className="flex flex-col p-2.5">
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <span className="font-semibold text-xs text-foreground truncate" title={quotaLabel(q)}>{quotaLabel(q)}</span>
                            <span className={`text-[10px] font-bold shrink-0 ${q.disabled ? 'text-muted-foreground' : isPlaceholder ? 'text-muted-foreground' : getTextColor(pct)}`}>
                              {q.disabled ? 'Disabled' : isPlaceholder ? 'Free Tier' : `${pct}%`}
                            </span>
                          </div>

                          {/* Progress bar */}
                          <Progress
                            value={q.disabled ? 0 : pct}
                            indicatorClassName={q.disabled ? 'bg-muted-foreground/30' : isPlaceholder ? 'bg-primary/50' : getFillClass(pct)}
                            className="h-1.5 mb-1.5"
                          />

                          {/* Footer metadata: remaining & window type */}
                          <div className="flex items-center justify-between text-[9px] text-muted-foreground gap-1">
                            <span className="truncate">{q.windowLabel || q.windowType}</span>
                            {q.disabled ? (
                              <span className="text-amber-400 font-medium shrink-0">Limit reached</span>
                            ) : q.resetCountdown ? (
                              <span className="text-muted-foreground/80 shrink-0">Resets {q.resetCountdown}</span>
                            ) : null}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
