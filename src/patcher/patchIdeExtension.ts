import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vm from 'vm';

/**
 * Resolves the absolute path to Antigravity IDE's built-in extension.js
 */
export function locateIdeExtensionPath(): string | null {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity IDE', 'resources', 'app', 'extensions', 'antigravity', 'dist', 'extension.js'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'resources', 'app', 'extensions', 'antigravity', 'dist', 'extension.js'),
    path.join(path.dirname(process.execPath), 'resources', 'app', 'extensions', 'antigravity', 'dist', 'extension.js'),
    path.join(path.dirname(process.execPath), '..', 'Resources', 'app', 'extensions', 'antigravity', 'dist', 'extension.js'),
    '/usr/share/antigravity/resources/app/extensions/antigravity/dist/extension.js'
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

/**
 * Restores the original unpatched extension.js from extension.js.bak
 */
export function restoreIdeExtensionBackup(): boolean {
  try {
    const extJsPath = locateIdeExtensionPath();
    if (!extJsPath) return false;

    const bakPath = extJsPath + '.bak';
    if (!fs.existsSync(bakPath)) {
      console.warn('[Antigravity Swap] Backup file extension.js.bak does not exist, cannot restore.');
      return false;
    }

    const bakContent = fs.readFileSync(bakPath, 'utf8');
    // Sanity check backup syntax before restoring
    new vm.Script(bakContent);

    fs.copyFileSync(bakPath, extJsPath);
    console.log('[Antigravity Swap] Successfully restored original extension.js from extension.js.bak!');
    return true;
  } catch (err) {
    console.error('[Antigravity Swap] Failed to restore backup extension.js.bak:', err);
    return false;
  }
}

/**
 * Validates JavaScript syntax using Node's V8 compiler without executing it.
 */
function validateJsSyntax(code: string): boolean {
  try {
    new vm.Script(code);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Automatically patches Antigravity IDE's built-in extension.js with automated
 * error detection, syntax validation, and atomic rollback to extension.js.bak.
 */
export function ensureIdeExtensionPatched(): boolean {
  const extJsPath = locateIdeExtensionPath();
  if (!extJsPath) {
    console.warn('[Antigravity Swap] Could not locate Antigravity built-in extension.js for self-healing patch');
    return false;
  }

  const bakPath = extJsPath + '.bak';

  try {
    let content = fs.readFileSync(extJsPath, 'utf8');

    // 1. INTEGRITY CHECK ON EXISTING FILE:
    // If the file on disk is corrupted, truncated (< 100KB), or has syntax errors:
    const isValidSyntax = validateJsSyntax(content);
    const isReasonableSize = content.length > 100000;

    if (!isValidSyntax || !isReasonableSize) {
      console.error('[Antigravity Swap] Existing extension.js is corrupted or has syntax error! Automatically restoring from backup...');
      if (fs.existsSync(bakPath)) {
        restoreIdeExtensionBackup();
        content = fs.readFileSync(extJsPath, 'utf8');
      } else {
        console.error('[Antigravity Swap] Cannot restore: backup file not found.');
        return false;
      }
    }

    // 2. CHECK IF ALREADY PATCHED AND VALID:
    if (content.includes('evictSession') && content.includes('antigravity.evictAuthSession')) {
      console.log('[Antigravity Swap] Antigravity built-in extension is already patched and verified.');
      return true;
    }

    // 3. CREATE BACKUP IF NOT ALREADY PRESENT:
    // Ensure we only back up a valid, non-empty file
    if (!fs.existsSync(bakPath) && validateJsSyntax(content) && content.length > 100000) {
      try {
        fs.copyFileSync(extJsPath, bakPath);
        console.log('[Antigravity Swap] Created pristine backup extension.js.bak');
      } catch (bakErr) {
        console.warn('[Antigravity Swap] Failed to create backup:', bakErr);
      }
    }

    const targetOriginal = 'async getSessions(){const e=await i.antigravityUnifiedStateSync.OAuthPreferences.getOAuthTokenInfo();if(!e)return[];const t=await i.antigravityUnifiedStateSync.UserStatus.getUserStatus();if(!t)return[];const n=(0,s.P2)(t,r.dZ7),{email:o,name:l}=n;return""===o?[]:[{id:`antigravity-${o}`,accessToken:e.accessToken,account:{id:o,label:l},scopes:[]}]}async createSession(e,t){try{const e=await this.getSessions();if(e.length>0)return this._sessionChangeEmitter.fire({added:e,removed:[],changed:[]}),e[0];throw new Error("No auth token found - should never happen")}catch(e){throw i.window.showErrorMessage(`Sign in failed: ${e}`),e}}async removeSession(){const e=await this.getSessions();0!==e.length&&(e.length>1&&console.error("Multiple sessions found - should never happen"),await i.antigravityUnifiedStateSync.OAuthPreferences.setOAuthTokenInfo(null),await i.antigravityUnifiedStateSync.UserStatus.clearUserStatus(),this._sessionChangeEmitter.fire({added:[],removed:e,changed:[]}))}';

    const targetIntermediate = 'async getSessions(){const e=await i.antigravityUnifiedStateSync.OAuthPreferences.getOAuthTokenInfo();if(!e)return[];const t=await i.antigravityUnifiedStateSync.UserStatus.getUserStatus();if(!t)return[];const n=(0,s.P2)(t,r.dZ7),{email:o,name:l}=n;if(""===o)return[];const c=[{id:`antigravity-${o}`,accessToken:e.accessToken,account:{id:o,label:l},scopes:[]}];return !this._lastSession&&(this._lastSession=c[0]),c}async createSession(e,t){try{const e=await this.getSessions();if(e.length>0){const t=this._lastSession&&this._lastSession.id!==e[0].id?[this._lastSession]:[];return this._lastSession=e[0],this._sessionChangeEmitter.fire({added:e,removed:t,changed:[]}),e[0]}throw new Error("No auth token found - should never happen")}catch(e){throw i.window.showErrorMessage(`Sign in failed: ${e}`),e}}async removeSession(){const e=await this.getSessions();0!==e.length&&(e.length>1&&console.error("Multiple sessions found - should never happen"),await i.antigravityUnifiedStateSync.OAuthPreferences.setOAuthTokenInfo(null),await i.antigravityUnifiedStateSync.UserStatus.clearUserStatus(),this._lastSession=void 0,this._sessionChangeEmitter.fire({added:[],removed:e,changed:[]}))}';

    const enhancedAuthMethods = [
      'async getSessions(){',
        'const e=await i.antigravityUnifiedStateSync.OAuthPreferences.getOAuthTokenInfo();',
        'if(!e)return[];',
        'const t=await i.antigravityUnifiedStateSync.UserStatus.getUserStatus();',
        'if(!t)return[];',
        'const n=(0,s.P2)(t,r.dZ7),{email:o,name:l}=n;',
        'if(""===o)return[];',
        'const c=[{id:`antigravity-${o}`,accessToken:e.accessToken,account:{id:o,label:l},scopes:[]}];',
        'return !this._lastSession&&(this._lastSession=c[0]),c',
      '}',
      'async evictSession(m){',
        'if(!m)return;',
        'const rem=[{id:`antigravity-${m}`,accessToken:"",account:{id:m,label:m},scopes:[]}];',
        'this._sessionChangeEmitter.fire({added:[],removed:rem,changed:[]});',
      '}',
      'async createSession(e,t){',
        'try{',
          'let s=await this.getSessions();',
          'if(0===s.length){',
            'for(let r=0;r<12;r++){',
              'await new Promise(res=>setTimeout(res,50));',
              's=await this.getSessions();',
              'if(s.length>0)break;',
            '}',
          '}',
          'if(s.length>0){',
            'const rem=[];',
            'if(this._lastSession&&this._lastSession.id!==s[0].id)rem.push(this._lastSession);',
            'try{',
              'const f=require("fs"),o=require("os"),p=require("path");',
              'const gaPath=p.join(o.homedir(),".gemini","google_accounts.json");',
              'if(f.existsSync(gaPath)){',
                'const ga=JSON.parse(f.readFileSync(gaPath,"utf8"));',
                'const oldList=Array.isArray(ga.old)?ga.old:[];',
                'for(const oldEmail of oldList){',
                  'if(oldEmail&&oldEmail!==s[0].account.id&&!rem.some(r=>r.account&&r.account.id===oldEmail)){',
                    'rem.push({id:`antigravity-${oldEmail}`,accessToken:"",account:{id:oldEmail,label:oldEmail},scopes:[]});',
                  '}',
                '}',
              '}',
            '}catch(_){}',
            'return this._lastSession=s[0],this._sessionChangeEmitter.fire({added:s,removed:rem,changed:[]}),s[0];',
          '}',
          'throw new Error("No auth token found - should never happen");',
        '}catch(e){',
          'throw i.window.showErrorMessage(`Sign in failed: ${e}`),e;',
        '}',
      '}',
      'async removeSession(){',
        'const e=await this.getSessions();',
        '0!==e.length&&(e.length>1&&console.error("Multiple sessions found - should never happen"),',
        'await i.antigravityUnifiedStateSync.OAuthPreferences.setOAuthTokenInfo(null),',
        'await i.antigravityUnifiedStateSync.UserStatus.clearUserStatus(),',
        'this._lastSession=void 0,',
        'this._sessionChangeEmitter.fire({added:[],removed:e,changed:[]}))',
      '}'
    ].join('');

    let replaced = false;
    let newContent = content;

    if (newContent.includes(targetOriginal)) {
      newContent = newContent.replace(targetOriginal, enhancedAuthMethods);
      replaced = true;
    } else if (newContent.includes(targetIntermediate)) {
      newContent = newContent.replace(targetIntermediate, enhancedAuthMethods);
      replaced = true;
    }

    const cmdTarget = 'o.commands.registerCommand("antigravity.handleAuthRefresh",async()=>{await(0,a.B)(E.n.AuthenticationRefreshEvent)})';
    const cmdReplacement = 'o.commands.registerCommand("antigravity.handleAuthRefresh",async()=>{await(0,a.B)(E.n.AuthenticationRefreshEvent)}),o.commands.registerCommand("antigravity.evictAuthSession",async(m)=>{if(m)await s.b.getInstance().evictSession(m)})';

    if (newContent.includes(cmdTarget) && !newContent.includes('antigravity.evictAuthSession')) {
      newContent = newContent.replace(cmdTarget, cmdReplacement);
      replaced = true;
    }

    if (replaced) {
      // 4. PRE-WRITE SYNTAX VALIDATION:
      // Verify that the transformed code is 100% syntactically valid before writing to disk
      if (!validateJsSyntax(newContent)) {
        console.error('[Antigravity Swap] Pre-write syntax validation failed for patched extension! Aborting write and restoring backup...');
        restoreIdeExtensionBackup();
        return false;
      }

      // 5. ATOMIC WRITE VIA TEMP FILE:
      const tmpPath = extJsPath + '.tmp';
      fs.writeFileSync(tmpPath, newContent, 'utf8');

      // Verify the written temp file before replacing
      const writtenContent = fs.readFileSync(tmpPath, 'utf8');
      if (!validateJsSyntax(writtenContent)) {
        console.error('[Antigravity Swap] Temp file failed syntax validation! Aborting.');
        try { fs.unlinkSync(tmpPath); } catch (_) {}
        restoreIdeExtensionBackup();
        return false;
      }

      fs.copyFileSync(tmpPath, extJsPath);
      try { fs.unlinkSync(tmpPath); } catch (_) {}

      console.log('[Antigravity Swap] Successfully applied verified self-healing patch to Antigravity extension.js!');
      return true;
    }
  } catch (e) {
    console.error('[Antigravity Swap] ensureIdeExtensionPatched encountered an unexpected error, rolling back to backup:', e);
    // On any unexpected failure during patching, automatically rollback to backup
    restoreIdeExtensionBackup();
  }
  return false;
}
