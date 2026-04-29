import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNtfyTransport } from '../src/ntfy-transport.js';

function fakeFetch(captured, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return async (url, init) => {
    captured.url = url;
    captured.init = init;
    return { ok, status, statusText };
  };
}

test('sendNtfy POSTs to baseUrl/topic with message body', async () => {
  const captured = {};
  const t = createNtfyTransport({ baseUrl: 'https://ntfy.sh', fetch: fakeFetch(captured) });
  await t.sendNtfy({ topic: 'latefyi-abc', title: 'ICE 145 platform', message: 'Track 7' });
  assert.equal(captured.url, 'https://ntfy.sh/latefyi-abc');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.body, 'Track 7');
  assert.equal(captured.init.headers['Title'], 'ICE 145 platform');
});

test('sendNtfy serializes priority and tags as headers', async () => {
  const captured = {};
  const t = createNtfyTransport({ fetch: fakeFetch(captured) });
  await t.sendNtfy({ topic: 'x', title: 't', message: 'm', priority: 4, tags: ['train', 'delay'] });
  assert.equal(captured.init.headers['Priority'], '4');
  assert.equal(captured.init.headers['Tags'], 'train,delay');
});

test('sendNtfy omits optional headers when not provided', async () => {
  const captured = {};
  const t = createNtfyTransport({ fetch: fakeFetch(captured) });
  await t.sendNtfy({ topic: 'x', message: 'm' });
  assert.equal(captured.init.headers['Title'], undefined);
  assert.equal(captured.init.headers['Priority'], undefined);
  assert.equal(captured.init.headers['Tags'], undefined);
});

test('sendNtfy throws on non-2xx response', async () => {
  const captured = {};
  const t = createNtfyTransport({ fetch: fakeFetch(captured, { ok: false, status: 502, statusText: 'Bad Gateway' }) });
  await assert.rejects(
    () => t.sendNtfy({ topic: 'x', message: 'm' }),
    /ntfy POST failed: 502/
  );
});

test('sendNtfy requires topic', async () => {
  const t = createNtfyTransport({ fetch: fakeFetch({}) });
  await assert.rejects(() => t.sendNtfy({ message: 'm' }), /topic required/);
});

test('createNtfyTransport throws when fetch is explicitly null', () => {
  // Node 22+ always provides globalThis.fetch, so we pass `null` to simulate
  // a runtime that doesn't (and to verify the guard fires).
  assert.throws(
    () => createNtfyTransport({ fetch: null }),
    /no fetch implementation/
  );
});

test('default baseUrl is ntfy.sh', async () => {
  const captured = {};
  const t = createNtfyTransport({ fetch: fakeFetch(captured) });
  await t.sendNtfy({ topic: 'x', message: 'm' });
  assert.equal(captured.url, 'https://ntfy.sh/x');
});
