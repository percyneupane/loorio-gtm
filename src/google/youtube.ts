/** YouTube Data API v3 via an API key. Quota: search = 100 units, channels/playlistItems = 1 unit. */

const API = 'https://www.googleapis.com/youtube/v3';

export interface YoutubeChannel {
  id: string;
  title: string;
  handle: string;
  description: string;
  subscribers: number | null;
  uploadsPlaylistId: string | null;
}

export interface Youtube {
  searchChannels(query: string, max?: number): Promise<string[]>;
  channels(ids: readonly string[]): Promise<YoutubeChannel[]>;
  channelByHandle(handle: string): Promise<YoutubeChannel | undefined>;
  recentVideoDescriptions(uploadsPlaylistId: string, max?: number): Promise<string[]>;
}

interface RawChannel {
  id: string;
  snippet?: { title?: string; description?: string; customUrl?: string };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
}

function toChannel(raw: RawChannel): YoutubeChannel {
  const subs = raw.statistics?.hiddenSubscriberCount ? null : Number(raw.statistics?.subscriberCount ?? NaN);
  return {
    id: raw.id,
    title: raw.snippet?.title ?? '',
    handle: (raw.snippet?.customUrl ?? raw.id).replace(/^@/, ''),
    description: raw.snippet?.description ?? '',
    subscribers: subs === null || Number.isNaN(subs) ? null : subs,
    uploadsPlaylistId: raw.contentDetails?.relatedPlaylists?.uploads ?? null,
  };
}

export function createYoutube(apiKey: string): Youtube {
  async function call<T>(path: string, params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams({ ...params, key: apiKey });
    const res = await fetch(`${API}${path}?${qs}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`YouTube ${path} failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  const parts = 'snippet,statistics,contentDetails';

  return {
    async searchChannels(query, max = 25) {
      const res = await call<{ items?: { id?: { channelId?: string } }[] }>('/search', {
        part: 'snippet',
        type: 'channel',
        q: query,
        maxResults: String(Math.min(max, 50)),
        relevanceLanguage: 'en',
      });
      return (res.items ?? []).map((i) => i.id?.channelId).filter((id): id is string => Boolean(id));
    },

    async channels(ids) {
      if (ids.length === 0) return [];
      const res = await call<{ items?: RawChannel[] }>('/channels', { part: parts, id: ids.slice(0, 50).join(',') });
      return (res.items ?? []).map(toChannel);
    },

    async channelByHandle(handle) {
      const res = await call<{ items?: RawChannel[] }>('/channels', {
        part: parts,
        forHandle: handle.startsWith('@') ? handle : `@${handle}`,
      });
      return res.items?.[0] ? toChannel(res.items[0]) : undefined;
    },

    async recentVideoDescriptions(uploadsPlaylistId, max = 5) {
      const res = await call<{ items?: { snippet?: { description?: string } }[] }>('/playlistItems', {
        part: 'snippet',
        playlistId: uploadsPlaylistId,
        maxResults: String(max),
      });
      return (res.items ?? []).map((i) => i.snippet?.description ?? '').filter(Boolean);
    },
  };
}
