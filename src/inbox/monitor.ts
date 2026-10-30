import type { Agent } from '../ai/agent.ts';
import type { Triage } from '../ai/prompts.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import { GmailError, type Gmail, type GmailMessage } from '../google/gmail.ts';
import { stripQuoted } from '../google/mime.ts';
import { errorMessage, logger } from '../log.ts';
import { gmailThreadUrl, type Notifier } from '../notify.ts';
import { findCreatorByEmail, getCreator, updateCreator, type Creator } from '../repo/creators.ts';
import { insertInboxItem, updateInboxItem, type InboxCategory } from '../repo/inbox.ts';
import { findSequenceByCreator, findSequenceByThread, stopSequence } from '../repo/sequences.ts';
import { getKv, logActivity, setKv } from '../repo/state.ts';
import { followUpSubject } from '../outreach/schedule.ts';

const log = logger('inbox');
const HISTORY_KEY = 'gmail_history_id';
const THREAD_MESSAGES_FOR_CONTEXT = 6;
const SKIP_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'SPAM'];
const BOUNCE_FROM_RE = /^(mailer-daemon|postmaster)@/i;
const NO_DRAFT_CATEGORIES: readonly InboxCategory[] = ['spam', 'newsletter', 'notification', 'opt_out', 'bounce'];

export interface MonitorDeps {
  gmail: Gmail;
  agent?: Agent;
  notify: Notifier;
  config: Config;
  account: string;
}

export interface PollResult {
  processed: number;
}

/** Fetches inbox messages added since the last poll and handles each one. */
export async function pollInbox(db: Db, deps: MonitorDeps): Promise<PollResult> {
  const lastHistoryId = getKv(db, HISTORY_KEY);
  if (!lastHistoryId) {
    const profile = await deps.gmail.profile();
    setKv(db, HISTORY_KEY, profile.historyId);
    logActivity(db, 'inbox', `Inbox monitoring started for ${profile.emailAddress}`);
    return { processed: 0 };
  }

  let batch: { ids: string[]; historyId: string };
  try {
    batch = await deps.gmail.newInboxMessageIds(lastHistoryId);
  } catch (error) {
    if (error instanceof GmailError && error.status === 404) {
      // History IDs expire after about a week offline; restart from now.
      const profile = await deps.gmail.profile();
      setKv(db, HISTORY_KEY, profile.historyId);
      logActivity(db, 'inbox', 'Inbox history expired — resumed monitoring from now');
      return { processed: 0 };
    }
    throw error;
  }

  let processed = 0;
  for (const id of batch.ids) {
    try {
      const message = await deps.gmail.getMessage(id);
      if (message.fromAddress === deps.account) continue;
      const itemId = insertInboxItem(db, {
        gmail_message_id: message.id,
        thread_id: message.threadId,
        from_addr: message.from,
        subject: message.subject,
        snippet: message.snippet,
        received_at: message.date,
      });
      if (itemId === null) continue;
      await handleMessage(db, deps, message, itemId);
      processed++;
    } catch (error) {
      log.error(`message ${id} failed`, error);
      logActivity(db, 'error', `Inbox: failed to process a message — ${errorMessage(error)}`);
    }
  }
  setKv(db, HISTORY_KEY, batch.historyId);
  return { processed };
}

function outreachCreatorFor(db: Db, message: GmailMessage): Creator | undefined {
  const seq = findSequenceByThread(db, message.threadId);
  if (seq) return getCreator(db, seq.creator_id);
  const byEmail = findCreatorByEmail(db, message.fromAddress);
  return byEmail && findSequenceByCreator(db, byEmail.id)?.thread_id ? byEmail : undefined;
}

async function handleBounce(db: Db, deps: MonitorDeps, message: GmailMessage, itemId: number): Promise<void> {
  const seq = findSequenceByThread(db, message.threadId);
  const creator = seq ? getCreator(db, seq.creator_id) : undefined;
  if (seq && creator) {
    stopSequence(db, seq.id, 'bounced');
    updateCreator(db, creator.id, { status: 'bounced' });
    logActivity(db, 'reply', `${creator.name}: email bounced — sequence stopped`, creator.id);
  }
  updateInboxItem(db, itemId, { category: 'bounce', summary: 'Delivery failure', creator_id: creator?.id ?? null });
  if (creator) {
    await deps.notify({ title: `Bounced: ${creator.name}`, message: `${creator.email} is undeliverable`, tags: ['warning'] });
    updateInboxItem(db, itemId, { notified: 1 });
  }
}

