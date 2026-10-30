import crypto from 'node:crypto';
import { z } from 'zod';
import { capabilities } from './config.ts';
import { parseProfileInput } from './discovery/profiles.ts';
import { HttpError, intParam, ok, parseCookies, readJson, redirect, type Router } from './http.ts';
import { listInbox } from './repo/inbox.ts';
import {
  countByStatus,
  getCreator,
  insertCreator,
  listCandidates,
  listCreators,
  updateCreator,
  type CreatorStatus,
} from './repo/creators.ts';
import {
  approveSequence,
  editStep,
  findSequenceByCreator,
  getSteps,
  listSequences,
  rejectSequence,
  stopSequence,
  type SequenceStatus,
} from './repo/sequences.ts';
import { logActivity, recentActivity } from './repo/state.ts';
import { sentToday } from './outreach/sender.ts';
import type { JobName, Scheduler, Services } from './scheduler.ts';

const OAUTH_STATE_COOKIE = 'gtm_oauth_state';
const JOB_NAMES: readonly JobName[] = ['inbox', 'send', 'enrich', 'discover'];
const SEQUENCE_STATUSES: readonly SequenceStatus[] = ['pending_approval', 'active', 'stopped', 'completed', 'rejected'];

const StepEdit = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000) });
const ImportBody = z.object({ lines: z.string().max(50_000) });
const Empty = z.object({}).passthrough();

