import { AccountInfo, QuotaGroup, QuotaBucket, ModelQuota } from '../../src/types';

/**
 * Comprehensive Mock Accounts and Raw API Responses
 * Covering every account tier, quota condition, and edge case.
 */

// 1. Pro Account - Healthy (100% Gemini 5h, 100% Claude 5h, 90% Claude Weekly)
export const MOCK_PRO_HEALTHY: AccountInfo = {
  id: 'pro-healthy-01',
  email: 'pro.healthy@gmail.com',
  name: 'Alex Rivera',
  avatarUrl: 'https://lh3.googleusercontent.com/a/default-user',
  isActive: true,
  addedAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: '2026-10-16T18:00:00.000Z',
  lastRefreshedAt: '2026-10-16T18:30:00.000Z',
  status: 'healthy',
  isBanned: false,
  accountType: 'Google AI Pro',
  tierBadge: 'PRO',
  averageQuotaPercentage: 90,
  fiveHourQuotaPercentage: 100,
  weeklyQuotaPercentage: 90,
  has5HourQuota: true,
  hasWeeklyQuota: true,
  fiveHourResetTime: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
  fiveHourResetCountdown: '4h 59m',
  weeklyResetTime: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  weeklyResetCountdown: '6d 23h',
  geminiGroup: {
    id: 'gemini',
    name: 'Gemini Models',
    fiveHour: {
      bucketId: 'gemini-5h',
      displayName: '5 Hour Limit Remaining',
      window: '5h',
      percentage: 100,
      remainingFraction: 1.0,
      resetTime: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
      resetCountdown: '4h 59m',
      disabled: false
    },
    buckets: [
      {
        bucketId: 'gemini-5h',
        displayName: '5 Hour Limit Remaining',
        window: '5h',
        percentage: 100,
        remainingFraction: 1.0,
        resetTime: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
        resetCountdown: '4h 59m',
        disabled: false
      }
    ]
  },
  claudeGptGroup: {
    id: 'claude_gpt',
    name: 'Claude and GPT models',
    fiveHour: {
      bucketId: 'claude-5h',
      displayName: '5 Hour Limit Remaining',
      window: '5h',
      percentage: 100,
      remainingFraction: 1.0,
      resetTime: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
      resetCountdown: '4h 59m',
      disabled: false
    },
    weekly: {
      bucketId: 'claude-weekly',
      displayName: 'Weekly Limit Remaining',
      window: 'weekly',
      percentage: 90,
      remainingFraction: 0.9,
      resetTime: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      resetCountdown: '6d 23h',
      disabled: false
    },
    buckets: [
      {
        bucketId: 'claude-5h',
        displayName: '5 Hour Limit Remaining',
        window: '5h',
        percentage: 100,
        remainingFraction: 1.0,
        resetTime: new Date(Date.now() + 5 * 3600 * 1000).toISOString(),
        resetCountdown: '4h 59m',
        disabled: false
      },
      {
        bucketId: 'claude-weekly',
        displayName: 'Weekly Limit Remaining',
        window: 'weekly',
        percentage: 90,
        remainingFraction: 0.9,
        resetTime: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        resetCountdown: '6d 23h',
        disabled: false
      }
    ]
  },
  quotas: [
    {
      id: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      groupName: 'Gemini Models',
      percentage: 100,
      remainingFraction: 1.0,
      windowType: '5h',
      windowLabel: '5-Hour Window',
      disabled: false
    },
    {
      id: 'claude-3-7-sonnet',
      displayName: 'Claude 3.7 Sonnet',
      groupName: 'Claude and GPT models',
      percentage: 100,
      remainingFraction: 1.0,
      windowType: '5h',
      windowLabel: '5-Hour Window',
      disabled: false
    }
  ]
};

