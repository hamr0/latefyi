// Unit tests for the inbound sender-authentication policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { senderFailsDmarc } from '../src/auth-results.js';

test('explicit dmarc=fail → reject', () => {
  assert.equal(senderFailsDmarc('mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail (p=reject) header.from=gmail.com'), true);
});

test('dmarc=pass → allow', () => {
  assert.equal(senderFailsDmarc('mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass header.from=gmail.com'), false);
});

test('dmarc=none → allow (no published policy, can\'t prove spoof)', () => {
  assert.equal(senderFailsDmarc('mx.cloudflare.net; spf=pass; dmarc=none'), false);
});

test('dmarc=temperror → allow (transient, not a spoof verdict)', () => {
  assert.equal(senderFailsDmarc('mx; dmarc=temperror'), false);
});

test('absent header → allow', () => {
  assert.equal(senderFailsDmarc(undefined), false);
  assert.equal(senderFailsDmarc(null), false);
  assert.equal(senderFailsDmarc(''), false);
});

test('case-insensitive and whitespace-tolerant', () => {
  assert.equal(senderFailsDmarc('MX; DMARC = FAIL'), true);
});

test('multiple hops: a single fail anywhere rejects', () => {
  assert.equal(senderFailsDmarc('relay-a; dmarc=pass, relay-b; dmarc=fail'), true);
});

test('does not match dmarc substrings of other tokens (e.g. "spf=fail" alone)', () => {
  assert.equal(senderFailsDmarc('mx; spf=fail; dkim=fail; dmarc=pass'), false);
});

test('non-string input → allow (defensive)', () => {
  assert.equal(senderFailsDmarc({}), false);
  assert.equal(senderFailsDmarc(42), false);
});
