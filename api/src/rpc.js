'use strict';
// Appels métier POST /rpc/<nom> : port de 0002_securite_auth_donnees.sql.
const { q, one, tx, json } = require('./db');
const { err, iso } = require('./util');
const score = require('./score');

const GENDERS = ['femme', 'homme', 'non_binaire', 'femme_trans', 'homme_trans', 'genderfluid', 'agenre', 'queer', 'intersexe', 'autre'];
const AGE_RANGES = ['18-24', '25-29', '30-39', '40-49', '50-69', '70+'];
const RELATIONS = ['serieuse', 'legere', 'indecis'];
const MARITAL = ['single', 'divorced', 'widowed'];
const KIDS = ['none', 'dependent', 'shared', 'adult'];
const KIDS_OK = ['any', 'none', 'with'];
const PROJECTS = ['wants', 'no', 'unsure', 'complete'];
const MUST_HAVE = ['max60', 'same_relation', 'non_smoker'];
const PURPOSES = ['terms', 'sensitive_data', 'connector', 'ads_personalized', 'location'];
const CATEGORIES = ['music', 'listening', 'sport', 'series', 'books', 'authors', 'follows'];
const SOURCES = ['google', 'strava', 'netflix', 'instagram', 'facebook', 'tiktok', 'disney', 'prime', 'spotify', 'deezer', 'letterboxd', 'goodreads', 'snapchat'];
const REASONS = ['harassment', 'fake', 'scam', 'minor', 'inappropriate', 'other'];

const bad = (field) => err(400, 'invalid_input', `Champ invalide : ${field}`);
const str = (v, field, min, max) => {
  if (typeof v !== 'string') throw bad(field);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad(field);
  return s;
};
const oneOf = (v, list, field) => { if (!list.includes(v)) throw bad(field); return v; };
const subset = (v, list, field, nonEmpty) => {
  if (!Array.isArray(v) || (nonEmpty && !v.length) || !v.every((x) => list.includes(x))) throw bad(field);
  return [...new Set(v)];
};
const int = (v, field, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(field);
  return n;
};
const id = (v) => int(v, 'p_id', 1, Number.MAX_SAFE_INTEGER);

// ---------- Questions (cache) ----------
let QUESTIONS;
async function questions() {
  if (!QUESTIONS) {
    QUESTIONS = (await q('SELECT id, module_id, weight, tag, mode, `sensitive`, cross_id, slug, text FROM questions ORDER BY id'));
  }
  return QUESTIONS;
}

// ---------- Consentements ----------
async function hasConsent(u, purpose, scope = null, conn) {
  const r = await one(`SELECT granted FROM consents WHERE user_id = ? AND purpose = ? AND scope <=> ?
                       ORDER BY id DESC LIMIT 1`, [u, purpose, scope], conn);
  return !!(r && r.granted);
}

async function recordConsent(u, p, conn) {
  const purpose = oneOf(p.p_purpose, PURPOSES, 'p_purpose');
  const scope = p.p_scope === null || p.p_scope === undefined || p.p_scope === '' ? null : str(p.p_scope, 'p_scope', 1, 40);
  if (typeof p.p_granted !== 'boolean') throw bad('p_granted');
  const version = str(p.p_version || 'v1', 'p_version', 1, 20);
  const last = await one(`SELECT granted FROM consents WHERE user_id = ? AND purpose = ? AND scope <=> ?
                          ORDER BY id DESC LIMIT 1`, [u, purpose, scope], conn);
  if (!last || !!last.granted !== p.p_granted) {
    await q('INSERT INTO consents (user_id, purpose, scope, granted, text_version) VALUES (?, ?, ?, ?, ?)',
      [u, purpose, scope, p.p_granted ? 1 : 0, version], conn);
  }
  if (purpose === 'sensitive_data' && !p.p_granted) {
    await q(`UPDATE answers SET value = 0 WHERE user_id = ?
             AND question_id IN (SELECT id FROM questions WHERE \`sensitive\` IS NOT NULL)`, [u], conn);
  }
  if (purpose === 'location' && !p.p_granted) {
    await q('DELETE FROM user_locations WHERE user_id = ?', [u], conn);
  }
  if (purpose === 'connector' && !p.p_granted) {
    await q('DELETE FROM user_interests WHERE user_id = ? AND source = ?', [u, scope], conn);
  }
  return null;
}

