import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  businessScore,
  deobfuscate,
  extractEmails,
  extractLinks,
  extractMailtos,
  extractUrls,
  htmlToText,
  isContactLink,
  isLinkInBio,
  isOwnSiteCandidate,
} from '../src/discovery/extract.ts';

test('finds a plain business email in a channel description', () => {
  const found = extractEmails('Study tips every week!\n📩 Business inquiries: Hello@StudyWithMaya.com');
  assert.deepEqual(found.map((f) => f.email), ['hello@studywithmaya.com']);
  assert.match(found[0].snippet, /Business inquiries/);
});

test('decodes bracketed obfuscation', () => {
  assert.equal(deobfuscate('maya [at] gmail [dot] com'), 'maya@gmail.com');
  assert.deepEqual(extractEmails('collabs: maya(at)gmail(dot)com').map((f) => f.email), ['maya@gmail.com']);
});

test('ignores asset filenames, platform domains and noreply addresses', () => {
  const text = 'logo@2x.png noreply@studio.com abuse@site.com test@example.com x@sentry.io real@creator.co';
  assert.deepEqual(extractEmails(text).map((f) => f.email), ['real@creator.co']);
});

test('dedupes repeated emails and strips trailing dots', () => {
  const found = extractEmails('Email a@b.co. Or again a@b.co');
  assert.deepEqual(found.map((f) => f.email), ['a@b.co']);
});

test('returns nothing for text without emails', () => {
  assert.deepEqual(extractEmails('no contact info here, DM me'), []);
});

test('businessScore prefers business-context emails', () => {
  const biz = { email: 'collabs@maya.com', snippet: 'For brand deals: collabs@maya.com' };
  const fan = { email: 'maya123@gmail.com', snippet: 'fan mail maya123@gmail.com' };
  assert.ok(businessScore(biz) > businessScore(fan));
});

test('extractUrls trims trailing punctuation and dedupes', () => {
  const urls = extractUrls('site: https://maya.com/about). also https://maya.com/about, and http://x.io');
  assert.deepEqual(urls, ['https://maya.com/about', 'http://x.io/']);
});

test('extractMailtos decodes and filters', () => {
  const html = '<a href="mailto:Hi%40maya.com?subject=x">mail</a><a href="mailto:noreply@x.com">n</a>';
  assert.deepEqual(extractMailtos(html), ['hi@maya.com']);
});

test('extractLinks resolves relative hrefs and drops non-http schemes', () => {
  const html = '<a href="/contact">c</a><a href="javascript:void(0)">j</a><a href=\'https://x.com/a\'>x</a>';
  assert.deepEqual(extractLinks(html, 'https://maya.com/'), ['https://maya.com/contact', 'https://x.com/a']);
});

test('htmlToText strips tags, scripts and decodes encoded @', () => {
  const text = htmlToText('<script>var a=1</script><p>Email: hi&#64;maya&#46;com</p>');
  assert.equal(text, 'Email: hi@maya.com');
});

test('link classifiers', () => {
  assert.equal(isLinkInBio('https://linktr.ee/maya'), true);
  assert.equal(isLinkInBio('https://maya.com'), false);
  assert.equal(isOwnSiteCandidate('https://www.mayatutoring.com'), true);
  assert.equal(isOwnSiteCandidate('https://instagram.com/maya'), false);
  assert.equal(isOwnSiteCandidate('https://beacons.ai/maya'), false);
  assert.equal(isOwnSiteCandidate('not a url'), false);
  assert.equal(isContactLink('https://maya.com/contact'), true);
  assert.equal(isContactLink('https://maya.com/work-with-me/'), true);
  assert.equal(isContactLink('https://maya.com/blog/post'), false);
});
