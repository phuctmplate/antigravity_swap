import * as https from 'https';
import { API_ENDPOINTS } from '../constants';
import { is5HourBucket, isWeeklyBucket } from './quotaClassifier';

export class QuotaApiClient {
  /**
   * Pure HTTPS live quota fetching against Cloud Code PA backend.
   * Completely isolated per account token without local Language Server RPC state pollution.
   */
  public async fetchLiveQuotaData(accessToken: string, _isActiveAccount: boolean = false): Promise<any> {
    let projectId: string | undefined;
    let tierData: any = {};
    let lastAuthError: Error | null = null;
    let anyEndpointSucceeded = false;

    const hosts = API_ENDPOINTS.CLOUD_CODE_HOSTS;

    // 1. Discover project ID and subscription tier via loadCodeAssist
    const codeAssistBodies = [
      {
        metadata: { ideType: 'ANTIGRAVITY' }
      },
      {},
      {
        metadata: {
          ide_type: 'ANTIGRAVITY',
          ide_version: '1.22.2',
          ide_name: 'antigravity'
        }
      }
    ];

    for (const host of hosts) {
      for (const body of codeAssistBodies) {
        try {
          const res = await this.callCloudCodePost(accessToken, host, '/v1internal:loadCodeAssist', body);
          if (res) {
            anyEndpointSucceeded = true;
            if (res.cloudaicompanionProject) {
              projectId = res.cloudaicompanionProject;
            }
            tierData = { ...tierData, ...res };
            break;
          }
        } catch (err: any) {
          if (err.message && (err.message.includes('401') || err.message.includes('UNAUTHENTICATED'))) {
            lastAuthError = err;
          }
        }
      }
      if (projectId || Object.keys(tierData).length > 0) break;
    }

    // 2. Fetch available quota groups and dynamic models via Cloud Code PA HTTPS
    let groupsData: any = null;
    let modelsData: any = null;

    const isPooled = !projectId || projectId === 'aicode-consumers';
    const body = isPooled ? {} : { project: projectId };

    if (!groupsData) {
      for (const host of hosts) {
        let hostGroups: any = null;
        try {
          hostGroups = await this.callCloudCodePost(accessToken, host, '/v1internal:retrieveUserQuotaSummary', body);
          if (hostGroups) anyEndpointSucceeded = true;
        } catch (err: any) {
          if (err.message && (err.message.includes('401') || err.message.includes('UNAUTHENTICATED'))) {
            lastAuthError = err;
          }
          if (projectId) {
            try {
              hostGroups = await this.callCloudCodePost(accessToken, host, '/v1internal:retrieveUserQuotaSummary', {});
              if (hostGroups) anyEndpointSucceeded = true;
            } catch {}
          }
        }

        if (hostGroups) {
          if (!groupsData) {
            groupsData = hostGroups;
          } else {
            // Merge missing groups and synchronize matching buckets across hosts
            const existingGroups: any[] = groupsData?.response?.groups || groupsData?.groups || [];
            const newGroups: any[] = hostGroups?.response?.groups || hostGroups?.groups || [];
            for (const ng of newGroups) {
              const ngName = (ng.displayName || '').toLowerCase();
              const isNgGemini = ngName.includes('gemini');
              const isNgClaude = ngName.includes('claude') || ngName.includes('gpt') || ngName.includes('3p');
              const existingMatch = existingGroups.find((eg: any) => {
                const egName = (eg.displayName || '').toLowerCase();
                return (
                  (isNgGemini && egName.includes('gemini')) ||
                  (isNgClaude && (egName.includes('claude') || egName.includes('gpt') || egName.includes('3p')))
                );
              });
              if (!existingMatch) {
                existingGroups.push(ng);
              } else {
                for (const nb of (ng.buckets || [])) {
                  const nbIs5h = is5HourBucket(nb.window, nb.bucketId, nb.displayName);
                  const nbIsWk = isWeeklyBucket(nb.window, nb.bucketId, nb.displayName);

                  const eb = (existingMatch.buckets || []).find((b: any) => {
                    const bIs5h = is5HourBucket(b.window, b.bucketId, b.displayName);
                    const bIsWk = isWeeklyBucket(b.window, b.bucketId, b.displayName);
                    if (nbIs5h || bIs5h) return bIs5h && nbIs5h;
                    if (nbIsWk || bIsWk) return bIsWk && nbIsWk;
                    if (b.bucketId && nb.bucketId) return b.bucketId === nb.bucketId;
                    if (b.displayName && nb.displayName) return b.displayName.trim().toLowerCase() === nb.displayName.trim().toLowerCase();
                    return false;
                  });

                  if (eb) {
                    if (typeof nb.remainingFraction === 'number' && typeof eb.remainingFraction === 'number') {
                      if (nb.remainingFraction < eb.remainingFraction) {
                        eb.remainingFraction = nb.remainingFraction;
                        eb.resetTime = nb.resetTime || eb.resetTime;
                        eb.description = nb.description || eb.description;
                      }
                    } else if (typeof nb.remainingFraction === 'number' && typeof eb.remainingFraction !== 'number') {
                      eb.remainingFraction = nb.remainingFraction;
                      eb.resetTime = nb.resetTime || eb.resetTime;
                      eb.description = nb.description || eb.description;
                    }
                    if (!eb.description && nb.description) {
                      eb.description = nb.description;
                    }
                  } else {
                    (existingMatch.buckets || []).push(nb);
                  }
                }
              }
            }
            if (groupsData.response && groupsData.response.groups) {
              groupsData.response.groups = existingGroups;
            }
            if (groupsData.groups) {
              groupsData.groups = existingGroups;
            }
          }
        }
      }
    }

    // 4. Fetch models via Cloud Code PA if not already provided by Language Server
    if (!modelsData) {
      for (const host of hosts) {
        let hostModels: any = null;
        try {
          hostModels = await this.callCloudCodePost(accessToken, host, '/v1internal:fetchAvailableModels', body);
          if (hostModels) anyEndpointSucceeded = true;
        } catch (err: any) {
          if (err.message && (err.message.includes('401') || err.message.includes('UNAUTHENTICATED'))) {
            lastAuthError = err;
          }
          if (projectId) {
            try {
              hostModels = await this.callCloudCodePost(accessToken, host, '/v1internal:fetchAvailableModels', {});
              if (hostModels) anyEndpointSucceeded = true;
            } catch {}
          }
        }

        if (hostModels && hostModels.models) {
          if (!modelsData) {
            modelsData = { ...hostModels, models: { ...hostModels.models } };
          } else {
            modelsData.models = modelsData.models || {};
            for (const [id, m] of Object.entries<any>(hostModels.models)) {
              if (!modelsData.models[id]) {
                modelsData.models[id] = m;
              } else {
                const currFrac = modelsData.models[id]?.quotaInfo?.remainingFraction;
                const newFrac = m?.quotaInfo?.remainingFraction;
                if (typeof newFrac === 'number') {
                  if (typeof currFrac !== 'number' || newFrac < currFrac) {
                    modelsData.models[id] = m;
                  }
                }
              }
            }
          }
        }
      }
    }


    // If nothing succeeded and we encountered 401, throw so fetchAccountQuotas can refresh token or mark auth_failed
    if (!anyEndpointSucceeded && lastAuthError) {
      throw lastAuthError;
    }

    return {
      ...tierData,
      ...(groupsData || {}),
      models: modelsData?.models || groupsData?.models || tierData?.models || {},
      response: groupsData?.response || groupsData
    };
  }

  public callCloudCodePost(accessToken: string, hostname: string, path: string, body: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request(
        {
          hostname,
          port: 443,
          path,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/1.22.2 windows',
            'Content-Length': Buffer.byteLength(data)
          },
          timeout: 8000
        },
        (res) => {
          let resData = '';
          res.on('data', (chunk) => (resData += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(resData));
              } catch (e) {
                reject(new Error(`Failed to parse response: ${resData}`));
              }
            } else if (res.statusCode === 403) {
              reject(new Error(`403 PERMISSION_DENIED: ${resData}`));
            } else if (res.statusCode === 401) {
              reject(new Error(`401 UNAUTHENTICATED: ${resData}`));
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${resData}`));
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
}
