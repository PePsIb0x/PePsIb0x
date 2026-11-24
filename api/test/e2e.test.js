'use strict';
// Test de bout en bout : nécessite une base MySQL/MariaDB vide (variables DB_*). Ignoré sinon.
const test = require('node:test');
const assert = require('node:assert');
if (!process.env.DB_NAME) { test('e2e (ignoré : DB_NAME absent)', { skip: true }, () => {}); return; }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
process.env.NODE_ENV = 'test';

const codes = {};
const origLog = console.log;
console.log = (...a) => { const m = /^\[mail:dev\] (\w+) -> (\S+) : (\d{6})$/.exec(a.join(' ')); if (m) codes[m[2] + ':' + m[1]] = m[3]; else origLog(...a); };

const { app } = require('../src/server');
const { migrate, q } = require('../src/db');
const { nightly } = require('../src/rpc');
let base;

async function call(path, body, token) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}
const rpc = (name, body, tok) => call('/rpc/' + name, body, tok);

async function account(email, profile, answerFn) {
  let r = await call('/auth/signup', { email, password: 'motdepasse123' });
  assert.strictEqual(r.status, 201);
  r = await call('/auth/login', { email, password: 'motdepasse123' });
  assert.strictEqual(r.body.error, 'email_not_confirmed');
  r = await call('/auth/verify', { email, code: '000000' === codes[email + ':verify'] ? '111111' : '000000' });
  assert.strictEqual(r.body.error, 'otp_expired');
  r = await call('/auth/verify', { email, code: codes[email + ':verify'] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const tok = r.body.access_token;
  const answers = Array.from({ length: 180 }, (_, i) => [i + 1, answerFn(i + 1)]);
  r = await rpc('sync_state', { p: { profile, answers } }, tok);
  assert.strictEqual(r.body.error, 'terms_required');
  r = await rpc('sync_state', { p: { consents: [{ purpose: 'terms', granted: true, version: 'v1' }], profile, answers } }, tok);
  assert.deepStrictEqual(r.body, { answers: 180, questionnaire_done: true });
  return { tok, refresh: r.refresh, id: null, tokens: null };
}

test('parcours complet', async (t) => {
  for (const tb of ['messages', 'reports', 'blocks', 'proposals', 'user_interests', 'consents', 'answers', 'profiles', 'refresh_tokens', 'auth_codes', 'account_status', 'users']) {
    try { await q(`DELETE FROM ${tb}`); } catch (_) { /* tables pas encore créées */ }
  }
  await migrate();
  const srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}/v1`;
  t.after(async () => { srv.close(); await require('../src/db').getPool().end().catch(() => {}); });

  const P = { pseudo: 'Alex', birth_date: '1994-04-12', gender: 'homme', country_code: 'CH', city_name: 'Lausanne', lat: 46.5197, lon: 6.6323,
    seeks: ['femme'], age_ranges: ['25-29', '30-39'], max_km: 60, relation: 'serieuse', marital_status: 'single', kids: 'none',
    kids_ok: ['any'], family_project: 'wants', project_ok: ['any'], must_have: [], lang: 'fr' };
  const A = await account('alex@example.test', P, (n) => (n % 5) + 1);
  const N = await account('nora@example.test', { ...P, pseudo: 'Nora', gender: 'femme', seeks: ['homme'], city_name: 'Vevey', lat: 46.46, lon: 6.84 }, (n) => (n % 5) + 1);
  const Z = await account('zoe@example.test', { ...P, pseudo: 'Zoé', gender: 'femme', seeks: ['homme'], lat: 47.37, lon: 8.54, city_name: 'Zurich' }, () => 3);

  // Mot de passe faible, doublon sans énumération
  assert.strictEqual((await call('/auth/signup', { email: 'x@example.test', password: 'court1' })).body.error, 'weak_password');
  assert.strictEqual((await call('/auth/signup', { email: 'alex@example.test', password: 'autremotdepasse9' })).status, 201);
  assert.strictEqual((await call('/auth/login', { email: 'alex@example.test', password: 'faux-mot-de-passe1' })).body.error, 'invalid_credentials');

  // Règle 1 : impossible de se réactiver ou de forcer des champs protégés
  await q("UPDATE account_status SET suspended = 1 WHERE user_id = (SELECT id FROM users WHERE email = 'zoe@example.test')");
  await rpc('sync_state', { p: { profile: { ...P, suspended: false, questionnaire_done_at: null } } }, Z.tok);
  const st = await q("SELECT suspended FROM account_status WHERE user_id = (SELECT id FROM users WHERE email = 'zoe@example.test')");
  assert.strictEqual(st[0].suspended, 1);

  // Règle 2 : uniquement pour soi, 1 fois / minute
  let r = await rpc('refresh_my_proposals', { target: 'autre' }, A.tok);
  assert.strictEqual(r.body, 1);
  assert.strictEqual((await rpc('refresh_my_proposals', {}, A.tok)).body, -1);

  r = await rpc('get_proposals', {}, A.tok);
  assert.strictEqual(r.body.length, 1);
  const p = r.body[0];
  assert.strictEqual(p.pseudo, 'Nora');
  assert.ok(p.score >= 50 && p.km > 10 && p.km < 30, JSON.stringify(p));
  assert.strictEqual(p.modules.length, 6);
  assert.ok(!('email' in p));

  // Chat fermé avant le match
  assert.strictEqual((await rpc('send_message', { p_id: p.id, p_body: 'Salut' }, A.tok)).body.error, 'chat_closed');
  assert.deepStrictEqual((await rpc('decide', { p_id: p.id, d: 'accepted' }, A.tok)).body, { id: p.id, matched: false, closed: false });
  assert.deepStrictEqual((await rpc('decide', { p_id: p.id, d: 'accepted' }, N.tok)).body, { id: p.id, matched: true, closed: false });
  r = await rpc('send_message', { p_id: p.id, p_body: '  Salut Nora  ' }, A.tok);
  assert.strictEqual(r.body.body, 'Salut Nora');
  r = await rpc('get_messages', { p_id: p.id, p_after: 0 }, N.tok);
  assert.strictEqual(r.body.length, 1);
  assert.strictEqual(r.body[0].me, false);
  // Zoé (hors proposition) ne lit rien
  assert.strictEqual((await rpc('get_messages', { p_id: p.id, p_after: 0 }, Z.tok)).body.error, 'chat_closed');

  // Règle 3 : refus après match -> chat fermé
  assert.deepStrictEqual((await rpc('decide', { p_id: p.id, d: 'refused' }, N.tok)).body, { id: p.id, matched: false, closed: true });
  assert.strictEqual((await rpc('send_message', { p_id: p.id, p_body: 'Encore là ?' }, A.tok)).body.error, 'chat_closed');
  assert.strictEqual((await rpc('get_proposals', {}, A.tok)).body.length, 0);
  assert.strictEqual((await rpc('decide', { p_id: p.id, d: 'accepted' }, A.tok)).body.error, 'proposal_not_found');

  // Signalement
  assert.strictEqual((await rpc('report_proposal', { p_id: p.id, p_reason: 'nope' }, A.tok)).body.error, 'invalid_reason');
  assert.strictEqual((await rpc('report_proposal', { p_id: p.id, p_reason: 'fake', p_details: 'faux profil' }, A.tok)).status, 200);

  // Règle 5 : consentement sensible
  await rpc('record_consent', { p_purpose: 'sensitive_data', p_scope: null, p_granted: true, p_version: 'v1' }, A.tok);
  await rpc('sync_state', { p: { answers: [[33, 5]] } }, A.tok);
  assert.strictEqual((await q("SELECT value FROM answers a JOIN users u ON u.id = a.user_id WHERE u.email='alex@example.test' AND question_id = 33"))[0].value, 5);
  await rpc('record_consent', { p_purpose: 'sensitive_data', p_scope: null, p_granted: false, p_version: 'v1' }, A.tok);
  assert.strictEqual((await q("SELECT value FROM answers a JOIN users u ON u.id = a.user_id WHERE u.email='alex@example.test' AND question_id = 33"))[0].value, 0);

  // Connecteurs
  await rpc('sync_state', { p: { interests: { spotify: [{ category: 'music', key: 'angele', label: 'Angèle', weight: 2 }] } } }, A.tok);
  assert.deepStrictEqual((await rpc('get_my_state', {}, A.tok)).body.interest_sources, []);
  await rpc('sync_state', { p: { consents: [{ purpose: 'connector', scope: 'spotify', granted: true }], interests: { spotify: [{ category: 'music', key: 'angele', label: 'Angèle', weight: 2 }] } } }, A.tok);
  r = await rpc('get_my_state', {}, A.tok);
  assert.deepStrictEqual(r.body.interest_sources, ['spotify']);
  assert.strictEqual(r.body.answers.length, 180);
  assert.strictEqual(r.body.profile.birth_date, '1994-04-12');
  await rpc('record_consent', { p_purpose: 'connector', p_scope: 'spotify', p_granted: false, p_version: 'v1' }, A.tok);
  assert.deepStrictEqual((await rpc('get_my_state', {}, A.tok)).body.interest_sources, []);

  // Récupération du mot de passe, révocation des sessions
  r = await call('/auth/login', { email: 'nora@example.test', password: 'motdepasse123' });
  const oldRefresh = r.body.refresh_token;
  assert.strictEqual((await call('/auth/recover', { email: 'nora@example.test' })).status, 204);
  assert.strictEqual((await call('/auth/recover', { email: 'inconnu@example.test' })).status, 204);
  r = await call('/auth/reset', { email: 'nora@example.test', code: codes['nora@example.test:reset'], password: 'nouveaumotdepasse7' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual((await call('/auth/refresh', { refresh_token: oldRefresh })).status, 401);
  r = await call('/auth/refresh', { refresh_token: r.body.refresh_token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call('/auth/logout', { refresh_token: r.body.refresh_token }, r.body.access_token)).status, 204);
  assert.strictEqual((await call('/auth/refresh', { refresh_token: r.body.refresh_token })).status, 401);
  assert.strictEqual((await call('/auth/login', { email: 'nora@example.test', password: 'nouveaumotdepasse7' })).status, 200);

  // Sans jeton
  assert.strictEqual((await rpc('get_proposals', {})).body.error, 'not_authenticated');

  // RGPD
  r = await rpc('export_my_data', {}, A.tok);
  assert.strictEqual(r.body.account.email, 'alex@example.test');
  assert.strictEqual(r.body.answers.length, 180);
  await nightly();
  assert.strictEqual((await rpc('delete_my_account', {}, A.tok)).status, 200);
  assert.strictEqual((await q("SELECT COUNT(*) AS n FROM users WHERE email = 'alex@example.test'"))[0].n, 0);
  assert.strictEqual((await rpc('get_my_state', {}, A.tok)).body.error, 'not_authenticated');
});
