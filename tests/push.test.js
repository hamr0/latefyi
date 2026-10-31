// Behavior tests for push.dispatch(). Uses fake transports to assert
// the email-only delivery path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/push.js';

// Fake transport exposing ONLY sendEmail. `calls` records every transport
// method invoked, so a test can assert nothing else was ever asked for.
function makeTransport({ failEmail = false } = {}) {
  const sent = { email: [] };
  const calls = [];
  const t = {
    sent,
    calls,
    async sendEmail(msg) {
      calls.push('sendEmail');
      if (failEmail) throw new Error('smtp down');
      sent.email.push(msg);
    },
  };
  return new Proxy(t, {
    get(target, prop) {
      if (!(prop in target) && typeof prop === 'string' && prop.startsWith('send')) calls.push(prop);
      return target[prop];
    },
  });
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
  line: 'ICE 145', trainNum: 'ICE145',
  confirmationMsgid: '<conf-1@late.fyi>',
  transport: makeTransport(),
  ...over,
});

// ===== email routing =====

test('event is sent via email', async () => {
  const transport = makeTransport();
  await dispatch(baseArgs({ transport }));
  assert.equal(transport.sent.email.length, 1);
});

test('critical event (cancelled) is delivered by email, and email is the only transport call', async () => {
  const transport = makeTransport();
  const out = await dispatch(baseArgs({
    events: [{ type: 'cancelled', priority: 'urgent', title: 'ICE 145 CANCELLED', body: 'Cancelled.' }],
    transport,
  }));
  assert.equal(transport.sent.email.length, 1);
  assert.match(transport.sent.email[0].subject, /CANCELLED/);
  assert.deepEqual(transport.calls, ['sendEmail']);
  assert.deepEqual(out[0].results, [{ channel: 'email', ok: true }]);
});

test('every event type is delivered by email', async () => {
  for (const type of ['tracking_started', 'platform_changed', 'delay_change', 'departed', 'arrived',
                      'cancelled', 'replaced', 'terminating_short', 'tracking_lost']) {
    const transport = makeTransport();
    await dispatch(baseArgs({ events: [{ type, priority: 'high', title: `t-${type}`, body: '...' }], transport }));
    assert.equal(transport.sent.email.length, 1, type);
    assert.deepEqual(transport.calls, ['sendEmail'], type);
  }
});

test('email send failure does not throw — captured in result', async () => {
  const transport = makeTransport({ failEmail: true });
  const out = await dispatch(baseArgs({ transport }));
  assert.equal(out[0].results[0].channel, 'email');
  assert.equal(out[0].results[0].ok, false);
  assert.match(out[0].results[0].error, /smtp down/);
});

// ===== email content threading =====

test('email is threaded via In-Reply-To against confirmationMsgid', async () => {
  const transport = makeTransport();
  await dispatch(baseArgs({
    confirmationMsgid: '<conf-xyz@late.fyi>',
    transport,
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
    transport,
  }));
  assert.equal(transport.sent.email.length, 2);
  assert.equal(transport.sent.email[0].subject, 'one');
  assert.equal(transport.sent.email[1].subject, 'two');
});