// 2. Pro Account - Gemini Depleted (0% Gemini 5h, 100% Claude)
export const MOCK_PRO_GEMINI_DEPLETED: AccountInfo = {
  ...MOCK_PRO_HEALTHY,
  id: 'pro-gemini-depleted-02',
  email: 'pro.gemini.depleted@gmail.com',
  name: 'Morgan Blake',
  isActive: false,
  status: 'healthy',
  statusMessage: 'Gemini depleted · Claude available',
  geminiGroup: {
    ...MOCK_PRO_HEALTHY.geminiGroup!,
    fiveHour: {
      ...MOCK_PRO_HEALTHY.geminiGroup!.fiveHour!,
      percentage: 0,
      remainingFraction: 0.0
    },
    buckets: [
      {
        ...MOCK_PRO_HEALTHY.geminiGroup!.buckets[0],
        percentage: 0,
        remainingFraction: 0.0
      }
    ]
  }
};

// 3. Pro Account - Claude Depleted (100% Gemini, 0% Claude 5h & Weekly)
export const MOCK_PRO_CLAUDE_DEPLETED: AccountInfo = {
  ...MOCK_PRO_HEALTHY,
  id: 'pro-claude-depleted-03',
  email: 'pro.claude.depleted@gmail.com',
  name: 'Sam Taylor',
  isActive: false,
  status: 'healthy',
  statusMessage: 'Claude depleted · Gemini available',
  claudeGptGroup: {
    ...MOCK_PRO_HEALTHY.claudeGptGroup!,
    fiveHour: {
      ...MOCK_PRO_HEALTHY.claudeGptGroup!.fiveHour!,
      percentage: 0,
      remainingFraction: 0.0
    },
    weekly: {
      ...MOCK_PRO_HEALTHY.claudeGptGroup!.weekly!,
      percentage: 0,
      remainingFraction: 0.0
    },
    buckets: [
      {
        ...MOCK_PRO_HEALTHY.claudeGptGroup!.buckets[0],
        percentage: 0,
        remainingFraction: 0.0
      },
      {
        ...MOCK_PRO_HEALTHY.claudeGptGroup!.buckets[1],
        percentage: 0,
        remainingFraction: 0.0
      }
    ]
  }
};

// 4. Pro Account - All Models Depleted (0% Gemini, 0% Claude)
export const MOCK_PRO_ALL_DEPLETED: AccountInfo = {
  ...MOCK_PRO_HEALTHY,
  id: 'pro-all-depleted-04',
  email: 'pro.all.depleted@gmail.com',
  name: 'Jordan Lee',
  isActive: false,
  status: 'low_balance',
  statusMessage: 'All model quotas depleted',
  fiveHourQuotaPercentage: 0,
  weeklyQuotaPercentage: 0,
  averageQuotaPercentage: 0,
  geminiGroup: {
    ...MOCK_PRO_GEMINI_DEPLETED.geminiGroup!
  },
  claudeGptGroup: {
    ...MOCK_PRO_CLAUDE_DEPLETED.claudeGptGroup!
  }
};

// 5. Pro Account - Low Quota (Critical Threshold < 5%)
export const MOCK_PRO_LOW_QUOTA: AccountInfo = {
  ...MOCK_PRO_HEALTHY,
  id: 'pro-low-quota-05',
  email: 'pro.low.quota@gmail.com',
  name: 'Casey Quinn',
  isActive: false,
  status: 'healthy',
  fiveHourQuotaPercentage: 4,
  weeklyQuotaPercentage: 10,
  averageQuotaPercentage: 10,
  geminiGroup: {
    ...MOCK_PRO_HEALTHY.geminiGroup!,
    fiveHour: {
      ...MOCK_PRO_HEALTHY.geminiGroup!.fiveHour!,
      percentage: 4,
      remainingFraction: 0.04
    }
  }
};

