/**
 * The LiteLLM calls and their normalisation: the key's own spend from
 * `GET /key/info`, and the user's daily buckets from `GET /user/daily/activity`
 * for rolling day/week/month spend. Raw LiteLLM JSON never leaves this module.
 *
 * Both calls read the same `Target` — the proxy the section is pointed at — and
 * `readDailyActivity` also needs the windows the caller has already placed on
 * the local calendar (`service/dates.ts`).
 */
import { createHash } from 'node:crypto';
import type { DailyBucket } from './dates.ts';
import type { SpendKind } from '../shared/wire.ts';

export type KeyInfoFailure = 'unauthorized' | 'unsupported_proxy' | 'provider_unreachable' | 'upstream_error';

/** A LiteLLM proxy and the virtual key to read it with. */
export type Target = { host: string; key: string };

export type KeyInfo =
  | { ok: true; spend: number; spendKind: SpendKind; userId?: string | undefined }
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
  if (!info || typeof info.spend !== 'number') return { ok: false, code: 'unsupported_proxy' };

  const userId = typeof info.user_id === 'string' ? info.user_id : undefined;
  const budgetDuration = info.budget_duration;
  const windowed = typeof budgetDuration === 'string' && budgetDuration.length > 0;
  return { ok: true, spend: info.spend, spendKind: windowed ? 'window' : 'lifetime', userId };
}

/** Returns the daily buckets, or `null` when the activity call can't be used. */
export async function readDailyActivity(
  fetchImpl: typeof fetch,
  target: Target,
  startDate: string,
  endDate: string,
  timezoneOffsetMinutes: number,
): Promise<DailyBucket[] | null> {
  const query = new URLSearchParams({
    api_key: createHash('sha256').update(target.key).digest('hex'),
    start_date: startDate,
    end_date: endDate,
    include_current_utc_day: 'true',
    timezone: String(timezoneOffsetMinutes),
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

  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;

  const buckets: DailyBucket[] = [];
  for (const result of results) {
    const date = (result as { date?: unknown }).date;
    const spend = (result as { metrics?: { spend?: unknown } }).metrics?.spend;
    if (typeof date === 'string' && typeof spend === 'number') buckets.push({ date, spend });
  }
  return buckets;
}
