// Station-local time formatters. Shared by reply.js (confirmation/help text)
// and diff.js (push notification bodies).
//
// HAFAS gives times as ISO strings with the station's local offset baked in
// (e.g. '2026-05-04T11:10:00+02:00' for an 11:10 CEST departure). All
// formatters here read the literal Y/M/D/HH:MM components OUT of the string
// instead of going through new Date(...).toISOString(), which forces UTC and
// silently shifts the displayed time by 1-2 hours. The May 2026 EUR9340
// incident: user thought a future train had already departed because the
// confirmation said '09:10' instead of '11:10'.
//
// Times are always station-local. The station name appears next to the time
// in rendered text, so we don't add a TZ label.

const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?([+-]\d{2}:?\d{2}|Z)?/;

export function parseLocal(iso) {
  if (!iso) return null;
  const s = (iso instanceof Date) ? iso.toISOString() : iso;
  if (typeof s !== 'string') return null;
  const m = s.match(ISO_LOCAL);
  if (!m) return null;
  const [, y, mo, d, hh, mm, off] = m;
  return { y, mo, d, hh, mm, off: off || 'Z' };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function dayName(iso) {
  const p = parseLocal(iso);
  if (!p) return '?';
  // Day-of-week from the LOCAL date, not the JS-coerced UTC date — otherwise
  // a 23:30 local departure on Sunday gets labelled "Monday".
  return DAYS[new Date(`${p.y}-${p.mo}-${p.d}T12:00:00Z`).getUTCDay()];
}

export function fmtTime(iso) {
  const p = parseLocal(iso);
  return p ? `${p.hh}:${p.mm}` : '?';
}

export function fmtDate(iso) {
  const p = parseLocal(iso);
  return p ? `${p.y}-${p.mo}-${p.d}` : '?';
}

export function fmtDatetime(iso) {
  const p = parseLocal(iso);
  if (!p) return '?';
  return `${dayName(iso)}, ${p.y}-${p.mo}-${p.d} ${p.hh}:${p.mm}`;
}

// Shift an ISO timestamp by deltaMin minutes, preserving its original offset.
// shiftIso('2026-05-04T11:10:00+02:00', -30) → '2026-05-04T10:40:00+02:00'.
export function shiftIso(iso, deltaMin) {
  const p = parseLocal(iso);
  if (!p) return null;
  const t = Date.UTC(+p.y, +p.mo - 1, +p.d, +p.hh, +p.mm) + deltaMin * 60_000;
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00${p.off === 'Z' ? 'Z' : p.off}`;
}