// 6. Free Account - Healthy (100% Gemini Weekly, NO Claude, NO 5h window)
export const MOCK_FREE_HEALTHY: AccountInfo = {
  id: 'free-healthy-06',
  email: 'free.healthy@gmail.com',
  name: 'Taylor Green',
  isActive: false,
  addedAt: '2026-10-05T00:00:00.000Z',
  lastUsedAt: '2026-10-15T12:00:00.000Z',
  lastRefreshedAt: '2026-10-16T18:20:00.000Z',
  status: 'healthy',
  isBanned: false,
  accountType: 'Standard Free',
  tierBadge: 'STANDARD FREE',
  averageQuotaPercentage: 100,
  weeklyQuotaPercentage: 100,
  has5HourQuota: false,
  hasWeeklyQuota: true,
  weeklyResetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
  weeklyResetCountdown: '4d 18h',
  geminiGroup: {
    id: 'gemini',
    name: 'Gemini Models',
    weekly: {
      bucketId: 'gemini-weekly',
      displayName: 'Weekly Limit Remaining',
      window: 'weekly',
      percentage: 100,
      remainingFraction: 1.0,
      resetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
      resetCountdown: '4d 18h',
      disabled: false
    },
    buckets: [
      {
        bucketId: 'gemini-weekly',
        displayName: 'Weekly Limit Remaining',
        window: 'weekly',
        percentage: 100,
        remainingFraction: 1.0,
        resetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
        resetCountdown: '4d 18h',
        disabled: false
      }
    ]
  },
  claudeGptGroup: {
    id: 'claude_gpt',
    name: 'Claude and GPT models',
    weekly: {
      bucketId: 'claude-weekly',
      displayName: 'Weekly Limit Remaining',
      window: 'weekly',
      percentage: 100,
      remainingFraction: 1.0,
      resetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
      resetCountdown: '4d 18h',
      disabled: false
    },
    buckets: [
      {
        bucketId: 'claude-weekly',
        displayName: 'Weekly Limit Remaining',
        window: 'weekly',
        percentage: 100,
        remainingFraction: 1.0,
        resetTime: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
        resetCountdown: '4d 18h',
        disabled: false
      }
    ]
  },
  quotas: [
    {
      id: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      groupName: 'Gemini Models',
      percentage: 100,
      remainingFraction: 1.0,
      windowType: 'weekly',
      windowLabel: 'Weekly Plan Quota',
      disabled: false
    },
    {
      id: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      groupName: 'Claude and GPT models',
      percentage: 100,
      remainingFraction: 1.0,
      windowType: 'weekly',
      windowLabel: 'Weekly Plan Quota',
      disabled: false
    }
  ]
};

// 7. Free Account - All Depleted (0% Gemini Weekly, 0% Claude Weekly)
export const MOCK_FREE_DEPLETED: AccountInfo = {
  ...MOCK_FREE_HEALTHY,
  id: 'free-depleted-07',
  email: 'free.depleted@gmail.com',
  name: 'Riley Davis',
  status: 'low_balance',
  statusMessage: 'All model quotas depleted',
  averageQuotaPercentage: 0,
  weeklyQuotaPercentage: 0,
  geminiGroup: {
    ...MOCK_FREE_HEALTHY.geminiGroup!,
    weekly: {
      ...MOCK_FREE_HEALTHY.geminiGroup!.weekly!,
      percentage: 0,
      remainingFraction: 0.0
    },
    buckets: [
      {
        ...MOCK_FREE_HEALTHY.geminiGroup!.buckets[0],
        percentage: 0,
        remainingFraction: 0.0
      }
    ]
  },
  claudeGptGroup: {
    ...MOCK_FREE_HEALTHY.claudeGptGroup!,
    weekly: {
      ...MOCK_FREE_HEALTHY.claudeGptGroup!.weekly!,
      percentage: 0,
      remainingFraction: 0.0
    },
    buckets: [
      {
        ...MOCK_FREE_HEALTHY.claudeGptGroup!.buckets[0],
        percentage: 0,
        remainingFraction: 0.0
      }
    ]
  }
};