// ---------- Profil, réponses, imports ----------
function validateProfile(p) {
  if (!p || typeof p !== 'object') throw err(400, 'profile_required');
  const birth = str(p.birth_date, 'birth_date', 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || Number.isNaN(Date.parse(birth))) throw bad('birth_date');
  if (score.ageOf(birth) < 18) throw bad('birth_date');
  const lat = Number(p.lat), lon = Number(p.lon);
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) throw bad('lat/lon');
  return {
    pseudo: str(p.pseudo, 'pseudo', 2, 30),
    birth_date: birth,
    gender: oneOf(p.gender, GENDERS, 'gender'),
    country_code: (() => { const c = str(p.country_code, 'country_code', 2, 2).toUpperCase(); if (!/^[A-Z]{2}$/.test(c)) throw bad('country_code'); return c; })(),
    city_name: str(p.city_name, 'city_name', 1, 120),
    lat: Math.round(lat * 100) / 100,
    lon: Math.round(lon * 100) / 100,
    seeks: subset(p.seeks, GENDERS, 'seeks', true),
    age_ranges: subset(p.age_ranges, AGE_RANGES, 'age_ranges', true),
    max_km: int(p.max_km ?? 50, 'max_km', 0, 20000),   // 0 = monde entier
    relation: oneOf(p.relation, RELATIONS, 'relation'),
    marital_status: oneOf(p.marital_status ?? 'single', MARITAL, 'marital_status'),
    kids: oneOf(p.kids ?? 'none', KIDS, 'kids'),
    kids_ok: subset(p.kids_ok ?? ['any'], KIDS_OK, 'kids_ok', true),
    family_project: oneOf(p.family_project, PROJECTS, 'family_project'),
    project_ok: subset(p.project_ok ?? ['any'], ['any', ...PROJECTS], 'project_ok', true),
    must_have: subset(p.must_have ?? [], MUST_HAVE, 'must_have', false),
    bio: p.bio === undefined || p.bio === null || p.bio === '' ? null : str(p.bio, 'bio', 1, 500),
    lang: typeof p.lang === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(p.lang) ? p.lang : 'fr',
  };
}

async function saveProfile(u, raw, conn) {
  if (!(await hasConsent(u, 'terms', null, conn))) throw err(403, 'terms_required', 'Acceptez les conditions d\'utilisation.');
  const p = validateProfile(raw);
  const cols = ['pseudo', 'birth_date', 'gender', 'country_code', 'city_name', 'lat', 'lon', 'seeks', 'age_ranges', 'max_km',
    'relation', 'marital_status', 'kids', 'kids_ok', 'family_project', 'project_ok', 'must_have', 'bio', 'lang'];
  const jsonCols = new Set(['seeks', 'age_ranges', 'kids_ok', 'project_ok', 'must_have']);
  const vals = cols.map((c) => (jsonCols.has(c) ? JSON.stringify(p[c]) : p[c]));
  // questionnaire_done_at, suspended et consentements ne sont jamais modifiables ici (règle 1)
  await q(`INSERT INTO profiles (user_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
           ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`, [u, ...vals], conn);
  await q('INSERT IGNORE INTO account_status (user_id) VALUES (?)', [u], conn);
}

