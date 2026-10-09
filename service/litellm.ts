/**
 * The LiteLLM calls and their normalisation: the key's own spend from
 * `GET /key/info`, and the user's daily buckets from `GET /user/daily/activity`
 * for rolling day/week/month spend. Raw LiteLLM JSON never leaves this module.
 */
import { createHash } from 'node:crypto';

export type KeyInfoFailure = 'unauthorized' | 'unsupported_proxy' | 'provider_unreachable' | 'upstream_error';
export type KeyInfo =
  | { ok: true; spend: number; userId?: string | undefined }
  | { ok: false; code: KeyInfoFailure };

export type DailyBucket = { date: string; spend: number };
export type Rolling = { day: number; week: number; month: number };

export async function readKeyInfo(
  fetchImpl: typeof fetch,
  host: string,
  key: string,
): Promise<KeyInfo> {
  let response: Response;
  try {
    response = await fetchImpl(`${host}/key/info`, { headers: { authorization: `Bearer ${key}` } });
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
  return { ok: true, spend: info.spend, userId };
}

/** Returns the daily buckets, or `null` when the activity call can't be used. */
export async function readDailyActivity(
  fetchImpl: typeof fetch,
  host: string,
  rawKey: string,
  startDate: string,
  endDate: string,
  timezoneOffsetMinutes: number,
): Promise<DailyBucket[] | null> {
  const query = new URLSearchParams({
    api_key: createHash('sha256').update(rawKey).digest('hex'),
    start_date: startDate,
    end_date: endDate,
    include_current_utc_day: 'true',
    timezone: String(timezoneOffsetMinutes),
  });

  let response: Response;
  try {
    response = await fetchImpl(`${host}/user/daily/activity?${query.toString()}`, {
      headers: { authorization: `Bearer ${rawKey}` },
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

/** The local calendar date (`YYYY-MM-DD`) of `date` in `timeZone`. */
export function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '01';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** `YYYY-MM-DD` shifted by whole days. */
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** Sum the buckets into today, the last 7 days (incl. today) and the last 30. */
export function bucketRolling(buckets: DailyBucket[], today: string): Rolling {
  const weekStart = shiftDate(today, -6);
  const monthStart = shiftDate(today, -29);
  let day = 0;
  let week = 0;
  let month = 0;
  for (const bucket of buckets) {
    if (bucket.date === today) day += bucket.spend;
    if (bucket.date >= weekStart && bucket.date <= today) week += bucket.spend;
    if (bucket.date >= monthStart && bucket.date <= today) month += bucket.spend;
  }
  return { day: round(day), week: round(week), month: round(month) };
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
