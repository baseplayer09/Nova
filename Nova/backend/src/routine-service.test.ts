import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextRoutineRunAt,
  RoutineServiceError,
} from './routine-service.js';

test('routine schedules use the selected local timezone and weekdays', () => {
  const now = new Date('2025-01-06T08:00:00.000Z');
  const next = nextRoutineRunAt(
    {
      timezone: 'America/New_York',
      localTime: '07:30',
      scheduleDays: [1, 2, 3, 4, 5],
    },
    now,
  );
  assert.equal(next.toISOString(), '2025-01-06T12:30:00.000Z');
});

test('routine schedules skip a passed local time and account for daylight saving', () => {
  const afterMondayRun = new Date('2025-01-06T13:00:00.000Z');
  const next = nextRoutineRunAt(
    {
      timezone: 'America/New_York',
      localTime: '07:30',
      scheduleDays: [1, 2, 3, 4, 5],
    },
    afterMondayRun,
  );
  assert.equal(next.toISOString(), '2025-01-07T12:30:00.000Z');

  const afterDstSwitch = new Date('2025-03-10T08:00:00.000Z');
  const dstNext = nextRoutineRunAt(
    {
      timezone: 'America/New_York',
      localTime: '07:30',
      scheduleDays: [1, 2, 3, 4, 5],
    },
    afterDstSwitch,
  );
  assert.equal(dstNext.toISOString(), '2025-03-10T11:30:00.000Z');
});

test('routine schedules reject invalid timezones, times, and weekdays', () => {
  for (const schedule of [
    { timezone: 'Mars/Olympus', localTime: '07:30', scheduleDays: [1] },
    { timezone: 'UTC', localTime: '25:30', scheduleDays: [1] },
    { timezone: 'UTC', localTime: '07:30', scheduleDays: [0] },
    { timezone: 'UTC', localTime: '07:30', scheduleDays: [] },
  ]) {
    assert.throws(
      () => nextRoutineRunAt(schedule, new Date('2025-01-01T00:00:00Z')),
      (error: unknown) =>
        error instanceof RoutineServiceError && error.statusCode === 400,
    );
  }
});