async function saveAnswers(u, list, conn) {
  if (!(await one('SELECT 1 AS x FROM profiles WHERE user_id = ?', [u], conn))) throw err(409, 'profile_required');
  if (!Array.isArray(list)) throw bad('answers');
  const qs = await questions();
  const byId = new Map(qs.map((x) => [x.id, x]));
  const sens = await hasConsent(u, 'sensitive_data', null, conn);
  const rows = [];
  const seen = new Set();
  for (const a of list.slice(0, 1000)) {
    if (!Array.isArray(a) || a[1] === null || a[1] === undefined) continue;
    const qid = Number(a[0]), v = Number(a[1]);
    const qq = byId.get(qid);
    if (!qq || seen.has(qid) || !Number.isInteger(v) || v < 0 || v > 5) continue;
    seen.add(qid);
    rows.push([u, qid, qq.sensitive && !sens ? 0 : v]);
  }
  if (rows.length) {
    await q('INSERT INTO answers (user_id, question_id, value) VALUES ? ON DUPLICATE KEY UPDATE value = VALUES(value)', [rows], conn);
  }
  const { n } = await one('SELECT COUNT(*) AS n FROM answers WHERE user_id = ?', [u], conn);
  await q(`UPDATE profiles SET questionnaire_done_at = IF(? >= ?, COALESCE(questionnaire_done_at, UTC_TIMESTAMP()), NULL)
           WHERE user_id = ?`, [n, qs.length, u], conn);
  return Number(n);
}

async function saveInterests(u, source, items, conn) {
  oneOf(source, SOURCES, 'source');
  await q('DELETE FROM user_interests WHERE user_id = ? AND source = ?', [u, source], conn);
  if (!Array.isArray(items) || !items.length || !(await hasConsent(u, 'connector', source, conn))) return 0;
  const seen = new Set();
  const rows = [];
  for (const x of items.slice(0, 600)) {
    if (!x || !CATEGORIES.includes(x.category)) continue;
    const key = String(x.key ?? '').slice(0, 120), label = String(x.label ?? '').slice(0, 120);
    if (!key || !label || seen.has(x.category + '\u0000' + key)) continue;
    seen.add(x.category + '\u0000' + key);
    const w = Math.min(3, Math.max(1, parseInt(x.weight, 10) || 1));
    rows.push([u, x.category, key, label, source, w]);
  }
  if (rows.length) {
    const exp = new Date(Date.now() + 365 * 86400_000);
    await q(`INSERT INTO user_interests (user_id, category, item_key, label, source, weight, expires_at) VALUES ?`,
      [rows.map((r) => [...r, exp])], conn);
  }
  return rows.length;
}

async function syncState(u, { p }) {
  if (!p || typeof p !== 'object') throw bad('p');
  return tx(async (c) => {
    for (const k of Array.isArray(p.consents) ? p.consents : []) {
      await recordConsent(u, { p_purpose: k.purpose, p_scope: k.scope, p_granted: k.granted, p_version: k.version || 'v1' }, c);
    }
    if (p.profile) await saveProfile(u, p.profile, c);
    const n = p.answers ? await saveAnswers(u, p.answers, c)
      : Number((await one('SELECT COUNT(*) AS n FROM answers WHERE user_id = ?', [u], c)).n);
    if (p.interests && typeof p.interests === 'object') {
      for (const src of Object.keys(p.interests)) await saveInterests(u, src, p.interests[src], c);
    }
    const pr = await one('SELECT questionnaire_done_at FROM profiles WHERE user_id = ?', [u], c);
    return { answers: n, questionnaire_done: !!(pr && pr.questionnaire_done_at) };
  });
}

// ---------- Propositions ----------
function normProfile(r) {
  const hasEff = r.eff_lat !== undefined && r.eff_lat !== null;
  return { ...r, lat: Number(hasEff ? r.eff_lat : r.lat), lon: Number(hasEff ? r.eff_lon : r.lon), seeks: json(r.seeks, []), age_ranges: json(r.age_ranges, []),
    kids_ok: json(r.kids_ok, ['any']), project_ok: json(r.project_ok, ['any']), must_have: json(r.must_have, []),
    suspended: !!r.suspended, smoker: r.smoker === null || r.smoker === undefined ? 0 : Number(r.smoker) };
}

