// The routine calendar, carried over from JAOA Pragati: these are the rules staff rely on to know
// what is due, so each frequency is pinned down by example.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, dayStatus, describe, isLate, localNow, occursOn, versionOn, zonedInstant, type Schedule } from '../server/src/services/schedule.ts';

const base: Schedule = { effective_from: '2026-01-01', frequency: 'daily', every: 1, weekdays: [], month_days: [], starts_on: '2026-01-01',
  ends_on: null, start_time: null, end_time: null, paused: false, remarks: 'exception', reading_label: null, reading_unit: null,
  photo_required: false, reference_required: false };
const s = (o: Partial<Schedule>): Schedule => ({ ...base, ...o });
const days = (sch: Schedule, from: string, n: number) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) { const d = addDays(from, i); if (occursOn(sch, d)) out.push(d); }
  return out;
};

test('daily and every-n-days', () => {
  assert.equal(days(s({}), '2026-01-01', 5).length, 5);
  assert.deepEqual(days(s({ every: 3 }), '2026-01-01', 8), ['2026-01-01', '2026-01-04', '2026-01-07']);
  assert.deepEqual(days(s({ starts_on: '2026-01-03', ends_on: '2026-01-04' }), '2026-01-01', 6), ['2026-01-03', '2026-01-04']);
  assert.deepEqual(days(s({ paused: true }), '2026-01-01', 5), []);
});

test('weekly on chosen days, and every other week counted from the starting week', () => {
  // 2026-01-05 is a Monday
  assert.deepEqual(days(s({ frequency: 'weekly', weekdays: [1, 4], starts_on: '2026-01-05' }), '2026-01-05', 14),
    ['2026-01-05', '2026-01-08', '2026-01-12', '2026-01-15']);
  // Starting on a Wednesday, every two weeks on Mondays: the first Monday is in the next week (skipped), then the week after.
  assert.deepEqual(days(s({ frequency: 'weekly', every: 2, weekdays: [1], starts_on: '2026-01-07' }), '2026-01-07', 28),
    ['2026-01-19', '2026-02-02']);
});

test('monthly days, the last day of short months, and quarterly, half-yearly and yearly steps', () => {
  assert.deepEqual(days(s({ frequency: 'monthly', month_days: [31], starts_on: '2026-01-01' }), '2026-01-01', 90),
    ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.deepEqual(days(s({ frequency: 'monthly', month_days: [1, 15], starts_on: '2026-01-01' }), '2026-01-01', 40),
    ['2026-01-01', '2026-01-15', '2026-02-01']);
  assert.deepEqual(days(s({ frequency: 'quarterly', month_days: [10], starts_on: '2026-01-01' }), '2026-01-01', 300),
    ['2026-01-10', '2026-04-10', '2026-07-10', '2026-10-10']);
  assert.deepEqual(days(s({ frequency: 'half_yearly', month_days: [1], starts_on: '2026-02-01' }), '2026-01-01', 400),
    ['2026-02-01', '2026-08-01', '2027-02-01']);
  assert.deepEqual(days(s({ frequency: 'annually', month_days: [5], starts_on: '2026-03-01' }), '2026-01-01', 700),
    ['2026-03-05', '2027-03-05']);
  assert.deepEqual(days(s({ frequency: 'once', starts_on: '2026-01-09' }), '2026-01-01', 20), ['2026-01-09']);
});

test('the version in force on a day judges that day', () => {
  const v1 = s({ effective_from: '2026-01-01', frequency: 'daily' });
  const v2 = s({ effective_from: '2026-02-01', frequency: 'weekly', weekdays: [1] });
  assert.equal(versionOn([v2, v1], '2026-01-20'), v1);
  assert.equal(versionOn([v1, v2], '2026-02-03'), v2);
  assert.equal(versionOn([v2], '2026-01-20'), null);
});

test('status of a day: missed only after its window closes; late when done after the window', () => {
  const sch = s({ start_time: '06:00', end_time: '07:00' });
  const now = { day: '2026-03-10', minute: '06:30' };
  assert.equal(dayStatus(sch, '2026-03-09', null, now), 'missed');
  assert.equal(dayStatus(sch, '2026-03-10', null, now), 'due');
  assert.equal(dayStatus(sch, '2026-03-10', null, { ...now, minute: '05:00' }), 'upcoming');
  assert.equal(dayStatus(sch, '2026-03-10', null, { ...now, minute: '07:00' }), 'missed');
  assert.equal(dayStatus(sch, '2026-03-09', { status: 'skipped' }, now), 'skipped');
  assert.equal(isLate(sch, '2026-03-10', { day: '2026-03-10', minute: '06:59' }), false);
  assert.equal(isLate(sch, '2026-03-10', { day: '2026-03-10', minute: '07:05' }), true);
  assert.equal(isLate(s({}), '2026-03-10', { day: '2026-03-10', minute: '23:00' }), false);
});

test('plain-English summaries', () => {
  assert.equal(describe(s({ start_time: '06:00', end_time: '07:00' })), 'Daily, 06:00 to 07:00');
  assert.equal(describe(s({ frequency: 'weekly', weekdays: [4, 1] })), 'Mondays and Thursdays');
  assert.equal(describe(s({ frequency: 'monthly', month_days: [31] })), 'Monthly on the last day');
  assert.equal(describe(s({ frequency: 'quarterly', month_days: [1, 15] })), 'Quarterly on the 1st and the 15th');
});

test('the community clock in India', () => {
  const at = new Date('2026-03-09T20:15:00Z');   // 01:45 on the 10th in India
  assert.deepEqual(localNow('Asia/Kolkata', at), { day: '2026-03-10', minute: '01:45' });
  assert.equal(zonedInstant('2026-03-10', '06:30', 'Asia/Kolkata').toISOString(), '2026-03-10T01:00:00.000Z');
});
