import type { Db } from '../db.ts';

export function getKv(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKv(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export function deleteKv(db: Db, key: string): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}

/** Atomically adds `by` to a numeric counter and returns the new value. */
export function incrementKv(db: Db, key: string, by = 1): number {
  const row = db
    .prepare(
      `INSERT INTO kv (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ? RETURNING value`,
    )
    .get(key, String(by), by) as { value: string | number };
  return Number(row.value);
}

export type ActivityKind = 'discovery' | 'enrich' | 'approve' | 'send' | 'reply' | 'inbox' | 'error' | 'system';

export interface Activity {
  id: number;
  kind: ActivityKind;
  message: string;
  creator_id: number | null;
  created_at: string;
}

export function logActivity(db: Db, kind: ActivityKind, message: string, creatorId: number | null = null): void {
  db.prepare('INSERT INTO activity (kind, message, creator_id) VALUES (?, ?, ?)').run(kind, message, creatorId);
}

export function recentActivity(db: Db, limit = 100): Activity[] {
  return db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit) as unknown as Activity[];
}
