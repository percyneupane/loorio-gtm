/** Builds and parses RFC 2822 messages for the Gmail API. Pure — fully unit tested. */

import { isValidEmail } from '../discovery/extract.ts';

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string | null;
}

/** Encodes a header value as RFC 2047 UTF-8 base64 when it isn't plain ASCII. */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`Header ${name} contains a line break`);
}

export function buildRawMessage(email: OutgoingEmail): string {
  assertHeaderSafe('To', email.to);
  assertHeaderSafe('From', email.from);
  if (!isValidEmail(email.to)) throw new Error(`To must be exactly one email address, got "${email.to.slice(0, 80)}"`);
  const headers = [
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${encodeHeader(email.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  if (email.inReplyTo) {
    assertHeaderSafe('In-Reply-To', email.inReplyTo);
    if (email.references) assertHeaderSafe('References', email.references);
    headers.push(`In-Reply-To: ${email.inReplyTo}`);
    headers.push(`References: ${email.references ?? email.inReplyTo}`);
  }
  const body = Buffer.from(email.text.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  const message = `${headers.join('\r\n')}\r\n\r\n${body}`;
  return Buffer.from(message, 'utf8').toString('base64url');
}

/** "Maya Lin <maya@x.com>" → "maya@x.com" */
export function parseAddress(header: string): string {
  const angle = header.match(/<([^>]+)>/);
  return (angle ? angle[1] : header).trim().toLowerCase();
}

export interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

/** Depth-first search for the first text/plain part (falls back to stripped text/html). */
export function extractPlainText(part: GmailPart | undefined): string {
  const plain = findPart(part, 'text/plain');
  if (plain) return plain;
  const html = findPart(part, 'text/html');
  return html ? html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function findPart(part: GmailPart | undefined, mimeType: string): string {
  if (!part) return '';
  if (part.mimeType === mimeType && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const child of part.parts ?? []) {
    const text = findPart(child, mimeType);
    if (text) return text;
  }
  return '';
}

/** Drops quoted history ("On … wrote:" and ">" lines) so the AI sees just the new message. */
export function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((l) => /^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()));
  const kept = (cut === -1 ? lines : lines.slice(0, cut)).filter((l) => !l.trimStart().startsWith('>'));
  return kept.join('\n').trim();
}
