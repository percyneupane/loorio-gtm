import type { Db } from '../db.ts';

export type InboxCategory =
  | 'pending'
  | 'creator_reply'
  | 'opt_out'
  | 'bounce'
  | 'business'
  | 'personal'
  | 'notification'
  | 'newsletter'
  | 'spam'
  | 'skipped';

export interface InboxItem {
  id: number;
  gmail_message_id: string;
  thread_id: string;
  from_addr: string;
  subject: string;
  snippet: string;
  received_at: string;
  category: InboxCategory;
  needs_reply: number;
  summary: string;
  creator_id: number | null;
  draft_id: string | null;
  notified: number;
  error: string | null;
}

export interface NewInboxItem {
  gmail_message_id: string;
  thread_id: string;
  from_addr: string;
  subject: string;
  snippet: string;
  received_at: string;
}

/** Returns the new row id, or null if this Gmail message was already recorded. */
export function insertInboxItem(db: Db, item: NewInboxItem): number | null {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO inbox_items (gmail_message_id, thread_id, from_addr, subject, snippet, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(item.gmail_message_id, item.thread_id, item.from_addr, item.subject, item.snippet, item.received_at);
  return result.changes > 0 ? Number(result.lastInsertRowid) : null;
}

type InboxUpdate = Partial<
  Pick<InboxItem, 'category' | 'needs_reply' | 'summary' | 'creator_id' | 'draft_id' | 'notified' | 'error'>
>;

export function updateInboxItem(db: Db, id: number, fields: InboxUpdate): void {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE inbox_items SET ${sets} WHERE id = ?`).run(
    ...entries.map(([, v]) => v as string | number | null),
    id,
  );
}

export function listInbox(db: Db, limit = 100): InboxItem[] {
  return db
    .prepare(`SELECT * FROM inbox_items WHERE category != 'skipped' ORDER BY received_at DESC LIMIT ?`)
    .all(limit) as unknown as InboxItem[];
}
