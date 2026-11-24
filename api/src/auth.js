'use strict';
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { q, one, tx } = require('./db');
const { err, sha256, codeHash, randomCode, randomToken, normEmail } = require('./util');
const { sendCode } = require('./mail');
const limit = require('./limit');
const oidc = require('./oidc');

const ACCESS_TTL = 900;                 // 15 min
const REFRESH_DAYS = 30;
const CODE_TTL_MIN = 60;
const CODE_MAX_ATTEMPTS = 5;
const BCRYPT_COST = 12;
let DUMMY;
const dummyHash = () => (DUMMY = DUMMY || bcrypt.hashSync('dummy-password-0', BCRYPT_COST));

function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 10 || Buffer.byteLength(p, 'utf8') > 72
      || !/\p{L}/u.test(p) || !/\d/.test(p)) {
    throw err(400, 'weak_password', 'Le mot de passe doit faire 10 à 72 caractères, avec au moins une lettre et un chiffre.');
  }
}

function signAccess(user) {
  return jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TTL, issuer: 'cruch-finder' });
}

async function issueTokens(user, conn) {
  const refresh = randomToken();
  await q(`INSERT INTO refresh_tokens (token_hash, user_id, expires_at)
           VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL ${REFRESH_DAYS} DAY)`, [sha256(refresh), user.id], conn);
  await q('UPDATE users SET last_sign_in_at = UTC_TIMESTAMP() WHERE id = ?', [user.id], conn);
  return { access_token: signAccess(user), refresh_token: refresh, expires_in: ACCESS_TTL,
    user: { id: user.id, email: user.email } };
}

// Envoi d'un code : 3 envois / heure / e-mail (signup, resend, recover confondus)
async function newCode(user, kind, lang) {
  if (!limit.hit(`code:${user.email}`, 3, 3600_000)) throw err(429, 'rate_limited', 'Trop de codes envoyés. Réessayez plus tard.');
  const code = randomCode();
  await tx(async (c) => {
    await q('UPDATE auth_codes SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND kind = ? AND used_at IS NULL', [user.id, kind], c);
    await q(`INSERT INTO auth_codes (user_id, kind, code_hash, expires_at)
             VALUES (?, ?, ?, UTC_TIMESTAMP() + INTERVAL ${CODE_TTL_MIN} MINUTE)`, [user.id, kind, codeHash(user.id, kind, code)], c);
  });
  await sendCode(user.email, kind, code, lang);
}

// Vérifie un code (5 essais, 1 h, usage unique). Renvoie true si correct.
async function consumeCode(user, kind, code, conn) {
  const row = await one(`SELECT * FROM auth_codes WHERE user_id = ? AND kind = ? AND used_at IS NULL
                         AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1 FOR UPDATE`, [user.id, kind], conn);
  if (!row || row.attempts >= CODE_MAX_ATTEMPTS) throw err(400, 'otp_expired', 'Code expiré ou invalide. Demandez-en un nouveau.');
  const expected = Buffer.from(row.code_hash, 'hex');
  const given = Buffer.from(codeHash(user.id, kind, String(code || '').trim()), 'hex');
  if (!crypto.timingSafeEqual(expected, given)) {
    await q('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?', [row.id], conn);
    return false;
  }
  await q('UPDATE auth_codes SET used_at = UTC_TIMESTAMP() WHERE id = ?', [row.id], conn);
  return true;
}

const userByEmail = (email, conn) => one('SELECT * FROM users WHERE email = ?', [email], conn);
const langOf = (req) => (String(req.body.lang || req.get('accept-language') || 'fr').slice(0, 2).toLowerCase());

// Middleware Bearer
async function requireUser(req, _res, next) {
  try {
    const h = req.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) throw err(401, 'not_authenticated');
    let payload;
    try {
      payload = jwt.verify(m[1], process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'cruch-finder' });
    } catch (_) { throw err(401, 'not_authenticated'); }
    const user = await one('SELECT id, email, email_verified_at FROM users WHERE id = ?', [payload.sub]);
    if (!user || !user.email_verified_at) throw err(401, 'not_authenticated');
    req.user = user;
    next();
  } catch (e) { next(e); }
}

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

router.post('/signup', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  if (!email) throw err(400, 'invalid_email', 'Adresse e-mail invalide.');
  checkPassword(req.body.password);
  let user = await userByEmail(email);
  if (user && user.email_verified_at) {
    // Pas d'énumération : même réponse, aucun code envoyé
    return res.status(201).json({ needsVerification: true });
  }
  const hash = await bcrypt.hash(req.body.password, BCRYPT_COST);
  if (user) {
    await q('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
  } else {
    user = { id: crypto.randomUUID(), email };
    await tx(async (c) => {
      await q('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', [user.id, email, hash], c);
      await q('INSERT INTO account_status (user_id) VALUES (?)', [user.id], c);
    });
  }
  try { await newCode(user, 'verify', langOf(req)); } catch (e) { if (e.code !== 'rate_limited') throw e; }
  res.status(201).json({ needsVerification: true });
}));

router.post('/verify', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  if (!email || !limit.hit(`verify:${email}`, 10, 900_000)) throw err(429, 'rate_limited');
  const user = await userByEmail(email);
  if (!user) throw err(400, 'otp_expired', 'Code expiré ou invalide.');
  const tokens = await tx(async (c) => {
    const ok = await consumeCode(user, 'verify', req.body.code, c);
    if (!ok) return null;
    await q('UPDATE users SET email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP()) WHERE id = ?', [user.id], c);
    return issueTokens(user, c);
  });
  if (!tokens) throw err(400, 'otp_expired', 'Code incorrect.');
  res.json(tokens);
}));

