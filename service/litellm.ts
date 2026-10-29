/**
 * The LiteLLM calls and their normalisation: the key's own window from
 * `GET /key/info`, and the user's daily buckets from `GET /user/daily/activity`
 * for rolling day/week/month spend. Raw LiteLLM JSON never leaves this module.
 *
 * Both calls read the same `Target` — the proxy the section is pointed at — and
 * `readDailyActivity` also needs the windows the caller has already placed on
 * the local calendar (`service/dates.ts`).
 */
import { createHash } from 'node:crypto';
import type { DailyBucket } from './dates.ts';
import type { BudgetPeriod, Budgets } from '../shared/wire.ts';

export type KeyInfoFailure = 'unauthorized' | 'unsupported_proxy' | 'provider_unreachable' | 'upstream_error';

/** A LiteLLM proxy and the virtual key to read it with. */
export type Target = { host: string; key: string };

export type KeyInfo =
  | { ok: true; spend: number; userId?: string | undefined; budgets?: Budgets | undefined }
  | { ok: false; code: KeyInfoFailure };

/**
 * The probe's deadline. A discovery read probes every candidate in parallel, so
 * one dead endpoint must not stall the whole list.
 */
export const PROBE_TIMEOUT_MS = 2000;

export async function readKeyInfo(
  fetchImpl: typeof fetch,
  target: Target,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<KeyInfo> {
  let response: Response;
  try {
    response = await fetchImpl(`${target.host}/key/info`, {
      headers: { authorization: `Bearer ${target.key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, code: 'provider_unreachable' };
  }

  if (response.status === 401 || response.status === 403) return { ok: false, code: 'unauthorized' };
  if (response.status === 404) return { ok: false, code: 'unsupported_proxy' };
  if (!response.ok) return { ok: false, code: 'upstream_error' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: 'unsupported_proxy' };
  }

  const info = (body as { info?: Record<string, unknown> } | null)?.info;
  const spend = numberAt(info, 'spend');
  if (!info || spend === undefined) return { ok: false, code: 'unsupported_proxy' };

  const userId = typeof info.user_id === 'string' ? info.user_id : undefined;
  const budgets = readBudgets(info, spend);
  return {
    ok: true,
    spend,
    ...(userId !== undefined ? { userId } : {}),
    ...(budgets !== undefined ? { budgets } : {}),
  };
}

/**
 * The key's own windows, mapped onto the section's three periods.
 *
 * `max_budget` + `budget_duration` is the legacy single window; `budget_limits`
 * is the multi-window list, each paired with `budget_limits_usage`. A
 * `max_budget` with no duration is a lifetime cap, shown as `total`. Other
 * durations (5h, 12h, …) are ignored. When both forms cover one period, the
 * tighter one wins.
 */
function readBudgets(info: Record<string, unknown>, spend: number): Budgets | undefined {
  const budgets: Budgets = {};
  const legacyCap = numberAt(info, 'max_budget');
  if (legacyCap !== undefined) {
    const duration = typeof info.budget_duration === 'string' ? info.budget_duration.trim() : '';
    const period = duration.length > 0 ? periodFor(duration) : 'total';
    if (period) keepTighter(budgets, period, { cap: legacyCap, spend });
  }

  const limits = info.budget_limits;
  const usage = info.budget_limits_usage;
  if (Array.isArray(limits) && usage !== null && typeof usage === 'object') {
    const byDuration = usage as Record<string, unknown>;
    for (const entry of limits) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const rawDuration = typeof record.budget_duration === 'string' ? record.budget_duration.trim() : '';
      const cap = numberAt(record, 'max_budget');
      if (rawDuration.length === 0 || cap === undefined) continue;
      const period = periodFor(rawDuration);
      if (!period) continue;
      const usageEntry = byDuration[rawDuration] ?? byDuration[rawDuration.toLowerCase()];
      const windowSpend = numberAt(usageEntry, 'current_spend');
      if (windowSpend === undefined) continue;
      keepTighter(budgets, period, { cap, spend: windowSpend });
    }
  }

  return Object.keys(budgets).length > 0 ? budgets : undefined;
}

function periodFor(duration: string): BudgetPeriod | null {
  switch (duration.toLowerCase()) {
    case '24h':
    case '1d':
    case '1day':
      return 'day';
    case '7d':
    case '1w':
    case '1week':
      return 'week';
    case '30d':
    case '1mo':
    case '1month':
      return 'month';
    default:
      return null;
  }
}

/** Keep the window whose spend is the largest share of its cap. */
function keepTighter(budgets: Budgets, period: BudgetPeriod, candidate: { cap: number; spend: number }): void {
  const current = budgets[period];
  if (!current || ratio(candidate) > ratio(current)) budgets[period] = candidate;
}

function ratio(window: { cap: number; spend: number }): number {
  if (window.cap <= 0) return window.spend > 0 ? Number.POSITIVE_INFINITY : 0;
  return window.spend / window.cap;
}

/** Returns the daily buckets, or `null` when the activity call can't be used. */
export async function readDailyActivity(
  fetchImpl: typeof fetch,
  target: Target,
  startDate: string,
  endDate: string,
  timezoneOffsetMinutes: number,
): Promise<DailyBucket[] | null> {
  const apiKey = createHash('sha256').update(target.key).digest('hex');
  const seen = new Set<string>();
  const buckets: DailyBucket[] = [];

  // The endpoint pages at roughly 15 days. 30 days needs two pages; the cap is
  // a guard against a proxy that never clears `has_more`.
  for (let page = 1; page <= 4; page += 1) {
    const query = new URLSearchParams({
      api_key: apiKey,
      start_date: startDate,
      end_date: endDate,
      include_current_utc_day: 'true',
      timezone: String(timezoneOffsetMinutes),
      page: String(page),
    });

    let response: Response;
    try {
      response = await fetchImpl(`${target.host}/user/daily/activity?${query.toString()}`, {
        headers: { authorization: `Bearer ${target.key}` },
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }

    const pageBody = body as { results?: unknown; metadata?: { has_more?: unknown } } | null;
    const results = pageBody?.results;
    if (!Array.isArray(results)) return null;

    for (const result of results) {
      const date = (result as { date?: unknown }).date;
      const spend = (result as { metrics?: { spend?: unknown } }).metrics?.spend;
      if (typeof date === 'string' && typeof spend === 'number' && !seen.has(date)) {
        seen.add(date);
        buckets.push({ date, spend });
      }
    }

    if (pageBody?.metadata?.has_more !== true) break;
  }

  return buckets;
}

function numberAt(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}