/** Stops the creator's sequence the moment they reply, before any AI call can fail. */
function recordCreatorReply(db: Db, creator: Creator): void {
  const seq = findSequenceByCreator(db, creator.id);
  if (seq) stopSequence(db, seq.id, 'replied');
  // Never downgrade a suppression: an opted-out or bounced creator stays that way.
  if (creator.status === 'opted_out' || creator.status === 'bounced') return;
  updateCreator(db, creator.id, { status: 'replied' });
  logActivity(db, 'reply', `${creator.name || creator.handle} replied`, creator.id);
}

async function buildThreadText(deps: MonitorDeps, threadId: string): Promise<string> {
  const messages = await deps.gmail.getThread(threadId);
  return messages
    .slice(-THREAD_MESSAGES_FOR_CONTEXT)
    .map((m) => `From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${stripQuoted(m.text).slice(0, 4000)}`)
    .join('\n\n---\n\n');
}

async function createReplyDraft(deps: MonitorDeps, message: GmailMessage, creator: Creator | undefined): Promise<string> {
  const body = await deps.agent!.draftReply(await buildThreadText(deps, message.threadId), creator);
  // Gmail may return folded header values; unfold before reusing them in our draft.
  const references = [message.references, message.rfcMessageId].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || null;
  const draft = await deps.gmail.createDraft(
    {
      from: `${deps.config.SENDER_NAME} <${deps.account}>`,
      to: message.fromAddress,
      subject: followUpSubject(message.subject || '(no subject)'),
      text: `${body}\n\n${deps.config.SENDER_NAME}`,
      inReplyTo: message.rfcMessageId,
      references,
    },
    message.threadId,
  );
  return draft.id;
}

function shouldNotify(level: Config['NOTIFY_LEVEL'], category: InboxCategory, needsReply: boolean): boolean {
  if (category === 'spam') return false;
  if (level === 'all') return true;
  return needsReply || category === 'creator_reply' || category === 'opt_out';
}

async function handleMessage(db: Db, deps: MonitorDeps, message: GmailMessage, itemId: number): Promise<void> {
  if (BOUNCE_FROM_RE.test(message.fromAddress)) return handleBounce(db, deps, message, itemId);

  const creator = outreachCreatorFor(db, message);
  if (creator) recordCreatorReply(db, creator);

  const bulk = message.labelIds.some((l) => SKIP_LABELS.includes(l)) || message.listUnsubscribe || message.autoSubmitted;
  if (bulk && !creator) {
    updateInboxItem(db, itemId, { category: 'skipped' });
    return;
  }

  let triage: Triage = {
    category: creator ? 'creator_reply' : 'business',
    needsReply: true,
    urgency: 'normal',
    summary: message.snippet.slice(0, 140),
  };
  if (deps.agent) {
    triage = await deps.agent.triage({
      from: message.from,
      subject: message.subject,
      text: stripQuoted(message.text) || message.snippet,
      isOutreachThread: Boolean(creator),
    });
  }
  const category: InboxCategory = creator && triage.category !== 'opt_out' ? 'creator_reply' : triage.category;
  updateInboxItem(db, itemId, {
    category,
    needs_reply: triage.needsReply ? 1 : 0,
    summary: triage.summary,
    creator_id: creator?.id ?? null,
  });

  if (creator && category === 'opt_out') {
    updateCreator(db, creator.id, { status: 'opted_out' });
    logActivity(db, 'reply', `${creator.name}: opted out — will never be emailed again`, creator.id);
  }

  let draftNote = '';
  if (deps.agent && triage.needsReply && !NO_DRAFT_CATEGORIES.includes(category)) {
    try {
      const draftId = await createReplyDraft(deps, message, creator);
      updateInboxItem(db, itemId, { draft_id: draftId });
      draftNote = '\n✍️ Reply draft ready in Gmail';
    } catch (error) {
      updateInboxItem(db, itemId, { error: errorMessage(error) });
      draftNote = '\n⚠️ Could not draft a reply';
      log.error('draft failed', error);
    }
  }

  if (!shouldNotify(deps.config.NOTIFY_LEVEL, category, triage.needsReply)) return;
  const sender = message.from.replace(/\s*<.*>$/, '').replace(/"/g, '') || message.fromAddress;
  const title =
    category === 'creator_reply'
      ? `💬 ${creator?.name || sender} replied to your outreach`
      : category === 'opt_out'
        ? `🚫 ${sender} opted out`
        : `✉️ ${sender}: ${message.subject || '(no subject)'}`;
  await deps.notify({
    title,
    message: `${triage.summary}${draftNote}`,
    url: gmailThreadUrl(message.threadId),
    priority: triage.urgency === 'high' || category === 'creator_reply' ? 'high' : triage.needsReply ? 'default' : 'low',
    tags: category === 'creator_reply' ? ['tada'] : undefined,
  });
  updateInboxItem(db, itemId, { notified: 1 });
}
