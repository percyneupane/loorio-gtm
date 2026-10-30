import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Db } from '../src/db.ts';
import { GmailError } from '../src/google/gmail.ts';
import { pollInbox, type MonitorDeps } from '../src/inbox/monitor.ts';
import { getCreator, insertCreator, updateCreator } from '../src/repo/creators.ts';
import { listInbox } from '../src/repo/inbox.ts';
import { approveSequence, createSequence, findSequenceByCreator, getSteps, markStepSent, nextDueStep } from '../src/repo/sequences.ts';
import { getKv, setKv } from '../src/repo/state.ts';
import { buildSteps } from '../src/outreach/schedule.ts';
import {
  ACCOUNT,
  captureNotifications,
  deliver,
  fakeAgent,
  fakeGmail,
  message,
  testConfig,
  testDb,
  type FakeGmail,
} from './helpers.ts';

let db: Db;
let gmail: FakeGmail;
let notes: ReturnType<typeof captureNotifications>;

beforeEach(() => {
  db = testDb();
  gmail = fakeGmail();
  notes = captureNotifications();
  setKv(db, 'gmail_history_id', '100');
});

function deps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return { gmail, agent: fakeAgent(), notify: notes.notify, config: testConfig(), account: ACCOUNT, ...overrides };
}

/** A creator mid-sequence: first email sent in thread "thread-maya", follow-ups scheduled. */
function creatorInSequence(): { creatorId: number; seqId: number } {
  const creatorId = insertCreator(db, { platform: 'tiktok', handle: 'maya', name: 'Maya' })!;
  updateCreator(db, creatorId, { email: 'hello@maya.co' });
  const steps = buildSteps([1, 2, 3, 4].map((i) => ({ subject: 's', body: `b${i}` })), [3, 7, 14]);
  const seqId = createSequence(db, creatorId, steps);
  approveSequence(db, seqId, '2026-10-28T10:00:00.000Z');
  const due = nextDueStep(db, '2026-10-28T10:00:01.000Z')!;
  markStepSent(db, due, { gmailMessageId: 'm0', threadId: 'thread-maya', rfcMessageId: '<m0@g>', sentAt: '2026-10-28T10:00:00.000Z' });
  return { creatorId, seqId };
}

test('first poll only records the history id (no backlog processing)', async () => {
  setKv(db, 'gmail_history_id', '');
  db.prepare("DELETE FROM kv WHERE key = 'gmail_history_id'").run();
  assert.deepEqual(await pollInbox(db, deps()), { processed: 0 });
  assert.equal(getKv(db, 'gmail_history_id'), '100');
});

test('a creator reply stops the sequence, drafts a reply in-thread and sends a high-priority push', async () => {
  const { creatorId, seqId } = creatorInSequence();
  deliver(gmail, message({ id: 'r1', threadId: 'thread-maya', from: 'Maya <hello@maya.co>', fromAddress: 'hello@maya.co', subject: 'Re: s', text: "I'm in! What do you need?" }));

  const r = await pollInbox(db, deps());

  assert.equal(r.processed, 1);
  assert.equal(getCreator(db, creatorId)!.status, 'replied');
  assert.equal(findSequenceByCreator(db, creatorId)!.status, 'stopped');
  assert.ok(getSteps(db, seqId).slice(1).every((s) => s.status === 'skipped'));
  assert.equal(gmail.drafts.length, 1);
  assert.equal(gmail.drafts[0].threadId, 'thread-maya');
  assert.equal(gmail.drafts[0].email.inReplyTo, '<r1@mail>');
  assert.equal(gmail.drafts[0].email.subject, 'Re: s');
  const [item] = listInbox(db);
  assert.equal(item.category, 'creator_reply');
  assert.equal(item.draft_id, 'draft-1');
  assert.equal(notes.list.length, 1);
  assert.match(notes.list[0].title, /Maya replied/);
  assert.equal(notes.list[0].priority, 'high');
  assert.match(notes.list[0].message, /draft ready/);
  assert.equal(getKv(db, 'gmail_history_id'), '200');
});

test('an opt-out marks the creator and creates no draft', async () => {
  const { creatorId } = creatorInSequence();
  deliver(gmail, message({ id: 'r2', threadId: 'thread-maya', fromAddress: 'hello@maya.co', from: 'hello@maya.co' }));
  const agent = fakeAgent({ async triage() { return { category: 'opt_out', needsReply: false, urgency: 'low', summary: 'Not interested' }; } });

  await pollInbox(db, deps({ agent }));

  assert.equal(getCreator(db, creatorId)!.status, 'opted_out');
  assert.equal(gmail.drafts.length, 0);
  assert.match(notes.list[0].title, /opted out/);
});

