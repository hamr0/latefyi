// Fuzzy station-name matching against the resolved train's route.
//
// PRD §13.3 + §7a. Two-layer disambiguation:
//   - When a user-typed name fuzzy-matches multiple canonical stations but
//     ONLY ONE of those candidates appears on the route, take it silently.
//   - Otherwise, return all matching route stops as candidates for §7a's
//     numbered reply.
//
// Pure module, no I/O. Aliases are passed in as data (loaded by the caller
// from config/aliases.json) so tests can supply synthetic tables.

// ---- normalization ----

// Strip diacritics, lowercase, collapse whitespace, drop punctuation.
// Keeps letters/digits/spaces only. Used for both user input and route stops.
export function normalize(s) {
  if (!s) return '';
  return s
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')   // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Levenshtein (vanilla, ≤25 lines) ----

export function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  // Rolling two-row buffer
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

// ---- candidate scoring against a single route stop ----

// Returns either { score: number } when the user input matches this stop, or null.
// Lower score = better match. Score values:
//   0  exact (after normalize)
//   1  alias-target match
//   2  one is a substring of the other
//   3+ Levenshtein distance (capped at 2 of the longer's normalized length)
function scoreAgainstStop(userNorm, stop, aliasTargetsNormSet) {
  const stopNorm = normalize(stop);
  if (userNorm === stopNorm) return { score: 0 };
  if (aliasTargetsNormSet.has(stopNorm)) return { score: 1 };

  // Substring (only meaningful if user input is non-trivially long).
  if (userNorm.length >= 3 && (stopNorm.includes(userNorm) || userNorm.includes(stopNorm))) {
    return { score: 2 };
  }

  // Whole-string Levenshtein.
  const distFull = levenshtein(userNorm, stopNorm);
  const longerFull = Math.max(userNorm.length, stopNorm.length);
  const thresholdFull = longerFull <= 6 ? 1 : 2;
  if (distFull <= thresholdFull) return { score: 2 + distFull };

  // Token-level Levenshtein: user input close to any single word of the stop.
  // Catches "Amstrdam" → "Amsterdam Centraal" where the suffix would wreck whole-string distance.
  const tokens = stopNorm.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    let bestTokDist = Infinity, bestTokLen = 0;
    for (const tok of tokens) {
      const d = levenshtein(userNorm, tok);
      if (d < bestTokDist) { bestTokDist = d; bestTokLen = tok.length; }
    }
    const longerTok = Math.max(userNorm.length, bestTokLen);
    const thresholdTok = longerTok <= 6 ? 1 : 2;
    if (bestTokDist <= thresholdTok) return { score: 5 + bestTokDist };
  }

  return null;
}

// ---- public API ----

// Match a user-typed station name against the train's route.
//
//   userInput          string  e.g. "Paris"
//   routeStopNames     string[] e.g. ["Amsterdam Centraal", "Paris Nord"]
//   aliases            { [normalizedAlias: string]: string[] }   from config/aliases.json
//
// Returns one of:
//   { status: "unique",       match: string }
//   { status: "ambiguous",    candidates: string[] }    // multiple route stops match
//   { status: "not_on_route", suggestion?: string }     // matched something, but not a route stop
//   { status: "no_match" }
//
export function matchStation(userInput, routeStopNames, aliases = {}) {
  if (!userInput || !Array.isArray(routeStopNames) || routeStopNames.length === 0) {
    return { status: 'no_match' };
  }

  const userNorm = normalize(userInput);
  if (!userNorm) return { status: 'no_match' };

  // Resolve alias targets for this input. The alias table is keyed by normalized text.
  const aliasTargets = aliases[userNorm] || [];
  const aliasTargetsNorm = new Set(aliasTargets.map(normalize));

  // Score every route stop. Track best score per stop (lowest wins).
  const scored = [];
  for (const stop of routeStopNames) {
    const r = scoreAgainstStop(userNorm, stop, aliasTargetsNorm);
    if (r) scored.push({ stop, score: r.score });
  }

  if (scored.length === 0) {
    // Nothing on the route matched. As a courtesy, see if any alias target
    // exists at all (so we can hint "you probably meant <X>, but it's not on
    // this train's route").
    if (aliasTargets.length === 1) {
      return { status: 'not_on_route', suggestion: aliasTargets[0] };
    }
    return { status: 'no_match' };
  }

  // Find the best (lowest) score. If multiple stops share that score, ambiguous.
  scored.sort((a, b) => a.score - b.score);
  const best = scored[0].score;
  const winners = scored.filter(s => s.score === best).map(s => s.stop);

  if (winners.length === 1) return { status: 'unique', match: winners[0] };
  return { status: 'ambiguous', candidates: winners };
}

// Resolve a user's reply to an ambiguity prompt. Forgiving per PRD §7a:
// accepts a digit (1-based index into choices) OR a fuzzy station name.
//
//   answer    string   user's reply (e.g. "1" or "Paris Nord" or "lyon")
//   choices   string[] the choices we presented (in order)
//
// Returns:
//   { status: "resolved", match: string }
//   { status: "ambiguous", candidates: string[] }   // name matched >1 choice
//   { status: "no_match" }
//   { status: "out_of_range" }                       // digit reply outside choices
//
export function resolveDisambiguation(answer, choices) {
  if (!answer || !Array.isArray(choices) || choices.length === 0) {
    return { status: 'no_match' };
  }
  const trimmed = answer.trim();

  // 1. Digit reply
  if (/^\d+$/.test(trimmed)) {
    const idx = parseInt(trimmed, 10) - 1;
    if (idx >= 0 && idx < choices.length) {
      return { status: 'resolved', match: choices[idx] };
    }
    return { status: 'out_of_range' };
  }

  // 2. Fuzzy name match against the choices, treating choices as a route.
  // No aliases here — the user is choosing among canonical names we already gave them.
  const r = matchStation(trimmed, choices, {});
  if (r.status === 'unique') return { status: 'resolved', match: r.match };
  if (r.status === 'ambiguous') return { status: 'ambiguous', candidates: r.candidates };
  return { status: 'no_match' };
}
