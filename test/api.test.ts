import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { GoogleAuth } from '../src/google/oauth.ts';
import { createScheduler, type Services } from '../src/scheduler.ts';
import { createServer } from '../src/server.ts';
import { getCreator, insertCreator, updateCreator } from '../src/repo/creators.ts';
import { createSequence, findSequenceByCreator, getSteps } from '../src/repo/sequences.ts';
import { buildSteps } from '../src/outreach/schedule.ts';
import { captureNotifications, fakeAgent, fakeGmail, testConfig, testDb } from './helpers.ts';

const db = testDb();
const notes = captureNotifications();
const fakeAuth: GoogleAuth = {
  authUrl: (state) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
  exchangeCode: async () => undefined,
  accessToken: async () => 'token',
  isConnected: () => false,
  account: () => undefined,
  setAccount: () => undefined,
  disconnect: () => undefined,
};
let base = '';
const config = testConfig({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
const services: Services = {
  db,
  config,
  auth: fakeAuth,
  gmail: fakeGmail(),
  agent: fakeAgent(),
  notify: notes.notify,
  fetchPage: async (url) => ({ url, status: 200, html: '' }),
};
const server = createServer(services, createScheduler(services), path.resolve('public'));

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${p}`, {
    method,
    redirect: 'manual',
    headers: method === 'GET' ? headers : { 'content-type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text.startsWith('{') ? JSON.parse(text) : text };
}

test('status reports capabilities and job state', async () => {
  const r = await call('GET', '/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.equal(r.json.data.capabilities.gmail, true);
  assert.equal(r.json.data.gmail.connected, false);
  assert.ok(r.json.data.jobs.inbox);
});

test('import parses lines and reports the ones it could not read', async () => {
  const r = await call('POST', '/api/creators/import', { lines: 'https://www.tiktok.com/@maya\nig:sat.guy\n???\nhttps://www.tiktok.com/@maya' });
  assert.equal(r.json.data.added, 2);
  assert.deepEqual(r.json.data.invalid, ['???']);
  const list = await call('GET', '/api/creators?status=new');
  assert.equal(list.json.data.length, 2);
});

test('approve flow: pending → active, edits validated, second approve conflicts', async () => {
  const id = insertCreator(db, { platform: 'youtube', handle: 'flow' })!;
  updateCreator(db, id, { email: 'flow@x.com' });
  const seqId = createSequence(db, id, buildSteps([{ subject: 'a', body: 'b' }, { subject: 'a', body: 'c' }], [3]));
  const [first] = getSteps(db, seqId);

  assert.equal((await call('PUT', `/api/steps/${first.id}`, { subject: '', body: 'x' })).status, 400);
  assert.equal((await call('PUT', `/api/steps/${first.id}`, { subject: 'hello', body: 'edited' })).status, 200);
  assert.equal((await call('GET', '/api/sequences?status=pending_approval')).json.data[0].steps[0].body, 'edited');

  assert.equal((await call('POST', `/api/sequences/${seqId}/approve`)).status, 200);
  assert.equal(findSequenceByCreator(db, id)!.status, 'active');
  assert.equal((await call('POST', `/api/sequences/${seqId}/approve`)).status, 409);
  assert.equal((await call('POST', `/api/sequences/${seqId}/stop`)).status, 200);
  assert.equal(findSequenceByCreator(db, id)!.status, 'stopped');
});

test('creator detail and retry', async () => {
  const id = insertCreator(db, { platform: 'web', handle: 'retry.com' })!;
  updateCreator(db, id, { status: 'no_email' });
  const detail = await call('GET', `/api/creators/${id}`);
  assert.equal(detail.json.data.creator.handle, 'retry.com');
  assert.equal((await call('POST', `/api/creators/${id}/retry`)).status, 200);
  assert.equal(getCreator(db, id)!.status, 'new');
  assert.equal((await call('POST', `/api/creators/${id}/retry`)).status, 409);
  assert.equal((await call('GET', '/api/creators/99999')).status, 404);
  assert.equal((await call('GET', '/api/creators/abc')).status, 400);
});

test('cross-site and non-JSON writes are blocked', async () => {
  const evil = await call('POST', '/api/sequences/approve-all', {}, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const form = await fetch(`${base}/api/sequences/approve-all`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(form.status, 415);
});

test('requests with a foreign Host header are refused (DNS rebinding)', async () => {
  const http = await import('node:http');
  const status = await new Promise<number>((resolve) => {
    const u = new URL(`${base}/api/inbox`);
    http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'attacker.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
  });
  assert.equal(status, 421);
});

test('jobs run on demand and unknown jobs 404', async () => {
  const r = await call('POST', '/api/jobs/send/run');
  assert.equal(r.json.data.result, 'skipped: Gmail not connected');
  assert.equal((await call('POST', '/api/jobs/nope/run')).status, 404);
});

test('test notification goes through the notifier', async () => {
  await call('POST', '/api/notify/test');
  assert.equal(notes.list.at(-1)?.title, 'Loorio GTM');
});

test('OAuth start sets a state cookie; callback rejects a mismatched state', async () => {
  const start = await call('GET', '/api/auth/google');
  assert.equal(start.status, 302);
  assert.match(start.headers.get('set-cookie') ?? '', /gtm_oauth_state=.+HttpOnly/);
  const bad = await call('GET', '/api/auth/callback/google?state=wrong&code=x', undefined, { cookie: 'gtm_oauth_state=right' });
  assert.equal(bad.status, 400);
});

test('static files are served and path traversal is refused', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});
