// Behavior tests for push.dispatch(). Uses fake transports to assert
// what gets sent where under each channel preference.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/push.js';

function makeTransport({ failEmail = false, failNtfy = false } = {}) {
  const sent = { email: [], ntfy: [] };
  return {
    sent,
    async sendEmail(msg) {
      if (failEmail) throw new Error('smtp down');
      sent.email.push(msg);
    },
    async sendNtfy(payload) {
      if (failNtfy) throw new Error('ntfy 503');
      sent.ntfy.push(payload);
    },
  };
}

const platformEvent = (over = {}) => ({
  type: 'platform_changed',
  priority: 'urgent',
  title: 'ICE 145 platform CHANGED → 8b',
  body: 'Was 7, now 8b at Amsterdam Centraal.',
  ...over,
});

const baseArgs = (over = {}) => ({
  events: [platformEvent()],
  sender: 'amr@example.com',
  userChannel: 'email',
  line: 'ICE 145', trainNum: 'ICE145',
  confirmationMsgid: '<conf-1@late.fyi>',
  transport: makeTransport(),
  ...over,
});

// ===== channel routing =====

test('email-only user: event sent via email only', async () => {
  const transport = makeTransport();
  await dispatch(baseArgs({ userChannel: 'email', transport }));
  assert.equal(transport.sent.email.length, 1);
  assert.equal(transport.sent.ntfy.length, 0);
});

test('ntfy-only user: non-critical event sent via ntfy only', async () => {
  const transport = makeTransport();
  await dispatch(baseArgs({
    events: [{ type: 'delay_change', priority: 'high', title: 'ICE 145 +5min', body: '...' }],
    userChannel: 'ntfy', transport,
  }));
  assert.equal(transport.sent.email.length, 0);
  assert.equal(transport.sent.ntfy.length, 1);
});

test('both: each event goes to email AND ntfy', async () => {
  const transport = makeTransport();
  await dispatch(baseArgs({ userChannel: 'both', transport }));
  assert.equal(transport.sent.email.length, 1);
  assert.equal(transport.sent.ntfy.length, 1);
});

// ===== critical-event override =====

test('critical event overrides email-only user → also goes to ntfy', async () => {
  const transport = makeTransport();
  await dispatch(baseArgs({
    events: [{ type: 'cancelled', priority: 'urgent', title: 'ICE 145 CANCELLED', body: '...' }],
    userChannel: 'email', transport,
  }));
  assert.equal(transport.sent.email.length, 1);
  assert.equal(transport.sent.ntfy.length, 1);
});

test('critical event for ntfy-only user → also goes to email', async () => {
  const transport = makeTransport();
  await dispatch(baseArgs({
    events: [{ type: 'terminating_short', priority: 'urgent', title: '...', body: '...' }],
    userChannel: 'ntfy', transport,
  }));
  assert.equal(transport.sent.email.length, 1);
  assert.equal(transport.sent.ntfy.length, 1);
});

// ===== ntfy payload =====

test('ntfy payload has priority+tags+topic from sender hash', async () => {
  const transport = makeTransport();
  await dispatch(baseArgs({ userChannel: 'ntfy', transport }));
  const p = transport.sent.ntfy[0];
  assert.equal(p.priority, 5); // urgent
  assert.match(p.topic, /^latefyi-[a-f0-9]{16}$/);
  assert.equal(p.title, 'ICE 145 platform CHANGED → 8b');
});

test('ntfy priority defaults to 3 for "default" priority events', async () => {
  const transport = makeTransport();
  await dispatch(baseArgs({
    events: [{ type: 'arrived', priority: 'default', title: '...', body: '...' }],
    userChannel: 'ntfy', transport,
  }));
  assert.equal(transport.sent.ntfy[0].priority, 3);
});

// ===== failure handling =====

test('email send failure does not throw — captured in result', async () => {
  const transport = makeTransport({ failEmail: true });
  const out = await dispatch(baseArgs({ userChannel: 'email', transport }));
  assert.equal(out[0].results[0].channel, 'email');
  assert.equal(out[0].results[0].ok, false);
  assert.match(out[0].results[0].error, /smtp down/);
});

test('ntfy fail streak increments across events for same trip', async () => {
  const transport = makeTransport({ failNtfy: true });
  const events = [
    { type: 'delay_change', priority: 'high', title: 'a', body: 'a' },
    { type: 'delay_change', priority: 'high', title: 'b', body: 'b' },
    { type: 'delay_change', priority: 'high', title: 'c', body: 'c' },
  ];
  const out = await dispatch(baseArgs({
    events, userChannel: 'ntfy', transport,
  }));
  assert.equal(out[0].ntfyFailStreak, 1);
  assert.equal(out[1].ntfyFailStreak, 2);
  assert.equal(out[2].ntfyFailStreak, 3);
});

test('successful ntfy resets the failure streak', async () => {
  const transport = makeTransport({ failNtfy: false });
  const out = await dispatch(baseArgs({
    events: [platformEvent()],
    userChannel: 'ntfy', transport, ntfyFailureCounter: 5,
  }));
  assert.equal(out[0].ntfyFailStreak, 0);
});

// ===== email content threading =====

test('email is threaded via In-Reply-To against confirmationMsgid', async () => {
  const transport = makeTransport();
  await dispatch(baseArgs({
    confirmationMsgid: '<conf-xyz@late.fyi>',
    userChannel: 'email', transport,
  }));
  assert.equal(transport.sent.email[0].headers['In-Reply-To'], '<conf-xyz@late.fyi>');
});

// ===== multiple events =====

test('multiple events dispatched in order', async () => {
  const transport = makeTransport();
  await dispatch(baseArgs({
    events: [
      { type: 'platform_changed', priority: 'urgent', title: 'one', body: '...' },
      { type: 'delay_change', priority: 'high', title: 'two', body: '...' },
    ],
    userChannel: 'email', transport,
  }));
  assert.equal(transport.sent.email.length, 2);
  assert.equal(transport.sent.email[0].subject, 'one');
  assert.equal(transport.sent.email[1].subject, 'two');
});