async function loadAnswers(userIds) {
  const map = new Map(userIds.map((x) => [x, new Map()]));
  for (let i = 0; i < userIds.length; i += 500) {
    const chunk = userIds.slice(i, i + 500);
    for (const r of await q('SELECT user_id, question_id, value FROM answers WHERE user_id IN (?)', [chunk])) {
      map.get(r.user_id).set(r.question_id, r.value);
    }
  }
  return map;
}

async function loadInterests(userIds) {
  const map = new Map(userIds.map((x) => [x, []]));
  for (let i = 0; i < userIds.length; i += 500) {
    const chunk = userIds.slice(i, i + 500);
    for (const r of await q(`SELECT user_id, category, item_key, label FROM user_interests
                             WHERE user_id IN (?) AND expires_at > UTC_TIMESTAMP()`, [chunk])) map.get(r.user_id).push(r);
  }
  return map;
}

const PROFILE_SQL = `SELECT p.*, COALESCE(s.suspended, 0) AS suspended,
  COALESCE(l.lat, p.lat) AS eff_lat, COALESCE(l.lon, p.lon) AS eff_lon,
  (SELECT a.value FROM answers a JOIN questions qq ON qq.id = a.question_id WHERE a.user_id = p.user_id AND qq.slug = 'vie.fumeur') AS smoker
  FROM profiles p LEFT JOIN account_status s ON s.user_id = p.user_id
  LEFT JOIN user_locations l ON l.user_id = p.user_id AND l.updated_at > UTC_TIMESTAMP() - INTERVAL 7 DAY`;

// Calcule les propositions d'une personne (règle 2 : uniquement pour soi, ou par la tâche de nuit)
async function refreshProposals(target, ctx) {
  const cfg = ctx?.cfg || await one('SELECT * FROM app_settings WHERE id = 1');
  const meRow = await one(`${PROFILE_SQL} WHERE p.user_id = ? AND p.questionnaire_done_at IS NOT NULL`, [target]);
  if (!meRow) return 0;
  const me = normProfile(meRow);
  if (me.suspended) return 0;
  const qs = await questions();
  // Préfiltre grossier par latitude (le rayon exact est vérifié par compatible) ; 0 = monde entier
  const r = score.radius(me);
  const dLat = Number.isFinite(r) ? Math.min(180, r / 111 + 0.1) : 180;
  const others = (await q(`${PROFILE_SQL} WHERE p.user_id <> ? AND p.questionnaire_done_at IS NOT NULL
      AND COALESCE(l.lat, p.lat) BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker = ? AND b.blocked = p.user_id) OR (b.blocker = p.user_id AND b.blocked = ?))`,
  [target, me.lat - dLat, me.lat + dLat, target, target]))
    .map(normProfile).filter((o) => score.compatible(me, o));
  if (!others.length) return 0;
  const ids = [target, ...others.map((o) => o.user_id)];
  const answers = await loadAnswers(ids);
  const interests = await loadInterests(ids);
  const popular = ctx?.popular || await popularItems(cfg);
  let n = 0;
  for (const o of others) {
    const s = score.pairScore(qs, answers.get(target), answers.get(o.user_id), interests.get(target), interests.get(o.user_id), popular, cfg);
    const prox = score.proximity(score.band(score.km(me.lat, me.lon, o.lat, o.lon)));
    if (s.common_count < cfg.min_common_answers || Math.min(100, s.score + prox) < cfg.match_threshold) continue;
    const [a, b] = target < o.user_id ? [target, o.user_id] : [o.user_id, target];
    const open = 'matched_at IS NULL AND closed_at IS NULL';
    await q(`INSERT INTO proposals (user_a, user_b, score, qscore, bonus, common_tags, common_count, module_scores, shared)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               score = IF(${open}, VALUES(score), score), qscore = IF(${open}, VALUES(qscore), qscore),
               bonus = IF(${open}, VALUES(bonus), bonus), common_tags = IF(${open}, VALUES(common_tags), common_tags),
               common_count = IF(${open}, VALUES(common_count), common_count),
               module_scores = IF(${open}, VALUES(module_scores), module_scores), shared = IF(${open}, VALUES(shared), shared)`,
    [a, b, s.score, s.qscore, s.bonus, JSON.stringify(s.common_tags), s.common_count, JSON.stringify(s.module_scores), JSON.stringify(s.shared)]);
    n++;
  }
  return n;
}

