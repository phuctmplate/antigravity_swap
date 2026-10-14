import React from 'react';
import { OverallQuotaSummary, Account } from '../types';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { Progress, DashedProgress } from './ui/progress';
import { Clock, Calendar, Users, ShieldCheck, Sparkles, Zap, HelpCircle } from 'lucide-react';
import { quotaFillClass, quotaTextClass, quotaStrokeColor, calculateModulatedInstantQuota, SAFE_WEEKLY_THRESHOLDS } from '../lib/quota';
import { LogoIcon } from './LogoIcon';
import { InstantConceptModal } from './InstantConceptModal';

interface HeaderProps {
  overall: OverallQuotaSummary;
  accounts: Account[];
}

export const Header: React.FC<HeaderProps> = ({ overall, accounts }) => {
  const instantPct = overall.instantPercentage ?? 0;
  const overallPct = overall.overallPercentage ?? 0;
  // Half-circle gauge metrics (180deg dome arc)
  const arcRadius = 42;
  const arcLength = Math.PI * arcRadius; // ~131.947
  const instantClamped = Math.min(100, Math.max(0, instantPct));
  const overallClamped = Math.min(100, Math.max(0, overallPct));
  const instantArcOffset = arcLength * (1 - instantClamped / 100);
  const overallArcOffset = arcLength * (1 - overallClamped / 100);

  const healthyCount = accounts.filter(
    (a) => !a.isBanned && a.status !== 'banned' && a.status !== 'auth_failed'
  ).length;

  const getGaugeColor = quotaStrokeColor;
  const getTextColor = quotaTextClass;
  const getProgressIndicator = quotaFillClass;

  const gemini5h = overall.gemini5HourPercentage;
  const geminiWk = overall.geminiWeeklyPercentage;
  const claude5h = overall.claude5HourPercentage;
  const claudeWk = overall.claudeWeeklyPercentage;
  const hasPro = (overall.proAccountsCount || 0) > 0;

  const geminiInstant =
    overall.geminiInstantPercentage ??
    (hasPro && gemini5h != null && geminiWk != null
      ? calculateModulatedInstantQuota(gemini5h, geminiWk, SAFE_WEEKLY_THRESHOLDS.GEMINI)
      : hasPro && gemini5h != null
        ? gemini5h
        : geminiWk);

  const claudeInstant =
    overall.claudeInstantPercentage ??
    (hasPro && claude5h != null && claudeWk != null
      ? calculateModulatedInstantQuota(claude5h, claudeWk, SAFE_WEEKLY_THRESHOLDS.CLAUDE_GPT)
      : hasPro && claude5h != null
        ? claude5h
        : claudeWk);

  return (
    <div className="flex flex-col gap-2.5 mb-3">
      {/* Title Header */}
      <div className="flex items-center justify-between px-0.5 py-0.5 min-h-6">
        <div className="flex items-center gap-2">
          <LogoIcon className="w-5 h-5 shrink-0 drop-shadow-sm" />
          <span className="font-bold text-sm tracking-tight text-foreground leading-none">
            Antigravity Swap
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <InstantConceptModal>
            <button
              type="button"
              className="flex items-center justify-center h-5 w-5 rounded-full text-muted-foreground/80 hover:text-foreground hover:bg-accent/60 transition-colors cursor-pointer"
              title="Learn about Instant Quota concept"
              aria-label="Instant Quota explanation"
            >
              <HelpCircle className="w-3.5 h-3.5" />
            </button>
          </InstantConceptModal>
          <Badge
            variant="outline"
            className="text-[10px] text-muted-foreground/80 font-mono border-border/60 py-0 px-1.5 h-5 leading-none inline-flex items-center justify-center"
          >
            v1.3.1
          </Badge>
        </div>
      </div>

      {/* Hero Overview Card with Twin Circular Gauges */}
      <Card className="relative overflow-hidden border-border/80 bg-card/70 shadow-sm">
        <CardContent className="flex flex-col gap-2.5 p-3">
          {/* Twin SVG Half-Circle Gauges Container - Width-constrained for consistent spacing that fluidly scales on smaller viewports */}
          <div className="flex items-center justify-between max-w-[300px] mx-auto w-full px-2 py-1">
            {/* 1. Instant Quota Gauge */}
            <div
              className="flex flex-col items-center cursor-help"
              title={`All Accounts Instant Quota (${instantPct}%): Usable pooled quota in the current session across all accounts (5-Hour rolling window, modulated by remaining weekly capacity).`}
            >
              <div className="relative flex h-[58px] w-[104px] shrink-0 items-center justify-center">
                <svg className="h-full w-full" viewBox="0 0 104 58" aria-hidden="true">
                  <path
                    d="M 10 50 A 42 42 0 0 1 94 50"
                    fill="none"
                    stroke="currentColor"
                    className="text-black/10 dark:text-white/15"
                    strokeWidth="7"
                    strokeLinecap="round"
                  />
                  <path
                    d="M 10 50 A 42 42 0 0 1 94 50"
                    fill="none"
                    stroke={getGaugeColor(instantPct)}
                    strokeWidth="7"
                    strokeLinecap="round"
                    strokeDasharray={arcLength}
                    strokeDashoffset={instantArcOffset}
                    style={{
                      transition: 'stroke-dashoffset 0.6s ease, opacity 0.3s ease',
                      opacity: instantClamped > 0 ? 1 : 0,
                    }}
                  />
                </svg>
                <div className="absolute inset-x-0 bottom-0.5 flex items-center justify-center pointer-events-none">
                  <span className="text-lg font-bold text-foreground tracking-tight leading-none">
                    {instantPct}%
                  </span>
                </div>
              </div>
              <div className="flex flex-col items-center text-center gap-0.5 mt-1">
                <span className="text-xs font-bold text-foreground tracking-tight">Pool Instant Quota</span>
                <span className="text-[10px] text-muted-foreground font-medium whitespace-nowrap">All Accounts Pool</span>
              </div>
            </div>

            {/* Subtle Divider */}
            <div className="h-12 w-px bg-border/70 shrink-0 self-center mx-1" />

            {/* 2. Total Quota Gauge */}
            <div
              className="flex flex-col items-center cursor-help"
              title={`All Accounts Total Quota (${overallPct}%): Total weekly plan capacity across all healthy accounts.`}
            >
              <div className="relative flex h-[58px] w-[104px] shrink-0 items-center justify-center">
                <svg className="h-full w-full" viewBox="0 0 104 58" aria-hidden="true">
                  <path
                    d="M 10 50 A 42 42 0 0 1 94 50"
                    fill="none"
                    stroke="currentColor"
                    className="text-black/10 dark:text-white/15"
                    strokeWidth="7"
                    strokeLinecap="round"
                  />
                  <path
                    d="M 10 50 A 42 42 0 0 1 94 50"
                    fill="none"
                    stroke={getGaugeColor(overallPct)}
                    strokeWidth="7"
                    strokeLinecap="round"
                    strokeDasharray={arcLength}
                    strokeDashoffset={overallArcOffset}
                    style={{
                      transition: 'stroke-dashoffset 0.6s ease, opacity 0.3s ease',
                      opacity: overallClamped > 0 ? 1 : 0,
                    }}
                  />
                </svg>
                <div className="absolute inset-x-0 bottom-0.5 flex items-center justify-center pointer-events-none">
                  <span className="text-lg font-bold text-foreground tracking-tight leading-none">
                    {overallPct}%
                  </span>
                </div>
              </div>
              <div className="flex flex-col items-center text-center gap-0.5 mt-1">
                <span className="text-xs font-bold text-foreground tracking-tight">Pool Total Quota</span>
                <span className="text-[10px] text-muted-foreground font-medium whitespace-nowrap">Total Weekly Capacity</span>
              </div>
            </div>
          </div>

          {/* Hero Meta Info & Status Pills */}
          <div className="flex items-center justify-center flex-wrap gap-1.5 pt-2 border-t border-border/60">
            <Badge variant="secondary" className="gap-1 text-[10px] py-0.5 px-2">
              <Users className="w-3 h-3 text-muted-foreground" />
              <span>{accounts.length} Account{accounts.length !== 1 ? 's' : ''}</span>
            </Badge>
            <Badge variant="success" className="gap-1 text-[10px] py-0.5 px-2">
              <ShieldCheck className="w-3 h-3" />
              <span>{healthyCount} Healthy</span>
            </Badge>
            {hasPro && (
              <Badge variant="pro" className="gap-1 text-[10px] py-0.5 px-2">
                <Sparkles className="w-3 h-3 text-purple-700 dark:text-purple-300" />
                <span>{overall.proAccountsCount} Pro</span>
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Separated Gemini and Claude & GPT Overall Cards */}
      <div className="grid grid-cols-2 gap-2">
        {/* Gemini Models Card */}
        <Card className="bg-card/70 border-border/80">
          <CardContent className="flex flex-col gap-1.5 p-2.5">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold text-foreground flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                <span>Gemini</span>
              </div>
            </div>

            {/* Instant Usable Quota */}
            <div
              className="flex flex-col gap-0.5 cursor-help"
              title={`Gemini Instant Quota (${geminiInstant != null ? `${geminiInstant}%` : '—'}): Usable quota available right now, calculated from the 5h rolling window modulated by weekly capacity.`}
            >
              <div className="flex justify-between items-center text-[9px]">
                <span className="flex items-center gap-1 min-w-0">
                  <Zap className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                  <span className="text-foreground/90 font-medium">Instant</span>
                </span>
                <span className={`font-bold font-mono ${geminiInstant != null ? getTextColor(geminiInstant) : 'text-muted-foreground'}`}>
                  {geminiInstant != null ? `${geminiInstant}%` : '—'}
                </span>
              </div>
              <Progress
                value={geminiInstant ?? 0}
                indicatorClassName={geminiInstant != null ? getProgressIndicator(geminiInstant) : 'bg-muted'}
                className="h-1.5 w-full"
              />
            </div>

            {/* Gemini Sub-Windows Breakdown */}
            {hasPro && gemini5h != null ? (
              <div className="flex flex-col gap-1.5 pt-1.5 border-t border-border/30 mt-0.5">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between text-[9px] text-muted-foreground" title={`5h: ${gemini5h}%`}>
                    <span className="flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                      <span className="font-medium text-foreground/80">5h</span>
                    </span>
                    <span className={`font-bold font-mono ${getTextColor(gemini5h)}`}>
                      {gemini5h}%
                    </span>
                  </div>
                  <DashedProgress
                    value={gemini5h}
                    indicatorClassName={getProgressIndicator(gemini5h)}
                    className="h-1.5 w-full"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between text-[9px] text-muted-foreground" title={`Weekly: ${geminiWk != null ? geminiWk + '%' : '—'}`}>
                    <span className="flex items-center gap-1">
                      <Calendar className="w-2.5 h-2.5 text-purple-400 shrink-0" />
                      <span className="font-medium text-foreground/80">Weekly</span>
                    </span>
                    <span className={`font-bold font-mono ${geminiWk != null ? getTextColor(geminiWk) : 'text-muted-foreground'}`}>
                      {geminiWk != null ? `${geminiWk}%` : '—'}
                    </span>
                  </div>
                  <DashedProgress
                    value={geminiWk ?? 0}
                    indicatorClassName={geminiWk != null ? getProgressIndicator(geminiWk) : 'bg-muted'}
                    className="h-1.5 w-full"
                  />
                </div>
              </div>
            ) : (
              /* Weekly Plan Quota */
              <div className="flex flex-col gap-0.5 pt-1 border-t border-border/30 mt-0.5">
                <div className="flex items-center justify-between text-[9px] text-muted-foreground" title={`Weekly: ${geminiWk != null ? geminiWk + '%' : '—'}`}>
                  <span className="flex items-center gap-1">
                    <Calendar className="w-2.5 h-2.5 text-purple-400 shrink-0" />
                    <span className="font-medium text-foreground/80">Weekly</span>
                  </span>
                  <span className={`font-bold font-mono ${geminiWk != null ? getTextColor(geminiWk) : 'text-muted-foreground'}`}>
                    {geminiWk != null ? `${geminiWk}%` : '—'}
                  </span>
                </div>
                <DashedProgress
                  value={geminiWk ?? 0}
                  indicatorClassName={geminiWk != null ? getProgressIndicator(geminiWk) : 'bg-muted'}
                  className="h-1.5 w-full"
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Claude & GPT Models Card */}
        <Card className="bg-card/70 border-border/80">
          <CardContent className="flex flex-col gap-1.5 p-2.5">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-bold text-foreground flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                <span>Claude & GPT</span>
              </div>
            </div>

            {/* Instant Usable Quota */}
            <div
              className="flex flex-col gap-0.5 cursor-help"
              title={`Claude & GPT Instant Quota (${claudeInstant != null ? `${claudeInstant}%` : '—'}): Usable quota available right now, calculated from the 5h rolling window modulated by weekly capacity.`}
            >
              <div className="flex justify-between items-center text-[9px]">
                <span className="flex items-center gap-1 min-w-0">
                  <Zap className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                  <span className="text-foreground/90 font-medium">Instant</span>
                </span>
                <span className={`font-bold font-mono ${claudeInstant != null ? getTextColor(claudeInstant) : 'text-muted-foreground'}`}>
                  {claudeInstant != null ? `${claudeInstant}%` : '—'}
                </span>
              </div>
              <Progress
                value={claudeInstant ?? 0}
                indicatorClassName={claudeInstant != null ? getProgressIndicator(claudeInstant) : 'bg-muted'}
                className="h-1.5 w-full"
              />
            </div>

            {/* Claude Sub-Windows Breakdown */}
            {hasPro && claude5h != null ? (
              <div className="flex flex-col gap-1.5 pt-1.5 border-t border-border/30 mt-0.5">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between text-[9px] text-muted-foreground" title={`5h: ${claude5h}%`}>
                    <span className="flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5 text-sky-400 shrink-0" />
                      <span className="font-medium text-foreground/80">5h</span>
                    </span>
                    <span className={`font-bold font-mono ${getTextColor(claude5h)}`}>
                      {claude5h}%
                    </span>
                  </div>
                  <DashedProgress
                    value={claude5h}
                    indicatorClassName={getProgressIndicator(claude5h)}
                    className="h-1.5 w-full"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center justify-between text-[9px] text-muted-foreground" title={`Weekly: ${claudeWk != null ? claudeWk + '%' : '—'}`}>
                    <span className="flex items-center gap-1">
                      <Calendar className="w-2.5 h-2.5 text-purple-400 shrink-0" />
                      <span className="font-medium text-foreground/80">Weekly</span>
                    </span>
                    <span className={`font-bold font-mono ${claudeWk != null ? getTextColor(claudeWk) : 'text-muted-foreground'}`}>
                      {claudeWk != null ? `${claudeWk}%` : '—'}
                    </span>
                  </div>
                  <DashedProgress
                    value={claudeWk ?? 0}
                    indicatorClassName={claudeWk != null ? getProgressIndicator(claudeWk) : 'bg-muted'}
                    className="h-1.5 w-full"
                  />
                </div>
              </div>
            ) : (
              /* Weekly Plan Quota */
              <div className="flex flex-col gap-0.5 pt-1 border-t border-border/30 mt-0.5">
                <div className="flex items-center justify-between text-[9px] text-muted-foreground" title={`Weekly: ${claudeWk != null ? claudeWk + '%' : '—'}`}>
                  <span className="flex items-center gap-1">
                    <Calendar className="w-2.5 h-2.5 text-purple-400" />
                    <span className="font-medium text-foreground/80">Weekly</span>
                  </span>
                  <span className={`font-bold font-mono ${claudeWk != null ? getTextColor(claudeWk) : 'text-muted-foreground'}`}>
                    {claudeWk != null ? `${claudeWk}%` : '—'}
                  </span>
                </div>
                <DashedProgress
                  value={claudeWk ?? 0}
                  indicatorClassName={claudeWk != null ? getProgressIndicator(claudeWk) : 'bg-muted'}
                  className="h-1.5 w-full"
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