export function registerRoutes(router: Router, s: Services, scheduler: Scheduler): void {
  const { db, config, auth } = s;

  router.get('/api/status', (ctx) =>
    ok(ctx, {
      capabilities: capabilities(config),
      gmail: { connected: auth.isConnected(), account: auth.account() ?? null },
      counts: countByStatus(db),
      pendingApprovals: listSequences(db, 'pending_approval', 1000).length,
      sentToday: sentToday(db, new Date()),
      dailyLimit: config.DAILY_SEND_LIMIT,
      sendWindow: `${config.SEND_WINDOW_START}:00–${config.SEND_WINDOW_END}:00 weekdays`,
      followUpDays: config.followUpDays,
      autoApprove: config.AUTO_APPROVE,
      notifyLevel: config.NOTIFY_LEVEL,
      jobs: scheduler.status(),
    }),
  );

  // --- Outreach sequences -------------------------------------------------------------
  router.get('/api/sequences', (ctx) => {
    const status = (ctx.url.searchParams.get('status') ?? 'pending_approval') as SequenceStatus;
    if (!SEQUENCE_STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
    ok(ctx, listSequences(db, status));
  });

  router.post('/api/sequences/:id/approve', async (ctx) => {
    await readJson(ctx, Empty);
    if (!approveSequence(db, intParam(ctx, 'id'), new Date().toISOString())) throw new HttpError(409, 'Not pending');
    logActivity(db, 'approve', `Approved sequence #${ctx.params.id}`);
    ok(ctx, { approved: 1 });
  });

  router.post('/api/sequences/:id/reject', async (ctx) => {
    await readJson(ctx, Empty);
    if (!rejectSequence(db, intParam(ctx, 'id'))) throw new HttpError(409, 'Not pending');
    ok(ctx, { rejected: 1 });
  });

  router.post('/api/sequences/:id/stop', async (ctx) => {
    await readJson(ctx, Empty);
    stopSequence(db, intParam(ctx, 'id'), 'stopped manually');
    ok(ctx, { stopped: 1 });
  });

  router.post('/api/sequences/approve-all', async (ctx) => {
    await readJson(ctx, Empty);
    const now = new Date().toISOString();
    const approved = listSequences(db, 'pending_approval', 1000).filter((q) => approveSequence(db, q.id, now)).length;
    logActivity(db, 'approve', `Approved ${approved} sequences`);
    ok(ctx, { approved });
  });

  router.put('/api/steps/:id', async (ctx) => {
    const body = await readJson(ctx, StepEdit);
    if (!editStep(db, intParam(ctx, 'id'), body.subject, body.body)) throw new HttpError(409, 'Step already sent');
    ok(ctx, { saved: true });
  });

  // --- Creators -------------------------------------------------------------------------
  router.get('/api/creators', (ctx) => {
    const status = ctx.url.searchParams.get('status') as CreatorStatus | null;
    ok(ctx, listCreators(db, status ?? undefined, 300));
  });

  router.get('/api/creators/:id', (ctx) => {
    const creator = getCreator(db, intParam(ctx, 'id'));
    if (!creator) throw new HttpError(404, 'Creator not found');
    const sequence = findSequenceByCreator(db, creator.id);
    ok(ctx, {
      creator,
      candidates: listCandidates(db, creator.id),
      sequence: sequence ? { ...sequence, steps: getSteps(db, sequence.id) } : null,
    });
  });

  router.post('/api/creators/import', async (ctx) => {
    const { lines } = await readJson(ctx, ImportBody);
    let added = 0;
    const invalid: string[] = [];
    for (const line of lines.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const ref = parseProfileInput(line);
      if (!ref) {
        invalid.push(line);
        continue;
      }
      if (insertCreator(db, { ...ref, name: ref.handle, source: 'import' }) !== null) added++;
    }
    logActivity(db, 'discovery', `Imported ${added} creators`);
    ok(ctx, { added, invalid });
  });

  router.post('/api/creators/:id/retry', async (ctx) => {
    await readJson(ctx, Empty);
    const creator = getCreator(db, intParam(ctx, 'id'));
    if (!creator) throw new HttpError(404, 'Creator not found');
    if (!['no_email', 'error', 'rejected'].includes(creator.status)) throw new HttpError(409, 'Only failed creators can be retried');
    if (findSequenceByCreator(db, creator.id)) throw new HttpError(409, 'Creator already has a sequence');
    updateCreator(db, creator.id, { status: 'new', error: null });
    ok(ctx, { queued: true });
  });

  // --- Inbox, activity, jobs ------------------------------------------------------------
  router.get('/api/inbox', (ctx) => ok(ctx, listInbox(db, 150)));
  router.get('/api/activity', (ctx) => ok(ctx, recentActivity(db, 150)));

  router.post('/api/jobs/:name/run', async (ctx) => {
    await readJson(ctx, Empty);
    const name = ctx.params.name as JobName;
    if (!JOB_NAMES.includes(name)) throw new HttpError(404, 'Unknown job');
    ok(ctx, { result: await scheduler.run(name, { force: true }) });
  });

  router.post('/api/notify/test', async (ctx) => {
    await readJson(ctx, Empty);
    await s.notify({ title: 'Loorio GTM', message: 'Notifications are working ✅', priority: 'default' });
    ok(ctx, { sent: true });
  });

  // --- Google OAuth ---------------------------------------------------------------------
  router.get('/api/auth/google', (ctx) => {
    if (!capabilities(config).gmail) throw new HttpError(400, 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first');
    const state = crypto.randomBytes(24).toString('base64url');
    redirect(ctx.res, auth.authUrl(state), {
      'set-cookie': `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
    });
  });

  router.get('/api/auth/callback/google', async (ctx) => {
    const state = ctx.url.searchParams.get('state');
    const code = ctx.url.searchParams.get('code');
    const expected = parseCookies(ctx.req)[OAUTH_STATE_COOKIE];
    if (ctx.url.searchParams.get('error')) throw new HttpError(400, `Google sign-in cancelled: ${ctx.url.searchParams.get('error')}`);
    if (!state || !expected || state.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
      throw new HttpError(400, 'OAuth state mismatch — start again from the dashboard');
    }
    if (!code) throw new HttpError(400, 'Missing authorization code');
    await auth.exchangeCode(code);
    const profile = await s.gmail.profile();
    auth.setAccount(profile.emailAddress);
    logActivity(db, 'system', `Connected Gmail ${profile.emailAddress}`);
    void scheduler.run('inbox');
    redirect(ctx.res, '/', { 'set-cookie': `${OAUTH_STATE_COOKIE}=; Path=/; Max-Age=0` });
  });

  router.post('/api/auth/disconnect', async (ctx) => {
    await readJson(ctx, Empty);
    auth.disconnect();
    logActivity(db, 'system', 'Disconnected Gmail');
    ok(ctx, { disconnected: true });
  });
}
