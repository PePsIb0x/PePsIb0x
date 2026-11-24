'use strict';
// Calcul du score et filtres éliminatoires : port fidèle de private.pair_score / private.compatible (0002).
// Fonctions pures, testées dans test/score.test.js.

const MODULES = ['perso', 'valeurs', 'famille', 'loisirs', 'vie', 'projets'];

// Pénalité d'une préférence (pref, 1..5) face au trait de l'autre (trait, 1..5)
function penalty(mode, pref, trait) {
  if (!(pref > 0 && trait > 0)) return 0;
  const f = mode === 'avoid' ? (trait - 1) / 4 : (5 - trait) / 4;
  return Math.max(0, pref - 3) / 2 * f;
}

// questions : [{id, module_id, weight, tag, mode, sensitive, cross_id}]
// a, b : Map(question_id -> valeur 0..5)
function questionScore(questions, a, b) {
  const ok = [];
  for (const q of questions) {
    const va = a.get(q.id) || 0, vb = b.get(q.id) || 0;
    let s = null;
    if (q.mode === 'sim' || q.mode === 'risk') {
      if (va > 0 && vb > 0) {
        s = (1 - Math.abs(va - vb) / 4) * (q.mode === 'risk' && va >= 4 && vb >= 4 ? 0.5 : 1);
      }
    } else {
      const ta = q.cross_id ? (a.get(q.cross_id) || 0) : 0;
      const tb = q.cross_id ? (b.get(q.cross_id) || 0) : 0;
      if ((va > 0 && tb > 0) || (vb > 0 && ta > 0)) {
        s = 1 - Math.max(penalty(q.mode, va, tb), penalty(q.mode, vb, ta));
      }
    }
    if (s !== null) ok.push({ q, s });
  }
  let num = 0, den = 0;
  for (const { q, s } of ok) { num += q.weight * s; den += q.weight; }
  const qscore = den > 0 ? Math.round(100 * num / den) : null;
  const common_tags = ok.filter((x) => x.q.mode === 'sim' && !x.q.sensitive)
    .sort((x, y) => (y.s - x.s) || (y.q.weight - x.q.weight) || (x.q.id - y.q.id))
    .slice(0, 3).map((x) => x.q.tag);
  const module_scores = MODULES.map((m) => {
    const xs = ok.filter((x) => x.q.module_id === m);
    return xs.length ? Math.round(100 * xs.reduce((t, x) => t + x.s, 0) / xs.length) : 0;
  });
  return { qscore, common_count: ok.length, common_tags, module_scores };
}

// ia, ib : [{category, item_key, label}] ; popular : Set("category\u0000item_key") des éléments
// détenus par au moins min_item_users personnes (k-anonymat)
function sharedInterests(ia, ib, popular) {
  const keysB = new Set(ib.map((x) => x.category + '\u0000' + x.item_key));
  const common = new Map();
  for (const x of ia) {
    const k = x.category + '\u0000' + x.item_key;
    if (!keysB.has(k) || !popular.has(k)) continue;
    const prev = common.get(k);
    if (!prev || x.label < prev.label) common.set(k, { category: x.category, label: x.label });
  }
  const byCat = {};
  for (const { category, label } of common.values()) (byCat[category] = byCat[category] || []).push(label);
  const shared = {};
  for (const cat of Object.keys(byCat).sort()) shared[cat] = byCat[cat].sort().slice(0, 5);
  return shared;
}

function pairScore(questions, a, b, ia, ib, popular, cfg) {
  const qs = questionScore(questions, a, b);
  const shared = sharedInterests(ia || [], ib || [], popular || new Set());
  const bonus = Math.min(cfg.bonus_max, cfg.bonus_per_category * Object.keys(shared).length);
  const score = qs.qscore === null ? 0 : Math.min(100, qs.qscore + bonus);
  return { ...qs, shared, bonus, score };
}

// ---------- Filtres éliminatoires ----------
function ageOf(birthDate, now = new Date()) {
  const d = new Date(birthDate);
  let y = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) y--;
  return y;
}

function inRanges(years, ranges) {
  return ranges.some((r) => {
    if (r === '70+') return years >= 70;
    const [lo, hi] = r.split('-').map(Number);
    return years >= lo && years <= hi;
  });
}

function km(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function radius(p) { return p.must_have.includes('max60') ? Math.min(p.max_km, 60) : p.max_km; }

// a, b : profils normalisés (tableaux décodés, lat/lon en nombres, smoker = valeur de vie.fumeur, suspended)
function compatible(a, b, now = new Date()) {
  if (a.suspended || b.suspended) return false;
  if (!a.seeks.includes(b.gender) || !b.seeks.includes(a.gender)) return false;
  if (!inRanges(ageOf(b.birth_date, now), a.age_ranges) || !inRanges(ageOf(a.birth_date, now), b.age_ranges)) return false;
  if (km(a.lat, a.lon, b.lat, b.lon) > Math.min(radius(a), radius(b))) return false;
  if ((a.must_have.includes('same_relation') || b.must_have.includes('same_relation')) && a.relation !== b.relation) return false;
  const kidsOf = (p) => (p.kids === 'none' ? 'none' : 'with');
  if (!a.kids_ok.includes('any') && !a.kids_ok.includes(kidsOf(b))) return false;
  if (!b.kids_ok.includes('any') && !b.kids_ok.includes(kidsOf(a))) return false;
  if (!a.project_ok.includes('any') && !a.project_ok.includes(b.family_project)) return false;
  if (!b.project_ok.includes('any') && !b.project_ok.includes(a.family_project)) return false;
  if (a.must_have.includes('non_smoker') && (b.smoker || 0) >= 4) return false;
  if (b.must_have.includes('non_smoker') && (a.smoker || 0) >= 4) return false;
  return true;
}

module.exports = { MODULES, penalty, questionScore, sharedInterests, pairScore, ageOf, inRanges, km, compatible };
