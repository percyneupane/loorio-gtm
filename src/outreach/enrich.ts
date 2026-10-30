import { readPitch, type Agent } from '../ai/agent.ts';
import { extractEmails, extractUrls } from '../discovery/extract.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { gatherPublicEmails, type GatherDeps } from '../discovery/gather.ts';
import { errorMessage, logger } from '../log.ts';
import {
  getCreator,
  isSuppressed,
  replaceCandidates,
  updateCreator,
  type Creator,
} from '../repo/creators.ts';
import { approveSequence, createSequence } from '../repo/sequences.ts';
import { logActivity } from '../repo/state.ts';
import { buildSteps, type DraftEmail } from './schedule.ts';

const log = logger('enrich');

export interface EnrichDeps extends GatherDeps {
  agent: Agent;
  config: Config;
  now?: () => string;
  /** Pitch text; defaults to config/pitch.md. */
  pitch?: string;
}

/**
 * Links or addresses in a draft that the pitch never mentions. Scraped pages flow into the
 * drafting prompt, so an auto-approved email must not carry anything a page could have planted.
 */
export function unexpectedContacts(drafts: readonly DraftEmail[], pitch: string): string[] {
  const text = drafts.map((d) => `${d.subject}\n${d.body}`).join('\n');
  const found = [...extractUrls(text), ...extractEmails(text).map((e) => e.email)];
  const domains = text.match(/\b[a-z0-9-]+\.(?:com|co|io|ai|app|net|org|me|ly|gg|xyz)\b/gi) ?? [];
  const lowerPitch = pitch.toLowerCase();
  return [...new Set([...found, ...domains])].filter((x) => !lowerPitch.includes(x.toLowerCase().replace(/\/$/, '')));
}

export type EnrichOutcome = 'drafted' | 'no_email' | 'rejected' | 'duplicate' | 'error';

/** One creator: find public emails → AI picks the email and scores fit → AI drafts the sequence. */
export async function enrichCreator(db: Db, deps: EnrichDeps, creator: Creator): Promise<EnrichOutcome> {
  const label = creator.name || `@${creator.handle}`;
  try {
    const gathered = await gatherPublicEmails(creator, deps);
    updateCreator(db, creator.id, {
      name: gathered.profile.name || creator.name,
      bio: gathered.profile.bio ?? creator.bio,
      followers: gathered.profile.followers ?? creator.followers,
      channel_id: gathered.profile.channelId ?? creator.channel_id,
      context: gathered.context,
    });
    replaceCandidates(db, creator.id, gathered.candidates);

    if (gathered.candidates.length === 0) {
      updateCreator(db, creator.id, { status: 'no_email', error: gathered.errors.join('; ') || null });
      logActivity(db, 'enrich', `${label}: no public email found`, creator.id);
      return 'no_email';
    }

    const fresh = getCreator(db, creator.id)!;
    const q = await deps.agent.qualify(fresh, gathered.context, gathered.candidates);
    const source = gathered.candidates.find((c) => c.email === q.email);
    updateCreator(db, creator.id, {
      email: q.email,
      email_source: source ? `${source.source_label} — ${source.source_url}` : null,
      fit_score: q.fitScore,
      fit_reason: q.fitReason,
      first_name: q.firstName,
    });

    if (!q.email) {
      updateCreator(db, creator.id, { status: 'no_email', error: q.emailReason });
      logActivity(db, 'enrich', `${label}: no usable business email (${q.emailReason})`, creator.id);
      return 'no_email';
    }
    if (isSuppressed(db, q.email) || emailAlreadyContacted(db, q.email, creator.id)) {
      updateCreator(db, creator.id, { status: 'rejected', error: 'Email already contacted or suppressed' });
      return 'duplicate';
    }
    if (q.fitScore < deps.config.MIN_FIT_SCORE) {
      updateCreator(db, creator.id, { status: 'rejected' });
      logActivity(db, 'enrich', `${label}: fit ${q.fitScore} below threshold — ${q.fitReason}`, creator.id);
      return 'rejected';
    }

    const drafts = await deps.agent.draftSequence(getCreator(db, creator.id)!, q.hook, deps.config.followUpDays.length);
    const sequenceId = createSequence(db, creator.id, buildSteps(drafts, deps.config.followUpDays));
    if (deps.config.AUTO_APPROVE) {
      const stray = unexpectedContacts(drafts, deps.pitch ?? readPitch());
      if (stray.length === 0) {
        approveSequence(db, sequenceId, (deps.now ?? (() => new Date().toISOString()))());
      } else {
        logActivity(db, 'enrich', `${label}: held for review — draft contains ${stray.join(', ')} not in pitch.md`, creator.id);
      }
    }
    logActivity(db, 'enrich', `${label}: drafted ${drafts.length} emails to ${q.email} (fit ${q.fitScore})`, creator.id);
    return 'drafted';
  } catch (error) {
    log.error(`${label} failed`, error);
    updateCreator(db, creator.id, { status: 'error', error: errorMessage(error) });
    logActivity(db, 'error', `${label}: enrichment failed — ${errorMessage(error)}`, creator.id);
    return 'error';
  }
}

/** Two creators can share one inbox (e.g. a channel on YouTube and TikTok) — email once. */
function emailAlreadyContacted(db: Db, email: string, creatorId: number): boolean {
  const row = db
    .prepare(`SELECT 1 FROM creators WHERE email = ? AND id != ? AND status NOT IN ('new','no_email','rejected','error') LIMIT 1`)
    .get(email, creatorId);
  return row !== undefined;
}
