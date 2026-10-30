import { execFile } from 'node:child_process';
import type { Config } from './config.ts';
import { logger } from './log.ts';

const log = logger('notify');

export interface Notification {
  title: string;
  message: string;
  url?: string;
  priority?: 'low' | 'default' | 'high';
  tags?: string[];
}

export type Notifier = (n: Notification) => Promise<void>;

const NTFY_PRIORITY = { low: '2', default: '3', high: '5' } as const;

/** Header values must be ASCII for fetch; ntfy accepts RFC 2047 for anything else. */
function asciiHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
}

async function pushNtfy(config: Config, n: Notification): Promise<void> {
  const headers: Record<string, string> = {
    Title: asciiHeader(n.title.slice(0, 200)),
    Priority: NTFY_PRIORITY[n.priority ?? 'default'],
  };
  if (n.url) headers.Click = n.url;
  if (n.tags?.length) headers.Tags = n.tags.join(',');
  const res = await fetch(`${config.NTFY_SERVER}/${encodeURIComponent(config.NTFY_TOPIC)}`, {
    method: 'POST',
    headers,
    body: n.message.slice(0, 4000),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
}

function desktop(n: Notification): Promise<void> {
  // Arguments are passed via argv, never interpolated into the AppleScript source.
  const script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script, n.title.slice(0, 120), n.message.slice(0, 240)], () => resolve());
  });
}

/** Sends to every configured channel (phone push via ntfy, macOS banner). Never throws. */
export function createNotifier(config: Config): Notifier {
  return async (n) => {
    const jobs: Promise<void>[] = [];
    if (config.NTFY_TOPIC) jobs.push(pushNtfy(config, n));
    if (config.NOTIFY_DESKTOP && process.platform === 'darwin') jobs.push(desktop(n));
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === 'rejected') log.warn('notification failed', r.reason);
  };
}

export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`;
}
