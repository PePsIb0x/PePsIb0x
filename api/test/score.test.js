'use strict';
const test = require('node:test');
const assert = require('node:assert');
const s = require('../src/score');

const Q = [
  { id: 1, module_id: 'perso', weight: 1, tag: 'A', mode: 'sim', sensitive: null, cross_id: null },
  { id: 2, module_id: 'valeurs', weight: 2, tag: 'B', mode: 'sim', sensitive: 'religion', cross_id: null },
  { id: 3, module_id: 'vie', weight: 1, tag: 'C', mode: 'risk', sensitive: null, cross_id: null },
  { id: 4, module_id: 'vie', weight: 1, tag: 'D', mode: 'avoid', sensitive: null, cross_id: 5 },
  { id: 5, module_id: 'vie', weight: 1, tag: 'E', mode: 'sim', sensitive: null, cross_id: null },
];
const M = (o) => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));

test('sim, 0 ignoré, risk divisé par 2', () => {
  const r = s.questionScore(Q.slice(0, 3), M({ 1: 5, 2: 0, 3: 5 }), M({ 1: 4, 2: 3, 3: 4 }));
  // q1 : 0.75 ; q2 ignorée ; q3 : (1-1/4)*0.5 = 0.375 ; moyenne pondérée (1,1) = 0.5625 -> 56
  assert.strictEqual(r.common_count, 2);
  assert.strictEqual(r.qscore, 56);
  assert.deepStrictEqual(r.common_tags, ['A']);  // q3 risk exclue des tags, q2 sensible
});

test('avoid : pénalité croisée', () => {
  // A évite fortement (5) le trait ; B a le trait à 5 -> pénalité 1*1 = 1 -> s = 0
  const r = s.questionScore([Q[3], Q[4]], M({ 4: 5, 5: 1 }), M({ 4: 1, 5: 5 }));
  assert.strictEqual(r.common_count, 2);
  // q4 : 0 ; q5 sim : 1-4/4 = 0 -> 0
  assert.strictEqual(r.qscore, 0);
  const r2 = s.questionScore([Q[3]], M({ 4: 5, 5: 1 }), M({ 4: 1, 5: 1 }));
  assert.strictEqual(r2.qscore, 100);
});

test('bonus k-anonyme plafonné', () => {
  const ia = [{ category: 'music', item_key: 'x', label: 'X' }, { category: 'books', item_key: 'y', label: 'Y' }, { category: 'sport', item_key: 'z', label: 'Z' }, { category: 'series', item_key: 'w', label: 'W' }];
  const pop = new Set(['music\u0000x', 'books\u0000y', 'sport\u0000z', 'series\u0000w']);
  const r = s.pairScore(Q.slice(0, 1), M({ 1: 5 }), M({ 1: 5 }), ia, ia, pop, { bonus_max: 6, bonus_per_category: 2 });
  assert.strictEqual(r.bonus, 6);
  assert.strictEqual(r.score, 100);
  const r2 = s.pairScore(Q.slice(0, 1), M({ 1: 5 }), M({ 1: 5 }), ia, ia, new Set(), { bonus_max: 6, bonus_per_category: 2 });
  assert.strictEqual(r2.bonus, 0);
});

test('filtres éliminatoires', () => {
  const base = { gender: 'femme', seeks: ['homme'], birth_date: '1995-01-01', age_ranges: ['25-29', '30-39'], lat: 46.52, lon: 6.63,
    max_km: 50, must_have: [], relation: 'serieuse', kids: 'none', kids_ok: ['any'], family_project: 'wants', project_ok: ['any'], smoker: 0, suspended: false };
  const a = { ...base };
  const b = { ...base, gender: 'homme', seeks: ['femme'], lat: 46.46, lon: 6.84 };
  const now = new Date('2026-11-24');
  assert.ok(s.compatible(a, b, now));
  assert.ok(!s.compatible(a, { ...b, suspended: true }, now));
  assert.ok(!s.compatible({ ...a, must_have: ['non_smoker'] }, { ...b, smoker: 4 }, now));
  assert.ok(!s.compatible(a, { ...b, lat: 47.37, lon: 8.54 }, now)); // Zurich > 50 km
  assert.ok(!s.compatible({ ...a, kids_ok: ['none'] }, { ...b, kids: 'shared' }, now));
  assert.ok(!s.compatible({ ...a, must_have: ['same_relation'] }, { ...b, relation: 'legere' }, now));
  assert.strictEqual(s.ageOf('2008-11-25', now), 17);
  assert.ok(s.inRanges(72, ['70+']));
});
