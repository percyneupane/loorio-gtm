import type { Platform } from '../repo/creators.ts';
import { extractUrls, htmlToText } from './extract.ts';
import type { PageFetcher } from './fetch-page.ts';

export interface ProfileRef {
  platform: Platform;
  handle: string;
  url: string;
}

const PROFILE_PATTERNS: { platform: Platform; re: RegExp; url: (h: string) => string }[] = [
  { platform: 'tiktok', re: /tiktok\.com\/@([\w.]+)/i, url: (h) => `https://www.tiktok.com/@${h}` },
  { platform: 'instagram', re: /instagram\.com\/([\w.]+)/i, url: (h) => `https://www.instagram.com/${h}/` },
  { platform: 'youtube', re: /youtube\.com\/@([\w.-]+)/i, url: (h) => `https://www.youtube.com/@${h}` },
  { platform: 'youtube', re: /youtube\.com\/channel\/(UC[\w-]{22})/i, url: (h) => `https://www.youtube.com/channel/${h}` },
];
const RESERVED_IG_PATHS = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv']);

/**
 * Parses one line of user input: a profile URL, "tiktok:@name", "ig:name", "yt:@name", or a
 * plain website. Returns undefined for lines it can't interpret.
 */
export function parseProfileInput(line: string): ProfileRef | undefined {
  const input = line.trim();
  if (!input) return undefined;

  const prefixed = input.match(/^(tiktok|tt|instagram|ig|youtube|yt):\s*@?([\w.-]+)$/i);
  if (prefixed) {
    const key = prefixed[1].toLowerCase();
    const platform: Platform = key.startsWith('t') ? 'tiktok' : key.startsWith('i') ? 'instagram' : 'youtube';
    const pattern = PROFILE_PATTERNS.find((p) => p.platform === platform)!;
    return { platform, handle: prefixed[2].toLowerCase(), url: pattern.url(prefixed[2]) };
  }

  for (const p of PROFILE_PATTERNS) {
    const m = input.match(p.re);
    if (!m) continue;
    if (p.platform === 'instagram' && RESERVED_IG_PATHS.has(m[1].toLowerCase())) return undefined;
    return { platform: p.platform, handle: m[1].toLowerCase(), url: p.url(m[1]) };
  }

  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (!url.hostname.includes('.')) return undefined;
    return { platform: 'web', handle: url.hostname.replace(/^www\./, '').toLowerCase(), url: url.toString() };
  } catch {
    return undefined;
  }
}

export interface SocialProfile {
  name: string;
  bio: string;
  links: string[];
  followers: number | null;
}

function findJsonScript(html: string, id: string): unknown {
  const m = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`));
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

function metaContent(html: string, property: string): string {
  const re = new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]*)"`, 'i');
  return html.match(re)?.[1] ?? '';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

interface TikTokData {
  __DEFAULT_SCOPE__?: {
    'webapp.user-detail'?: {
      userInfo?: {
        user?: { nickname?: string; signature?: string; bioLink?: { link?: string } };
        stats?: { followerCount?: number };
      };
    };
  };
}

/** Parses the public TikTok profile page (logged out). Pure, so it is tested on fixtures. */
export function parseTikTokProfile(html: string): SocialProfile {
  const data = findJsonScript(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__') as TikTokData | undefined;
  const info = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
  const bio = info?.user?.signature ?? decodeEntities(metaContent(html, 'description'));
  const bioLink = info?.user?.bioLink?.link;
  const links = [...(bioLink ? [bioLink.startsWith('http') ? bioLink : `https://${bioLink}`] : []), ...extractUrls(bio)];
  return {
    name: info?.user?.nickname ?? '',
    bio,
    links: [...new Set(links)],
    followers: info?.stats?.followerCount ?? null,
  };
}

/** Instagram mostly serves a login wall when logged out; this takes whatever public text exists. */
export function parseInstagramProfile(html: string): SocialProfile {
  const bioMatch = html.match(/"biography":"((?:[^"\\]|\\.)*)"/);
  let bio = '';
  if (bioMatch) {
    try {
      bio = JSON.parse(`"${bioMatch[1]}"`) as string;
    } catch {
      bio = bioMatch[1];
    }
  }
  const description = decodeEntities(metaContent(html, 'og:description') || metaContent(html, 'description'));
  const extUrl = html.match(/"external_url":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\\//g, '/');
  const title = decodeEntities(metaContent(html, 'og:title')).replace(/\s*[(•|].*$/, '');
  const followers = description.match(/([\d.,]+[KM]?)\s+Followers/i)?.[1] ?? null;
  const text = [bio, description].filter(Boolean).join('\n');
  return {
    name: title,
    bio: text,
    links: [...new Set([...(extUrl ? [extUrl] : []), ...extractUrls(text)])],
    followers: followers ? parseCount(followers) : null,
  };
}

export function parseCount(s: string): number {
  const n = Number.parseFloat(s.replace(/,/g, ''));
  if (/k$/i.test(s)) return Math.round(n * 1_000);
  if (/m$/i.test(s)) return Math.round(n * 1_000_000);
  return Math.round(n);
}

export async function fetchSocialProfile(fetcher: PageFetcher, ref: ProfileRef): Promise<SocialProfile> {
  const page = await fetcher(ref.url);
  if (ref.platform === 'tiktok') return parseTikTokProfile(page.html);
  if (ref.platform === 'instagram') return parseInstagramProfile(page.html);
  const text = htmlToText(page.html).slice(0, 4000);
  return { name: metaContent(page.html, 'og:title'), bio: text, links: [], followers: null };
}
