import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { AlertTriangle, Trash2 } from 'lucide-react';

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
  onCancel,
}) => {
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader className="gap-2">
          <div className="flex items-center gap-2 text-foreground">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-rose-500/15 text-rose-500 shrink-0">
              {isDestructive ? (
                <Trash2 className="w-3.5 h-3.5" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5" />
              )}
            </div>
            <DialogTitle>{title}</DialogTitle>
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

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

        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

