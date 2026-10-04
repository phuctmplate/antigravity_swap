import React, { useState, useRef } from 'react';
import { Account } from '../types';
import { AccountCard } from './AccountCard';
import { getVsCodeApi } from '../vscode';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Badge } from './ui/badge';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './Toast';
import {
  Zap,
  LogIn,
  Plus,
  Filter,
  CheckSquare,
  Square,
  RotateCw,
  Trash2,
  X,
  ChevronsLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  ArrowUpDown
} from 'lucide-react';
import { cn } from '../lib/utils';

interface AccountListProps {
  accounts: Account[];
  activeAccount: Account | null;
  selectedEmail: string | null;
  onSelectAccount: (email: string) => void;
}

const REFRESH_COOLDOWN_MS = 10000;

export const AccountList: React.FC<AccountListProps> = ({
  accounts,
  activeAccount,
  selectedEmail,
  onSelectAccount
}) => {
  const [filterType, setFilterType] = useState<string>('all');
  const [sortMode, setSortMode] = useState<'tier' | 'tier-asc' | 'name-asc' | 'name-desc'>('tier');
  const [pageSize, setPageSize] = useState<number>(10);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [checkedEmails, setCheckedEmails] = useState<Set<string>>(new Set());
  const [refreshingEmails, setRefreshingEmails] = useState<Set<string>>(new Set());
  const [isBulkRefreshing, setIsBulkRefreshing] = useState(false);

  // Dialog state
  const [deleteDialog, setDeleteDialog] = useState<{
    isOpen: boolean;
    emails: string[];
  }>({
    isOpen: false,
    emails: []
  });

  const lastRefreshMap = useRef<Map<string, number>>(new Map());
  const vscode = getVsCodeApi();
  const { showToast } = useToast();

  const handleImport = () => {
    vscode.postMessage({ command: 'importCurrentAntigravity' });
  };

  const handleSignIn = () => {
    vscode.postMessage({ command: 'addOAuth' });
  };

  const getAccountCategory = (acc: Account): string => {
    const badge = (acc.tierBadge || '').toUpperCase();
    const type = (acc.accountType || '').toLowerCase();
    if (badge === 'ENTERPRISE' || type.includes('enterprise')) return 'enterprise';
    if (badge === 'ULTRA' || type.includes('ultra')) return 'ultra';
    if (badge === 'AI PREMIUM' || type.includes('premium')) return 'premium';
    if (badge === 'PRO' || type.includes('pro')) return 'pro';
    return 'free';
  };

  const counts = {
    all: accounts.length,
    free: accounts.filter((a) => getAccountCategory(a) === 'free').length,
    pro: accounts.filter((a) => getAccountCategory(a) === 'pro').length,
    ultra: accounts.filter((a) => getAccountCategory(a) === 'ultra').length,
    premium: accounts.filter((a) => getAccountCategory(a) === 'premium').length,
    enterprise: accounts.filter((a) => getAccountCategory(a) === 'enterprise').length
  };

  const filterBadges = [
    { id: 'all', label: 'All', count: counts.all, activeClass: 'bg-primary text-primary-foreground border-primary' },
    { id: 'free', label: 'Free', count: counts.free, activeClass: 'bg-slate-700 text-slate-100 border-slate-500 dark:bg-slate-700 dark:text-slate-100' },
    { id: 'pro', label: 'Pro', count: counts.pro, activeClass: 'bg-purple-600/90 text-white border-purple-400' },
    { id: 'ultra', label: 'Ultra', count: counts.ultra, activeClass: 'bg-fuchsia-600/90 text-white border-fuchsia-400' },
    { id: 'premium', label: 'AI Premium', count: counts.premium, activeClass: 'bg-sky-600/90 text-white border-sky-400' },
    { id: 'enterprise', label: 'Enterprise', count: counts.enterprise, activeClass: 'bg-emerald-600/90 text-white border-emerald-400' }
  ].filter((b) => b.id === 'all' || b.id === 'free' || b.id === 'pro' || b.id === 'ultra' || b.count > 0);

  const getTierRank = (acc: Account): number => {
    const badge = (acc.tierBadge || '').toUpperCase();
    const type = (acc.accountType || '').toLowerCase();
    if (badge === 'ENTERPRISE' || type.includes('enterprise')) return 1;
    if (badge === 'ULTRA' || type.includes('ultra')) return 2;
    if (badge === 'AI PREMIUM' || type.includes('premium')) return 3;
    if (badge === 'PRO' || type.includes('pro')) return 4;
    return 5; // Free
  };

  const filteredAccounts = accounts.filter((acc) => {
    if (filterType === 'all') return true;
    return getAccountCategory(acc) === filterType;
  });

  const sortedAccounts = [...filteredAccounts].sort((a, b) => {
    if (sortMode === 'name-asc') {
      const nameA = a.name || a.email;
      const nameB = b.name || b.email;
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
    }
    if (sortMode === 'name-desc') {
      const nameA = a.name || a.email;
      const nameB = b.name || b.email;
      return nameB.localeCompare(nameA, undefined, { sensitivity: 'base', numeric: true });
    }

    if (sortMode === 'tier-asc') {
      // Free first, then Pro, then Ultra/Enterprise
      const rankA = getTierRank(a);
      const rankB = getTierRank(b);
      if (rankA !== rankB) {
        return rankB - rankA;
      }
      const nameA = a.name || a.email;
      const nameB = b.name || b.email;
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
    }

    // Default 'tier' (tier-desc): Ultra/Enterprise first, then Pro, then Free.
    // Within the same tier, always sort alphabetically by name (A-Z)
    const rankA = getTierRank(a);
    const rankB = getTierRank(b);
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    const nameA = a.name || a.email;
    const nameB = b.name || b.email;
    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
  });

  const handleFilterChange = (newFilter: string) => {
    setFilterType(newFilter);
    setCurrentPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(sortedAccounts.length / pageSize));
  const validCurrentPage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (validCurrentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, sortedAccounts.length);
  const pagedAccounts = sortedAccounts.slice(startIndex, endIndex);

  // Toggle multi-select mode
  const toggleMultiSelectMode = () => {
    setIsMultiSelectMode((prev) => {
      if (prev) {
        setCheckedEmails(new Set());
      }
      return !prev;
    });
  };

  // Toggle check for a single account
  const handleToggleCheck = (email: string) => {
    setCheckedEmails((prev) => {
      const next = new Set(prev);
      if (next.has(email)) {
        next.delete(email);
      } else {
        next.add(email);
      }
      return next;
    });
  };

  // Select all or deselect all
  const handleToggleSelectAll = () => {
    const allFilteredEmails = sortedAccounts.map((a) => a.email);
    const areAllSelected = allFilteredEmails.every((email) => checkedEmails.has(email));

    if (areAllSelected) {
      setCheckedEmails((prev) => {
        const next = new Set(prev);
        for (const email of allFilteredEmails) {
          next.delete(email);
        }
        return next;
      });
    } else {
      setCheckedEmails((prev) => {
        const next = new Set(prev);
        for (const email of allFilteredEmails) {
          next.add(email);
        }
        return next;
      });
    }
  };

  // Single Account Refresh with Anti-spam Cooldown
  const handleRefreshAccount = (email: string) => {
    const now = Date.now();
    const last = lastRefreshMap.current.get(email) || 0;
    const elapsed = now - last;

    if (elapsed < REFRESH_COOLDOWN_MS) {
      const remainingSec = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000);
      showToast(
        `Please wait ${remainingSec}s before refreshing ${email} again to avoid rate limits.`,
        'warning'
      );
      return;
    }

    lastRefreshMap.current.set(email, now);
    setRefreshingEmails((prev) => new Set(prev).add(email));

    vscode.postMessage({ command: 'refreshAccount', email });
    showToast(`Refreshing quota for ${email}...`, 'info');

    setTimeout(() => {
      setRefreshingEmails((prev) => {
        const next = new Set(prev);
        next.delete(email);
        return next;
      });
    }, 2000);
  };

  // Bulk Refresh with Cooldown check
  const handleBulkRefresh = () => {
    if (checkedEmails.size === 0) return;

    const emailsToRefresh = Array.from(checkedEmails);
    const now = Date.now();
    const emailsReady: string[] = [];
    let minRemaining = REFRESH_COOLDOWN_MS;

    for (const email of emailsToRefresh) {
      const last = lastRefreshMap.current.get(email) || 0;
      const elapsed = now - last;
      if (elapsed >= REFRESH_COOLDOWN_MS) {
        emailsReady.push(email);
        lastRefreshMap.current.set(email, now);
      } else {
        const rem = REFRESH_COOLDOWN_MS - elapsed;
        if (rem < minRemaining) minRemaining = rem;
      }
    }

    if (emailsReady.length === 0) {
      const remSec = Math.ceil(minRemaining / 1000);
      showToast(
        `Please wait ${remSec}s before refreshing selected accounts again to avoid rate limits.`,
        'warning'
      );
      return;
    }

    setIsBulkRefreshing(true);
    setRefreshingEmails((prev) => {
      const next = new Set(prev);
      for (const email of emailsReady) {
        next.add(email);
      }
      return next;
    });

    vscode.postMessage({ command: 'refreshMultipleAccounts', emails: emailsReady });
    showToast(`Refreshing ${emailsReady.length} account(s)...`, 'info');

    setTimeout(() => {
      setIsBulkRefreshing(false);
      setRefreshingEmails((prev) => {
        const next = new Set(prev);
        for (const email of emailsReady) {
          next.delete(email);
        }
        return next;
      });
    }, 2500);
  };

  // Single Delete Request -> Open Confirmation Dialog
  const handleDeleteSingleRequest = (email: string) => {
    setDeleteDialog({
      isOpen: true,
      emails: [email]
    });
  };

  // Bulk Delete Request -> Open Confirmation Dialog
  const handleBulkDeleteRequest = () => {
    if (checkedEmails.size === 0) return;
    setDeleteDialog({
      isOpen: true,
      emails: Array.from(checkedEmails)
    });
  };

  // Execute Confirmed Delete
  const handleConfirmDelete = () => {
    const { emails } = deleteDialog;
    if (emails.length === 1) {
      vscode.postMessage({ command: 'removeAccount', email: emails[0], confirmed: true });
      showToast(`Removed account ${emails[0]}`, 'success');
    } else if (emails.length > 1) {
      vscode.postMessage({ command: 'removeMultipleAccounts', emails });
      showToast(`Successfully removed ${emails.length} accounts`, 'success');
    }

    // Clean up checked emails
    setCheckedEmails((prev) => {
      const next = new Set(prev);
      for (const email of emails) {
        next.delete(email);
      }
      return next;
    });

    setDeleteDialog({ isOpen: false, emails: [] });
  };

  const areAllFilteredSelected =
    filteredAccounts.length > 0 &&
    filteredAccounts.every((acc) => checkedEmails.has(acc.email));

  return (
    <div className="flex flex-col gap-2 mb-3">
      {/* Delete Confirmation Modal Dialog */}
      <ConfirmDialog
        isOpen={deleteDialog.isOpen}
        title={deleteDialog.emails.length > 1 ? 'Confirm Bulk Account Removal' : 'Confirm Account Removal'}
        description={
          deleteDialog.emails.length > 1
            ? `Are you sure you want to remove ${deleteDialog.emails.length} selected accounts? Stored tokens will be deleted and this action cannot be undone.`
            : `Are you sure you want to remove account ${deleteDialog.emails[0]}? This action cannot be undone.`
        }
        items={deleteDialog.emails}
        confirmText={deleteDialog.emails.length > 1 ? `Remove ${deleteDialog.emails.length} Accounts` : 'Remove Account'}
        cancelText="Cancel"
        isDestructive={true}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteDialog({ isOpen: false, emails: [] })}
      />

      {/* Section Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span>Accounts & Fast Switch</span>
          <span className="text-[10px] font-semibold text-foreground/80 normal-case">
            ({accounts.length} connected)
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {accounts.length > 0 && (
            <Button
              onClick={toggleMultiSelectMode}
              size="xs"
              variant={isMultiSelectMode ? 'default' : 'outline'}
              title={isMultiSelectMode ? 'Exit selection mode' : 'Select multiple accounts for bulk actions'}
              className="gap-1 text-[10px]"
            >
              <CheckSquare className="w-3 h-3" />
              <span>{isMultiSelectMode ? 'Done' : 'Select'}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Multi-Select Floating / Sticky Action Toolbar */}
      {isMultiSelectMode && accounts.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/10 p-2 text-xs shadow-md animate-in fade-in slide-in-from-top-1">
          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleSelectAll}
              className="flex items-center gap-1.5 text-xs font-semibold text-foreground hover:text-primary transition-colors cursor-pointer"
            >
              {areAllFilteredSelected ? (
                <CheckSquare className="w-4 h-4 text-primary" />
              ) : (
                <Square className="w-4 h-4 text-muted-foreground" />
              )}
              <span>{areAllFilteredSelected ? 'Deselect All' : 'Select All'}</span>
            </button>
            <Badge variant="secondary" className="font-mono text-[10px] px-1.5 py-0 bg-card">
              Selected: <span className="font-bold text-primary ml-1">{checkedEmails.size}</span>/{accounts.length}
            </Badge>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              onClick={handleBulkRefresh}
              disabled={checkedEmails.size === 0 || isBulkRefreshing}
              size="xs"
              variant="outline"
              title="Refresh quota for selected accounts"
              className="gap-1 bg-card hover:bg-accent"
            >
              <RotateCw className={cn("w-3 h-3", isBulkRefreshing && "animate-spin text-primary")} />
              <span>Refresh ({checkedEmails.size})</span>
            </Button>

            <Button
              onClick={handleBulkDeleteRequest}
              disabled={checkedEmails.size === 0}
              size="xs"
              variant="destructive"
              title="Remove selected accounts"
              className="gap-1"
            >
              <Trash2 className="w-3 h-3" />
              <span>Delete ({checkedEmails.size})</span>
            </Button>

            <Button
              onClick={() => {
                setIsMultiSelectMode(false);
                setCheckedEmails(new Set());
              }}
              size="iconXs"
              variant="ghost"
              title="Close selection mode"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Fast Type Filter Badges & Sort Selector Bar */}
      {accounts.length > 0 && !isMultiSelectMode && (
        <div className="flex flex-wrap items-center justify-between gap-1.5 py-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mr-0.5">
              <Filter className="w-3 h-3" />
              <span>Filter:</span>
            </div>
            {filterBadges.map((badge) => {
              const isSelected = filterType === badge.id;
              return (
                <button
                  key={badge.id}
                  type="button"
                  onClick={() => handleFilterChange(badge.id)}
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-semibold transition-all cursor-pointer border shadow-xs select-none',
                    isSelected
                      ? `${badge.activeClass} shadow-sm ring-1 ring-white/20`
                      : 'bg-card/70 text-muted-foreground border-border/70 hover:text-foreground hover:bg-accent/50'
                  )}
                  title={`Show ${badge.label} accounts (${badge.count})`}
                >
                  <span>{badge.label}</span>
                  <span
                    className={cn(
                      'text-[9px] px-1 py-0 rounded font-mono font-bold',
                      isSelected
                        ? 'bg-black/25 text-white dark:bg-white/20'
                        : 'bg-muted/70 text-muted-foreground'
                    )}
                  >
                    {badge.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Sort Selector Dropdown */}
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground ml-auto">
            <ArrowUpDown className="w-3 h-3 text-muted-foreground" />
            <select
              value={sortMode}
              onChange={(e) => {
                setSortMode(e.target.value as any);
                setCurrentPage(1);
              }}
              className="h-5.5 rounded border border-border bg-card px-1.5 text-[10px] font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
              title="Sort accounts"
            >
              <option value="tier">Sort: Tier (Ultra → Pro → Free)</option>
              <option value="tier-asc">Sort: Tier (Free → Pro → Ultra)</option>
              <option value="name-asc">Sort: Name (A → Z)</option>
              <option value="name-desc">Sort: Name (Z → A)</option>
            </select>
          </div>
        </div>
      )}

      {/* Account Grid or Empty State */}
      {accounts.length === 0 ? (
        <Card className="border-dashed bg-card/40">
          <CardContent className="flex flex-col items-center justify-center p-6 text-center">
            <Zap className="w-8 h-8 text-primary mb-2" />
            <div className="text-xs text-foreground font-medium mb-3">
              No accounts connected. Import from current Antigravity or sign in!
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {/* Google Sign In Button */}
              <Button
                onClick={handleSignIn}
                size="sm"
                variant="default"
                title="Add account via Google OAuth sign in"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Google Sign In</span>
              </Button>

              {/* Import Antigravity Button */}
              <Button
                onClick={handleImport}
                size="sm"
                variant="secondary"
                title="Import account from active Antigravity IDE session"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>Import</span>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : filteredAccounts.length === 0 ? (
        <Card className="border-dashed bg-card/30">
          <CardContent className="flex flex-col items-center justify-center p-4 text-center">
            <div className="text-xs text-muted-foreground mb-2">
              No <span className="font-semibold text-foreground uppercase">{filterType}</span> accounts found.
            </div>
            <Button
              onClick={() => handleFilterChange('all')}
              size="xs"
              variant="outline"
            >
              Show All Accounts ({accounts.length})
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
            {pagedAccounts.map((acc) => (
              <AccountCard
                key={acc.email}
                account={acc}
                isActive={!!activeAccount && activeAccount.email === acc.email}
                isSelected={selectedEmail === acc.email}
                isMultiSelectMode={isMultiSelectMode}
                isChecked={checkedEmails.has(acc.email)}
                isRefreshing={refreshingEmails.has(acc.email)}
                onSelect={onSelectAccount}
                onToggleCheck={handleToggleCheck}
                onRefreshRequest={handleRefreshAccount}
                onDeleteRequest={handleDeleteSingleRequest}
              />
            ))}
          </div>

          {/* Pagination Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/40 mt-1 select-none">
            {/* Left side: Range counter & Items per page */}
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                Showing <span className="font-semibold text-foreground">{sortedAccounts.length === 0 ? 0 : startIndex + 1}–{endIndex}</span> of <span className="font-semibold text-foreground">{sortedAccounts.length}</span>
              </span>
              <div className="flex items-center gap-1.5 ml-1 border-l border-border/60 pl-2">
                <span className="text-[10px]">Per page:</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="h-6 rounded border border-border bg-card px-1.5 text-[11px] font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                  title="Select accounts per page"
                >
                  <option value={5}>5</option>
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                </select>
              </div>
            </div>

            {/* Bottom Right: Page Status & Navigation Buttons */}
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-[11px] text-muted-foreground">
                Page <span className="font-semibold text-foreground">{validCurrentPage}</span> / <span className="font-semibold text-foreground">{totalPages}</span>
              </span>
              <div className="flex items-center gap-0.5">
                <Button
                  size="iconXs"
                  variant="outline"
                  onClick={() => setCurrentPage(1)}
                  disabled={validCurrentPage <= 1}
                  title="Jump to first page"
                  className="h-6 w-6"
                >
                  <ChevronsLeft className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="iconXs"
                  variant="outline"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={validCurrentPage <= 1}
                  title="Previous page"
                  className="h-6 w-6"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="iconXs"
                  variant="outline"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={validCurrentPage >= totalPages}
                  title="Next page"
                  className="h-6 w-6"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="iconXs"
                  variant="outline"
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={validCurrentPage >= totalPages}
                  title="Jump to last page"
                  className="h-6 w-6"
                >
                  <ChevronsRight className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
