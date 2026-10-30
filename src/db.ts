import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Creators move through: new → enriched → (no_email | rejected | drafted) → in_sequence →
 * (replied | opted_out | bounced | completed). A sequence is the first email plus follow-ups,
 * sent in one Gmail thread.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS creators (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('youtube','tiktok','instagram','web')),
  handle TEXT NOT NULL,
  channel_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  followers INTEGER,
  bio TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  email TEXT,
  email_source TEXT,
  fit_score INTEGER,
  fit_reason TEXT,
  first_name TEXT,
  error TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (platform, handle)
);
CREATE INDEX IF NOT EXISTS creators_status ON creators(status);
CREATE INDEX IF NOT EXISTS creators_email ON creators(email);

CREATE TABLE IF NOT EXISTS email_candidates (
  creator_id INTEGER NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_label TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (creator_id, email)
);

CREATE TABLE IF NOT EXISTS sequences (
  id INTEGER PRIMARY KEY,
  creator_id INTEGER NOT NULL UNIQUE REFERENCES creators(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval','active','stopped','completed','rejected')),
  stop_reason TEXT,
  thread_id TEXT,
  last_rfc_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sequences_thread ON sequences(thread_id);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id INTEGER PRIMARY KEY,
  sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL,
  delay_days INTEGER NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','skipped')),
  due_at TEXT,
  sent_at TEXT,
  gmail_message_id TEXT,
  UNIQUE (sequence_id, step_index)
);
CREATE INDEX IF NOT EXISTS steps_due ON sequence_steps(status, due_at);

CREATE TABLE IF NOT EXISTS inbox_items (
  id INTEGER PRIMARY KEY,
  gmail_message_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'pending',
  needs_reply INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  creator_id INTEGER REFERENCES creators(id) ON DELETE SET NULL,
  draft_id TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS inbox_received ON inbox_items(received_at);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  creator_id INTEGER REFERENCES creators(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export type Db = DatabaseSync;

export function openDb(dbPath: string): Db {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Run `fn` inside a transaction, rolling back on any error. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