router.post('/resend', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  if (email) {
    const user = await userByEmail(email);
    if (user && !user.email_verified_at) await newCode(user, 'verify', langOf(req));
  }
  res.status(204).end();
}));

router.post('/login', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  const key = `login:${req.ip}:${email}`;
  if (!limit.hit(key, 5, 900_000)) throw err(429, 'rate_limited', 'Trop de tentatives. Réessayez dans 15 minutes.');
  const user = email && await userByEmail(email);
  const ok = user && typeof req.body.password === 'string'
    && await bcrypt.compare(req.body.password, user.password_hash);
  if (!ok) {
    if (!user) await bcrypt.compare('x', dummyHash()); // temps constant, pas d'énumération
    throw err(401, 'invalid_credentials', 'E-mail ou mot de passe incorrect.');
  }
  if (!user.email_verified_at) throw err(403, 'email_not_confirmed', 'Confirmez votre e-mail avec le code reçu.');
  limit.reset(key);
  res.json(await issueTokens(user));
}));

router.post('/refresh', wrap(async (req, res) => {
  const t = req.body.refresh_token;
  if (typeof t !== 'string' || !t) throw err(401, 'not_authenticated');
  const tokens = await tx(async (c) => {
    const row = await one(`SELECT r.*, u.email, u.email_verified_at FROM refresh_tokens r JOIN users u ON u.id = r.user_id
                           WHERE r.token_hash = ? FOR UPDATE`, [sha256(t)], c);
    if (!row || row.expires_at < new Date() || !row.email_verified_at) return null;
    if (row.revoked_at) return null;
    await q('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE token_hash = ?', [row.token_hash], c);
    return issueTokens({ id: row.user_id, email: row.email }, c);
  });
  if (!tokens) throw err(401, 'not_authenticated');
  res.json(tokens);
}));

router.post('/recover', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  if (email) {
    const user = await userByEmail(email);
    if (user) { try { await newCode(user, 'reset', langOf(req)); } catch (e) { if (e.code !== 'rate_limited') throw e; } }
  }
  res.status(204).end();
}));

router.post('/reset', wrap(async (req, res) => {
  const email = normEmail(req.body.email);
  if (!email || !limit.hit(`reset:${email}`, 10, 900_000)) throw err(429, 'rate_limited');
  checkPassword(req.body.password);
  const user = await userByEmail(email);
  if (!user) throw err(400, 'otp_expired', 'Code expiré ou invalide.');
  const hash = await bcrypt.hash(req.body.password, BCRYPT_COST);
  const tokens = await tx(async (c) => {
    const ok = await consumeCode(user, 'reset', req.body.code, c);
    if (!ok) return null;
    await q(`UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, UTC_TIMESTAMP())
             WHERE id = ?`, [hash, user.id], c);
    await q('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [user.id], c);
    return issueTokens(user, c);
  });
  if (!tokens) throw err(400, 'otp_expired', 'Code incorrect.');
  res.json(tokens);
}));

router.post('/logout', requireUser, wrap(async (req, res) => {
  const t = req.body.refresh_token;
  if (typeof t === 'string' && t) {
    await q('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL',
      [sha256(t), req.user.id]);
  }
  res.status(204).end();
}));

// Connexion Google / Apple : (provider, sub) -> compte ; sinon rattachement par e-mail vérifié ; sinon création
async function socialLogin(provider, req) {
  if (!limit.hit(`social:${req.ip}`, 30, 900_000)) throw err(429, 'rate_limited');
  const id = await oidc.verify(provider, req.body.id_token, req.body.nonce);
  return tx(async (c) => {
    const known = await one(`SELECT u.id, u.email FROM auth_identities i JOIN users u ON u.id = i.user_id
                             WHERE i.provider = ? AND i.sub = ? FOR UPDATE`, [provider, id.sub], c);
    if (known) {
      await q('UPDATE auth_identities SET last_used_at = UTC_TIMESTAMP() WHERE provider = ? AND sub = ?', [provider, id.sub], c);
      return issueTokens(known, c);
    }
    if (!id.email || !id.email_verified) throw err(403, 'email_not_verified', 'Adresse e-mail non vérifiée par le fournisseur.');
    let user = await one('SELECT * FROM users WHERE email = ? FOR UPDATE', [id.email], c);
    if (user && !user.email_verified_at) {
      // Compte local jamais confirmé : son mot de passe a pu être choisi par un tiers, on l'invalide
      await q(`UPDATE users SET email_verified_at = UTC_TIMESTAMP(), password_hash = ? WHERE id = ?`,
        [await bcrypt.hash(randomToken(), 10), user.id], c);
      await q('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [user.id], c);
    }
    if (!user) {
      user = { id: crypto.randomUUID(), email: id.email };
      await q(`INSERT INTO users (id, email, password_hash, email_verified_at) VALUES (?, ?, ?, UTC_TIMESTAMP())`,
        [user.id, id.email, await bcrypt.hash(randomToken(), 10)], c);
      await q('INSERT INTO account_status (user_id) VALUES (?)', [user.id], c);
    }
    await q(`INSERT INTO auth_identities (provider, sub, user_id, email, last_used_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())`,
      [provider, id.sub, user.id, id.email], c);
    return issueTokens(user, c);
  });
}

router.post('/google', wrap(async (req, res) => res.json(await socialLogin('google', req))));
router.post('/apple', wrap(async (req, res) => res.json(await socialLogin('apple', req))));

module.exports = { router, requireUser, checkPassword };
