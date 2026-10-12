import { expect, test } from 'bun:test';
import { bucketRolling, localDate, offsetMinutes, shiftDate } from '../service/dates';

test('localDate reads the calendar day in the named zone', () => {
  const late = new Date('2026-10-09T22:30:00.000Z');
  expect(localDate(late, 'UTC')).toBe('2026-10-09');
  expect(localDate(late, 'Europe/Budapest')).toBe('2026-10-10');
});

test('offsetMinutes tracks the zone across a DST boundary', () => {
  // JS `getTimezoneOffset` sign: Budapest is UTC+1 in winter (−60) and UTC+2
  // under summer time (−120); the EU switch is the last Sunday of March
  // (2026-03-29).
  expect(offsetMinutes(new Date('2026-03-28T12:00:00.000Z'), 'Europe/Budapest')).toBe(-60);
  expect(offsetMinutes(new Date('2026-03-30T12:00:00.000Z'), 'Europe/Budapest')).toBe(-120);
  expect(offsetMinutes(new Date('2026-10-09T12:00:00.000Z'), 'UTC')).toBe(0);
});

test('shiftDate moves whole days and crosses month and year ends', () => {
  expect(shiftDate('2026-10-09', -6)).toBe('2026-10-03');
  expect(shiftDate('2026-10-09', -29)).toBe('2026-09-10');
  expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
  expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
});

test('bucketRolling sums today, the last 7 and the last 30, ignoring older', () => {
  const today = '2026-10-09';
  const buckets = [
    { date: '2026-10-09', spend: 1.2 },
    { date: '2026-10-08', spend: 1.0 },
    { date: '2026-10-05', spend: 0.5 },
    { date: '2026-09-20', spend: 3.0 },
    { date: '2026-08-01', spend: 9.0 },
  ];
  expect(bucketRolling(buckets, today)).toEqual({ day: 1.2, week: 2.7, month: 5.7 });
});

test('bucketRolling includes today in both the 7- and 30-day windows', () => {
  const today = '2026-10-09';
  const buckets = [
    { date: today, spend: 2 }, // day + week + month
    { date: shiftDate(today, -6), spend: 3 }, // week + month
    { date: shiftDate(today, -7), spend: 5 }, // month only
    { date: shiftDate(today, -29), spend: 4 }, // month (its last day)
    { date: shiftDate(today, -30), spend: 100 }, // out of every window
  ];
  expect(bucketRolling(buckets, today)).toEqual({ day: 2, week: 5, month: 14 });
});
