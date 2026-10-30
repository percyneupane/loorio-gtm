import type { GoogleAuth } from './oauth.ts';
import type { GmailPart, OutgoingEmail } from './mime.ts';
import { buildRawMessage, extractPlainText, parseAddress } from './mime.ts';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  date: string;
  rfcMessageId: string | null;
  references: string | null;
  snippet: string;
  text: string;
  autoSubmitted: boolean;
  listUnsubscribe: boolean;
}

export interface SentMessage {
  id: string;
  threadId: string;
}

/** The subset of Gmail the app uses — an interface so tests can supply a fake. */
export interface Gmail {
  profile(): Promise<{ emailAddress: string; historyId: string }>;
  send(email: OutgoingEmail, threadId?: string | null): Promise<SentMessage>;
  createDraft(email: OutgoingEmail, threadId: string): Promise<{ id: string }>;
  newInboxMessageIds(startHistoryId: string): Promise<{ ids: string[]; historyId: string }>;
  getMessage(id: string): Promise<GmailMessage>;
  getThread(threadId: string): Promise<GmailMessage[]>;
}

interface RawHeader {
  name: string;
  value: string;
}
interface RawMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: RawHeader[] };
}

function toMessage(raw: RawMessage): GmailMessage {
  const headers = raw.payload?.headers ?? [];
  const h = (name: string) => headers.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  const from = h('From');
  const autoSubmitted = h('Auto-Submitted');
  return {
    id: raw.id,
    threadId: raw.threadId,
    labelIds: raw.labelIds ?? [],
    from,
    fromAddress: parseAddress(from),
    to: h('To'),
    subject: h('Subject'),
    date: raw.internalDate ? new Date(Number(raw.internalDate)).toISOString() : new Date().toISOString(),
    rfcMessageId: h('Message-ID') || h('Message-Id') || null,
    references: h('References') || null,
    snippet: raw.snippet ?? '',
    text: extractPlainText(raw.payload),
    autoSubmitted: autoSubmitted !== '' && autoSubmitted.toLowerCase() !== 'no',
    listUnsubscribe: h('List-Unsubscribe') !== '',
  };
}

export function createGmail(auth: GoogleAuth): Gmail {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await auth.accessToken();
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new GmailError(res.status, `Gmail ${init.method ?? 'GET'} ${path.split('?')[0]} failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  return {
    profile: () => call('/profile'),

    async send(email, threadId) {
      const raw = buildRawMessage(email);
      return call<SentMessage>('/messages/send', {
        method: 'POST',
        body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
      });
    },

    async createDraft(email, threadId) {
      const raw = buildRawMessage(email);
      return call<{ id: string }>('/drafts', { method: 'POST', body: JSON.stringify({ message: { raw, threadId } }) });
    },

    async newInboxMessageIds(startHistoryId) {
      const ids = new Set<string>();
      let pageToken: string | undefined;
      let historyId = startHistoryId;
      do {
        const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await call<{
          history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
          historyId: string;
          nextPageToken?: string;
        }>(`/history?${params}`);
        for (const h of page.history ?? []) {
          for (const added of h.messagesAdded ?? []) {
            if (added.message.labelIds?.includes('INBOX')) ids.add(added.message.id);
          }
        }
        historyId = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
      return { ids: [...ids], historyId };
    },

    async getMessage(id) {
      return toMessage(await call<RawMessage>(`/messages/${encodeURIComponent(id)}?format=full`));
    },

    async getThread(threadId) {
      const thread = await call<{ messages?: RawMessage[] }>(`/threads/${encodeURIComponent(threadId)}?format=full`);
      return (thread.messages ?? []).map(toMessage);
    },
  };
}
