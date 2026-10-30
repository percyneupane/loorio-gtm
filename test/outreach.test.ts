import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { Db } from '../src/db.ts';
import type { Page } from '../src/discovery/fetch-page.ts';
import { enrichCreator } from '../src/outreach/enrich.ts';
import { sendNextDue, withFooter } from '../src/outreach/sender.ts';
import { getCreator, insertCreator, listCandidates, updateCreator } from '../src/repo/creators.ts';
import {
  approveSequence,
  editStep,
  findSequenceByCreator,
  getSteps,
  listSequences,
  rejectSequence,
} from '../src/repo/sequences.ts';
import { ACCOUNT, deliver, fakeAgent, fakeGmail, message, testConfig, testDb, type FakeGmail } from './helpers.ts';

const WED_10AM = new Date(2026, 9, 28, 10, 0);
const config = testConfig();

const PAGES: Record<string, string> = {
  'https://www.tiktok.com/@maya': `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify({
    __DEFAULT_SCOPE__: { 'webapp.user-detail': { userInfo: { user: { nickname: 'Maya', signature: 'SAT tips daily', bioLink: { link: 'https://linktr.ee/maya' } }, stats: { followerCount: 40000 } } } },
  })}</script>`,
  'https://linktr.ee/maya': '<a href="https://mayatutoring.com">My tutoring</a><a href="mailto:hello%40maya.co">Email</a>',
  'https://mayatutoring.com/': '<a href="/contact">Contact</a><p>Book a session</p>',
  'https://mayatutoring.com/contact': '<p>Business inquiries: biz [at] mayatutoring [dot] com</p>',
};
const fetchPage = async (url: string): Promise<Page> => {
  const key = Object.keys(PAGES).find((k) => url === k || url === `${k}/`);
  if (!key) throw new Error(`404 ${url}`);
  return { url: key, status: 200, html: PAGES[key] };
};

let db: Db;
let gmail: FakeGmail;
beforeEach(() => {
  db = testDb();
  gmail = fakeGmail();
});

function addMaya(): number {
  return insertCreator(db, { platform: 'tiktok', handle: 'Maya', url: 'https://www.tiktok.com/@maya' })!;
}

test('enrich follows bio → link-in-bio → own site and drafts a pending sequence', async () => {
  const id = addMaya();
  const agent = fakeAgent();
  const outcome = await enrichCreator(db, { agent, config, fetchPage }, getCreator(db, id)!);

  assert.equal(outcome, 'drafted');
  const emails = listCandidates(db, id).map((c) => c.email).sort();
  assert.deepEqual(emails, ['biz@mayatutoring.com', 'hello@maya.co']);
  const creator = getCreator(db, id)!;
  assert.equal(creator.status, 'drafted');
  assert.equal(creator.followers, 40000);
  assert.ok(creator.email);
  const pending = listSequences(db, 'pending_approval');
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].steps.map((s) => s.delay_days), [0, 3, 7, 14]);
  assert.deepEqual(agent.calls, ['qualify', 'draft']);
});

test('enrich marks no_email when nothing is published, without calling the AI', async () => {
  const id = insertCreator(db, { platform: 'web', handle: 'nothing.com', url: 'https://nothing.com/' })!;
  const agent = fakeAgent();
  const outcome = await enrichCreator(db, { agent, config, fetchPage: async (url) => ({ url, status: 200, html: '<p>hi</p>' }) }, getCreator(db, id)!);
  assert.equal(outcome, 'no_email');
  assert.deepEqual(agent.calls, []);
});

test('enrich rejects low-fit creators and never drafts', async () => {
  const id = addMaya();
  const agent = fakeAgent({
    async qualify(_c, _x, cands) {
      return { email: cands[0].email, emailReason: '', fitScore: 20, fitReason: 'gaming only', firstName: null, hook: '' };
    },
  });
  assert.equal(await enrichCreator(db, { agent, config, fetchPage }, getCreator(db, id)!), 'rejected');
  assert.equal(listSequences(db, 'pending_approval').length, 0);
});

test('enrich skips an email another creator was already contacted on', async () => {
  const other = insertCreator(db, { platform: 'youtube', handle: 'maya-yt' })!;
  updateCreator(db, other, { email: 'hello@maya.co', status: 'in_sequence' });
  const id = addMaya();
  const agent = fakeAgent({
    async qualify() {
      return { email: 'hello@maya.co', emailReason: '', fitScore: 90, fitReason: '', firstName: null, hook: '' };
    },
  });
  assert.equal(await enrichCreator(db, { agent, config, fetchPage }, getCreator(db, id)!), 'duplicate');
});

test('enrich records errors instead of throwing', async () => {
  const id = addMaya();
  const outcome = await enrichCreator(db, { agent: fakeAgent(), config, fetchPage: async () => { throw new Error('boom'); } }, getCreator(db, id)!);
  assert.equal(outcome, 'error');
  assert.equal(getCreator(db, id)!.error, 'boom');
});

