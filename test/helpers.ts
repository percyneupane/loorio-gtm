import type { Agent } from '../src/ai/agent.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { openDb, type Db } from '../src/db.ts';
import type { Gmail, GmailMessage } from '../src/google/gmail.ts';
import type { OutgoingEmail } from '../src/google/mime.ts';
import type { Notification } from '../src/notify.ts';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ SENDER_ADDRESS: '1 Main St, Austin TX', ...overrides });
}

export function testDb(): Db {
  return openDb(':memory:');
}

export const ACCOUNT = 'percy@loorio.app';

export function message(partial: Partial<GmailMessage> & { id: string }): GmailMessage {
  return {
    threadId: `t-${partial.id}`,
    labelIds: ['INBOX'],
    from: 'Someone <someone@x.com>',
    fromAddress: 'someone@x.com',
    to: ACCOUNT,
    subject: 'Hello',
    date: '2026-10-29T15:00:00.000Z',
    rfcMessageId: `<${partial.id}@mail>`,
    references: null,
    snippet: 'hi there',
    text: 'hi there',
    autoSubmitted: false,
    listUnsubscribe: false,
    ...partial,
  };
}

export interface FakeGmail extends Gmail {
  sent: { email: OutgoingEmail; threadId?: string | null }[];
  drafts: { email: OutgoingEmail; threadId: string }[];
  messages: Map<string, GmailMessage>;
  threads: Map<string, GmailMessage[]>;
  inbox: string[];
  failSend?: Error;
}

export function fakeGmail(): FakeGmail {
  let n = 0;
  const fake: FakeGmail = {
    sent: [],
    drafts: [],
    messages: new Map(),
    threads: new Map(),
    inbox: [],
    async profile() {
      return { emailAddress: ACCOUNT, historyId: '100' };
    },
    async send(email, threadId) {
      if (fake.failSend) throw fake.failSend;
      n++;
      const id = `sent-${n}`;
      const tid = threadId ?? `thread-${n}`;
      fake.sent.push({ email, threadId });
      const msg = message({ id, threadId: tid, from: `Percy <${ACCOUNT}>`, fromAddress: ACCOUNT, rfcMessageId: `<${id}@gmail>` });
      fake.messages.set(id, msg);
      fake.threads.set(tid, [...(fake.threads.get(tid) ?? []), msg]);
      return { id, threadId: tid };
    },
    async createDraft(email, threadId) {
      fake.drafts.push({ email, threadId });
      return { id: `draft-${fake.drafts.length}` };
    },
    async newInboxMessageIds() {
      const ids = fake.inbox;
      fake.inbox = [];
      return { ids, historyId: '200' };
    },
    async getMessage(id) {
      const m = fake.messages.get(id);
      if (!m) throw new Error(`no message ${id}`);
      return m;
    },
    async getThread(threadId) {
      return fake.threads.get(threadId) ?? [];
    },
  };
  return fake;
}

/** Adds an inbound message to the fake: in its thread and in the next history poll. */
export function deliver(gmail: FakeGmail, msg: GmailMessage): void {
  gmail.messages.set(msg.id, msg);
  gmail.threads.set(msg.threadId, [...(gmail.threads.get(msg.threadId) ?? []), msg]);
  gmail.inbox.push(msg.id);
}

export function fakeAgent(overrides: Partial<Agent> = {}): Agent & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async qualify(_c, _ctx, candidates) {
      calls.push('qualify');
      return {
        email: candidates[0]?.email ?? null,
        emailReason: 'listed for business',
        fitScore: 85,
        fitReason: 'educational shorts',
        firstName: 'Maya',
        hook: 'her 60-second SAT grammar series',
      };
    },
    async draftSequence(_c, _hook, followUps) {
      calls.push('draft');
      return Array.from({ length: followUps + 1 }, (_, i) => ({ subject: 'loorio x you', body: `email ${i}` }));
    },
    async triage() {
      calls.push('triage');
      return { category: 'business', needsReply: true, urgency: 'normal', summary: 'Wants to chat' };
    },
    async draftReply() {
      calls.push('reply');
      return 'Thanks! Happy to chat.';
    },
    ...overrides,
  };
}

export function captureNotifications(): { list: Notification[]; notify: (n: Notification) => Promise<void> } {
  const list: Notification[] = [];
  return { list, notify: async (n) => void list.push(n) };
}