// 7b. Free Account - Gemini Depleted but Claude Available (Gemini 0%, Claude 85%)
export const MOCK_FREE_GEMINI_DEPLETED: AccountInfo = {
  ...MOCK_FREE_HEALTHY,
  id: 'free-gemini-depleted-07b',
  email: 'free.gemini.depleted@gmail.com',
  name: 'Morgan Blake',
  status: 'healthy',
  statusMessage: 'Gemini depleted · Claude available',
  averageQuotaPercentage: 26,
  weeklyQuotaPercentage: 26,
  geminiGroup: {
    ...MOCK_FREE_HEALTHY.geminiGroup!,
    weekly: {
      ...MOCK_FREE_HEALTHY.geminiGroup!.weekly!,
      percentage: 0,
      remainingFraction: 0.0
    },
    buckets: [
      {
        ...MOCK_FREE_HEALTHY.geminiGroup!.buckets[0],
        percentage: 0,
        remainingFraction: 0.0
      }
    ]
  },
  claudeGptGroup: {
    ...MOCK_FREE_HEALTHY.claudeGptGroup!,
    weekly: {
      ...MOCK_FREE_HEALTHY.claudeGptGroup!.weekly!,
      percentage: 85,
      remainingFraction: 0.85
    },
    buckets: [
      {
        ...MOCK_FREE_HEALTHY.claudeGptGroup!.buckets[0],
        percentage: 85,
        remainingFraction: 0.85
      }
    ]
  }
};

// 7c. Downgraded Free Account (Expired from Pro to Free: 5h stripped, only weekly remains)
export const MOCK_DOWNGRADED_FREE: AccountInfo = {
  ...MOCK_FREE_HEALTHY,
  id: 'downgraded-free-07c',
  email: 'downgraded.expired@gmail.com',
  name: 'Sam Fisher (Downgraded)',
  status: 'healthy',
  accountType: 'Standard Free',
  tierBadge: 'STANDARD FREE',
  has5HourQuota: false,
  hasWeeklyQuota: true,
  averageQuotaPercentage: 80,
  weeklyQuotaPercentage: 80
};

// 8. Ultra Account - Healthy (Ultra tier, 4.0x capacity weight)
export const MOCK_ULTRA_HEALTHY: AccountInfo = {
  ...MOCK_PRO_HEALTHY,
  id: 'ultra-healthy-08',
  email: 'ultra.user@gmail.com',
  name: 'Elena Rostova',
  isActive: false,
  accountType: 'Google AI Ultra',
  tierBadge: 'ULTRA',
  averageQuotaPercentage: 100,
  fiveHourQuotaPercentage: 100,
  weeklyQuotaPercentage: 100
};

// 9. Enterprise Account - Healthy (Enterprise tier, 5.0x capacity weight)
export const MOCK_ENTERPRISE_HEALTHY: AccountInfo = {
  ...MOCK_PRO_HEALTHY,
  id: 'enterprise-healthy-09',
  email: 'enterprise.corp@company.com',
  name: 'DevOps Lead',
  isActive: false,
  accountType: 'Antigravity Enterprise',
  tierBadge: 'ENTERPRISE',
  averageQuotaPercentage: 100,
  fiveHourQuotaPercentage: 100,
  weeklyQuotaPercentage: 100
};

// 10. Auth Failed Account (Tokens expired or revoked)
export const MOCK_AUTH_FAILED: AccountInfo = {
  id: 'auth-failed-10',
  email: 'auth.expired@gmail.com',
  name: 'Chris Evans',
  isActive: false,
  addedAt: '2026-09-01T00:00:00.000Z',
  status: 'auth_failed',
  statusMessage: 'Credentials expired. Re-login required.',
  isBanned: false,
  accountType: 'Google AI Pro',
  tierBadge: 'PRO',
  averageQuotaPercentage: 0,
  quotas: []
};

