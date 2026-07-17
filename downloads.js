/**
 * In-memory registry of finished clone zips that are waiting to be
 * downloaded. Nothing is served from a public folder — a zip lives in a
 * temp file, is handed out exactly once through a one-time id, and is
 * deleted the moment the download finishes (or after it expires unused).
 *
 * This is what keeps clones from being persisted on the server.
 */

const fs = require('fs');

const pending = new Map(); // id -> { zipPath, filename, timer }
const TTL_MS = 15 * 60 * 1000; // drop undownloaded zips after 15 minutes

function remove(id) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  fs.rm(entry.zipPath, { force: true }, () => {});
}

function register(id, zipPath, filename) {
  const timer = setTimeout(() => remove(id), TTL_MS);
  if (timer.unref) timer.unref();
  pending.set(id, { zipPath, filename, timer });
}

function get(id) {
  return pending.get(id);
}

module.exports = { register, get, remove };
