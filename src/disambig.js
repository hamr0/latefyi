// Park / read / remove pending disambiguation state.
//
// When resolve() returns `disambiguation_needed`, server.js sends a reply
// listing the candidates and parks a record at
// state/pending-disambig/<our-msgid>.json. When the user replies (the parser
// returns kind: 'reply' with an answer), server.js looks up by In-Reply-To,
// applies the answer, and resolves fresh.
//
// Records expire after 24h (lazy expiry on read; no janitor needed since
// state/pending-disambig/ is small).

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TTL_MS = 24 * 60 * 60 * 1000;

function dir(stateDir) {
  return join(stateDir, 'pending-disambig');
}

function pathFor(stateDir, msgid) {
  // Filenames must be filesystem-safe; msgids look like "<hex@late.fyi>".
  const safe = String(msgid).replace(/[<>]/g, '').replace(/[^A-Za-z0-9._@-]/g, '_');
  return join(dir(stateDir), `${safe}.json`);
}

export function parkDisambig(stateDir, record) {
  if (!record?.ourMsgid) throw new Error('parkDisambig: ourMsgid required');
  mkdirSync(dir(stateDir), { recursive: true });
  const path = pathFor(stateDir, record.ourMsgid);
  const tmp = `${path}.tmp`;
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  writeFileSync(tmp, JSON.stringify({ ...record, expiresAt }, null, 2));
  renameSync(tmp, path);
  return path;
}

// Returns the parked record, or null if missing / expired.
// Expired records are deleted as a side effect.
export function readDisambig(stateDir, msgid, now = Date.now()) {
  const path = pathFor(stateDir, msgid);
  if (!existsSync(path)) return null;
  let rec;
  try { rec = JSON.parse(readFileSync(path, 'utf8')); }
  catch { try { unlinkSync(path); } catch { /* race */ } return null; }
  const expires = Date.parse(rec.expiresAt);
  if (!isNaN(expires) && expires < now) {
    try { unlinkSync(path); } catch { /* race */ }
    return null;
  }
  return { ...rec, _path: path };
}

export function removeDisambig(stateDir, msgid) {
  const path = pathFor(stateDir, msgid);
  try { unlinkSync(path); } catch { /* already gone */ }
}
