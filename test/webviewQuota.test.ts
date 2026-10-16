import test from 'node:test';
import assert from 'node:assert';
import {
  calculateModulatedInstantQuota,
  quotaFillClass,
  quotaTextClass,
  formatCountdown,
  SAFE_WEEKLY_THRESHOLDS
} from '../src/webview/src/lib/quota';

test('Instant Quota Modulation Logic', async (t) => {
  await t.test('Health factor is 1.0 when weekly quota is above or equal to safe threshold', () => {
    // Gemini safe threshold is 25%
    const fullGemini = calculateModulatedInstantQuota(100, 30, SAFE_WEEKLY_THRESHOLDS.GEMINI);
    assert.strictEqual(fullGemini, 100);

    const boundaryGemini = calculateModulatedInstantQuota(80, 25, SAFE_WEEKLY_THRESHOLDS.GEMINI);
    assert.strictEqual(boundaryGemini, 80);

    // Claude safe threshold is 50%
    const fullClaude = calculateModulatedInstantQuota(100, 60, SAFE_WEEKLY_THRESHOLDS.CLAUDE_GPT);
    assert.strictEqual(fullClaude, 100);
  });

  await t.test('Health factor attenuates instant quota when weekly capacity is low', () => {
    // Gemini: weekly quota is 12.5% (half of 25% threshold) -> healthFactor = 0.5 -> 100 * 0.5 = 50%
    const attenuatedGemini = calculateModulatedInstantQuota(100, 12.5, SAFE_WEEKLY_THRESHOLDS.GEMINI);
    assert.strictEqual(attenuatedGemini, 50);

    // Claude: weekly quota is 25% (half of 50% threshold) -> healthFactor = 0.5 -> 80 * 0.5 = 40%
    const attenuatedClaude = calculateModulatedInstantQuota(80, 25, SAFE_WEEKLY_THRESHOLDS.CLAUDE_GPT);
    assert.strictEqual(attenuatedClaude, 40);

    // Weekly is 0% -> instant is 0%
    const emptyWeekly = calculateModulatedInstantQuota(100, 0, SAFE_WEEKLY_THRESHOLDS.DEFAULT);
    assert.strictEqual(emptyWeekly, 0);
  });

  await t.test('Returns raw 5h quota if weekly quota is undefined', () => {
    assert.strictEqual(calculateModulatedInstantQuota(75, undefined), 75);
  });
});

test('Quota Color and Text Mapping', async (t) => {
  await t.test('Correct color classes for emerald, amber, and rose boundaries', () => {
    assert.strictEqual(quotaFillClass(100), 'bg-emerald-500');
    assert.strictEqual(quotaFillClass(51), 'bg-emerald-500');
    assert.strictEqual(quotaFillClass(50), 'bg-amber-500');
    assert.strictEqual(quotaFillClass(21), 'bg-amber-500');
    assert.strictEqual(quotaFillClass(20), 'bg-rose-500');
    assert.strictEqual(quotaFillClass(0), 'bg-rose-500');

    assert.strictEqual(quotaTextClass(80), 'text-emerald-400');
    assert.strictEqual(quotaTextClass(45), 'text-amber-400');
    assert.strictEqual(quotaTextClass(10), 'text-rose-400');
  });
});

test('Format Countdown tests', async (t) => {
  await t.test('Formats past or immediate reset as Ready', () => {
    assert.strictEqual(formatCountdown(new Date(Date.now() - 1000).toISOString()), 'Ready');
  });

  await t.test('Formats future countdown properly', () => {
    const fiveHoursFromNow = new Date(Date.now() + 5 * 3600 * 1000 + 10000).toISOString();
    const cd = formatCountdown(fiveHoursFromNow);
    assert.strictEqual(cd?.includes('h') && cd?.includes('m'), true);
  });
});
