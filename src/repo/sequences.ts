import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { addDays, type StepSpec } from '../outreach/schedule.ts';
import type { Creator } from './creators.ts';
import { updateCreator } from './creators.ts';

export type SequenceStatus = 'pending_approval' | 'active' | 'stopped' | 'completed' | 'rejected';
export type StepStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'skipped';

export interface Sequence {
  id: number;
  creator_id: number;
  status: SequenceStatus;
  stop_reason: string | null;
  thread_id: string | null;
  last_rfc_message_id: string | null;
  created_at: string;
}

export interface Step {
  id: number;
  sequence_id: number;
  step_index: number;
  delay_days: number;
  subject: string;
  body: string;
  status: StepStatus;
  due_at: string | null;
  sent_at: string | null;
  gmail_message_id: string | null;
}

export interface SequenceView extends Sequence {
  creator: Creator;
  steps: Step[];
}

export interface DueStep extends Step {
  creator_id: number;
  email: string;
  thread_id: string | null;
  last_rfc_message_id: string | null;
}

export function createSequence(db: Db, creatorId: number, steps: readonly StepSpec[]): number {
  return transaction(db, () => {
    const seq = db.prepare('INSERT INTO sequences (creator_id) VALUES (?)').run(creatorId);
    const sequenceId = Number(seq.lastInsertRowid);
    const insert = db.prepare(
      'INSERT INTO sequence_steps (sequence_id, step_index, delay_days, subject, body) VALUES (?, ?, ?, ?, ?)',
    );
    for (const s of steps) insert.run(sequenceId, s.step_index, s.delay_days, s.subject, s.body);
    updateCreator(db, creatorId, { status: 'drafted' });
    return sequenceId;
  });
}

export function getSequence(db: Db, id: number): Sequence | undefined {
  return db.prepare('SELECT * FROM sequences WHERE id = ?').get(id) as Sequence | undefined;
}

export function getSteps(db: Db, sequenceId: number): Step[] {
  return db
    .prepare('SELECT * FROM sequence_steps WHERE sequence_id = ? ORDER BY step_index')
    .all(sequenceId) as unknown as Step[];
}

export function listSequences(db: Db, status: SequenceStatus, limit = 100): SequenceView[] {
  const seqs = db
    .prepare('SELECT * FROM sequences WHERE status = ? ORDER BY id DESC LIMIT ?')
    .all(status, limit) as unknown as Sequence[];
  return seqs.map((s) => ({
    ...s,
    creator: db.prepare('SELECT * FROM creators WHERE id = ?').get(s.creator_id) as unknown as Creator,
    steps: getSteps(db, s.id),
  }));
}

export function findSequenceByThread(db: Db, threadId: string): Sequence | undefined {
  return db.prepare('SELECT * FROM sequences WHERE thread_id = ?').get(threadId) as Sequence | undefined;
}

export function findSequenceByCreator(db: Db, creatorId: number): Sequence | undefined {
  return db.prepare('SELECT * FROM sequences WHERE creator_id = ?').get(creatorId) as Sequence | undefined;
}

/** Edits an unsent step. Returns false if the step was already sent or skipped. */
export function editStep(db: Db, stepId: number, subject: string, body: string): boolean {
  const result = db
    .prepare(`UPDATE sequence_steps SET subject = ?, body = ? WHERE id = ? AND status IN ('draft','scheduled')`)
    .run(subject, body, stepId);
  return result.changes > 0;
}

/** Approves a pending sequence: the first email becomes due immediately. */
export function approveSequence(db: Db, sequenceId: number, now: string): boolean {
  return transaction(db, () => {
    const result = db
      .prepare(`UPDATE sequences SET status = 'active' WHERE id = ? AND status = 'pending_approval'`)
      .run(sequenceId);
    if (result.changes === 0) return false;
    db.prepare(
      `UPDATE sequence_steps SET status = 'scheduled', due_at = ? WHERE sequence_id = ? AND step_index = 0`,
    ).run(now, sequenceId);
    return true;
  });
}

export function rejectSequence(db: Db, sequenceId: number): boolean {
  return transaction(db, () => {
    const seq = getSequence(db, sequenceId);
    if (!seq || seq.status !== 'pending_approval') return false;
    db.prepare(`UPDATE sequences SET status = 'rejected' WHERE id = ?`).run(sequenceId);
    db.prepare(`UPDATE sequence_steps SET status = 'skipped' WHERE sequence_id = ?`).run(sequenceId);
    updateCreator(db, seq.creator_id, { status: 'rejected' });
    return true;
  });
}

