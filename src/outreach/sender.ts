import type { Config } from '../config.ts';
import type { Db } from '../db.ts';
import type { Gmail } from '../google/gmail.ts';
import { errorMessage, logger } from '../log.ts';
import { getCreator, isSuppressed, updateCreator } from '../repo/creators.ts';
import { claimStep, markStepSent, nextDueStep, releaseStep, stopSequence, type DueStep } from '../repo/sequences.ts';
import { getKv, incrementKv, logActivity } from '../repo/state.ts';
import { dayKey, followUpSubject, isWithinSendWindow } from './schedule.ts';

const log = logger('sender');
const RETRY_DELAY_MS = 60 * 60 * 1000;

export interface SenderDeps {
  gmail: Gmail;
  config: Config;
  /** The connected Gmail address — used to tell our messages apart from replies. */
  account: string;
}

export type SendOutcome = 'sent' | 'outside_window' | 'daily_limit' | 'nothing_due' | 'stopped' | 'error';

/** Signature + opt-out line appended to every outreach email (CAN-SPAM needs the postal address). */
export function withFooter(body: string, config: Config): string {
  const lines = [body.trim(), '', config.SENDER_NAME, config.SENDER_TITLE];
  if (config.SENDER_ADDRESS) lines.push(config.SENDER_ADDRESS);
  lines.push('', `Not for you? Reply "no thanks" and I won't follow up.`);
  return lines.join('\n');
}

export function sentToday(db: Db, now: Date): number {
  return Number(getKv(db, `sent:${dayKey(now)}`) ?? 0);
}

/** Before a follow-up, re-check the thread: any message not from us means they replied. */
async function threadHasReply(gmail: Gmail, threadId: string, account: string): Promise<boolean> {
  const messages = await gmail.getThread(threadId);
  return messages.some((m) => m.fromAddress !== account);
}

async function sendStep(db: Db, deps: SenderDeps, step: DueStep, now: Date): Promise<SendOutcome> {
  const creator = getCreator(db, step.creator_id);
  if (!creator || isSuppressed(db, step.email)) {
    stopSequence(db, step.sequence_id, 'suppressed');
    return 'stopped';
  }
  if (step.step_index > 0 && step.thread_id && (await threadHasReply(deps.gmail, step.thread_id, deps.account))) {
    stopSequence(db, step.sequence_id, 'replied');
    updateCreator(db, creator.id, { status: 'replied' });
    logActivity(db, 'reply', `${creator.name}: replied — follow-ups cancelled`, creator.id);
    return 'stopped';
  }

  const firstSubject =
    step.step_index === 0
      ? step.subject
      : ((db.prepare('SELECT subject FROM sequence_steps WHERE sequence_id = ? AND step_index = 0').get(step.sequence_id) as
          | { subject: string }
          | undefined)?.subject ?? step.subject);
  const from = `${deps.config.SENDER_NAME} <${deps.account}>`;
  if (!claimStep(db, step.id)) return 'nothing_due';
  let sent: { id: string; threadId: string };
  try {
    sent = await deps.gmail.send(
    {
      from,
      to: step.email,
      subject: step.step_index === 0 ? step.subject : followUpSubject(firstSubject),
      text: withFooter(step.body, deps.config),
      inReplyTo: step.step_index > 0 ? step.last_rfc_message_id : null,
    },
    step.step_index > 0 ? step.thread_id : null,
    );
  } catch (error) {
    // Gmail rejected it, so nothing went out — safe to retry later.
    releaseStep(db, step.id, new Date(now.getTime() + RETRY_DELAY_MS).toISOString());
    log.error(`step ${step.id} failed`, error);
    logActivity(db, 'error', `Sending to ${step.email} failed (retrying in 1h): ${errorMessage(error)}`, step.creator_id);
    return 'error';
  }
  try {
    const sentMessage = await deps.gmail.getMessage(sent.id).catch(() => undefined);
    markStepSent(db, step, {
      gmailMessageId: sent.id,
      threadId: sent.threadId,
      rfcMessageId: sentMessage?.rfcMessageId ?? null,
      sentAt: now.toISOString(),
    });
  } catch (error) {
    // The email DID go out. Leave the step in 'sending' so it is never sent twice.
    log.error(`step ${step.id} sent as ${sent.id} but could not be recorded`, error);
    logActivity(db, 'error', `Sent to ${step.email} but failed to record it — sequence paused to avoid a double send: ${errorMessage(error)}`, step.creator_id);
    return 'error';
  }
  incrementKv(db, `sent:${dayKey(now)}`);
  const what = step.step_index === 0 ? 'first email' : `follow-up #${step.step_index}`;
  logActivity(db, 'send', `Sent ${what} to ${creator.name || creator.handle} <${step.email}>`, creator.id);
  return 'sent';
}

/** Sends at most one due email per call; the scheduler calls this every few minutes. */
export async function sendNextDue(db: Db, deps: SenderDeps, now = new Date()): Promise<SendOutcome> {
  const { config } = deps;
  if (!isWithinSendWindow(now, config.SEND_WINDOW_START, config.SEND_WINDOW_END)) return 'outside_window';
  if (sentToday(db, now) >= config.DAILY_SEND_LIMIT) return 'daily_limit';
  const step = nextDueStep(db, now.toISOString());
  if (!step) return 'nothing_due';
  try {
    return await sendStep(db, deps, step, now);
  } catch (error) {
    // Failures before the claim (e.g. the reply check) leave the step scheduled; back off.
    db.prepare(`UPDATE sequence_steps SET due_at = ? WHERE id = ? AND status = 'scheduled'`).run(
      new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
      step.id,
    );
    log.error(`step ${step.id} failed`, error);
    logActivity(db, 'error', `Sending to ${step.email} failed (retrying in 1h): ${errorMessage(error)}`, step.creator_id);
    return 'error';
  }
}
