import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

console.log('[Antigravity Swap Webview] Initializing React...');

const rootElement = document.getElementById('root');
if (rootElement) {
  try {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
    console.log('[Antigravity Swap Webview] React rendered successfully.');
  } catch (err) {
    console.error('[Antigravity Swap Webview] Fatal render error:', err);
    rootElement.innerHTML = `
      <div style="padding: 16px; color: #f87171; font-family: sans-serif;">
        <h3 style="margin-bottom: 8px;">Failed to initialize UI</h3>
        <pre style="background: rgba(0,0,0,0.4); padding: 8px; border-radius: 6px; font-size: 11px;">${String(err)}</pre>
      </div>
    `;
  }
} else {
  console.error('[Antigravity Swap Webview] Root element #root not found in DOM.');
}
