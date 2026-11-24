'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { migrate } = require('./db');
const auth = require('./auth');
const { HANDLERS, nightly } = require('./rpc');
const limit = require('./limit');

for (const k of ['JWT_SECRET', 'DB_USER', 'DB_NAME']) {
  if (!process.env[k]) { console.error(`Variable d'environnement manquante : ${k}`); process.exit(1); }
}
if (process.env.JWT_SECRET.length < 32) { console.error('JWT_SECRET doit faire au moins 32 caractères'); process.exit(1); }

const ORIGINS = (process.env.CORS_ORIGINS || 'https://meet.optima-tools.ch,capacitor://localhost,https://localhost,http://localhost')
  .split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ORIGINS.includes(origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));
app.use(express.json({ limit: '1mb' }));

// Limite générale par IP
app.use((req, _res, next) => {
  if (!limit.hit(`ip:${req.ip}`, 300, 60_000)) {
    const e = new Error('rate_limited'); e.status = 429; e.code = 'rate_limited'; return next(e);
  }
  next();
});

const v1 = express.Router();
v1.get('/health', (_req, res) => res.json({ ok: true, version: 1, db: !!(app.locals.isReady && app.locals.isReady()) }));
v1.use((_req, res, next) => (app.locals.isReady && !app.locals.isReady()
  ? res.status(503).json({ error: 'starting', message: 'Démarrage en cours, réessayez dans un instant' }) : next()));
v1.use('/auth', auth.router);

v1.post('/rpc/:name', auth.requireUser, async (req, res, next) => {
  try {
    const fn = Object.prototype.hasOwnProperty.call(HANDLERS, req.params.name) ? HANDLERS[req.params.name] : null;
    if (!fn) return res.status(404).json({ error: 'not_found', message: 'Appel inconnu' });
    const out = await fn(req.user.id, req.body || {});
    res.json(out === undefined ? null : out);
  } catch (e) { next(e); }
});

app.use('/v1', v1);
app.use((_req, res) => res.status(404).json({ error: 'not_found', message: 'Route inconnue' }));

// Erreurs : {"error": code, "message": texte}
// eslint-disable-next-line no-unused-vars
app.use((e, _req, res, _next) => {
  if (e.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json', message: 'JSON invalide' });
  if (e.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Requête trop volumineuse' });
  const status = e.status && e.status < 600 ? e.status : 500;
  if (status >= 500) console.error(e);
  res.status(status).json({ error: status >= 500 ? 'server_error' : e.code, message: status >= 500 ? 'Erreur serveur' : e.message });
});

// Tâche de nuit (03:15 UTC) : conservation RGPD + recalcul des propositions
function scheduleNightly() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 15));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(async () => {
    try { console.log('nightly: propositions', await nightly()); } catch (e) { console.error('nightly', e); }
    scheduleNightly();
  }, next - now).unref();
}

// Hostinger exige un listen() immédiat au chargement du fichier d'entrée :
// on écoute d'abord, la migration de la base se fait juste après.
let ready = false;
app.locals.isReady = () => ready;

function start() {
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => console.log(`Cruch Finder API sur le port ${port}`));
  migrate().then(() => { ready = true; scheduleNightly(); console.log('Base prête'); })
    .catch((e) => { console.error('Migration impossible', e); });
  return server;
}

module.exports = { app, start, setReady: (v) => { ready = v; } };
