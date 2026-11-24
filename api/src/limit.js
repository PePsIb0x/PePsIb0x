'use strict';
// Limiteur en mémoire à fenêtre glissante (une seule instance Node sur Hostinger).
const buckets = new Map();

function hit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

function reset(key) { buckets.delete(key); }

setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) if (!arr.length || now - arr[arr.length - 1] > 3600_000) buckets.delete(k);
}, 600_000).unref();

module.exports = { hit, reset };
