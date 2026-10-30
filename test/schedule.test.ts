import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, buildSteps, dayKey, followUpSubject, isWithinSendWindow } from '../src/outreach/schedule.ts';
import { loadConfig } from '../src/config.ts';

test('buildSteps pairs drafts with follow-up offsets and drops extras', () => {
  const drafts = [1, 2, 3, 4, 5].map((i) => ({ subject: ` s${i} `, body: ` b${i} ` }));
  const steps = buildSteps(drafts, [3, 7, 14]);
  assert.deepEqual(
    steps.map((s) => [s.step_index, s.delay_days, s.subject, s.body]),
    [
      [0, 0, 's1', 'b1'],
      [1, 3, 's2', 'b2'],
      [2, 7, 's3', 'b3'],
      [3, 14, 's4', 'b4'],
    ],
  );
});

test('buildSteps works with fewer drafts than follow-up slots', () => {
  assert.equal(buildSteps([{ subject: 'a', body: 'b' }], [3, 7]).length, 1);
});

test('buildSteps rejects an empty sequence', () => {
  assert.throws(() => buildSteps([], [3]), /at least one email/);
});

test('addDays adds whole days', () => {
  assert.equal(addDays('2026-10-29T10:00:00.000Z', 3), '2026-11-01T10:00:00.000Z');
});

test('send window: weekdays inside hours only', () => {
  const wed10 = new Date(2026, 9, 28, 10, 0);
  const wed17 = new Date(2026, 9, 28, 17, 0);
  const wed8 = new Date(2026, 9, 28, 8, 59);
  const sat10 = new Date(2026, 9, 31, 10, 0);
  assert.equal(isWithinSendWindow(wed10, 9, 17), true);
  assert.equal(isWithinSendWindow(wed17, 9, 17), false);
  assert.equal(isWithinSendWindow(wed8, 9, 17), false);
  assert.equal(isWithinSendWindow(sat10, 9, 17), false);
});

test('followUpSubject adds exactly one Re:', () => {
  assert.equal(followUpSubject('loorio x you'), 'Re: loorio x you');
  assert.equal(followUpSubject('Re: RE: loorio'), 'Re: loorio');
});

test('dayKey uses the local calendar date', () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('config parses lists and validates follow-up days', () => {
  const c = loadConfig({ NICHES: 'a, b ,,c', FOLLOW_UP_DAYS: '2,5' });
  assert.deepEqual(c.NICHES, ['a', 'b', 'c']);
  assert.deepEqual(c.followUpDays, [2, 5]);
  assert.equal(c.AUTO_APPROVE, false);
  assert.throws(() => loadConfig({ FOLLOW_UP_DAYS: '3,x' }), /FOLLOW_UP_DAYS/);
  assert.throws(() => loadConfig({ NOTIFY_LEVEL: 'loud' }), /NOTIFY_LEVEL/);
});
