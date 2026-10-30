/** Pulls contact emails and outbound links out of public page text. Pure — no I/O. */

export interface FoundEmail {
  email: string;
  snippet: string;
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24}/gi;

/** Obfuscations creators use: "name [at] gmail [dot] com", "name(at)gmail(dot)com". */
const AT_RE = /\s*[[({<]\s*at\s*[\])}>]\s*/gi;
const DOT_RE = /\s*[[({<]\s*dot\s*[\])}>]\s*/gi;

const FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mp4|webm|woff2?)$/i;
const IGNORED_DOMAINS = [
  'example.com',
  'domain.com',
  'email.com',
  'sentry.io',
  'wixpress.com',
  'sentry-next.wixpress.com',
  'godaddy.com',
  'squarespace.com',
  'shopify.com',
  'tiktok.com',
  'youtube.com',
  'google.com',
  'instagram.com',
  'linktr.ee',
];
const IGNORED_LOCAL_PARTS = /^(no-?reply|donotreply|do-not-reply|privacy|abuse|postmaster|webmaster|dmca|legal|support|billing|security)$/i;
const BUSINESS_HINT_RE = /(business|collab|partner|booking|inquir|enquir|brand|sponsor|work with|management|mgmt|contact|press|pr@)/i;

export function deobfuscate(text: string): string {
  return text.replace(AT_RE, '@').replace(DOT_RE, '.');
}

const SINGLE_EMAIL_RE = new RegExp(`^${EMAIL_RE.source}$`, 'i');

/** Exactly one address — rejects lists ("a@x.com,b@y.com"), whitespace and control characters. */
export function isValidEmail(email: string): boolean {
  return email.length <= 254 && SINGLE_EMAIL_RE.test(email);
}

function isPlausibleEmail(email: string): boolean {
  if (!isValidEmail(email)) return false;
  if (FILE_EXT_RE.test(email)) return false;
  const [local, domain] = email.split('@');
  if (!local || !domain) return false;
  if (/@\dx\./.test(email)) return false; // retina asset names like logo@2x.png
  if (IGNORED_LOCAL_PARTS.test(local)) return false;
  return !IGNORED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Finds unique emails in text, each with ~80 chars of surrounding context. */
export function extractEmails(rawText: string): FoundEmail[] {
  const text = deobfuscate(rawText);
  const seen = new Map<string, FoundEmail>();
  for (const match of text.matchAll(EMAIL_RE)) {
    const email = match[0].toLowerCase().replace(/\.+$/, '');
    if (seen.has(email) || !isPlausibleEmail(email)) continue;
    const start = Math.max(0, (match.index ?? 0) - 80);
    const snippet = text.slice(start, (match.index ?? 0) + match[0].length + 40).replace(/\s+/g, ' ').trim();
    seen.set(email, { email, snippet });
  }
  return [...seen.values()];
}

/** Higher score = more likely to be the creator's business inbox. Used to order candidates. */
export function businessScore(found: FoundEmail): number {
  let score = 0;
  if (BUSINESS_HINT_RE.test(found.snippet)) score += 2;
  if (BUSINESS_HINT_RE.test(found.email.split('@')[0])) score += 2;
  return score;
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>()\\]+/gi;

export function extractUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const cleaned = m[0].replace(/[.,;:!?)\]]+$/, '');
    try {
      urls.add(new URL(cleaned).toString());
    } catch {
      // not a valid URL — skip
    }
  }
  return [...urls];
}

/** mailto: links in HTML — these are the most explicit "contact me here" signal. */
export function extractMailtos(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    try {
      out.add(decodeURIComponent(m[1]).toLowerCase());
    } catch {
      out.add(m[1].toLowerCase());
    }
  }
  return [...out].filter(isPlausibleEmail);
}

/** href targets in HTML, resolved against the page URL. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    try {
      const url = new URL(m[1], baseUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') out.add(url.toString());
    } catch {
      // ignore malformed href
    }
  }
  return [...out];
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#64;|&commat;/g, '@')
    .replace(/&#46;|&period;/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

const LINK_IN_BIO_HOSTS = [
  'linktr.ee',
  'beacons.ai',
  'stan.store',
  'bio.link',
  'linkin.bio',
  'campsite.bio',
  'carrd.co',
  'komi.io',
  'snipfeed.co',
  'hoo.be',
  'lnk.bio',
  'taplink.cc',
  'solo.to',
];
const SOCIAL_HOSTS = [
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'threads.net',
  'snapchat.com',
  'pinterest.com',
  'twitch.tv',
  'discord.gg',
  'discord.com',
  'spotify.com',
  'apple.com',
  'amazon.com',
  'amzn.to',
  'patreon.com',
  'bit.ly',
  'goo.gl',
  'reddit.com',
  'linkedin.com',
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function hostMatches(host: string, list: readonly string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

export function isLinkInBio(url: string): boolean {
  return hostMatches(hostOf(url), LINK_IN_BIO_HOSTS);
}

/** A link that is probably the creator's own site (not a social network or link-in-bio page). */
export function isOwnSiteCandidate(url: string): boolean {
  const host = hostOf(url);
  return host !== '' && !hostMatches(host, SOCIAL_HOSTS) && !hostMatches(host, LINK_IN_BIO_HOSTS);
}

/** On a personal site, links that likely lead to a contact page. */
export function isContactLink(url: string): boolean {
  return /\/(contact|about|work-with-me|collab|business|press|booking|partnerships?)(\/|$|\?|\.)/i.test(url);
}