async function popularItems(cfg) {
  const rows = await q(`SELECT category, item_key FROM user_interests WHERE expires_at > UTC_TIMESTAMP()
                        GROUP BY category, item_key HAVING COUNT(DISTINCT user_id) >= ?`, [cfg.min_item_users]);
  return new Set(rows.map((r) => r.category + '\u0000' + r.item_key));
}

async function refreshMyProposals(u) {
  const ok = await tx(async (c) => {
    await q('INSERT IGNORE INTO account_status (user_id) VALUES (?)', [u], c);
    const st = await one('SELECT last_refresh_at > UTC_TIMESTAMP() - INTERVAL 1 MINUTE AS recent FROM account_status WHERE user_id = ? FOR UPDATE', [u], c);
    if (st && Number(st.recent) === 1) return false;
    await q('UPDATE account_status SET last_refresh_at = UTC_TIMESTAMP() WHERE user_id = ?', [u], c);
    return true;
  });
  if (!ok) return -1;
  return refreshProposals(u);
}

async function getProposals(u) {
  const meRow = await one(`${PROFILE_SQL} WHERE p.user_id = ?`, [u]);
  if (!meRow) return [];
  const me = normProfile(meRow);
  const rows = await q(`SELECT p.*, o.pseudo, o.birth_date, o.gender, o.city_name, o.relation, o.bio,
      COALESCE(l.lat, o.lat) AS o_lat, COALESCE(l.lon, o.lon) AS o_lon, v.last_band,
      IF(p.user_a = ?, p.decision_a, p.decision_b) AS my_decision
    FROM proposals p
    JOIN profiles o ON o.user_id = IF(p.user_a = ?, p.user_b, p.user_a)
    LEFT JOIN user_locations l ON l.user_id = o.user_id AND l.updated_at > UTC_TIMESTAMP() - INTERVAL 7 DAY
    LEFT JOIN proposal_views v ON v.proposal_id = p.id AND v.user_id = ?
    LEFT JOIN account_status st ON st.user_id = o.user_id
    WHERE ? IN (p.user_a, p.user_b) AND p.closed_at IS NULL
      AND IF(p.user_a = ?, p.decision_a, p.decision_b) <> 'refused'
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker = p.user_a AND b.blocked = p.user_b) OR (b.blocker = p.user_b AND b.blocked = p.user_a))
      AND COALESCE(st.suspended, 0) = 0
    ORDER BY p.id`, [u, u, u, u, u]);
  const out = [];
  const views = [];
  for (const r of rows) {
    // Jamais de km exacts (triangulation) : uniquement une tranche
    const dist_band = score.band(score.km(me.lat, me.lon, Number(r.o_lat), Number(r.o_lon)));
    const proximity = score.proximity(dist_band);
    const closer = !!r.last_band && score.bandRank(dist_band) < score.bandRank(r.last_band);
    if (r.last_band !== dist_band) views.push([r.id, u, dist_band]);
    out.push({
      id: Number(r.id), pseudo: r.pseudo, age: score.ageOf(r.birth_date), gender: r.gender, city: r.city_name,
      relation: r.relation, bio: r.bio, dist_band, closer,
      score: Math.min(100, (r.qscore ?? 0) + r.bonus + proximity), qscore: r.qscore, bonus: r.bonus, proximity,
      common_tags: json(r.common_tags, []), common_count: r.common_count,
      modules: json(r.module_scores, null), shared: json(r.shared, {}), my_decision: r.my_decision, matched: !!r.matched_at,
    });
  }
  if (views.length) {
    await q('INSERT INTO proposal_views (proposal_id, user_id, last_band) VALUES ? ON DUPLICATE KEY UPDATE last_band = VALUES(last_band)', [views]);
  }
  return out.sort((a, b) => (b.score - a.score) || (a.id - b.id));
}

