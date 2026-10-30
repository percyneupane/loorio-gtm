import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';

export type Platform = 'youtube' | 'tiktok' | 'instagram' | 'web';
export type CreatorStatus =
  | 'new'
  | 'no_email'
  | 'rejected'
  | 'drafted'
  | 'in_sequence'
  | 'replied'
  | 'opted_out'
  | 'bounced'
  | 'completed'
  | 'error';

export interface Creator {
  id: number;
  platform: Platform;
  handle: string;
  channel_id: string | null;
  name: string;
  url: string;
  followers: number | null;
  bio: string;
  context: string;
  status: CreatorStatus;
  email: string | null;
  email_source: string | null;
  fit_score: number | null;
  fit_reason: string | null;
  first_name: string | null;
  error: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface NewCreator {
  platform: Platform;
  handle: string;
  channel_id?: string | null;
  name?: string;
  url?: string;
  followers?: number | null;
  bio?: string;
  context?: string;
  source?: string;
}

export interface EmailCandidate {
  email: string;
  source_url: string;
  source_label: string;
  snippet: string;
}

/** Statuses after which a creator must never be emailed again. */
export const TERMINAL_STATUSES: readonly CreatorStatus[] = ['replied', 'opted_out', 'bounced', 'completed'];

/** Inserts a creator unless (platform, handle) already exists. Returns the id when inserted. */
export function insertCreator(db: Db, c: NewCreator): number | null {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO creators (platform, handle, channel_id, name, url, followers, bio, context, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.platform,
      c.handle.toLowerCase(),
      c.channel_id ?? null,
      c.name ?? '',
      c.url ?? '',
      c.followers ?? null,
      c.bio ?? '',
      c.context ?? '',
      c.source ?? 'manual',
    );
  return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}

export function getCreator(db: Db, id: number): Creator | undefined {
  return db.prepare('SELECT * FROM creators WHERE id = ?').get(id) as Creator | undefined;
}

export function findCreatorByEmail(db: Db, email: string): Creator | undefined {
  return db.prepare('SELECT * FROM creators WHERE email = ? ORDER BY id LIMIT 1').get(email.toLowerCase()) as
    | Creator
    | undefined;
}

/** An address is suppressed once anyone using it replied, opted out or bounced — no more cold email. */
export function isSuppressed(db: Db, email: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM creators WHERE email = ? AND status IN ('opted_out','bounced','replied') LIMIT 1`)
    .get(email.toLowerCase());
  return row !== undefined;
}

export function listCreators(db: Db, status?: CreatorStatus, limit = 200): Creator[] {
  const sql = status
    ? 'SELECT * FROM creators WHERE status = ? ORDER BY updated_at DESC LIMIT ?'
    : 'SELECT * FROM creators ORDER BY updated_at DESC LIMIT ?';
  const params = status ? [status, limit] : [limit];
  return db.prepare(sql).all(...params) as unknown as Creator[];
}

export function countByStatus(db: Db): Record<string, number> {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM creators GROUP BY status').all() as {
    status: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

type UpdatableField =
  | 'status'
  | 'email'
  | 'email_source'
  | 'fit_score'
  | 'fit_reason'
  | 'first_name'
  | 'error'
  | 'name'
  | 'bio'
  | 'context'
  | 'url'
  | 'followers'
  | 'channel_id';

export function updateCreator(db: Db, id: number, fields: Partial<Pick<Creator, UpdatableField>>): void {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(', ');
  const values = entries.map(([, v]) => v as string | number | null);
  db.prepare(`UPDATE creators SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
}

export function replaceCandidates(db: Db, creatorId: number, candidates: readonly EmailCandidate[]): void {
  db.prepare('DELETE FROM email_candidates WHERE creator_id = ?').run(creatorId);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO email_candidates (creator_id, email, source_url, source_label, snippet) VALUES (?, ?, ?, ?, ?)',
  );
  for (const c of candidates) insert.run(creatorId, c.email, c.source_url, c.source_label, c.snippet);
}

export function listCandidates(db: Db, creatorId: number): EmailCandidate[] {
  return db
    .prepare('SELECT email, source_url, source_label, snippet FROM email_candidates WHERE creator_id = ?')
    .all(creatorId) as unknown as EmailCandidate[];
}

/** Creators waiting for enrichment, oldest first. */
export function nextToEnrich(db: Db, limit: number): Creator[] {
  return db
    .prepare(`SELECT * FROM creators WHERE status = 'new' ORDER BY id LIMIT ?`)
    .all(limit) as unknown as Creator[];
}
