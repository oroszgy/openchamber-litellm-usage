/**
 * Local-calendar date arithmetic for the rolling spend windows.
 *
 * Pure and ambient-clock free: every function takes the instant or the zone it
 * needs, so the bucketing is testable across DST boundaries and local midnight.
 */
import type { Rolling } from '../shared/wire.ts';

export type DailyBucket = { date: string; spend: number };

/** The host's UTC offset in minutes at `date`, `getTimezoneOffset()` convention. */
export function offsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value ?? '0');
  const wallClock = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return Math.round((date.getTime() - wallClock) / 60000);
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