// GPS approximatif, facultatif, sous consentement « location »
async function updateLocation(u, { p_lat, p_lon }) {
  if (!(await hasConsent(u, 'location'))) throw err(403, 'consent_required', 'Autorisez la localisation pour utiliser le GPS.');
  const lat = Number(p_lat), lon = Number(p_lon);
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) throw bad('p_lat/p_lon');
  const round = (x) => Math.round(Math.round(x / 0.02) * 0.02 * 100) / 100;   // ~2 km
  const last = await one('SELECT updated_at > UTC_TIMESTAMP() - INTERVAL 10 MINUTE AS recent FROM user_locations WHERE user_id = ?', [u]);
  if (last && Number(last.recent) === 1) throw err(429, 'rate_limited', 'Position déjà mise à jour il y a moins de 10 minutes.');
  await q(`INSERT INTO user_locations (user_id, lat, lon, updated_at) VALUES (?, ?, ?, UTC_TIMESTAMP())
           ON DUPLICATE KEY UPDATE lat = VALUES(lat), lon = VALUES(lon), updated_at = VALUES(updated_at)`, [u, round(lat), round(lon)]);
  return null;
}

// Règle 3 : un refus (avant ou après le match) ferme la proposition et le chat
async function decide(u, { p_id, d }) {
  const pid = id(p_id);
  if (d !== 'accepted' && d !== 'refused') throw bad('d');
  return tx(async (c) => {
    const p = await one('SELECT * FROM proposals WHERE id = ? AND ? IN (user_a, user_b) AND closed_at IS NULL FOR UPDATE', [pid, u], c);
    if (!p) throw err(404, 'proposal_not_found');
    const col = p.user_a === u ? 'decision_a' : 'decision_b';
    await q(`UPDATE proposals SET ${col} = ? WHERE id = ?`, [d, pid], c);
    if (d === 'refused') {
      await q('UPDATE proposals SET matched_at = NULL, closed_at = UTC_TIMESTAMP() WHERE id = ?', [pid], c);
    } else {
      await q(`UPDATE proposals SET matched_at = UTC_TIMESTAMP()
               WHERE id = ? AND decision_a = 'accepted' AND decision_b = 'accepted' AND matched_at IS NULL`, [pid], c);
    }
    const r = await one('SELECT id, matched_at, closed_at FROM proposals WHERE id = ?', [pid], c);
    return { id: Number(r.id), matched: !!r.matched_at, closed: !!r.closed_at };
  });
}

async function openMatch(pid, u, conn) {
  const p = await one(`SELECT * FROM proposals p WHERE id = ? AND ? IN (user_a, user_b)
      AND matched_at IS NOT NULL AND closed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker = p.user_a AND b.blocked = p.user_b) OR (b.blocker = p.user_b AND b.blocked = p.user_a))`,
  [pid, u], conn);
  if (!p) throw err(403, 'chat_closed', 'Cette conversation est fermée.');
  return p;
}

const msgOut = (m, u) => ({ id: Number(m.id), me: m.author === u, body: m.body, at: iso(m.created_at) });

async function getMessages(u, { p_id, p_after }) {
  const pid = id(p_id);
  await openMatch(pid, u);
  const after = Math.max(0, Number(p_after) || 0);
  const rows = await q('SELECT * FROM messages WHERE proposal_id = ? AND id > ? ORDER BY id LIMIT 200', [pid, after]);
  return rows.map((m) => msgOut(m, u));
}

async function sendMessage(u, { p_id, p_body }) {
  const pid = id(p_id);
  const body = str(p_body, 'p_body', 1, 2000);
  await openMatch(pid, u);
  const { n } = await one('SELECT COUNT(*) AS n FROM messages WHERE author = ? AND created_at > UTC_TIMESTAMP() - INTERVAL 1 MINUTE', [u]);
  if (Number(n) >= 30) throw err(429, 'rate_limited', 'Trop de messages. Patientez une minute.');
  const r = await q('INSERT INTO messages (proposal_id, author, body) VALUES (?, ?, ?)', [pid, u, body]);
  const m = await one('SELECT * FROM messages WHERE id = ?', [r.insertId]);
  return msgOut(m, u);
}