test('a second message from an opted-out creator never lifts the suppression', async () => {
  const { creatorId } = creatorInSequence();
  updateCreator(db, creatorId, { status: 'opted_out' });
  deliver(gmail, message({ id: 'r3', threadId: 'thread-maya', fromAddress: 'hello@maya.co' }));
  await pollInbox(db, deps());
  assert.equal(getCreator(db, creatorId)!.status, 'opted_out');
});

test('a bounce stops the sequence and marks the creator bounced', async () => {
  const { creatorId } = creatorInSequence();
  deliver(gmail, message({ id: 'b1', threadId: 'thread-maya', from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', fromAddress: 'mailer-daemon@googlemail.com' }));
  const agent = fakeAgent();
  await pollInbox(db, deps({ agent }));
  assert.equal(getCreator(db, creatorId)!.status, 'bounced');
  assert.deepEqual(agent.calls, []);
  assert.match(notes.list[0].title, /Bounced/);
});

test('regular email needing a reply gets triaged, drafted and notified', async () => {
  deliver(gmail, message({ id: 'x1', from: 'Investor <vc@fund.com>', fromAddress: 'vc@fund.com', subject: 'Coffee?' }));
  const agent = fakeAgent();
  await pollInbox(db, deps({ agent }));
  assert.deepEqual(agent.calls, ['triage', 'reply']);
  assert.equal(gmail.drafts.length, 1);
  assert.equal(gmail.drafts[0].email.to, 'vc@fund.com');
  assert.match(notes.list[0].title, /Investor: Coffee\?/);
});

test('promotions and list mail are skipped silently without AI calls', async () => {
  deliver(gmail, message({ id: 'p1', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }));
  deliver(gmail, message({ id: 'p2', listUnsubscribe: true }));
  const agent = fakeAgent();
  await pollInbox(db, deps({ agent }));
  assert.deepEqual(agent.calls, []);
  assert.equal(notes.list.length, 0);
  assert.equal(listInbox(db).length, 0);
});

test('NOTIFY_LEVEL=important skips FYI mail but still drafts nothing for it', async () => {
  deliver(gmail, message({ id: 'n1', subject: 'Your receipt' }));
  const agent = fakeAgent({ async triage() { return { category: 'notification', needsReply: false, urgency: 'low', summary: 'Receipt' }; } });
  await pollInbox(db, deps({ agent, config: testConfig({ NOTIFY_LEVEL: 'important' }) }));
  assert.equal(notes.list.length, 0);
  assert.equal(gmail.drafts.length, 0);
});

test('NOTIFY_LEVEL=all notifies FYI mail too, but never spam', async () => {
  deliver(gmail, message({ id: 'n2', subject: 'Your receipt' }));
  deliver(gmail, message({ id: 'n3', subject: 'You won!!!' }));
  let i = 0;
  const agent = fakeAgent({
    async triage() {
      i++;
      return i === 1
        ? { category: 'notification', needsReply: false, urgency: 'low', summary: 'Receipt' }
        : { category: 'spam', needsReply: false, urgency: 'low', summary: 'Spam' };
    },
  });
  await pollInbox(db, deps({ agent }));
  assert.equal(notes.list.length, 1);
  assert.equal(notes.list[0].priority, 'low');
});

test('our own sent mail and duplicates are ignored', async () => {
  deliver(gmail, message({ id: 'own', fromAddress: ACCOUNT }));
  deliver(gmail, message({ id: 'dup' }));
  await pollInbox(db, deps());
  deliver(gmail, message({ id: 'dup' }));
  const r = await pollInbox(db, deps());
  assert.equal(r.processed, 0);
  assert.equal(listInbox(db).length, 1);
});

test('draft failures are recorded and still notify', async () => {
  deliver(gmail, message({ id: 'f1' }));
  const agent = fakeAgent({ async draftReply() { throw new Error('rate limited'); } });
  await pollInbox(db, deps({ agent }));
  assert.equal(listInbox(db)[0].error, 'rate limited');
  assert.match(notes.list[0].message, /Could not draft/);
});

test('without an AI key it still notifies for every email', async () => {
  deliver(gmail, message({ id: 'a1', snippet: 'quick question' }));
  await pollInbox(db, deps({ agent: undefined }));
  assert.equal(gmail.drafts.length, 0);
  assert.equal(notes.list[0].message, 'quick question');
});

test('an expired history id resets to now', async () => {
  gmail.newInboxMessageIds = async () => {
    throw new GmailError(404, 'history expired');
  };
  assert.deepEqual(await pollInbox(db, deps()), { processed: 0 });
  assert.equal(getKv(db, 'gmail_history_id'), '100');
});
