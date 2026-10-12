import { expect, test } from 'bun:test';
import type { UsageResponse } from '../shared/wire';
import { buildView, formatUsd } from '../status/view-model';

const base: UsageResponse = {
  provider: { id: 'litellm', name: 'LiteLLM', host: 'https://proxy.example.com' },
  asOf: '2026-10-09T12:00:00.000Z',
  spend: 1536.61,
  spendKind: 'lifetime',
};

test('formatUsd uses two decimals, four under a dollar', () => {
  expect(formatUsd(1536.61)).toBe('$1,536.61');
  expect(formatUsd(12.5)).toBe('$12.50');
  expect(formatUsd(0.1234)).toBe('$0.1234');
  expect(formatUsd(0)).toBe('$0.0000');
});

test('buildView formats spend and the rolling rows', () => {
  const view = buildView({ ...base, rolling: { day: 1.2, week: 8.4, month: 21 } });

  expect(view.spendLabel).toBe('Lifetime spend');
  expect(view.spendValue).toBe('$1,536.61');
  expect(view.rolling).toEqual([
    { label: 'Today', value: '$1.20' },
    { label: 'Last 7 days', value: '$8.40' },
    { label: 'Last 30 days', value: '$21.00' },
  ]);
  expect(view.degraded).toBeNull();
});

test('a windowed key labels its figure Spend, not Lifetime spend', () => {
  const view = buildView({ ...base, spend: 12.5, spendKind: 'window' });
  expect(view.spendLabel).toBe('Spend');
  expect(view.spendValue).toBe('$12.50');
});

test('buildView omits rolling rows and surfaces a degraded note', () => {
  const view = buildView({
    ...base,
    spend: 5,
    degraded: [
      { figure: 'rolling', code: 'rolling_unavailable', message: 'Rolling spend is unavailable for this key.' },
    ],
  });

  expect(view.spendValue).toBe('$5.00');
  expect(view.rolling).toEqual([]);
  expect(view.degraded).toBe('Rolling spend is unavailable for this key.');
});
