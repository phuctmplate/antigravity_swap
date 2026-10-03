import React from 'react';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { AlertTriangle, Trash2, X } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  items?: string[];
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  description,
  items = [],
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  isDestructive = true,
  onConfirm,
  onCancel
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <Card className="w-full max-w-sm border-border bg-card shadow-2xl overflow-hidden scale-in-95 animate-in">
        <CardContent className="flex flex-col p-4 gap-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 text-foreground font-bold text-sm">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-500/15 text-rose-500">
                {isDestructive ? <Trash2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
              </div>
              <span>{title}</span>
            </div>
            <button
              onClick={onCancel}
              className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="text-xs text-muted-foreground leading-relaxed">
            {description}
          </div>

          {items.length > 0 && (
            <div className="max-h-28 overflow-y-auto rounded-md bg-muted/40 p-2 border border-border/60 flex flex-col gap-1 text-[11px] font-mono text-foreground/90">
              {items.map((item, idx) => (
                <div key={idx} className="truncate flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />
                  <span className="truncate">{item}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              onClick={onCancel}
              size="sm"
              variant="outline"
              className="text-xs font-medium"
            >
              {cancelText}
            </Button>
            <Button
              onClick={onConfirm}
              size="sm"
              variant={isDestructive ? 'destructive' : 'default'}
              className="text-xs font-semibold"
            >
              {confirmText}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
