import React, { useState } from 'react';
import { Account, ModelQuota } from '../types';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { Progress } from './ui/progress';
import { Search, ShieldAlert, AlertTriangle, Gauge, RotateCw } from 'lucide-react';
import { quotaFillClass, quotaTextClass, parseCountdownFromDescription } from '../lib/quota';

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
  const isFree = !targetAcc.tierBadge || targetAcc.tierBadge === 'STANDARD FREE';
  const isPro = targetAcc.tierBadge === 'PRO' || targetAcc.tierBadge === 'AI PREMIUM';
  const isUltra = targetAcc.tierBadge === 'ULTRA' || targetAcc.tierBadge === 'ENTERPRISE';

  const isArgonModel = (q: { id?: string; displayName?: string; groupName?: string }) => {
    const s = ((q.id || '') + ' ' + (q.displayName || '') + ' ' + (q.groupName || '')).toLowerCase();
    return s.includes('argon');
  };

  // Build effective model list with tier-aware Argon handling:
  // - Free tier: Argon is never available
  // - Pro tier: Argon is in its own dedicated weekly-only bucket ('Argon Models')
  // - Ultra tier: Argon is merged into 'Gemini Models'
  const rawQuotas = (targetAcc.quotas || []).filter((q) => !(isFree && isArgonModel(q)));
  const quotas: ModelQuota[] = [...rawQuotas];

  if (!isFree && quotas.length > 0 && !quotas.some((q) => isArgonModel(q))) {
    if (isPro && targetAcc.argonGroup?.weekly) {
      const argonWk = targetAcc.argonGroup.weekly;
      quotas.push({
        id: 'gemini-4-argon',
        displayName: 'Gemini 4 Argon',
        groupName: 'Argon Models',
        description: argonWk.description || 'Dedicated weekly quota bucket for Argon on Pro plan',
        remainingFraction: argonWk.remainingFraction,
        percentage: argonWk.percentage,
        resetTime: argonWk.resetTime,
        resetCountdown: argonWk.resetCountdown,
        windowType: 'weekly',
        windowLabel: 'Weekly Quota',
        disabled: argonWk.disabled ?? false
      });
    } else if (isUltra) {
      const gemWk = targetAcc.geminiGroup?.weekly || targetAcc.geminiGroup?.fiveHour;
      quotas.unshift({
        id: 'gemini-4-argon',
        displayName: 'Gemini 4 Argon',
        groupName: 'Gemini Models',
        description: gemWk?.description || 'Merged into Gemini Models bucket on Ultra plan',
        remainingFraction: gemWk ? gemWk.remainingFraction : 1.0,
        percentage: gemWk ? gemWk.percentage : 100,
        resetTime: gemWk?.resetTime,
        resetCountdown: gemWk?.resetCountdown,
        windowType: 'weekly',
        windowLabel: 'Weekly Quota',
        disabled: gemWk?.disabled ?? false
      });
    }
  }

  const quotaLabel = (q: { displayName?: string; id?: string }) => q.displayName || q.id || 'Unknown model';

  const filteredQuotas = quotas.filter((q) =>
    quotaLabel(q).toLowerCase().includes(filterText.toLowerCase())
  );

  const getFillClass = quotaFillClass;
  const getTextColor = quotaTextClass;

  const isSelectedActive = activeAccount && selectedAccount && activeAccount.email === selectedAccount.email;

  const groupTitles = isPro
    ? ['Gemini Models', 'Claude and GPT models', 'Argon Models']
    : ['Gemini Models', 'Claude and GPT models'];

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
          {groupTitles.map((groupTitle) => {
            const isGem = groupTitle === 'Gemini Models';
            const isArgonGroup = groupTitle === 'Argon Models';
            const groupModels = filteredQuotas.filter((q) => {
              const gName = (q.groupName || '').toLowerCase();
              const qIsArgon = isArgonModel(q);
              if (isArgonGroup) {
                return qIsArgon;
              }
              if (isGem) {
                if (isPro && qIsArgon) return false;
                return (
                  (isUltra && qIsArgon) ||
                  gName.includes('gemini') ||
                  q.displayName.toLowerCase().includes('gemini') ||
                  q.displayName.toLowerCase().includes('flash')
                );
              }
              return (
                !qIsArgon &&
                (gName.includes('claude') ||
                  gName.includes('gpt') ||
                  q.displayName.toLowerCase().includes('claude') ||
                  q.displayName.toLowerCase().includes('gpt'))
              );
            });

            if (groupModels.length === 0) return null;

            const dotClass = isArgonGroup
              ? 'bg-violet-500'
              : isGem
                ? 'bg-blue-500'
                : 'bg-amber-500';

            return (
              <div key={groupTitle} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs font-bold text-foreground">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${dotClass}`} />
                    <span>{groupTitle}</span>
                  </div>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
                  {groupModels.map((q, idx) => {
                    const isPlaceholder = q.percentage === -1;
                    const pct = isPlaceholder ? 100 : Math.max(0, Math.min(100, q.percentage || 0));
                    const effectiveWindowLabel = (isPro && isArgonModel(q))
                      ? 'Weekly Quota'
                      : (q.windowLabel || q.windowType);

                    return (
                      <Card
                        key={`${q.id || quotaLabel(q)}-${idx}`}
                        className="bg-card/70 border-border/80 hover:border-border transition-colors"
                      >
                        <CardContent className="flex flex-col p-2.5">
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <span className="font-semibold text-xs text-foreground truncate" title={quotaLabel(q)}>{quotaLabel(q)}</span>
                            <span className={`text-[10px] font-bold shrink-0 ${q.disabled ? 'text-muted-foreground' : isPlaceholder ? 'text-muted-foreground' : q.percentage != null ? getTextColor(pct) : 'text-muted-foreground'}`}>
                              {q.disabled ? 'Disabled' : isPlaceholder ? 'Free Tier' : q.percentage != null ? `${pct}%` : '-%'}
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
                            <span className="truncate">{effectiveWindowLabel}</span>
                            {q.disabled ? (
                              <span className="text-amber-400 font-medium shrink-0">Limit reached</span>
                            ) : (q.resetCountdown || (q.windowType === '5h' ? parseCountdownFromDescription(q.description) : (/\b\d+\s*d\b/i.test(parseCountdownFromDescription(q.description) || '') ? parseCountdownFromDescription(q.description) : undefined))) ? (
                              <span className="text-muted-foreground/80 shrink-0">Resets {q.resetCountdown || parseCountdownFromDescription(q.description)}</span>
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
