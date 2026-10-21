export interface IdeRuntimeMetadata {
  ideName: string;
  ideVersion: string;
  platform: string;
  userAgent: string;
  googApiClient: string;
}

/**
 * Dynamically resolves host IDE information at runtime.
 * Automatically adapts when Antigravity IDE updates (e.g. 1.22.2 -> 1.107.0 -> 2.x)
 * and detects host operating system (Windows, macOS, Linux) without manual code changes.
 */
export function getIdeRuntimeMetadata(): IdeRuntimeMetadata {
  let ideName = 'antigravity';
  let ideVersion = '1.22.2';

  try {
    const vscode = require('vscode');
    if (vscode) {
      const builtInExt = vscode.extensions?.getExtension('antigravity');
      if (builtInExt?.packageJSON?.version) {
        ideVersion = builtInExt.packageJSON.version;
      } else if (vscode.version) {
        ideVersion = vscode.version;
      }

      const appName = (vscode.env?.appName || '').toLowerCase();
      if (appName.includes('antigravity')) {
        ideName = 'antigravity';
      }
    }
  } catch {
    // Graceful fallback when running in standalone Node/test runner
  }

  const platform = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux';

  const userAgent = `${ideName}/${ideVersion} ${platform}`;
  const googApiClient = `gl-node/${process.versions.node || '20.0.0'} gccl/${ideName}`;

  return {
    ideName,
    ideVersion,
    platform,
    userAgent,
    googApiClient
  };
}
