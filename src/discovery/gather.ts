import type { Youtube } from '../google/youtube.ts';
import type { Creator, EmailCandidate } from '../repo/creators.ts';
import {
  businessScore,
  extractEmails,
  extractLinks,
  extractMailtos,
  htmlToText,
  isContactLink,
  isLinkInBio,
  isOwnSiteCandidate,
} from './extract.ts';
import type { PageFetcher } from './fetch-page.ts';
import { fetchSocialProfile, type ProfileRef } from './profiles.ts';

/**
 * Collects emails the creator published themselves, in order:
 * 1. YouTube channel description + recent video descriptions (or TikTok/IG bio)
 * 2. Link-in-bio pages (Linktree, Beacons, Stan…)
 * 3. Their own website — homepage, then contact/about pages
 */

const MAX_PAGE_FETCHES = 6;
const MAX_OWN_SITES = 2;
const MAX_CONTACT_PAGES = 2;
const CONTEXT_LIMIT = 6000;

export interface GatherDeps {
  fetchPage: PageFetcher;
  youtube?: Youtube;
}

export interface GatherResult {
  candidates: EmailCandidate[];
  /** Public text about the creator, used by the AI to judge fit and personalise the pitch. */
  context: string;
  profile: { name?: string; bio?: string; followers?: number | null; channelId?: string };
  errors: string[];
}

interface Collector {
  candidates: Map<string, EmailCandidate>;
  links: Set<string>;
  contextParts: string[];
  errors: string[];
  fetches: number;
}

function addEmailsFromText(c: Collector, text: string, sourceUrl: string, label: string): void {
  for (const found of extractEmails(text)) {
    if (!c.candidates.has(found.email)) {
      c.candidates.set(found.email, { email: found.email, source_url: sourceUrl, source_label: label, snippet: found.snippet });
    }
  }
}

async function readYoutube(c: Collector, creator: Creator, youtube: Youtube): Promise<GatherResult['profile']> {
  const channel = creator.channel_id
    ? (await youtube.channels([creator.channel_id]))[0]
    : await youtube.channelByHandle(creator.handle);
  if (!channel) throw new Error('YouTube channel not found');
  const url = `https://www.youtube.com/channel/${channel.id}`;
  addEmailsFromText(c, channel.description, `${url}/about`, 'YouTube channel description');
  c.contextParts.push(`Channel description:\n${channel.description}`);
  for (const link of channel.description.match(/https?:\/\/\S+/g) ?? []) c.links.add(link);

  if (channel.uploadsPlaylistId) {
    const descriptions = await youtube.recentVideoDescriptions(channel.uploadsPlaylistId, 5);
    descriptions.forEach((d, i) => {
      addEmailsFromText(c, d, url, 'YouTube video description');
      if (i < 3) c.contextParts.push(`Recent video description:\n${d.slice(0, 600)}`);
      for (const link of d.match(/https?:\/\/\S+/g) ?? []) c.links.add(link);
    });
  }
  return { name: channel.title, bio: channel.description.slice(0, 1000), followers: channel.subscribers, channelId: channel.id };
}

async function readSocial(c: Collector, ref: ProfileRef, deps: GatherDeps): Promise<GatherResult['profile']> {
  c.fetches++;
  const profile = await fetchSocialProfile(deps.fetchPage, ref);
  const label = ref.platform === 'tiktok' ? 'TikTok bio' : ref.platform === 'instagram' ? 'Instagram bio' : 'Website';
  addEmailsFromText(c, profile.bio, ref.url, label);
  if (profile.bio) c.contextParts.push(`${label}:\n${profile.bio}`);
  for (const link of profile.links) c.links.add(link);
  if (ref.platform === 'web') c.links.add(ref.url);
  return { name: profile.name || undefined, bio: profile.bio.slice(0, 1000), followers: profile.followers };
}

async function readPage(c: Collector, url: string, label: string, deps: GatherDeps): Promise<string[]> {
  if (c.fetches >= MAX_PAGE_FETCHES) return [];
  c.fetches++;
  try {
    const page = await deps.fetchPage(url);
    for (const email of extractMailtos(page.html)) {
      if (!c.candidates.has(email)) {
        c.candidates.set(email, { email, source_url: page.url, source_label: `${label} (mailto link)`, snippet: `mailto:${email}` });
      }
    }
    const text = htmlToText(page.html);
    addEmailsFromText(c, text, page.url, label);
    c.contextParts.push(`${label} (${page.url}):\n${text.slice(0, 800)}`);
    return extractLinks(page.html, page.url);
  } catch (error) {
    c.errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** Contact pages first, then business/collab pages, then about pages; shallow paths win ties. */
function contactPriority(url: string): number {
  const p = new URL(url).pathname.toLowerCase();
  const rank = p.includes('contact') ? 0 : /work-with|collab|business|partner|press|booking/.test(p) ? 1 : 2;
  return rank * 10 + p.split('/').filter(Boolean).length;
}

async function readLinkedPages(c: Collector, deps: GatherDeps): Promise<void> {
  const bioPages = [...c.links].filter(isLinkInBio).slice(0, 2);
  for (const url of bioPages) {
    for (const link of await readPage(c, url, 'Link-in-bio page', deps)) c.links.add(link);
  }

  const sites = [...c.links].filter(isOwnSiteCandidate).slice(0, MAX_OWN_SITES);
  for (const site of sites) {
    const siteLinks = await readPage(c, site, 'Own website', deps);
    const siteHost = new URL(site).hostname;
    const contactPages = siteLinks
      .filter((l) => new URL(l).hostname === siteHost && isContactLink(l))
      .sort((a, b) => contactPriority(a) - contactPriority(b))
      .slice(0, MAX_CONTACT_PAGES);
    for (const page of contactPages) await readPage(c, page, 'Own website contact page', deps);
  }
}

export async function gatherPublicEmails(creator: Creator, deps: GatherDeps): Promise<GatherResult> {
  const c: Collector = { candidates: new Map(), links: new Set(), contextParts: [], errors: [], fetches: 0 };
  let profile: GatherResult['profile'] = {};

  if (creator.platform === 'youtube') {
    if (!deps.youtube) throw new Error('YOUTUBE_API_KEY is not set');
    profile = await readYoutube(c, creator, deps.youtube);
  } else {
    profile = await readSocial(c, { platform: creator.platform, handle: creator.handle, url: creator.url }, deps);
  }

  await readLinkedPages(c, deps);

  const candidates = [...c.candidates.values()].sort((a, b) => businessScore(b) - businessScore(a));
  return { candidates, context: c.contextParts.join('\n\n').slice(0, CONTEXT_LIMIT), profile, errors: c.errors };
}
