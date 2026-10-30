import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrivateAddress } from '../src/discovery/fetch-page.ts';
import {
  parseCount,
  parseInstagramProfile,
  parseProfileInput,
  parseTikTokProfile,
} from '../src/discovery/profiles.ts';
import { buildRawMessage, encodeHeader, extractPlainText, parseAddress, stripQuoted } from '../src/google/mime.ts';

const decode = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');

test('buildRawMessage writes headers and a base64 body', () => {
  const raw = decode(buildRawMessage({ from: 'Percy <p@x.com>', to: 'maya@y.com', subject: 'hi', text: 'line1\nline2' }));
  assert.match(raw, /^From: Percy <p@x.com>\r\nTo: maya@y.com\r\nSubject: hi\r\n/);
  const body = raw.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'line1\r\nline2');
  assert.doesNotMatch(raw, /In-Reply-To/);
});

test('buildRawMessage threads replies and rejects header injection', () => {
  const raw = decode(buildRawMessage({ from: 'a@x.com', to: 'b@y.com', subject: 'Re: hi', text: 'x', inReplyTo: '<m1@g>' }));
  assert.match(raw, /In-Reply-To: <m1@g>\r\nReferences: <m1@g>/);
  assert.throws(() => buildRawMessage({ from: 'a@x.com', to: 'b@y.com\r\nBcc: z@z.com', subject: 's', text: 'x' }), /line break/);
});

test('encodeHeader encodes non-ASCII subjects', () => {
  assert.equal(encodeHeader('plain'), 'plain');
  assert.match(encodeHeader('loorio 🎓'), /^=\?UTF-8\?B\?/);
});

test('parseAddress and extractPlainText', () => {
  assert.equal(parseAddress('"Maya" <Maya@X.com>'), 'maya@x.com');
  assert.equal(parseAddress('maya@x.com'), 'maya@x.com');
  const data = (s: string) => Buffer.from(s).toString('base64url');
  const part = { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: data('<b>x</b>') } }, { mimeType: 'text/plain', body: { data: data('plain body') } }] };
  assert.equal(extractPlainText(part), 'plain body');
  assert.equal(extractPlainText({ mimeType: 'text/html', body: { data: data('<p>hi <b>there</b></p>') } }), 'hi there');
  assert.equal(extractPlainText(undefined), '');
});

test('stripQuoted keeps only the new message', () => {
  const text = 'Sounds great!\n\nOn Mon, Oct 27, 2026 at 9:00 AM Percy <p@x.com> wrote:\n> Hey Maya';
  assert.equal(stripQuoted(text), 'Sounds great!');
  assert.equal(stripQuoted('yes\n> quoted'), 'yes');
});

test('parseProfileInput understands URLs, prefixes and websites', () => {
  assert.deepEqual(parseProfileInput('https://www.tiktok.com/@StudyWithMaya?lang=en'), {
    platform: 'tiktok', handle: 'studywithmaya', url: 'https://www.tiktok.com/@StudyWithMaya',
  });
  assert.equal(parseProfileInput('ig:sat.math')?.platform, 'instagram');
  assert.equal(parseProfileInput('yt:@collegeinfogeek')?.url, 'https://www.youtube.com/@collegeinfogeek');
  assert.equal(parseProfileInput('https://instagram.com/p/abc123')?.platform, undefined);
  assert.deepEqual(parseProfileInput('mayatutoring.com'), { platform: 'web', handle: 'mayatutoring.com', url: 'https://mayatutoring.com/' });
  assert.equal(parseProfileInput('   '), undefined);
  assert.equal(parseProfileInput('justaword'), undefined);
});

test('parseTikTokProfile reads bio, bio link and followers', () => {
  const data = { __DEFAULT_SCOPE__: { 'webapp.user-detail': { userInfo: { user: { nickname: 'Maya', signature: 'SAT tips 📚 biz: maya@studio.co', bioLink: { link: 'linktr.ee/maya' } }, stats: { followerCount: 52000 } } } } };
  const html = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></html>`;
  const p = parseTikTokProfile(html);
  assert.equal(p.name, 'Maya');
  assert.equal(p.followers, 52000);
  assert.match(p.bio, /maya@studio.co/);
  assert.deepEqual(p.links, ['https://linktr.ee/maya']);
});

test('parseTikTokProfile falls back to meta description', () => {
  const p = parseTikTokProfile('<meta name="description" content="Study tips &amp; more">');
  assert.equal(p.bio, 'Study tips & more');
  assert.equal(p.followers, null);
});

test('parseInstagramProfile uses biography JSON and og tags', () => {
  const html = `<meta property="og:title" content="Maya (@sat.maya) • Instagram photos"><meta property="og:description" content="12.5K Followers, 300 Following">"biography":"Tutor \\ud83d\\udcda collabs@maya.co","external_url":"https:\\/\\/maya.co"`;
  const p = parseInstagramProfile(html);
  assert.equal(p.name, 'Maya');
  assert.equal(p.followers, 12500);
  assert.match(p.bio, /collabs@maya.co/);
  assert.deepEqual(p.links, ['https://maya.co']);
});

test('parseCount handles K/M suffixes', () => {
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('2.5M'), 2_500_000);
});

test('isPrivateAddress blocks internal ranges', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});
