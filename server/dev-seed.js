/**
 * Генерирует синтетический маршрут и GPS-треки для проверки построения линии
 * без внешнего API. Запуск:
 *   DB_FILE=./data/dev-seed.db node server/dev-seed.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { openDatabase, nowIso, transaction, upsertRoute, upsertStop } from './db.js';
import { buildStraightLine, haversineMeters, lineLengthMeters } from './geometry.js';
import { buildGeometry } from './jobs.js';

const dbFile = process.env.DB_FILE || path.join(config.dataDir, 'dev-seed.db');
for (const suffix of ['', '-wal', '-shm']) {
  try {
    fs.rmSync(`${dbFile}${suffix}`);
  } catch {
    // ignore
  }
}

const db = openDatabase(dbFile);
const updatedAt = nowIso();

const stopCount = 9;
const stops = [];

for (let i = 0; i < stopCount; i += 1) {
  stops.push({
    stopId: 9000 + i,
    name: `Тестовая ${i + 1}`,
    nameRu: `Тестовая ${i + 1}`,
    lat: 53.9 + Math.sin(i * 0.7) * 0.012,
    lon: 27.5 + i * 0.012,
    vector: 0,
    mspsid: '',
  });
}

transaction(db, () => {
  for (const stop of stops) upsertStop(db, stop, updatedAt);
});

const route = upsertRoute(db, { mtype: 'bus', numl: 'T1', name: 'Тестовый маршрут' }, updatedAt);

const variantId = transaction(db, () => {
  db.prepare(
    `INSERT INTO route_variants
       (route_id, direction, headsign, created_at, updated_at)
     VALUES (?, 0, 'Тестовая 9', ?, ?)`,
  ).run(route.id, updatedAt, updatedAt);

  const id = Number(
    db.prepare('SELECT id FROM route_variants WHERE route_id = ? AND direction = 0').get(route.id).id,
  );

  const insert = db.prepare(
    'INSERT INTO route_variant_stops (variant_id, stop_id, seq) VALUES (?, ?, ?)',
  );
  stops.forEach((stop, index) => insert.run(id, stop.stopId, index));

  return id;
});

const straight = buildStraightLine(stops);
const placeholderId = transaction(db, () => {
  const info = db
    .prepare(
      `INSERT INTO geometry_versions
         (variant_id, geometry, source, status, confidence, length_m, stats, created_at)
       VALUES (?, ?, 'stops_straight', 'placeholder', 0.1, ?, ?, ?)`,
    )
    .run(
      variantId,
      JSON.stringify(straight.line),
      straight.length,
      JSON.stringify({ stops: stops.length }),
      updatedAt,
    );
  const id = Number(info.lastInsertRowid);
  db.prepare('UPDATE route_variants SET current_geometry_id = ? WHERE id = ?').run(id, variantId);
  return id;
});

function bezier(a, control, b, t) {
  const mt = 1 - t;
  return [
    mt * mt * a[0] + 2 * mt * t * control[0] + t * t * b[0],
    mt * mt * a[1] + 2 * mt * t * control[1] + t * t * b[1],
  ];
}

function curvedPoint(a, b, t, side = 1) {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy) || 1;
  const curve = Math.min(0.004, length * 0.22) * side;
  const control = [mx - (dy / length) * curve, my + (dx / length) * curve];
  return bezier(a, control, b, t);
}

let ts = Date.now() - 2 * 60 * 60_000;
let inserted = 0;

for (let vehicle = 1; vehicle <= 5; vehicle += 1) {
  const noise = 0.000025;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO gps_samples
       (route_id, direction, vehicle_id, lat, lon, vector, ts, created_at)
     VALUES (?, 0, ?, ?, ?, 0, ?, ?)`,
  );

  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = [stops[i].lon, stops[i].lat];
    const b = [stops[i + 1].lon, stops[i + 1].lat];
    const steps = 12;

    for (let step = 0; step <= steps; step += 1) {
      if (i > 0 && step === 0) continue;
      const t = step / steps;
      const point = curvedPoint(a, b, t, vehicle % 2 === 0 ? -1 : 1);
      const lat = point[1] + (Math.sin(inserted * 1.7) * noise);
      const lon = point[0] + (Math.cos(inserted * 2.1) * noise);

      insert.run(route.id, 700000 + vehicle, lat, lon, ts, nowIso());
      inserted += 1;
      ts += 25_000;
    }
  }

  ts += 20 * 60_000;
}

const firstPass = await buildGeometry(db, 'first-pass');
const full = await buildGeometry(db, 'full');

const current = db
  .prepare(
    `SELECT g.* FROM route_variants v
     JOIN geometry_versions g ON g.id = v.current_geometry_id
     WHERE v.id = ?`,
  )
  .get(variantId);

const line = JSON.parse(current.geometry);
const length = lineLengthMeters(line);
const stopLength = stops.reduce(
  (sum, stop, index) =>
    index === 0 ? 0 : sum + haversineMeters([stops[index - 1].lon, stops[index - 1].lat], [stop.lon, stop.lat]),
  0,
);

console.log(
  JSON.stringify(
    {
      database: dbFile,
      placeholderLength: Math.round(straight.length),
      stopPolylineLength: Math.round(stopLength),
      firstPass,
      full,
      current: {
        id: current.id,
        source: current.source,
        status: current.status,
        length: Math.round(length),
        points: line.length,
        ratioToStraight: Number((length / stopLength).toFixed(2)),
      },
    },
    null,
    2,
  ),
);

db.close();
