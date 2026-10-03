import React, { createContext, useContext, useState, useCallback } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { cn } from '../lib/utils';

export type ToastType = 'info' | 'warning' | 'success' | 'error';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextType {
  showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const getIcon = (type: ToastType) => {
    switch (type) {
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />;
      case 'success':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />;
      case 'info':
      default:
        return <Info className="w-4 h-4 text-sky-400 shrink-0" />;
    }
  };

  const getBorderAndBg = (type: ToastType) => {
    switch (type) {
      case 'warning':
        return 'border-amber-500/50 bg-amber-950/90 text-amber-200';
      case 'success':
        return 'border-emerald-500/50 bg-emerald-950/90 text-emerald-200';
      case 'error':
        return 'border-rose-500/50 bg-rose-950/90 text-rose-200';
      case 'info':
      default:
        return 'border-sky-500/50 bg-slate-900/95 text-slate-100';
    }
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {/* Toast container overlay */}
      <div className="fixed bottom-3 right-3 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none px-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              'pointer-events-auto flex items-center justify-between gap-2.5 rounded-lg border p-3 text-xs shadow-xl backdrop-blur-md transition-all animate-in fade-in slide-in-from-bottom-2',
              getBorderAndBg(toast.type)
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              {getIcon(toast.type)}
              <span className="font-medium leading-tight break-words">{toast.message}</span>
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};