/** Stops an active sequence; unsent steps are skipped. Idempotent. */
export function stopSequence(db: Db, sequenceId: number, reason: string): void {
  transaction(db, () => {
    db.prepare(
      `UPDATE sequences SET status = 'stopped', stop_reason = ? WHERE id = ? AND status IN ('active','pending_approval')`,
    ).run(reason, sequenceId);
    db.prepare(
      `UPDATE sequence_steps SET status = 'skipped' WHERE sequence_id = ? AND status IN ('draft','scheduled')`,
    ).run(sequenceId);
  });
}

/** The oldest step that is due, belongs to an active sequence, and whose creator has an email. */
export function nextDueStep(db: Db, now: string): DueStep | undefined {
  return db
    .prepare(
      `SELECT st.*, s.creator_id, c.email, s.thread_id, s.last_rfc_message_id
         FROM sequence_steps st
         JOIN sequences s ON s.id = st.sequence_id
         JOIN creators c ON c.id = s.creator_id
        WHERE st.status = 'scheduled' AND st.due_at <= ? AND s.status = 'active'
          AND c.email IS NOT NULL AND c.status IN ('drafted','in_sequence')
        ORDER BY st.due_at, st.id LIMIT 1`,
    )
    .get(now) as DueStep | undefined;
}

/**
 * Claims a due step before it is handed to Gmail. Only one caller can win, and a step left in
 * 'sending' (crash between Gmail accepting it and us recording it) is never retried automatically.
 */
export function claimStep(db: Db, stepId: number): boolean {
  return db.prepare(`UPDATE sequence_steps SET status = 'sending' WHERE id = ? AND status = 'scheduled'`).run(stepId).changes > 0;
}

/** Returns a claimed step to the queue after Gmail rejected it. */
export function releaseStep(db: Db, stepId: number, retryAt: string): void {
  db.prepare(`UPDATE sequence_steps SET status = 'scheduled', due_at = ? WHERE id = ? AND status = 'sending'`).run(retryAt, stepId);
}

export interface SentInfo {
  gmailMessageId: string;
  threadId: string;
  rfcMessageId: string | null;
  sentAt: string;
}

/**
 * Records a sent step. After the first email, follow-ups are scheduled relative to its send
 * time. When nothing is left to send the sequence (and creator) are completed.
 */
export function markStepSent(db: Db, step: DueStep, info: SentInfo): void {
  transaction(db, () => {
    db.prepare(`UPDATE sequence_steps SET status = 'sent', sent_at = ?, gmail_message_id = ? WHERE id = ?`).run(
      info.sentAt,
      info.gmailMessageId,
      step.id,
    );
    db.prepare('UPDATE sequences SET thread_id = ?, last_rfc_message_id = COALESCE(?, last_rfc_message_id) WHERE id = ?').run(
      info.threadId,
      info.rfcMessageId,
      step.sequence_id,
    );
    if (step.step_index === 0) {
      const followUps = db
        .prepare(`SELECT id, delay_days FROM sequence_steps WHERE sequence_id = ? AND status = 'draft'`)
        .all(step.sequence_id) as { id: number; delay_days: number }[];
      const schedule = db.prepare(`UPDATE sequence_steps SET status = 'scheduled', due_at = ? WHERE id = ?`);
      for (const f of followUps) schedule.run(addDays(info.sentAt, f.delay_days), f.id);
      setCreatorStatusIfActive(db, step.creator_id, 'in_sequence');
    }
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM sequence_steps WHERE sequence_id = ? AND status IN ('draft','scheduled')`)
      .get(step.sequence_id) as { n: number };
    if (remaining.n === 0) {
      db.prepare(`UPDATE sequences SET status = 'completed' WHERE id = ? AND status = 'active'`).run(step.sequence_id);
      setCreatorStatusIfActive(db, step.creator_id, 'completed');
    }
  });
}

/** A reply, opt-out or bounce recorded while Gmail was sending must not be overwritten. */
function setCreatorStatusIfActive(db: Db, creatorId: number, status: 'in_sequence' | 'completed'): void {
  db.prepare(
    `UPDATE creators SET status = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('drafted','in_sequence')`,
  ).run(status, creatorId);
}
