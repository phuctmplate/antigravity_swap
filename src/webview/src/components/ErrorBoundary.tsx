import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from './ui/button';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: string;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: String(error) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Antigravity Swap] Component error:', error, info);
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
            border: '1px solid #f8717150'
          }}>
            {this.state.error}
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => this.setState({ hasError: false, error: '' })}
            className="mt-3 text-xs"
          >
            Retry
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
