'use strict';
// Vérification des id_token Google et Apple (signature JWKS, émetteur, audience, expiration, nonce).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { err } = require('./util');

const PROVIDERS = {
  google: {
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['accounts.google.com', 'https://accounts.google.com'],
    audiences: () => list(process.env.GOOGLE_CLIENT_IDS),
  },
  apple: {
    jwks: 'https://appleid.apple.com/auth/keys',
    issuers: ['https://appleid.apple.com'],
    audiences: () => list(process.env.APPLE_CLIENT_IDS),
  },
};

function list(v) { return String(v || '').split(',').map((s) => s.trim()).filter(Boolean); }

const cache = {};   // provider -> {at, keys: Map(kid -> KeyObject)}

async function keysFor(provider, force) {
  const c = cache[provider];
  if (c && !force && Date.now() - c.at < 3600_000) return c.keys;
  const r = await fetch(PROVIDERS[provider].jwks);
  if (!r.ok) throw err(503, 'server_error', 'Clés du fournisseur indisponibles');
  const { keys } = await r.json();
  const map = new Map(keys.map((k) => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
  cache[provider] = { at: Date.now(), keys: map };
  return map;
}

const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Renvoie {sub, email, email_verified, name}
async function verify(provider, idToken, nonce) {
  const p = PROVIDERS[provider];
  const audience = p.audiences();
  if (!audience.length) throw err(503, 'provider_not_configured', `Connexion ${provider} pas encore configurée`);
  if (typeof idToken !== 'string' || idToken.length > 8192) throw err(401, 'invalid_token');
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) throw err(401, 'invalid_token');
  let key = (await keysFor(provider)).get(decoded.header.kid);
  if (!key) key = (await keysFor(provider, true)).get(decoded.header.kid);   // rotation des clés
  if (!key) throw err(401, 'invalid_token');
  let c;
  try {
    c = jwt.verify(idToken, key, { algorithms: ['RS256'], issuer: p.issuers, audience, clockTolerance: 60 });
  } catch (_) { throw err(401, 'invalid_token'); }
  if (!c.sub) throw err(401, 'invalid_token');
  if (provider === 'google' && nonce !== undefined && nonce !== null && c.nonce !== nonce) throw err(401, 'invalid_token');
  if (provider === 'apple') {
    if (typeof nonce !== 'string' || !nonce || c.nonce !== sha256hex(nonce)) throw err(401, 'invalid_token');
  }
  const verified = c.email_verified === true || c.email_verified === 'true';
  return { sub: String(c.sub), email: c.email ? String(c.email).toLowerCase() : null, email_verified: verified };
}

module.exports = { verify, _setKeys: (provider, map) => { cache[provider] = { at: Date.now() + 1e12, keys: map }; } };
