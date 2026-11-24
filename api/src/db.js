'use strict';
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectionLimit: Number(process.env.DB_POOL || 5),
      timezone: 'Z',
      charset: 'utf8mb4',
      supportBigNumbers: true,
      bigNumberStrings: false,
      multipleStatements: false,
    });
    pool.pool.on('connection', (c) => c.query("SET time_zone = '+00:00'"));
  }
  return pool;
}

async function q(sql, params = [], conn) {
  const [rows] = await (conn || getPool()).query(sql, params);
  return rows;
}

async function one(sql, params = [], conn) {
  const rows = await q(sql, params, conn);
  return rows[0] || null;
}

// Exécute fn(conn) dans une transaction
async function tx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

// MariaDB renvoie les colonnes JSON comme du texte, MySQL comme des objets
function json(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return fallback; } }
  if (Buffer.isBuffer(v)) { try { return JSON.parse(v.toString('utf8')); } catch (_) { return fallback; } }
  return v;
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    await q(stmt);
  }
  await seedQuestions();
}

// Questionnaire v3 : data/questions.json (généré depuis seed_v3.sql)
async function seedQuestions() {
  const file = path.join(__dirname, '..', 'data', 'questions.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = data.questions.map((x) => [x.id, x.module_id, x.module_name, x.weight, x.position,
    x.text, x.tag, x.slug, x.mode, x.cross_id, x.sensitive]);
  await tx(async (c) => {
    await q(`INSERT INTO questions (id, module_id, module_name, weight, position, text, tag, slug, mode, cross_id, \`sensitive\`)
             VALUES ? ON DUPLICATE KEY UPDATE module_id = VALUES(module_id), module_name = VALUES(module_name),
             weight = VALUES(weight), position = VALUES(position), text = VALUES(text), tag = VALUES(tag),
             slug = VALUES(slug), mode = VALUES(mode), cross_id = VALUES(cross_id), \`sensitive\` = VALUES(\`sensitive\`)`, [rows], c);
  });
}

module.exports = { getPool, q, one, tx, json, migrate };
