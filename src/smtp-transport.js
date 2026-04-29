// SMTP transport adapter. Wraps `nodemailer` to expose the
// transport interface push.js / poll-runner.js / ingest-server.js expect:
//   { sendEmail(msg), sendNtfy(payload) }
//
// nodemailer is added as a dependency only because writing a correct,
// secure SMTP client (TLS + AUTH PLAIN/LOGIN + DKIM signing if needed)
// from scratch would be ~500 LOC of security-critical code. AGENT_RULES
// external-dep checklist: passes (necessity, maintained, lightweight,
// established, security-aware-domain).
//
// ntfy is wired in Phase 6. For now sendNtfy is a no-op stub that throws
// — push.dispatch surfaces this through its result object and continues.

import nodemailer from 'nodemailer';

export function createSmtpTransport({ host, port = 587, user, pass, fromAddress }) {
  if (!host) throw new Error('createSmtpTransport: host required');

  const tx = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,                // implicit TLS only on 465; 587 uses STARTTLS
    auth: (user && pass) ? { user, pass } : undefined,
  });

  return {
    async sendEmail(msg) {
      const headers = msg.headers || {};
      await tx.sendMail({
        from: fromAddress || msg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.body,
        // Threading headers — pass-through to preserve In-Reply-To/References.
        inReplyTo: headers['In-Reply-To'],
        references: headers['References'] || headers['In-Reply-To'],
        messageId: headers['Message-ID'],
      });
    },
    async sendNtfy() {
      throw new Error('SMTP transport does not handle ntfy — wire createNtfyTransport in Phase 6');
    },
  };
}
