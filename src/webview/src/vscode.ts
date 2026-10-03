interface VsCodeApi {
  postMessage(message: any): void;
  getState(): any;
  setState(state: any): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let vscodeApi: VsCodeApi | null = null;

export function getVsCodeApi(): VsCodeApi {
  if (!vscodeApi) {
    if (typeof acquireVsCodeApi === 'function') {
      try {
        vscodeApi = acquireVsCodeApi();
      } catch (e) {
        // acquireVsCodeApi can only be called once in the lifetime of a webview
      }
    }
    if (!vscodeApi) {
      // Mock fallback for browser / preview testing
      vscodeApi = {
        postMessage: (msg: any) => console.log('[VSCode Mock PostMessage]', msg),
        getState: () => ({}),
        setState: (st: any) => console.log('[VSCode Mock SetState]', st)
      };
    }
  }
  return vscodeApi;
}