test('AUTO_APPROVE approves drafted sequences immediately', async () => {
  const id = addMaya();
  await enrichCreator(db, { agent: fakeAgent(), config: testConfig({ AUTO_APPROVE: 'true' }), fetchPage }, getCreator(db, id)!);
  assert.equal(findSequenceByCreator(db, id)!.status, 'active');
});

async function approvedMaya(): Promise<{ id: number; seqId: number }> {
  const id = addMaya();
  await enrichCreator(db, { agent: fakeAgent(), config, fetchPage }, getCreator(db, id)!);
  const seqId = findSequenceByCreator(db, id)!.id;
  approveSequence(db, seqId, new Date(WED_10AM.getTime() - 1000).toISOString());
  return { id, seqId };
}

const deps = () => ({ gmail, config, account: ACCOUNT });

test('nothing sends before approval', async () => {
  addMaya();
  assert.equal(await sendNextDue(db, deps(), WED_10AM), 'nothing_due');
});

test('first email sends with footer, then follow-ups thread on day 3', async () => {
  const { id, seqId } = await approvedMaya();
  assert.equal(await sendNextDue(db, deps(), WED_10AM), 'sent');
  assert.equal(gmail.sent.length, 1);
  const first = gmail.sent[0];
  assert.equal(first.email.subject, 'loorio x you');
  assert.match(first.email.text, /1 Main St, Austin TX/);
  assert.match(first.email.text, /no thanks/);
  assert.equal(getCreator(db, id)!.status, 'in_sequence');

  const steps = getSteps(db, seqId);
  assert.equal(steps[1].status, 'scheduled');
  assert.equal(await sendNextDue(db, deps(), WED_10AM), 'nothing_due');

  const day3 = new Date(WED_10AM.getTime() + 3 * 86_400_000 + 60_000); // Saturday → outside window
  assert.equal(await sendNextDue(db, deps(), day3), 'outside_window');
  const mon = new Date(2026, 10, 2, 10, 0);
  assert.equal(await sendNextDue(db, deps(), mon), 'sent');
  const followUp = gmail.sent[1];
  assert.equal(followUp.email.subject, 'Re: loorio x you');
  assert.equal(followUp.email.inReplyTo, '<sent-1@gmail>');
  assert.equal(followUp.threadId, 'thread-1');
});

test('a reply in the thread cancels follow-ups before they send', async () => {
  const { id, seqId } = await approvedMaya();
  await sendNextDue(db, deps(), WED_10AM);
  deliver(gmail, message({ id: 'r1', threadId: 'thread-1', from: 'Maya <hello@maya.co>', fromAddress: 'hello@maya.co' }));
  const mon = new Date(2026, 10, 2, 10, 0);
  assert.equal(await sendNextDue(db, deps(), mon), 'stopped');
  assert.equal(gmail.sent.length, 1);
  assert.equal(getCreator(db, id)!.status, 'replied');
  assert.ok(getSteps(db, seqId).slice(1).every((s) => s.status === 'skipped'));
});

test('daily limit is enforced', async () => {
  await approvedMaya();
  assert.equal(await sendNextDue(db, { ...deps(), config: testConfig({ DAILY_SEND_LIMIT: '0' }) }, WED_10AM), 'daily_limit');
});

test('a failed send is retried later instead of blocking the queue', async () => {
  const { seqId } = await approvedMaya();
  gmail.failSend = new Error('Gmail 400');
  assert.equal(await sendNextDue(db, deps(), WED_10AM), 'error');
  const due = new Date(getSteps(db, seqId)[0].due_at!);
  assert.ok(due.getTime() > WED_10AM.getTime());
  assert.equal(await sendNextDue(db, deps(), WED_10AM), 'nothing_due');
});

test('opted-out addresses are never emailed', async () => {
  const { id } = await approvedMaya();
  updateCreator(db, id, { status: 'opted_out' });
  assert.equal(await sendNextDue(db, deps(), WED_10AM), 'nothing_due');
  assert.equal(gmail.sent.length, 0);
});

test('edit only works on unsent steps; reject skips everything', async () => {
  const id = addMaya();
  await enrichCreator(db, { agent: fakeAgent(), config, fetchPage }, getCreator(db, id)!);
  const seq = findSequenceByCreator(db, id)!;
  const [first] = getSteps(db, seq.id);
  assert.equal(editStep(db, first.id, 'new subject', 'new body'), true);
  assert.equal(getSteps(db, seq.id)[0].subject, 'new subject');
  assert.equal(rejectSequence(db, seq.id), true);
  assert.equal(rejectSequence(db, seq.id), false);
  assert.equal(getCreator(db, id)!.status, 'rejected');
  assert.equal(approveSequence(db, seq.id, WED_10AM.toISOString()), false);
});

test('withFooter appends signature, address and opt-out line', () => {
  assert.equal(
    withFooter('Hey Maya\n', config),
    'Hey Maya\n\nPercy\nFounder, Loorio\n1 Main St, Austin TX\n\nNot for you? Reply "no thanks" and I won\'t follow up.',
  );
});
