import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const schemaPath = new URL('./schema.sql', import.meta.url);

export function openDatabase(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateTrolleybus(db);
  return db;
}

/**
 * Старые базы хранили тип как `trolley`. Переводим на единый `trolleybus`.
 * Если маршрут с таким номером уже есть, старую запись оставляем неактивной.
 */
function migrateTrolleybus(db) {
  const rows = db.prepare("SELECT id, numl FROM routes WHERE mtype = 'trolley'").all();
  if (!rows.length) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const existing = db
        .prepare("SELECT id FROM routes WHERE mtype = 'trolleybus' AND numl = ?")
        .get(row.numl);

      if (existing) {
        db.prepare('UPDATE routes SET active = 0 WHERE id = ?').run(row.id);
      } else {
        db.prepare("UPDATE routes SET mtype = 'trolleybus' WHERE id = ?").run(row.id);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}

export function startRun(db, job) {
  const result = db
    .prepare('INSERT INTO ingest_runs (job, started_at, status) VALUES (?, ?, ?)')
    .run(job, nowIso(), 'running');
  return Number(result.lastInsertRowid);
}

export function finishRun(db, runId, status, stats = {}, error = null) {
  db.prepare(
    `UPDATE ingest_runs
     SET finished_at = ?, status = ?, stats = ?, error = ?
     WHERE id = ?`,
  ).run(nowIso(), status, JSON.stringify(stats), error ? String(error) : null, runId);
}

export function upsertStop(db, stop, updatedAt = nowIso()) {
  db.prepare(
    `INSERT INTO stops
       (stop_id, name, name_ru, name_by, name_en, lat, lon, vector, mspsid, active, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (stop_id) DO UPDATE SET
       name = excluded.name,
       name_ru = excluded.name_ru,
       name_by = excluded.name_by,
       name_en = excluded.name_en,
       lat = excluded.lat,
       lon = excluded.lon,
       vector = excluded.vector,
       mspsid = excluded.mspsid,
       active = 1,
       updated_at = excluded.updated_at`,
  ).run(
    stop.stopId,
    stop.name || '',
    stop.nameRu || '',
    stop.nameBy || '',
    stop.nameEn || '',
    Number.isFinite(stop.lat) ? stop.lat : null,
    Number.isFinite(stop.lon) ? stop.lon : null,
    Number.isFinite(stop.vector) ? stop.vector : 0,
    stop.mspsid || '',
    1,
    updatedAt,
  );
}

export function upsertRoute(db, { mtype, numl, name = '' }, updatedAt = nowIso()) {
  db.prepare(
    `INSERT INTO routes (mtype, numl, name, active, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (mtype, numl) DO UPDATE SET
       name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE routes.name END,
       active = 1,
       updated_at = excluded.updated_at`,
  ).run(mtype, numl, name, updatedAt, updatedAt);

  return db
    .prepare('SELECT * FROM routes WHERE mtype = ? AND numl = ?')
    .get(mtype, numl);
}
