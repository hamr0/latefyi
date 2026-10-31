// Notification dispatcher. Takes diff events from poll.js and per-record
// context, and sends each as an email via `transport.sendEmail()`. The
// transport is dependency-injected so tests use fakes and production wires up
// SMTP. Email is the only delivery channel (ntfy was removed in 0.19.0).
//
// PRD §7 (replies), §13.7 (this module).

import { pushReply, confirmationReply, missingContextReply,
         trainNotFoundReply, stationNotOnRouteReply, ambiguousStationReply,
         alreadyArrivedReply, unauthorizedSenderReply, stopReply, genericErrorReply } from './reply.js';

// Per-event dispatch. Returns array of { channel: 'email', ok, error? } for logging.
//
//   event             from diff.js
//   sender            recipient email
//   line, trainNum    for subject context
//   confirmationMsgid Message-ID of the original confirmation reply (for email threading)
//   transport         { sendEmail }
//
async function deliverOne({ event, sender, line, trainNum, trip, scheduledIso, confirmationMsgid, transport }) {
  const msg = pushReply({ event, line, trainNum, trip, scheduledIso, sender, confirmationMsgid });
  try {
    await transport.sendEmail(msg);
    return [{ channel: 'email', ok: true }];
  } catch (e) {
    return [{ channel: 'email', ok: false, error: e.message }];
  }
}

// Top-level dispatcher for a batch of events from one poll cycle.
// Returns an array of result objects (one per event) for logging.
//
//   { events, sender, line, trainNum, trip, scheduledIso, confirmationMsgid, transport }
//
export async function dispatch({ events, sender, line, trainNum, trip, scheduledIso,
                                 confirmationMsgid, transport }) {
  const out = [];
  for (const event of events) {
    const results = await deliverOne({ event, sender, line, trainNum, trip, scheduledIso, confirmationMsgid, transport });
    out.push({ event, results });
  }
  return out;
}

// Re-export the reply builders so a top-level server.js can `import { ... } from './push.js'`
// for consistency, without grabbing the rest of reply.js's surface area.
export {
  confirmationReply, missingContextReply, trainNotFoundReply,
  stationNotOnRouteReply, ambiguousStationReply, alreadyArrivedReply,
  unauthorizedSenderReply, stopReply, genericErrorReply,
};
