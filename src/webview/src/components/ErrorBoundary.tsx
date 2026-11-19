import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './ui/button';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: string;
  stack?: string;
  componentStack?: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: '' };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      error: error?.message || String(error),
      stack: error?.stack || ''
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Antigravity Swap] Component error:', error, info);
    this.setState({
      componentStack: info?.componentStack || ''
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '16px',
          color: '#f87171',
          fontFamily: 'monospace',
          fontSize: '12px',
          background: '#1a0a0a',
          minHeight: '100vh',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}>
          <div style={{ marginBottom: '8px', fontWeight: 'bold', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <AlertTriangle size={16} />
            Antigravity Swap render error
          </div>
          <div style={{
            background: 'rgba(0,0,0,0.5)',
            padding: '8px',
            borderRadius: '6px',
            border: '1px solid #f8717150',
            userSelect: 'text'
          }}>
            {this.state.error}
          </div>
          {this.state.stack && (
            <pre style={{
              marginTop: '8px',
              background: 'rgba(0,0,0,0.3)',
              padding: '8px',
              borderRadius: '6px',
              fontSize: '11px',
              maxHeight: '180px',
              overflow: 'auto',
              color: '#9ca3af',
              userSelect: 'text'
            }}>
              {this.state.stack}
            </pre>
          )}
          {this.state.componentStack && (
            <pre style={{
              marginTop: '8px',
              background: 'rgba(0,0,0,0.3)',
              padding: '8px',
              borderRadius: '6px',
              fontSize: '11px',
              maxHeight: '180px',
              overflow: 'auto',
              color: '#fbbf24',
              userSelect: 'text'
            }}>
              {this.state.componentStack}
            </pre>
          )}
          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => this.setState({ hasError: false, error: '', stack: undefined, componentStack: undefined })}
              className="text-xs"
            >
              Retry
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const text = `${this.state.error}\n\nStack:\n${this.state.stack || ''}\n\nComponent Stack:\n${this.state.componentStack || ''}`;
                navigator.clipboard?.writeText(text);
              }}
              className="text-xs"
            >
              Copy Error
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