async function otherOf(pid, u, conn) {
  const p = await one('SELECT user_a, user_b FROM proposals WHERE id = ? AND ? IN (user_a, user_b)', [pid, u], conn);
  if (!p) throw err(404, 'proposal_not_found');
  return p.user_a === u ? p.user_b : p.user_a;
}

// Règle 4 : le blocage ferme la proposition et masque la personne dans les deux sens
async function blockProposal(u, { p_id }) {
  const pid = id(p_id);
  await tx(async (c) => {
    const o = await otherOf(pid, u, c);
    await q('INSERT IGNORE INTO blocks (blocker, blocked) VALUES (?, ?)', [u, o], c);
    await q('UPDATE proposals SET matched_at = NULL, closed_at = COALESCE(closed_at, UTC_TIMESTAMP()) WHERE id = ?', [pid], c);
  });
  return null;
}

async function reportProposal(u, { p_id, p_reason, p_details }) {
  const pid = id(p_id);
  const o = await otherOf(pid, u);
  if (!REASONS.includes(p_reason)) throw err(400, 'invalid_reason');
  const details = typeof p_details === 'string' && p_details.trim() ? p_details.trim().slice(0, 1000) : null;
  await q('INSERT INTO reports (reporter, reported, reason, details, proposal_id) VALUES (?, ?, ?, ?, ?)', [u, o, p_reason, details, pid]);
  return null;
}

// ---------- État, RGPD ----------
function profileOut(r) {
  if (!r) return null;
  const p = normProfile(r);
  const out = {};
  for (const k of ['pseudo', 'gender', 'country_code', 'city_name', 'lat', 'lon', 'seeks', 'age_ranges', 'max_km', 'relation',
    'marital_status', 'kids', 'kids_ok', 'family_project', 'project_ok', 'must_have', 'bio', 'lang']) out[k] = p[k];
  out.birth_date = r.birth_date instanceof Date ? r.birth_date.toISOString().slice(0, 10) : String(r.birth_date).slice(0, 10);
  out.questionnaire_done_at = iso(r.questionnaire_done_at);
  out.updated_at = iso(r.updated_at);
  return out;
}

async function getMyState(u) {
  const pr = await one('SELECT * FROM profiles WHERE user_id = ?', [u]);
  const answers = await q('SELECT question_id, value FROM answers WHERE user_id = ? ORDER BY question_id', [u]);
  const sources = await q('SELECT DISTINCT source FROM user_interests WHERE user_id = ? ORDER BY source', [u]);
  return {
    profile: profileOut(pr),
    answers: answers.map((a) => [a.question_id, a.value]),
    consents: { terms: await hasConsent(u, 'terms'), sensitive: await hasConsent(u, 'sensitive_data'), ads: await hasConsent(u, 'ads_personalized'), location: await hasConsent(u, 'location') },
    interest_sources: sources.map((s) => s.source),
  };
}

