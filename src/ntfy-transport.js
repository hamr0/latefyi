// ntfy transport adapter. Wraps the global `fetch` to expose a `sendNtfy`
// matching the transport interface push.js expects:
//   { sendNtfy(payload) }  where payload = { topic, title, message, priority?, tags? }
//
// ntfy.sh accepts plain HTTP POSTs to https://<base>/<topic> with the message
// as the body and metadata as headers (Title, Priority, Tags). No auth needed
// for public ntfy.sh; topic-as-secret is the access control. PRD §6, §7.

export function createNtfyTransport({ baseUrl = 'https://ntfy.sh', fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!fetchImpl) throw new Error('createNtfyTransport: no fetch implementation available');

  return {
    async sendNtfy({ topic, title, message, priority, tags }) {
      if (!topic) throw new Error('sendNtfy: topic required');
      const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
      if (title) headers['Title'] = title;
      if (priority) headers['Priority'] = String(priority);
      if (tags && tags.length) headers['Tags'] = tags.join(',');

      const res = await fetchImpl(`${baseUrl}/${topic}`, {
        method: 'POST',
        headers,
        body: message ?? '',
      });
      if (!res.ok) {
        throw new Error(`ntfy POST failed: ${res.status} ${res.statusText}`);
      }
    },
  };
}
