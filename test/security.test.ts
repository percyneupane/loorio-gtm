import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from '../src/discovery/fetch-page.ts';
import { isPrivateAddress } from '../src/discovery/fetch-page.ts';
import { extractMailtos, isValidEmail } from '../src/discovery/extract.ts';
import { buildRawMessage } from '../src/google/mime.ts';
import { enrichCreator, unexpectedContacts } from '../src/outreach/enrich.ts';
import { sendNextDue } from '../src/outreach/sender.ts';
import { getCreator, insertCreator, isSuppressed, updateCreator } from '../src/repo/creators.ts';
import { approveSequence, createSequence, findSequenceByCreator, getSteps } from '../src/repo/sequences.ts';
import { buildSteps } from '../src/outreach/schedule.ts';
import { ACCOUNT, fakeAgent, fakeGmail, testConfig, testDb } from './helpers.ts';

const WED_10AM = new Date(2026, 9, 28, 10, 0);

test('multi-recipient mailto links never become candidates', () => {
  const html = '<a href="mailto:a@x.com,victim@y.com">x</a><a href="mailto:a@x.com%20b@y.com">y</a><a href="mailto:ok@x.com">z</a>';
  assert.deepEqual(extractMailtos(html), ['ok@x.com']);
  assert.equal(isValidEmail('a@x.com,b@y.com'), false);
  assert.equal(isValidEmail('a@x.com\r\nBcc: z@z.com'), false);
  assert.equal(isValidEmail('maya@studio.co'), true);
});

test('buildRawMessage refuses lists in To and folded References', () => {
  assert.throws(() => buildRawMessage({ from: 'a@x.com', to: 'a@x.com,b@y.com', subject: 's', text: 'x' }), /exactly one/);
  assert.throws(
    () => buildRawMessage({ from: 'a@x.com', to: 'b@y.com', subject: 's', text: 'x', inReplyTo: '<m@g>', references: '<a@g>\r\nBcc: z@z.com' }),
    /References/,
  );
});

test('SSRF guard covers mapped, NAT64 and benchmark ranges', () => {
  for (const ip of ['::ffff:7f00:1', '[::ffff:127.0.0.1]', '::ffff:a00:1', '64:ff9b::7f00:1', '198.18.0.1', '2002:7f00:1::', 'fec0::1', 'garbage']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  assert.equal(isPrivateAddress('::ffff:808:808'), false);
});

function activeStep() {
  const db = testDb();
  const id = insertCreator(db, { platform: 'youtube', handle: 'race' })!;
  updateCreator(db, id, { email: 'race@x.com' });
  const seqId = createSequence(db, id, buildSteps([{ subject: 's', body: 'a' }, { subject: 's', body: 'b' }], [3]));
  approveSequence(db, seqId, new Date(WED_10AM.getTime() - 1000).toISOString());
  return { db, id, seqId };
}

test('an email Gmail accepted is never re-sent even if recording it fails', async () => {
  const { db, seqId } = activeStep();
  const gmail = fakeGmail();
  const realSend = gmail.send;
  gmail.send = async (email, threadId) => {
    const r = await realSend(email, threadId);
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE OF sent_at ON sequence_steps BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    return r;
  };
  const deps = { gmail, config: testConfig(), account: ACCOUNT };
  assert.equal(await sendNextDue(db, deps, WED_10AM), 'error');
  db.exec('DROP TRIGGER boom');
  assert.equal(getSteps(db, seqId)[0].status, 'sending');
  assert.equal(await sendNextDue(db, deps, new Date(WED_10AM.getTime() + 2 * 3600_000)), 'nothing_due');
  assert.equal(gmail.sent.length, 1);
});

test('an opt-out recorded while Gmail is sending is not overwritten', async () => {
  const { db, id } = activeStep();
  const gmail = fakeGmail();
  const realSend = gmail.send;
  gmail.send = async (email, threadId) => {
    updateCreator(db, id, { status: 'opted_out' });
    return realSend(email, threadId);
  };
  assert.equal(await sendNextDue(db, { gmail, config: testConfig(), account: ACCOUNT }, WED_10AM), 'sent');
  assert.equal(getCreator(db, id)!.status, 'opted_out');
});

test('a replied address is suppressed for every creator row that shares it', () => {
  const db = testDb();
  const id = insertCreator(db, { platform: 'tiktok', handle: 'a' })!;
  updateCreator(db, id, { email: 'same@x.com', status: 'replied' });
  assert.equal(isSuppressed(db, 'same@x.com'), true);
});

test('unexpectedContacts flags links/addresses missing from the pitch', () => {
  const pitch = 'Loorio — see https://loorio.app';
  assert.deepEqual(unexpectedContacts([{ subject: 'hi', body: 'More at https://loorio.app' }], pitch), []);
  const stray = unexpectedContacts([{ subject: 'hi', body: 'Wire to pay.me or email x@evil.co' }], pitch);
  assert.ok(stray.includes('pay.me') && stray.includes('x@evil.co'));
});

test('AUTO_APPROVE holds drafts with planted links for review', async () => {
  const db = testDb();
  const id = insertCreator(db, { platform: 'web', handle: 'evil.com', url: 'https://evil.com/' })!;
  const fetchPage = async (url: string): Promise<Page> => ({ url, status: 200, html: '<p>biz@evil.com</p>' });
  const agent = fakeAgent({ async draftSequence() { return [{ subject: 'hey', body: 'click https://evil.com/pay' }]; } });
  await enrichCreator(db, { agent, config: testConfig({ AUTO_APPROVE: 'true' }), fetchPage, pitch: 'Loorio pitch' }, getCreator(db, id)!);
  assert.equal(findSequenceByCreator(db, id)!.status, 'pending_approval');
});
