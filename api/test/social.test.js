'use strict';
// Connexion Google / Apple avec des clés de test locales. Nécessite DB_* comme e2e.
const test = require('node:test');
const assert = require('node:assert');
if (!process.env.DB_NAME) { test('social (ignoré : DB_NAME absent)', { skip: true }, () => {}); return; }
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
process.env.GOOGLE_CLIENT_IDS = 'web-client.apps.googleusercontent.com,android-client';
process.env.APPLE_CLIENT_IDS = 'ch.optimatools.cruchfinder';
const { app, setReady } = require('../src/server');
const { migrate, q, getPool } = require('../src/db');
const oidc = require('../src/oidc');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
oidc._setKeys('google', new Map([['k1', publicKey]]));
oidc._setKeys('apple', new Map([['a1', publicKey]]));
const tok = (claims, kid = 'k1', key = privateKey) => jwt.sign(claims, key, { algorithm: 'RS256', keyid: kid, expiresIn: 300 });

test('Google et Apple', async (t) => {
  await migrate(); setReady(true);
  await q("DELETE FROM users WHERE email IN ('g@example.test','relay@privaterelay.appleid.com','local@example.test')");
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  t.after(async () => { srv.close(); await getPool().end().catch(() => {}); });
  const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };

  const g = { iss: 'https://accounts.google.com', aud: 'web-client.apps.googleusercontent.com', sub: 'g-123', email: 'G@example.test', email_verified: true };
  let r = await post('/auth/google', { id_token: tok(g) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.user.email, 'g@example.test');
  const uid = r.body.user.id;
  r = await post('/auth/google', { id_token: tok({ ...g, email: 'changed@example.test' }) });
  assert.strictEqual(r.body.user.id, uid);                                   // retrouvé par sub
  assert.strictEqual((await post('/auth/google', { id_token: tok({ ...g, aud: 'autre' }) })).body.error, 'invalid_token');
  assert.strictEqual((await post('/auth/google', { id_token: tok(g, 'k1', other.privateKey) })).body.error, 'invalid_token');
  assert.strictEqual((await post('/auth/google', { id_token: tok({ ...g, iss: 'evil' }) })).body.error, 'invalid_token');
  assert.strictEqual((await post('/auth/google', { id_token: tok({ ...g, sub: 'g-new', email_verified: false }) })).body.error, 'email_not_verified');
  assert.strictEqual((await post('/auth/google', { id_token: tok({ ...g, nonce: 'abc' }), nonce: 'xyz' })).body.error, 'invalid_token');

  // Apple : nonce = SHA-256 hex
  const nonce = 'n0nce-' + Math.random();
  const a = { iss: 'https://appleid.apple.com', aud: 'ch.optimatools.cruchfinder', sub: 'a-1', email: 'relay@privaterelay.appleid.com', email_verified: 'true',
    nonce: crypto.createHash('sha256').update(nonce).digest('hex') };
  assert.strictEqual((await post('/auth/apple', { id_token: tok(a, 'a1'), nonce: 'mauvais' })).body.error, 'invalid_token');
  r = await post('/auth/apple', { id_token: tok(a, 'a1'), nonce });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  // Rattachement à un compte local non confirmé : le mot de passe d'un tiers est invalidé
  await post('/auth/signup', { email: 'local@example.test', password: 'motdepasse123' });
  r = await post('/auth/google', { id_token: tok({ ...g, sub: 'g-local', email: 'local@example.test' }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await post('/auth/login', { email: 'local@example.test', password: 'motdepasse123' })).body.error, 'invalid_credentials');

  // Effacement : les identités partent avec le compte
  const t2 = r.body.access_token;
  const d = await fetch(base + '/rpc/delete_my_account', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t2 }, body: '{}' });
  assert.strictEqual(d.status, 200);
  assert.strictEqual((await q("SELECT COUNT(*) AS n FROM auth_identities WHERE sub = 'g-local'"))[0].n, 0);
});