async function exportMyData(u) {
  const acc = await one('SELECT email, created_at, email_verified_at, last_sign_in_at FROM users WHERE id = ?', [u]);
  const pr = await one('SELECT * FROM profiles WHERE user_id = ?', [u]);
  return {
    exported_at: new Date().toISOString(),
    account: { email: acc.email, created_at: iso(acc.created_at), email_verified_at: iso(acc.email_verified_at), last_sign_in_at: iso(acc.last_sign_in_at) },
    profile: profileOut(pr),
    answers: (await q(`SELECT q.text AS question, a.value FROM answers a JOIN questions q ON q.id = a.question_id
                       WHERE a.user_id = ? ORDER BY q.id`, [u])),
    interests: (await q('SELECT category, item_key, label, source, weight, imported_at, expires_at FROM user_interests WHERE user_id = ?', [u]))
      .map((i) => ({ ...i, imported_at: iso(i.imported_at), expires_at: iso(i.expires_at) })),
    consents: (await q('SELECT purpose, scope, granted, text_version, created_at FROM consents WHERE user_id = ? ORDER BY id', [u]))
      .map((c) => ({ ...c, granted: !!c.granted, created_at: iso(c.created_at) })),
    proposals: (await q('SELECT id, score, created_at, matched_at, closed_at FROM proposals WHERE ? IN (user_a, user_b)', [u]))
      .map((p) => ({ id: Number(p.id), score: p.score, created_at: iso(p.created_at), matched_at: iso(p.matched_at), closed_at: iso(p.closed_at) })),
    messages_sent: (await q('SELECT body, created_at FROM messages WHERE author = ? ORDER BY id', [u]))
      .map((m) => ({ body: m.body, at: iso(m.created_at) })),
    location: await (async () => { const l = await one('SELECT lat, lon, updated_at FROM user_locations WHERE user_id = ?', [u]);
      return l ? { lat: Number(l.lat), lon: Number(l.lon), updated_at: iso(l.updated_at) } : null; })(),
    sign_in_providers: (await q('SELECT provider, email, created_at FROM auth_identities WHERE user_id = ?', [u]))
      .map((i) => ({ provider: i.provider, email: i.email, linked_at: iso(i.created_at) })),
    blocks: Number((await one('SELECT COUNT(*) AS n FROM blocks WHERE blocker = ?', [u])).n),
    reports_sent: Number((await one('SELECT COUNT(*) AS n FROM reports WHERE reporter = ?', [u])).n),
  };
}

// Droit à l'effacement : tout part en cascade avec le compte
async function deleteMyAccount(u) {
  await tx(async (c) => {
    await q('DELETE FROM reports WHERE reporter = ?', [u], c);
    await q('DELETE FROM users WHERE id = ?', [u], c);
  });
  return null;
}

// ---------- Tâche de nuit : conservation (règle 6) et recalcul ----------
async function nightly() {
  await q('DELETE FROM user_interests WHERE expires_at < UTC_TIMESTAMP()');
  await q(`DELETE m FROM messages m JOIN proposals p ON p.id = m.proposal_id
           WHERE p.closed_at < UTC_TIMESTAMP() - INTERVAL 30 DAY
             AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.proposal_id = p.id AND r.status = 'open')`);
  await q('DELETE FROM users WHERE COALESCE(last_sign_in_at, created_at) < UTC_TIMESTAMP() - INTERVAL 24 MONTH');
  await q('DELETE FROM user_locations WHERE updated_at < UTC_TIMESTAMP() - INTERVAL 7 DAY');
  await q("DELETE FROM auth_codes WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 1 DAY");
  await q('DELETE FROM refresh_tokens WHERE expires_at < UTC_TIMESTAMP()');
  const cfg = await one('SELECT * FROM app_settings WHERE id = 1');
  const popular = await popularItems(cfg);
  const users = await q('SELECT user_id FROM profiles WHERE questionnaire_done_at IS NOT NULL');
  let total = 0;
  for (const { user_id } of users) total += await refreshProposals(user_id, { cfg, popular });
  return total;
}

const HANDLERS = {
  sync_state: syncState,
  record_consent: (u, p) => recordConsent(u, p),
  refresh_my_proposals: (u) => refreshMyProposals(u),
  get_proposals: (u) => getProposals(u),
  update_location: updateLocation,
  decide,
  get_messages: getMessages,
  send_message: sendMessage,
  block_proposal: blockProposal,
  report_proposal: reportProposal,
  get_my_state: (u) => getMyState(u),
  export_my_data: (u) => exportMyData(u),
  delete_my_account: (u) => deleteMyAccount(u),
};

module.exports = { HANDLERS, nightly, refreshProposals, validateProfile, _resetQuestionCache: () => { QUESTIONS = null; } };
