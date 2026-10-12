/**
 * The pure view-model: normalise a `/usage` body into the strings the section
 * shows. No DOM, no ambient clock — `now` and the time zone are parameters so
 * the formatting is testable.
 */

export type Usage = {
  provider: { id: string; name: string; host: string };
  asOf: string;
  spend: number;
  rolling?: { day: number; week: number; month: number };
  degraded?: Array<{ figure: string; code: string; message: string }>;
};

export type ViewRow = { label: string; value: string };

export type View = {
  total: string;
  rolling: ViewRow[];
  degraded: string | null;
};

/** USD with two decimals, or four under `$1`, thousands-separated. */
export function formatUsd(value: number): string {
  const decimals = Math.abs(value) < 1 ? 4 : 2;
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function buildView(usage: Usage): View {
  return {
    total: formatUsd(usage.spend),
    rolling: usage.rolling
      ? [
          { label: 'Today', value: formatUsd(usage.rolling.day) },
          { label: 'Last 7 days', value: formatUsd(usage.rolling.week) },
          { label: 'Last 30 days', value: formatUsd(usage.rolling.month) },
        ]
      : [],
    degraded: usage.degraded?.[0]?.message ?? null,
  };
}
