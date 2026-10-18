import test, { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseCountdownFromDescription,
  synthesizeResetTimeFromDescription,
  formatCountdown
} from '../src/quota/quotaFormatters';
import { QuotaParser } from '../src/quota/quotaParser';
import { is5HourBucket, isWeeklyBucket } from '../src/quota/quotaClassifier';
import { AccountInfo } from '../src/types';

describe('Description Countdown Parsing and Weekly Reset Preservation', () => {
  it('parses various Google Cloud Code PA description strings into countdowns', () => {
    assert.strictEqual(
      parseCountdownFromDescription('You have used some of your weekly limit, it will fully refresh in 6 days, 15 hours.'),
      '6d 15h'
    );
    assert.strictEqual(
      parseCountdownFromDescription('You have used some of your weekly limit, it will fully refresh in 3 days, 22 hours.'),
      '3d 22h'
    );
    assert.strictEqual(
      parseCountdownFromDescription('it will fully refresh in 4 days, 1 hour.'),
      '4d 1h'
    );
    assert.strictEqual(
      parseCountdownFromDescription('You have used some of your 5-hour limit, it will fully refresh in 1 hour, 42 minutes.'),
      '1h 42m'
    );
    assert.strictEqual(
      parseCountdownFromDescription('Your limit will fully refresh in 25 minutes.'),
      '25m'
    );
    assert.strictEqual(
      parseCountdownFromDescription('it will fully refresh in 2 days.'),
      '2d'
    );
    assert.strictEqual(parseCountdownFromDescription(''), undefined);
    assert.strictEqual(parseCountdownFromDescription(undefined), undefined);
  });

  it('synthesizes valid future ISO reset time from description', () => {
    const iso = synthesizeResetTimeFromDescription('it will fully refresh in 6 days, 15 hours.');
    assert.ok(iso);
    const target = new Date(iso).getTime();
    const diffHours = (target - Date.now()) / (1000 * 60 * 60);
    // 6 days 15 hours = 159 hours
    assert.ok(diffHours > 158 && diffHours < 160);
  });

  it('Weekly model quota preserves weekly bucket resetTime instead of short 5h burst limit', () => {
    const parser = new QuotaParser();
    const futureWeekly = new Date(Date.now() + 6 * 24 * 3600 * 1000 + 15 * 3600 * 1000).toISOString(); // 6d 15h
    const shortBurst5h = new Date(Date.now() + 1.8 * 3600 * 1000).toISOString(); // 1h 48m

    const rawData = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              displayName: 'Five Hour Limit Remaining',
              window: '5h',
              remainingFraction: 1.0,
              resetTime: shortBurst5h
            },
            {
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remainingFraction: 0.9,
              resetTime: futureWeekly,
              description: 'You have used some of your weekly limit, it will fully refresh in 6 days, 15 hours.'
            }
          ]
        }
      ],
      models: {
        'gemini-2.5-pro': {
          displayName: 'Gemini 2.5 Pro',
          quotaInfo: {
            remainingFraction: 0.9,
            resetTime: shortBurst5h // Google returns 5h burst reset time on model level
          }
        },
        'gemini-2.5-flash': {
          displayName: 'Gemini 2.5 Flash',
          quotaInfo: {
            remainingFraction: 1.0,
            resetTime: shortBurst5h
          }
        }
      }
    };

    const dummyAcc: AccountInfo = {
      email: 'pro.user@example.com',
      name: 'Pro User',
      isActive: true,
      accountType: 'Google AI Pro',
      tierBadge: 'PRO'
    };

    const res = parser.processQuotaData(rawData, dummyAcc);

    // Weekly bucket must use description countdown: '6d 15h'
    const wkBucket = res.geminiGroup?.weekly;
    assert.ok(wkBucket);
    assert.strictEqual(wkBucket.resetCountdown, '6d 15h');

    // Gemini 2.5 Pro with shortBurst5h (1h 48m) is accurately classified as 5h model and retains 1h countdown
    const proModel = res.quotas.find(q => q.id === 'gemini-2.5-pro');
    assert.ok(proModel);
    assert.strictEqual(proModel.windowType, '5h');
    assert.strictEqual(proModel.windowLabel, '5-Hour Rolling Window');
    assert.ok(proModel.resetCountdown?.includes('1h'));

    // Gemini 2.5 Flash (5h model) keeps 5h reset countdown
    const flashModel = res.quotas.find(q => q.id === 'gemini-2.5-flash');
    assert.ok(flashModel);
    assert.strictEqual(flashModel.windowType, '5h');
    assert.ok(flashModel.resetCountdown?.includes('1h'));
  });

  it('bucket discriminator prevents undefined bucketId from collapsing 5h and weekly buckets', () => {
    // Simulate two buckets without bucketId
    const bucket5h = { displayName: 'Five Hour Limit Remaining', remainingFraction: 1.0 };
    const bucketWk = { displayName: 'Weekly Limit Remaining', remainingFraction: 0.9 };

    const isMatch = (b: any, nb: any) => {
      const bIs5h = is5HourBucket(b.window, b.bucketId, b.displayName);
      const nbIs5h = is5HourBucket(nb.window, nb.bucketId, nb.displayName);
      const bIsWk = isWeeklyBucket(b.window, b.bucketId, b.displayName);
      const nbIsWk = isWeeklyBucket(nb.window, nb.bucketId, nb.displayName);
      if (nbIs5h || bIs5h) return bIs5h && nbIs5h;
      if (nbIsWk || bIsWk) return bIsWk && nbIsWk;
      if (b.bucketId && nb.bucketId) return b.bucketId === nb.bucketId;
      if (b.displayName && nb.displayName) return b.displayName.trim().toLowerCase() === nb.displayName.trim().toLowerCase();
      return false;
    };

    // 5h must NOT match Weekly even though b.bucketId === nb.bucketId (undefined === undefined)
    assert.strictEqual(isMatch(bucket5h, bucketWk), false);
    // 5h matches 5h
    assert.strictEqual(isMatch(bucket5h, { displayName: '5-hour limit', window: '5h' }), true);
    // Weekly matches Weekly
    assert.strictEqual(isMatch(bucketWk, { displayName: 'Weekly Limit Remaining', window: 'weekly' }), true);
  });

  it('accurately parses authentic Language Server Connect-RPC quota payload matching IDE native UI', () => {
    const parser = new QuotaParser();
    const lspPayload = {
      userTier: {
        id: 'g1-pro-tier',
        name: 'Google AI Pro'
      },
      paidTier: {
        id: 'g1-pro-tier',
        name: 'Google AI Pro'
      },
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                description: 'You have used some of your weekly limit, it will fully refresh in 6 days, 12 hours.',
                window: 'weekly',
                remainingFraction: 0.6820164,
                resetTime: '2026-10-24T04:41:39Z'
              },
              {
                bucketId: 'gemini-5h',
                displayName: 'Five Hour Limit Remaining',
                description: 'You have used some of your 5-hour limit, it will fully refresh in 3 hours, 49 minutes.',
                window: '5h',
                remainingFraction: 0.7191028,
                resetTime: '2026-10-17T19:41:39Z'
              }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
            buckets: [
              {
                bucketId: '3p-weekly',
                displayName: 'Weekly Limit Remaining',
                window: 'weekly',
                remainingFraction: 1,
                resetTime: '2026-10-24T16:02:22Z'
              },
              {
                bucketId: '3p-5h',
                displayName: 'Five Hour Limit Remaining',
                window: '5h',
                remainingFraction: 1,
                resetTime: '2026-10-17T21:02:22Z'
              }
            ]
          }
        ]
      }
    };

    const dummyAccount: AccountInfo = {
      id: 'acc-pro',
      email: 'pro.active@gmail.com',
      name: 'Alex Rivera',
      isActive: true,
      addedAt: Date.now()
    };

    const parsed = parser.processQuotaData(lspPayload, dummyAccount);

    assert.strictEqual(parsed.tierBadge, 'PRO');
    assert.strictEqual(parsed.accountType, 'Google AI Pro');
    // Gemini Weekly must be ~68% with 6d 12h countdown
    assert.strictEqual(parsed.geminiGroup?.weekly?.percentage, 68);
    assert.strictEqual(parsed.geminiGroup?.weekly?.resetCountdown, '6d 12h');
    // Gemini 5h must be ~72% with ~3h countdown
    assert.strictEqual(parsed.geminiGroup?.fiveHour?.percentage, 72);
    assert.ok(parsed.geminiGroup?.fiveHour?.resetCountdown?.includes('3h') || parsed.geminiGroup?.fiveHour?.resetCountdown?.includes('4h'));
    // Claude 5h and Weekly must be 100%
    assert.strictEqual(parsed.claudeGptGroup?.weekly?.percentage, 100);
    assert.strictEqual(parsed.claudeGptGroup?.fiveHour?.percentage, 100);
  });

  it('Model with short burst resetTime is classified as 5h and does not corrupt authentic weekly bucket', () => {
    const parser = new QuotaParser();
    const futureWeekly = new Date(Date.now() + 6 * 24 * 3600 * 1000 + 23 * 3600 * 1000).toISOString();
    const shortBurst5h = new Date(Date.now() + 4.5 * 3600 * 1000).toISOString();

    const payload = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remainingFraction: 1.0,
              resetTime: futureWeekly,
              description: 'You have used some of your weekly limit, it will fully refresh in 6 days, 23 hours.'
            },
            {
              bucketId: 'gemini-5h',
              displayName: 'Five Hour Limit Remaining',
              window: '5h',
              remainingFraction: 0.84,
              resetTime: shortBurst5h
            }
          ]
        }
      ],
      models: {
        'gemini-2.5-pro': {
          displayName: 'Gemini 2.5 Pro',
          quotaInfo: {
            remainingFraction: 0.84,
            resetTime: shortBurst5h
          }
        },
        'gemini-3.8-flash-tiered': {
          displayName: 'Gemini 3.8 Flash',
          quotaInfo: {
            remainingFraction: 0.84,
            resetTime: shortBurst5h
          }
        }
      }
    };

    const dummyAccount: AccountInfo = {
      id: 'acc-pro-user',
      email: 'pro.active@gmail.com',
      name: 'Alex Rivera',
      isActive: true,
      accountType: 'Google AI Pro',
      tierBadge: 'PRO'
    };

    const parsed = parser.processQuotaData(payload, dummyAccount);

    // 1. Weekly bucket remains authentic at 100% and resets in 6d 23h
    assert.strictEqual(parsed.geminiGroup?.weekly?.percentage, 100);
    assert.strictEqual(parsed.geminiGroup?.weekly?.resetCountdown, '6d 23h');

    // 2. 5-hour rolling bucket remains accurate at 84%
    assert.strictEqual(parsed.geminiGroup?.fiveHour?.percentage, 84);

    // 3. Gemini 2.5 Pro model is accurately classified as 5h rolling window due to shortBurst5h
    const proModel = parsed.quotas.find(q => q.id === 'gemini-2.5-pro');
    assert.ok(proModel);
    assert.strictEqual(proModel.windowType, '5h');
    assert.strictEqual(proModel.windowLabel, '5-Hour Rolling Window');
    assert.ok(proModel.resetCountdown?.includes('4h') || proModel.resetCountdown?.includes('5h'));
  });



  it('Live weekly model consumption synchronizes weekly bucket for Gemini and Claude', () => {
    const parser = new QuotaParser();
    const futureWeekly = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();

    const payload = {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remainingFraction: 1.0,
              resetTime: futureWeekly
            }
          ]
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remainingFraction: 1.0,
              resetTime: futureWeekly
            }
          ]
        }
      ],
      models: {
        'gemini-2.5-pro': {
          displayName: 'Gemini 2.5 Pro',
          quotaInfo: {
            remainingFraction: 0.50,
            resetTime: futureWeekly
          }
        },
        'claude-sonnet-4-6': {
          displayName: 'Claude Sonnet 4.6',
          quotaInfo: {
            remainingFraction: 0.60,
            resetTime: futureWeekly
          }
        }
      }
    };

    const dummyAccount: AccountInfo = {
      id: 'acc-pro-models',
      email: 'pro.models@gmail.com',
      name: 'Pro Models User',
      isActive: true,
      accountType: 'Google AI Pro',
      tierBadge: 'PRO'
    };

    const parsed = parser.processQuotaData(payload, dummyAccount);

    // Gemini weekly syncs with Gemini 2.5 Pro (50%)
    assert.strictEqual(parsed.geminiGroup?.weekly?.percentage, 50);
    // Claude weekly syncs with Claude Sonnet 4.6 (60%)
    assert.strictEqual(parsed.claudeGptGroup?.weekly?.percentage, 60);
    // Combined weekly: 50 * 0.85 + 60 * 0.15 = 42.5 + 9 = 51.5 -> 52%
    assert.strictEqual(parsed.weeklyPercentage, 52);
  });
});

