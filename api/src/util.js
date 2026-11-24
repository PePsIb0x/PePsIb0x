'use strict';
const crypto = require('crypto');

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.name = 'ApiError';
  }
}

const err = (status, code, message) => new ApiError(status, code, message);

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Hash d'un code à 6 chiffres, lié à l'utilisateur et poivré par un secret serveur
function codeHash(userId, kind, code) {
  return crypto.createHmac('sha256', process.env.CODE_PEPPER || process.env.JWT_SECRET)
    .update(`${userId}:${kind}:${code}`).digest('hex');
}

function randomCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function normEmail(e) {
  if (typeof e !== 'string') return null;
  const v = e.trim().toLowerCase();
  if (v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return null;
  return v;
}

function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

module.exports = { ApiError, err, sha256, codeHash, randomCode, randomToken, normEmail, iso };