// 11. Banned Account (ToS suspended by Google)
export const MOCK_BANNED: AccountInfo = {
  id: 'banned-11',
  email: 'banned.account@gmail.com',
  name: 'Pat Banned',
  isActive: false,
  addedAt: '2026-08-01T00:00:00.000Z',
  status: 'banned',
  isBanned: true,
  banReason: 'Account suspended by Google Terms of Service',
  statusMessage: 'Account suspended by Google Terms of Service',
  accountType: 'Google AI Pro',
  tierBadge: 'PRO',
  averageQuotaPercentage: 0,
  quotas: []
};

// 12. Uninitialized Account (Brand new, quotas pending first fetch)
export const MOCK_UNINITIALIZED: AccountInfo = {
  id: 'uninit-12',
  email: 'new.member@gmail.com',
  name: 'New Member',
  isActive: false,
  addedAt: '2026-10-16T18:40:00.000Z',
  status: 'healthy',
  isBanned: false,
  accountType: 'Standard Free',
  tierBadge: 'STANDARD FREE',
  quotas: []
};

// Complete test collection of all mock accounts
export const ALL_MOCK_ACCOUNTS: AccountInfo[] = [
  MOCK_PRO_HEALTHY,
  MOCK_PRO_GEMINI_DEPLETED,
  MOCK_PRO_CLAUDE_DEPLETED,
  MOCK_PRO_ALL_DEPLETED,
  MOCK_PRO_LOW_QUOTA,
  MOCK_FREE_HEALTHY,
  MOCK_FREE_DEPLETED,
  MOCK_FREE_GEMINI_DEPLETED,
  MOCK_DOWNGRADED_FREE,
  MOCK_ULTRA_HEALTHY,
  MOCK_ENTERPRISE_HEALTHY,
  MOCK_AUTH_FAILED,
  MOCK_BANNED,
  MOCK_UNINITIALIZED
];

// Raw Google Cloud Code PA API response payloads for testing parser resilience
export const MOCK_RAW_RESPONSES = {
  // Pro with "5 Hour Limit Remaining" (space, not hyphen)
  proWithSpaceInBucketName: {
    cloudaicompanionProject: 'project-pro-123',
    currentTier: { id: 'pro', name: 'Google AI Pro' },
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              displayName: '5 Hour Limit Remaining',
              window: '5h',
              remainingFraction: 1.0,
              quotaResetUTCTimestamp: new Date(Date.now() + 5 * 3600 * 1000).toISOString()
            }
          ]
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              displayName: '5-Hour Limit Remaining',
              window: '5h',
              remainingFraction: 1.0,
              quotaResetUTCTimestamp: new Date(Date.now() + 5 * 3600 * 1000).toISOString()
            },
            {
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remainingFraction: 0.9,
              quotaResetUTCTimestamp: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
            }
          ]
        }
      ]
    }
  },

  // Pro with Gemini depleted (0.0 float omitted in proto3 serialization)
  proGeminiDepletedProto3: {
    cloudaicompanionProject: 'project-pro-123',
    currentTier: { id: 'pro', name: 'Google AI Pro' },
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              displayName: '5 Hour Limit Remaining',
              window: '5h',
              // remainingFraction omitted = 0.0
              quotaResetUTCTimestamp: new Date(Date.now() + 5 * 3600 * 1000).toISOString()
            }
          ]
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              displayName: '5 Hour Limit Remaining',
              window: '5h',
              remainingFraction: 1.0
            },
            {
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remainingFraction: 1.0
            }
          ]
        }
      ]
    }
  },

  // Free tier with single Weekly bucket
  freeTierStandard: {
    cloudaicompanionProject: 'project-free-456',
    currentTier: { id: 'free-tier', name: 'Free Tier' },
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remainingFraction: 1.0,
              quotaResetUTCTimestamp: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString()
            }
          ]
        }
      ]
    }
  },

  // Free tier with unbranded bucket displayName (e.g. "Limit Remaining")
  freeTierGenericBucket: {
    cloudaicompanionProject: 'project-free-789',
    currentTier: 'free',
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              displayName: 'Limit Remaining',
              remainingFraction: 0.85,
              quotaResetUTCTimestamp: new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString()
            }
          ]
        }
      ]
    }
  }
};
