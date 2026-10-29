/**
 * The pure view-model: normalise a `/usage` body into the rows the section
 * shows. No DOM, no ambient clock.
 *
 * Three periods are always asked for. A period with a key budget window shows
 * the window's spend/cap as detail and the used percentage as the value; a
 * period without one shows its rolling amount.
 */
import type { Budget, UsageResponse } from '../shared/wire.ts';

export type ViewTone = 'warning' | 'error';

export type ViewRow = {
  label: string;
  value: string;
  /** The small `$spend of $cap` text beside the label. */
  detail?: string;
  tone?: ViewTone;
};

export type View = {
  rows: ViewRow[];
  notice: string | null;
};

const PERIODS = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: 'Last 7 days' },
  { key: 'month', label: 'Last 30 days' },
] as const;

export function buildView(usage: UsageResponse): View {
  const rows: ViewRow[] = [];

  for (const period of PERIODS) {
    const budget = usage.budgets?.[period.key];
    if (budget) {
      rows.push(budgetRow(period.label, budget));
    } else if (usage.rolling) {
      rows.push({ label: period.label, value: formatUsd(usage.rolling[period.key]) });
    }
  }

  if (usage.budgets?.total) rows.push(budgetRow('Total', usage.budgets.total));

  return { rows, notice: usage.notice ?? null };
}

/** USD with two decimals, four under a cent, and a plain `$0.00` for zero. */
export function formatUsd(value: number): string {
  if (value === 0) return '$0.00';
  const decimals = Math.abs(value) < 0.01 ? 4 : 2;
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Whole-number percentage, clamped to the rollup the bar can show. */
export function usedPercent(budget: Budget): number {
  if (budget.cap <= 0) return budget.spend > 0 ? 100 : 0;
  return Math.round(Math.min(100, Math.max(0, (budget.spend / budget.cap) * 100)));
}

function budgetRow(label: string, budget: Budget): ViewRow {
  const percent = usedPercent(budget);
  const tone: ViewTone | undefined = percent >= 80 ? 'error' : percent >= 50 ? 'warning' : undefined;
  return {
    label,
    value: `${percent}%`,
    detail: `${formatUsd(budget.spend)} of ${formatUsd(budget.cap)}`,
    ...(tone ? { tone } : {}),
  };
}
