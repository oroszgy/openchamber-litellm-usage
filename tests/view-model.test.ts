import { expect, test } from 'bun:test';
import type { UsageResponse } from '../shared/wire';
import { buildView, formatUsd, usedPercent } from '../status/view-model';

test('formatUsd uses two decimals, four only under a cent, and $0.00 for zero', () => {
  expect(formatUsd(1536.61)).toBe('$1,536.61');
  expect(formatUsd(12.5)).toBe('$12.50');
  expect(formatUsd(0.1234)).toBe('$0.12');
  expect(formatUsd(0.005)).toBe('$0.0050');
  expect(formatUsd(0)).toBe('$0.00');
  expect(formatUsd(1)).toBe('$1.00');
});

test('buildView shows the three rolling rows for an unbudgeted key', () => {
  const usage: UsageResponse = { rolling: { day: 1.2, week: 8.4, month: 21 } };
  expect(buildView(usage)).toEqual({
    rows: [
      { label: 'Today', value: '$1.20' },
      { label: 'Last 7 days', value: '$8.40' },
      { label: 'Last 30 days', value: '$21.00' },
    ],
    notice: null,
  });
});

test('a budget window adds the percentage and spend/cap to its row', () => {
  const usage: UsageResponse = {
    rolling: { day: 0, week: 18, month: 21 },
    budgets: {
      day: { cap: 10, spend: 8.4 },
      month: { cap: 100, spend: 21 },
    },
  };

  expect(buildView(usage).rows).toEqual([
    { label: 'Today', value: '84%', detail: '$8.40 of $10.00', tone: 'error' },
    { label: 'Last 7 days', value: '$18.00' },
    { label: 'Last 30 days', value: '21%', detail: '$21.00 of $100.00' },
  ]);
});

test('a total cap appends a Total row', () => {
  const usage: UsageResponse = {
    rolling: { day: 0, week: 0, month: 0 },
    budgets: { total: { cap: 100, spend: 42 } },
  };

  expect(buildView(usage).rows.at(-1)).toEqual({
    label: 'Total',
    value: '42%',
    detail: '$42.00 of $100.00',
  });
});

test('the tone follows the native 50% / 80% thresholds', () => {
  const tone = (spend: number) =>
    buildView({ budgets: { day: { cap: 100, spend } } }).rows[0]?.tone;

  expect(tone(49)).toBeUndefined();
  expect(tone(50)).toBe('warning');
  expect(tone(79)).toBe('warning');
  expect(tone(80)).toBe('error');
  expect(tone(100)).toBe('error');
});

test('usedPercent rounds, clamps and handles a zero cap', () => {
  expect(usedPercent({ cap: 3, spend: 1 })).toBe(33);
  expect(usedPercent({ cap: 0, spend: 0 })).toBe(0);
  expect(usedPercent({ cap: 0, spend: 1 })).toBe(100);
  expect(usedPercent({ cap: 10, spend: 20 })).toBe(100);
});

test('a missing rolling read keeps the budget rows and surfaces the notice', () => {
  const view = buildView({
    budgets: { month: { cap: 100, spend: 21 } },
    notice: 'Rolling spend is unavailable for this key.',
  });

  expect(view.rows).toEqual([
    { label: 'Last 30 days', value: '21%', detail: '$21.00 of $100.00' },
  ]);
  expect(view.notice).toBe('Rolling spend is unavailable for this key.');
});

test('no rows and no notice is still a well-formed view', () => {
  expect(buildView({})).toEqual({ rows: [], notice: null });
});
