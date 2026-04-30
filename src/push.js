// Notification dispatcher. Takes diff events from poll.js, the user's stored
// channel preference, and per-record context, and decides what gets sent
// where. Email goes through `transport.sendEmail()`, ntfy through
// `transport.sendNtfy()`. Both transports are dependency-injected so tests
// use fakes and production wires up SMTP / Cloudflare Email send / ntfy POST.
//
// PRD §6 (channels), §7 (replies), §13.7 (this module).

import { pushReply, ntfyOptInReply, confirmationReply, missingContextReply,
         trainNotFoundReply, stationNotOnRouteReply, ambiguousStationReply,
         alreadyArrivedReply, unauthorizedSenderReply, stopReply, genericErrorReply } from './reply.js';
import { ntfyTopic } from './users.js';

const CRITICAL_TYPES = new Set(['cancelled', 'replaced', 'terminating_short', 'tracking_lost']);

// Resolve effective channels for one event under a user's stored preference.
// Critical events always go to BOTH (PRD §6). Non-critical respects the user.
function effectiveChannels(userChannel, event) {
  if (CRITICAL_TYPES.has(event.type)) return new Set(['email', 'ntfy']);
  if (userChannel === 'email') return new Set(['email']);
  if (userChannel === 'ntfy') return new Set(['ntfy']);
  if (userChannel === 'both') return new Set(['email', 'ntfy']);
  return new Set(['email']);
}

// Build an ntfy POST payload. Server-side ntfy reads priority + tags as headers.
function ntfyPayload(event, topic) {
  const priorityMap = { urgent: 5, high: 4, default: 3 };
  return {
    topic,
    title: event.title,
    message: event.body || event.title,
    priority: priorityMap[event.priority] || 3,
    tags: event.tags || ['train'],
  };
}

// Per-event dispatch. Returns array of { channel, ok, error?, attempt } for logging.
//
//   event             from diff.js
//   userChannel       'email' | 'ntfy' | 'both'
//   sender            recipient email
//   line, trainNum    for subject context
//   confirmationMsgid Message-ID of the original confirmation reply (for email threading)
//   ntfyTopicValue    the user's ntfy topic (derived once at the call site)
//   transport         { sendEmail, sendNtfy }
//
async function deliverOne({ event, userChannel, sender, line, trainNum, trip, scheduledIso, confirmationMsgid, ntfyTopicValue, transport }) {
  const channels = effectiveChannels(userChannel, event);
  const results = [];

  if (channels.has('email')) {
    const msg = pushReply({ event, line, trainNum, trip, scheduledIso, sender, confirmationMsgid });
    try {
      await transport.sendEmail(msg);
      results.push({ channel: 'email', ok: true });
    } catch (e) {
      results.push({ channel: 'email', ok: false, error: e.message });
    }
  }

  if (channels.has('ntfy')) {
    if (!ntfyTopicValue) {
      results.push({ channel: 'ntfy', ok: false, error: 'no ntfy topic for sender' });
    } else {
      try {
        await transport.sendNtfy(ntfyPayload(event, ntfyTopicValue));
        results.push({ channel: 'ntfy', ok: true });
      } catch (e) {
        results.push({ channel: 'ntfy', ok: false, error: e.message });
      }
    }
  }

  return results;
}

// Top-level dispatcher for a batch of events from one poll cycle.
// Returns an array of result objects (one per event) for logging.
//
//   { events, sender, userChannel, line, trainNum, confirmationMsgid,
//     transport, ntfyFailureCounter? }
//
// `ntfyFailureCounter` (number, default 0): rolling count of consecutive ntfy
// failures during this trip. Caller persists it. After 3 consecutive fails
// for a single trip, we promote the request to `both` for the rest of the
// session and include a notice on the next email — but Phase 4 just exposes
// the number; the §6 fallback notice happens in Phase 6 when ntfy is wired.
//
export async function dispatch({ events, sender, userChannel = 'email', line, trainNum, trip, scheduledIso,
                                 confirmationMsgid, transport, ntfyFailureCounter = 0 }) {
  const ntfyTopicValue = ntfyTopic(sender);
  const out = [];
  let ntfyFailStreak = ntfyFailureCounter;

  for (const event of events) {
    const channels = effectiveChannels(userChannel, event);
    const results = await deliverOne({ event, userChannel, sender, line, trainNum, trip, scheduledIso, confirmationMsgid, ntfyTopicValue, transport });

    // Roll the ntfy failure streak for fallback logic (§6).
    if (channels.has('ntfy')) {
      const ntfyResult = results.find(r => r.channel === 'ntfy');
      if (ntfyResult) {
        if (ntfyResult.ok) ntfyFailStreak = 0;
        else ntfyFailStreak++;
      }
    }

    out.push({ event, results, ntfyFailStreak });
  }
  return out;
}

// Re-export the reply builders so a top-level server.js can `import { ... } from './push.js'`
// for consistency, without grabbing the rest of reply.js's surface area.
export {
  confirmationReply, missingContextReply, trainNotFoundReply,
  stationNotOnRouteReply, ambiguousStationReply, alreadyArrivedReply,
  unauthorizedSenderReply, stopReply, ntfyOptInReply, genericErrorReply,
};
