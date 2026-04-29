// Behavior tests for stations.js — fuzzy matching and disambiguation reply.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchStation, resolveDisambiguation, normalize, levenshtein } from '../src/stations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALIASES = JSON.parse(
  readFileSync(join(__dirname, '../config/aliases.json'), 'utf8')
);

// ===== normalize =====

test('normalize: strips diacritics, punctuation, lowercases', () => {
  assert.equal(normalize('München Hbf'), 'munchen hbf');
  assert.equal(normalize('Paris Gare du Nord'), 'paris gare du nord');
  assert.equal(normalize('Bruxelles Midi/Zuid'), 'bruxelles midi zuid');
  assert.equal(normalize('  Köln  '), 'koln');
});

// ===== levenshtein =====

test('levenshtein basic', () => {
  assert.equal(levenshtein('cat', 'cat'), 0);
  assert.equal(levenshtein('cat', 'cats'), 1);
  assert.equal(levenshtein('munich', 'munchen'), 3);
  assert.equal(levenshtein('', 'abc'), 3);
});

// ===== matchStation: exact / unique =====

test('exact match (case-insensitive) → unique', () => {
  const r = matchStation('Paris Nord', ['Amsterdam Centraal', 'Paris Nord', 'Köln Hbf'], ALIASES);
  assert.equal(r.status, 'unique');
  assert.equal(r.match, 'Paris Nord');
});

test('uppercase user input → matches mixed-case stop', () => {
  const r = matchStation('AMSTERDAM CENTRAAL', ['Amsterdam Centraal', 'Berlin Hbf'], ALIASES);
  assert.equal(r.status, 'unique');
  assert.equal(r.match, 'Amsterdam Centraal');
});

// ===== matchStation: alias-driven =====

test('alias resolves uniquely when only one target is on the route', () => {
  // EUR9316 stops at Paris Nord (not Lyon/Bercy etc.).
  // User types "Paris" — alias "paris" isn't in our table, so we rely on
  // substring/Levenshtein. "paris" vs "paris nord" → substring → unique.
  const r = matchStation('Paris', ['Amsterdam Centraal', 'Paris Nord', 'Bruxelles Midi'], ALIASES);
  assert.equal(r.status, 'unique');
  assert.equal(r.match, 'Paris Nord');
});

test('alias with explicit canonical: "Frankfurt" → "Frankfurt Hbf"', () => {
  const r = matchStation('Frankfurt', ['Frankfurt(Main)Hbf', 'Berlin Hbf'], ALIASES);
  assert.equal(r.status, 'unique');
  assert.equal(r.match, 'Frankfurt(Main)Hbf');
});

test('alias for accented stop: "Munich" → "München Hbf"', () => {
  const r = matchStation('Munich', ['München Hbf', 'Berlin Hbf'], ALIASES);
  assert.equal(r.status, 'unique');
  assert.equal(r.match, 'München Hbf');
});

// ===== matchStation: ambiguous =====

test('ambiguous: two route stops match user input → candidates returned', () => {
  // TGV stopping at both Paris Gare de Lyon and Paris Bercy → "Paris" is ambiguous.
  const r = matchStation('Paris', ['Lyon Part-Dieu', 'Paris Gare de Lyon', 'Paris Bercy'], ALIASES);
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.sort(), ['Paris Bercy', 'Paris Gare de Lyon']);
});

test('ambiguous: Lille route with both Flandres and Europe', () => {
  const r = matchStation('Lille', ['Lille Flandres', 'Lille Europe', 'Bruxelles Midi'], ALIASES);
  assert.equal(r.status, 'ambiguous');
  assert.deepEqual(r.candidates.sort(), ['Lille Europe', 'Lille Flandres']);
});

// ===== matchStation: not on route / no match =====

test('not_on_route: alias resolves but no candidate is on the route', () => {
  // User types "Munich", route doesn't include any München station.
  const r = matchStation('Munich', ['Amsterdam Centraal', 'Berlin Hbf'], ALIASES);
  assert.equal(r.status, 'not_on_route');
  assert.equal(r.suggestion, 'München Hbf');
});

test('no_match: user types something unrelated', () => {
  const r = matchStation('Buenos Aires', ['Amsterdam Centraal', 'Berlin Hbf'], ALIASES);
  assert.equal(r.status, 'no_match');
});

test('typo within Levenshtein 2 → unique', () => {
  // "Amstrdam" → "Amsterdam Centraal" (single-char deletion)
  const r = matchStation('Amstrdam', ['Amsterdam Centraal', 'Berlin Hbf'], ALIASES);
  assert.equal(r.status, 'unique');
  assert.equal(r.match, 'Amsterdam Centraal');
});

test('typo beyond threshold → no_match', () => {
  const r = matchStation('Aamssterdaaam', ['Amsterdam Centraal', 'Berlin Hbf'], ALIASES);
  // Lev distance > 2 against "amsterdam centraal" → no fuzzy match
  // (substring also doesn't apply since neither contains the other normalized)
  assert.equal(r.status, 'no_match');
});

// ===== matchStation: defensive =====

test('empty inputs return no_match', () => {
  assert.equal(matchStation('', ['Berlin Hbf'], ALIASES).status, 'no_match');
  assert.equal(matchStation('Berlin', [], ALIASES).status, 'no_match');
  assert.equal(matchStation('Berlin', null, ALIASES).status, 'no_match');
});

// ===== resolveDisambiguation =====

test('digit reply selects 1-based index', () => {
  const r = resolveDisambiguation('2', ['Lille Flandres', 'Lille Europe']);
  assert.equal(r.status, 'resolved');
  assert.equal(r.match, 'Lille Europe');
});

test('digit out of range', () => {
  const r = resolveDisambiguation('5', ['Lille Flandres', 'Lille Europe']);
  assert.equal(r.status, 'out_of_range');
});

test('name reply (forgiving) — exact match wins', () => {
  const r = resolveDisambiguation('Lille Europe', ['Lille Flandres', 'Lille Europe']);
  assert.equal(r.status, 'resolved');
  assert.equal(r.match, 'Lille Europe');
});

test('name reply — partial name with substring match', () => {
  const r = resolveDisambiguation('Europe', ['Lille Flandres', 'Lille Europe']);
  assert.equal(r.status, 'resolved');
  assert.equal(r.match, 'Lille Europe');
});

test('name reply that re-introduces ambiguity → ambiguous', () => {
  const r = resolveDisambiguation('Lille', ['Lille Flandres', 'Lille Europe']);
  assert.equal(r.status, 'ambiguous');
});

test('garbage reply → no_match', () => {
  const r = resolveDisambiguation('xyz', ['Lille Flandres', 'Lille Europe']);
  assert.equal(r.status, 'no_match');
});
