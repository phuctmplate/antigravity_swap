import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { GoogleDirectApiClient } from '../src/quota/googleDirectApiClient';
import { QuotaApiClient } from '../src/quota/quotaApiClient';
import { determineAccountTier } from '../src/quota/quotaClassifier';

describe('Google Direct API & Quota Engine Tests', () => {
  it('GoogleDirectApiClient invalidates cache cleanly', () => {
    const directClient = new GoogleDirectApiClient();
    (directClient as any).memoryCache.set('test@example.com', {
      data: { tier: 'pro' },
      timestamp: Date.now()
    });

    assert.ok((directClient as any).memoryCache.has('test@example.com'));
    directClient.invalidateCache('test@example.com');
    assert.strictEqual((directClient as any).memoryCache.has('test@example.com'), false);

    (directClient as any).memoryCache.set('all@example.com', { data: {}, timestamp: Date.now() });
    directClient.invalidateCache();
    assert.strictEqual((directClient as any).memoryCache.size, 0);
    directClient.dispose();
  });

  it('QuotaApiClient routes quota queries through GoogleDirectApiClient', async () => {
    const mockDirectClient = new GoogleDirectApiClient();
    (mockDirectClient as any).fetchStandbyQuota = async (token: string, email?: string) => {
      return {
        paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
        currentTier: { id: 'pro', name: 'Google AI Pro' },
        cloudaicompanionProject: 'aicode-consumers',
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.95, resetTime: '2026-10-25T11:00:51Z' },
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: '2026-10-20T19:00:36Z' }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { bucketId: 'claude-weekly', window: 'weekly', remainingFraction: 0.7, resetTime: '2026-10-25T11:00:51Z' }
            ]
          }
        ],
        models: {
          'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', quotaInfo: { remainingFraction: 0.8 } }
        }
      };
    };

    const apiClient = new QuotaApiClient(mockDirectClient);
    const result = await apiClient.fetchLiveQuotaData('mock-token', false, 'active.pro@gmail.com');

    assert.strictEqual(result.paidTier.id, 'g1-pro-tier');
    assert.strictEqual(result.groups.length, 2);
    assert.strictEqual(result.groups[0].buckets[0].remainingFraction, 0.95);
    assert.strictEqual(result.groups[0].buckets[1].remainingFraction, 0.8);

    const tier = determineAccountTier(result);
    assert.strictEqual(tier.tierBadge, 'PRO');
    assert.strictEqual(tier.accountType, 'Google AI Pro');
    apiClient.dispose();
  });

  it('Strictly classifies Free tier accounts as STANDARD FREE without 5h rolling window', async () => {
    const freeTierPayload = {
      paidTier: {
        id: 'free-tier',
        name: 'Antigravity Starter Quota',
        description: 'Antigravity Starter Quota'
      },
      currentTier: {
        id: 'free-tier',
        name: 'Antigravity'
      },
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 1.0, resetTime: '2026-10-27T10:00:00Z' }
          ]
        }
      ]
    };

    const tier = determineAccountTier(freeTierPayload);
    assert.strictEqual(tier.tierBadge, 'STANDARD FREE');
    assert.strictEqual(tier.accountType, 'Standard Free');
  });

  it('Strictly classifies Pro accounts as PRO when paidTier is g1-pro-tier', async () => {
    const proTierPayload = {
      paidTier: {
        id: 'g1-pro-tier',
        name: 'Google AI Pro',
        description: 'Google AI Pro'
      },
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.9, resetTime: '2026-10-27T10:00:00Z' },
            { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.6, resetTime: '2026-10-20T22:00:00Z' }
          ]
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: 'claude-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.05, resetTime: '2026-10-27T10:00:00Z' }
          ]
        }
      ]
    };

    const tier = determineAccountTier(proTierPayload);
    assert.strictEqual(tier.tierBadge, 'PRO');
    assert.strictEqual(tier.accountType, 'Google AI Pro');
  });

  it('probeJitCandidate flags depleted accounts when quota is exhausted', async () => {
    const directClient = new GoogleDirectApiClient();
    (directClient as any).fetchStandbyQuota = async () => ({
      groups: [
        {
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.02, resetTime: '2026-10-20T21:00:00Z' }
          ]
        }
      ]
    });

    const probe = await directClient.probeJitCandidate('mock-token');
    assert.strictEqual(probe.ok, true);
    assert.strictEqual(probe.isDepleted, true);
    assert.strictEqual(probe.fiveHourPercentage, 2);
    directClient.dispose();
  });
});
