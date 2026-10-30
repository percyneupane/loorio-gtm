import type { Agent } from './ai/agent.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { PageFetcher } from './discovery/fetch-page.ts';
import type { Gmail } from './google/gmail.ts';
import type { GoogleAuth } from './google/oauth.ts';
import type { Youtube } from './google/youtube.ts';
import { pollInbox } from './inbox/monitor.ts';
import { errorMessage, logger } from './log.ts';
import type { Notifier } from './notify.ts';
import { discoverYoutubeCreators } from './outreach/discover.ts';
import { enrichCreator } from './outreach/enrich.ts';
import { dayKey } from './outreach/schedule.ts';
import { sendNextDue } from './outreach/sender.ts';
import { nextToEnrich } from './repo/creators.ts';
import { getKv, incrementKv, logActivity, setKv } from './repo/state.ts';

const log = logger('scheduler');

const SEND_EVERY_MS = 5 * 60 * 1000;
const ENRICH_EVERY_MS = 10 * 60 * 1000;
const DISCOVERY_CHECK_MS = 60 * 60 * 1000;
const ENRICH_BATCH = 5;

export type JobName = 'inbox' | 'send' | 'enrich' | 'discover';

export interface Services {
  db: Db;
  config: Config;
  auth: GoogleAuth;
  gmail: Gmail;
  youtube?: Youtube;
  agent?: Agent;
  notify: Notifier;
  fetchPage: PageFetcher;
}

export interface JobStatus {
  running: boolean;
  lastRunAt: string | null;
  lastResult: string | null;
  lastError: string | null;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  run(job: JobName, opts?: { force?: boolean }): Promise<string>;
  status(): Record<JobName, JobStatus>;
}

export function createScheduler(s: Services): Scheduler {
  const timers: NodeJS.Timeout[] = [];
  const state = Object.fromEntries(
    (['inbox', 'send', 'enrich', 'discover'] as const).map((j) => [
      j,
      { running: false, lastRunAt: null, lastResult: null, lastError: null } satisfies JobStatus,
    ]),
  ) as Record<JobName, JobStatus>;

  function gmailAccount(): string | undefined {
    return s.auth.isConnected() ? s.auth.account() : undefined;
  }

  const jobs: Record<JobName, (force: boolean) => Promise<string>> = {
    async inbox() {
      const account = gmailAccount();
      if (!account) return 'skipped: Gmail not connected';
      const r = await pollInbox(s.db, { gmail: s.gmail, agent: s.agent, notify: s.notify, config: s.config, account });
      return `processed ${r.processed} new messages`;
    },

    async send() {
      const account = gmailAccount();
      if (!account) return 'skipped: Gmail not connected';
      return sendNextDue(s.db, { gmail: s.gmail, config: s.config, account });
    },

    async enrich(force) {
      if (!s.agent) return 'skipped: ANTHROPIC_API_KEY not set';
      const key = `enriched:${dayKey(new Date())}`;
      const done = Number(getKv(s.db, key) ?? 0);
      const budget = force ? ENRICH_BATCH : Math.min(ENRICH_BATCH, s.config.ENRICH_PER_DAY - done);
      if (budget <= 0) return 'daily enrichment limit reached';
      const creators = nextToEnrich(s.db, budget).filter((c) => c.platform !== 'youtube' || s.youtube);
      const outcomes: string[] = [];
      for (const c of creators) {
        outcomes.push(
          await enrichCreator(s.db, { agent: s.agent, config: s.config, fetchPage: s.fetchPage, youtube: s.youtube }, c),
        );
        incrementKv(s.db, key);
      }
      return creators.length ? outcomes.join(', ') : 'nothing to enrich';
    },

    async discover(force) {
      if (!s.youtube) return 'skipped: YOUTUBE_API_KEY not set';
      const today = dayKey(new Date());
      if (!force && getKv(s.db, 'last_discovery') === today) return 'already ran today';
      setKv(s.db, 'last_discovery', today);
      const r = await discoverYoutubeCreators(s.db, s.config, s.youtube);
      return `added ${r.added} creators from ${r.searched} niches`;
    },
  };

  async function run(job: JobName, opts: { force?: boolean } = {}): Promise<string> {
    const st = state[job];
    if (st.running) return 'already running';
    st.running = true;
    try {
      const result = await jobs[job](opts.force ?? false);
      st.lastResult = result;
      st.lastError = null;
      return result;
    } catch (error) {
      st.lastError = errorMessage(error);
      log.error(`${job} failed`, error);
      logActivity(s.db, 'error', `${job} job failed: ${errorMessage(error)}`);
      return `error: ${st.lastError}`;
    } finally {
      st.running = false;
      st.lastRunAt = new Date().toISOString();
    }
  }

  function every(ms: number, job: JobName): void {
    timers.push(setInterval(() => void run(job), ms));
  }

  return {
    start() {
      every(s.config.INBOX_POLL_SECONDS * 1000, 'inbox');
      every(SEND_EVERY_MS, 'send');
      every(ENRICH_EVERY_MS, 'enrich');
      every(DISCOVERY_CHECK_MS, 'discover');
      void run('inbox');
      void run('discover');
      log.info('worker started');
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
    },
    run,
    status: () => structuredClone(state),
  };
}
