import { config } from './config.js';
import {
  finishRun,
  getMeta,
  nowIso,
  setMeta,
  startRun,
  transaction,
  upsertRoute,
  upsertStop,
} from './db.js';
import {
  normalizeGeoInfo,
  normalizeSchedule,
  normalizeScheduleDay,
  normalizeScoreboardRoutes,
  normalizeStops,
  normalizeVehicles,
  transportFromMType,
} from './normalize.js';
import {
  buildAggregateGeometry,
  buildFirstPassGeometry,
  buildStraightLine,
  splitTrips,
} from './geometry.js';
import {
  fetchGeoInfoMar,
  fetchSchedule,
  fetchScheduleDay,
  fetchScoreboard,
  fetchStops,
  fetchVehicles,
} from './upstream.js';
import { errorMessage, mapLimit } from './util.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function log(...args) {
  console.log('[jobs]', ...args);
}

export async function withRun(db, job, fn) {
  const runId = startRun(db, job);
  const started = Date.now();

  try {
    const stats = (await fn()) || {};
    finishRun(db, runId, 'success', stats);
    log(`${job}: ok`, JSON.stringify(stats), `${Date.now() - started} ms`);
    return stats;
  } catch (error) {
    finishRun(db, runId, 'error', {}, errorMessage(error));
    log(`${job}: error`, errorMessage(error));
    throw error;
  }
}

export async function syncStops(db) {
  const payload = await fetchStops();
  const stops = normalizeStops(payload);
  if (!stops.length) throw new Error('API не вернул остановки');

  const updatedAt = nowIso();

  transaction(db, () => {
    db.exec('UPDATE stops SET active = 0');
    for (const stop of stops) upsertStop(db, stop, updatedAt);
  });

  return { stops: stops.length, updatedAt };
}

export async function syncVehicles(db) {
  const payload = await fetchVehicles();
  const vehicles = normalizeVehicles(payload);
  if (!vehicles.length) throw new Error('API не вернул транспортные средства');

  const updatedAt = nowIso();

  transaction(db, () => {
    const statement = db.prepare(
      `INSERT INTO vehicles (vehicle_id, vehicle_type, gosnum, garnum, model, park_name, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (vehicle_id) DO UPDATE SET
         vehicle_type = excluded.vehicle_type,
         gosnum = excluded.gosnum,
         garnum = excluded.garnum,
         model = excluded.model,
         park_name = excluded.park_name,
         updated_at = excluded.updated_at`,
    );

    for (const vehicle of vehicles) {
      statement.run(
        vehicle.vehicleId,
        vehicle.vehicleType,
        vehicle.gosnum,
        vehicle.garnum,
        vehicle.model,
        vehicle.parkName,
        updatedAt,
      );
    }
  });

  return { vehicles: vehicles.length, updatedAt };
}

export async function discoverRoutes(db) {
  let stops = db.prepare('SELECT stop_id FROM stops WHERE lat IS NOT NULL AND lon IS NOT NULL').all();
  if (!stops.length) {
    log('discoverRoutes: справочник остановок пуст, загружаю /stops');
    await syncStops(db);
    stops = db.prepare('SELECT stop_id FROM stops WHERE lat IS NOT NULL AND lon IS NOT NULL').all();
  }

  if (config.routeDiscoveryLimit > 0) {
    stops = stops.slice(0, config.routeDiscoveryLimit);
  }

  if (!stops.length) throw new Error('Нет остановок для обхода scoreboard');

  let requests = 0;
  let errors = 0;
  const found = new Map();

  const results = await mapLimit(stops, config.syncConcurrency, async (stop) => {
    try {
      const payload = await fetchScoreboard(stop.stop_id);
      requests += 1;
      return normalizeScoreboardRoutes(payload).routes;
    } catch (error) {
      errors += 1;
      return [];
    }
  });

  for (const routes of results) {
    if (!Array.isArray(routes)) continue;
    for (const route of routes) {
      const mtype = transportFromMType(route.mtype);
      if (!mtype) continue;
      const key = `${mtype}|${route.numl}`;
      const current = found.get(key);
      if (!current) {
        found.set(key, {
          mtype,
          numl: route.numl,
          name: route.endStopName || '',
        });
      } else if (!current.name && route.endStopName) {
        current.name = route.endStopName;
      }
    }
  }

  const updatedAt = nowIso();
  transaction(db, () => {
    for (const route of found.values()) {
      upsertRoute(db, route, updatedAt);
    }
  });

  return {
    stopsScanned: stops.length,
    requests,
    errors,
    routes: found.size,
  };
}

function scheduleDirectionsFromResponse(payload) {
  const normalized = normalizeSchedule(payload);
  if (normalized.length) {
    const byDirection = new Map();
    let validFrom = null;
    let validTo = null;

    for (const entry of normalized) {
      validFrom = validFrom || entry.validFrom;
      validTo = validTo || entry.validTo;
      for (const direction of entry.directions) {
        const current = byDirection.get(direction.direction);
        if (!current || direction.stops.length > current.stops.length) {
          byDirection.set(direction.direction, direction);
        }
      }
    }

    return { directions: [...byDirection.values()], validFrom, validTo };
  }

  const dayDirections = normalizeScheduleDay(payload);
  return { directions: dayDirections, validFrom: null, validTo: null };
}

function insertVariantStops(db, variantId, stops) {
  db.prepare('DELETE FROM route_variant_stops WHERE variant_id = ?').run(variantId);
  const statement = db.prepare(
    'INSERT INTO route_variant_stops (variant_id, stop_id, seq) VALUES (?, ?, ?)',
  );
  stops.forEach((stop, index) => statement.run(variantId, stop.stopId, index));
}

function getCurrentGeometry(db, variantId) {
  return db
    .prepare(
      `SELECT g.*
       FROM route_variants v
       JOIN geometry_versions g ON g.id = v.current_geometry_id
       WHERE v.id = ?`,
    )
    .get(variantId);
}

function insertGeometryVersion(db, variantId, result, source, status, confidence) {
  const createdAt = nowIso();
  const info = db
    .prepare(
      `INSERT INTO geometry_versions
         (variant_id, geometry, source, status, confidence, length_m, stats, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      variantId,
      JSON.stringify(result.line),
      source,
      status,
      confidence,
      result.length || 0,
      JSON.stringify(result.stats || {}),
      createdAt,
    );

  const geometryId = Number(info.lastInsertRowid);
  db.prepare('UPDATE route_variants SET current_geometry_id = ?, updated_at = ? WHERE id = ?').run(
    geometryId,
    createdAt,
    variantId,
  );

  return geometryId;
}

function stopsForVariant(db, variantId) {
  return db
    .prepare(
      `SELECT s.stop_id AS stopId, s.name, s.lat, s.lon
       FROM route_variant_stops rs
       JOIN stops s ON s.stop_id = rs.stop_id
       WHERE rs.variant_id = ?
       ORDER BY rs.seq`,
    )
    .all(variantId);
}

async function syncRouteSchedule(db, route) {
  let directions = [];
  let validFrom = null;
  let validTo = null;

  try {
    const schedulePayload = await fetchSchedule(route.mtype, route.numl);
    const parsed = scheduleDirectionsFromResponse(schedulePayload);
    directions = parsed.directions;
    validFrom = parsed.validFrom;
    validTo = parsed.validTo;
  } catch (error) {
    // /schedule может быть недоступен — пробуем /scheduleDay.
  }

  if (!directions.length) {
    const dayPayload = await fetchScheduleDay(route.mtype, route.numl);
    directions = normalizeScheduleDay(dayPayload);
  }

  if (!directions.length) return { variants: 0, placeholders: 0 };

  const stopMap = new Map(
    db
      .prepare('SELECT stop_id AS stopId, name, lat, lon FROM stops WHERE lat IS NOT NULL AND lon IS NOT NULL')
      .all()
      .map((stop) => [stop.stopId, stop]),
  );

  let variants = 0;
  let placeholders = 0;

  for (const direction of directions) {
    const stops = direction.stops.map((stopId) => stopMap.get(stopId)).filter(Boolean);
    if (stops.length < 2) continue;

    const headsign = direction.headsign || stops[stops.length - 1]?.name || '';
    const updatedAt = nowIso();

    const variantId = transaction(db, () => {
      db.prepare(
        `INSERT INTO route_variants
           (route_id, direction, headsign, valid_from, valid_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (route_id, direction) DO UPDATE SET
           headsign = excluded.headsign,
           valid_from = excluded.valid_from,
           valid_to = excluded.valid_to,
           updated_at = excluded.updated_at`,
      ).run(route.id, direction.direction, headsign, validFrom, validTo, updatedAt, updatedAt);

      const row = db
        .prepare('SELECT id FROM route_variants WHERE route_id = ? AND direction = ?')
        .get(route.id, direction.direction);
      const id = Number(row.id);

      insertVariantStops(db, id, stops);
      return id;
    });

    variants += 1;

    const current = getCurrentGeometry(db, variantId);
    if (!current || current.source === 'stops_straight') {
      const straight = buildStraightLine(stops);
      if (straight) {
        transaction(db, () => {
          insertGeometryVersion(
            db,
            variantId,
            {
              ...straight,
              stats: { stops: stops.length, source: 'stops_straight' },
            },
            'stops_straight',
            'placeholder',
            0.1,
          );
        });
        placeholders += 1;
      }
    }
  }

  return { variants, placeholders };
}

export async function syncSchedules(db) {
  const routes = db.prepare('SELECT id, mtype, numl FROM routes WHERE active = 1 ORDER BY id').all();
  if (!routes.length) throw new Error('Нет маршрутов: сначала выполните discoverRoutes');

  let variants = 0;
  let placeholders = 0;
  let errors = 0;

  await mapLimit(routes, config.syncConcurrency, async (route) => {
    try {
      const result = await syncRouteSchedule(db, route);
      variants += result.variants;
      placeholders += result.placeholders;
    } catch (error) {
      errors += 1;
    }
  });

  return {
    routes: routes.length,
    variants,
    placeholders,
    errors,
  };
}

export async function syncOperators(db) {
  const routes = db.prepare('SELECT id, mtype, numl FROM routes WHERE active = 1 ORDER BY id').all();
  if (!routes.length) return { routes: 0, observations: 0 };

  const parks = new Map(
    db
      .prepare('SELECT vehicle_id AS vehicleId, park_name AS parkName FROM vehicles')
      .all()
      .map((row) => [row.vehicleId, row.parkName]),
  );

  let observations = 0;
  const counts = new Map();

  await mapLimit(routes, config.syncConcurrency, async (route) => {
    try {
      const payload = await fetchGeoInfoMar(route.mtype, route.numl);
      const vehicles = normalizeGeoInfo(payload);
      for (const vehicle of vehicles) {
        const parkName = parks.get(vehicle.vehicleId);
        if (!parkName) continue;
        const key = `${route.id}|${parkName}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        observations += 1;
      }
    } catch {
      // Маршрут может быть временно недоступен.
    }
  });

  const seenAt = nowIso();
  transaction(db, () => {
    const statement = db.prepare(
      `INSERT INTO route_operators (route_id, park_name, sample_count, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (route_id, park_name) DO UPDATE SET
         sample_count = route_operators.sample_count + excluded.sample_count,
         last_seen = excluded.last_seen`,
    );

    for (const [key, count] of counts) {
      const [routeId, parkName] = key.split('|');
      statement.run(Number(routeId), parkName, count, seenAt);
    }
  });

  return { routes: routes.length, observations, operators: counts.size };
}

function selectFocusRoutes(db) {
  const focusHoursMs = config.traceFocusHours * 60 * 60_000;
  let focus = null;

  try {
    focus = JSON.parse(getMeta(db, 'trace_focus', 'null'));
  } catch {
    focus = null;
  }

  if (focus && Array.isArray(focus.routeIds) && Date.now() - Number(focus.startedAt) < focusHoursMs) {
    const placeholders = focus.routeIds.map(() => '?').join(',');
    const routes = db
      .prepare(
        `SELECT id, mtype, numl FROM routes
         WHERE active = 1 AND id IN (${placeholders})
         ORDER BY id`,
      )
      .all(...focus.routeIds);
    if (routes.length) return routes;
  }

  let candidates = db
    .prepare(
      `SELECT DISTINCT r.id, r.mtype, r.numl
       FROM routes r
       JOIN route_variants v ON v.route_id = r.id
       LEFT JOIN geometry_versions g ON g.id = v.current_geometry_id
       WHERE r.active = 1 AND (g.id IS NULL OR g.status IN ('placeholder', 'provisional'))
       ORDER BY r.id`,
    )
    .all();

  if (!candidates.length) {
    candidates = db
      .prepare('SELECT id, mtype, numl FROM routes WHERE active = 1 ORDER BY id')
      .all();
  }

  if (!candidates.length) return [];

  const cursor = Number(getMeta(db, 'trace_focus_cursor', '0')) || 0;
  const start = cursor % candidates.length;
  const size = Math.min(config.traceFocusSize, candidates.length);
  const selected = [];

  for (let i = 0; i < size; i += 1) {
    selected.push(candidates[(start + i) % candidates.length]);
  }

  setMeta(db, 'trace_focus', JSON.stringify({ routeIds: selected.map((route) => route.id), startedAt: Date.now() }));
  setMeta(db, 'trace_focus_cursor', (start + size) % candidates.length);

  return selected;
}

export async function collectTraces(db) {
  const routes = selectFocusRoutes(db);
  if (!routes.length) return { routes: 0, samples: 0 };

  let samples = 0;
  let errors = 0;
  const now = Date.now();
  const createdAt = new Date(now).toISOString();

  await mapLimit(routes, config.traceConcurrency, async (route) => {
    try {
      const payload = await fetchGeoInfoMar(route.mtype, route.numl);
      const vehicles = normalizeGeoInfo(payload);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO gps_samples
           (route_id, direction, vehicle_id, lat, lon, vector, ts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      let inserted = 0;
      transaction(db, () => {
        for (const vehicle of vehicles) {
          const info = insert.run(
            route.id,
            vehicle.direction,
            vehicle.vehicleId,
            vehicle.lat,
            vehicle.lon,
            vehicle.vector,
            now,
            createdAt,
          );
          if (info.changes > 0) inserted += 1;
        }
      });
      samples += inserted;
    } catch {
      errors += 1;
    }
  });

  return {
    routes: routes.length,
    samples,
    errors,
    focus: routes.map((route) => `${route.mtype}:${route.numl}`),
  };
}

export async function cleanupTraces(db) {
  const threshold = Date.now() - config.traceRetentionDays * DAY_MS;
  const gps = db.prepare('DELETE FROM gps_samples WHERE ts < ?').run(threshold);
  const runs = db
    .prepare("DELETE FROM ingest_runs WHERE finished_at IS NOT NULL AND finished_at < ?")
    .run(new Date(Date.now() - 90 * DAY_MS).toISOString());

  return {
    gpsDeleted: Number(gps.changes),
    runsDeleted: Number(runs.changes),
    retentionDays: config.traceRetentionDays,
  };
}

function loadTraces(db, routeId, direction, sinceTs) {
  let rows = db
    .prepare(
      `SELECT vehicle_id AS vehicleId, ts, lat, lon, vector
       FROM gps_samples
       WHERE route_id = ? AND direction = ? AND ts >= ?
       ORDER BY vehicle_id, ts
       LIMIT 500000`,
    )
    .all(routeId, direction, sinceTs);

  const byVehicle = new Map();
  for (const row of rows) {
    if (!byVehicle.has(row.vehicleId)) byVehicle.set(row.vehicleId, []);
    byVehicle.get(row.vehicleId).push(row);
  }

  const traces = [];
  for (const [vehicleId, samples] of byVehicle) {
    for (const trip of splitTrips(samples, config.traceTripGapMs)) {
      if (trip.length >= 2) traces.push({ vehicleId, samples: trip });
    }
  }

  return traces;
}

function geometryOptions() {
  return {
    maxCorridorMeters: config.geometryMaxCorridorMeters,
    simplifyMeters: config.geometrySimplifyMeters,
    stopToleranceMeters: config.geometryStopToleranceMeters,
    maxLengthFactor: config.geometryMaxLengthFactor,
  };
}

export async function buildGeometry(db, mode = 'first-pass') {
  const variants =
    mode === 'first-pass'
      ? db
          .prepare(
            `SELECT v.id, v.route_id AS routeId, v.direction, v.headsign,
                    r.mtype, r.numl, g.status AS geometryStatus, g.source AS geometrySource
             FROM route_variants v
             JOIN routes r ON r.id = v.route_id
             LEFT JOIN geometry_versions g ON g.id = v.current_geometry_id
             WHERE g.id IS NULL OR g.status = 'placeholder'
             ORDER BY v.id`,
          )
          .all()
      : db
          .prepare(
            `SELECT v.id, v.route_id AS routeId, v.direction, v.headsign,
                    r.mtype, r.numl, g.status AS geometryStatus, g.source AS geometrySource
             FROM route_variants v
             JOIN routes r ON r.id = v.route_id
             LEFT JOIN geometry_versions g ON g.id = v.current_geometry_id
             ORDER BY v.id`,
          )
          .all();

  if (!variants.length) return { variants: 0, updated: 0 };

  const sinceTs = Date.now() - config.traceRetentionDays * DAY_MS;
  const options = geometryOptions();

  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const results = [];

  for (const variant of variants) {
    try {
      const stops = stopsForVariant(db, variant.id);
      if (stops.length < 2) {
        skipped += 1;
        continue;
      }

      const traces = loadTraces(db, variant.routeId, variant.direction, sinceTs);
      if (!traces.length) {
        skipped += 1;
        continue;
      }

      const variantOptions = {
        ...options,
        allowLoop:
          variant.direction === 2 ||
          (stops.length > 1 && stops[0].stopId === stops[stops.length - 1].stopId),
      };

      if (mode === 'first-pass') {
        const result = buildFirstPassGeometry({
          traces,
          stops,
          options: variantOptions,
        });
        if (!result) {
          skipped += 1;
          continue;
        }

        transaction(db, () => {
          insertGeometryVersion(db, variant.id, result, 'gps_first_pass', 'provisional', 0.45);
        });
        updated += 1;
        results.push({
          route: `${variant.mtype}:${variant.numl}`,
          direction: variant.direction,
          status: 'provisional',
          length: Math.round(result.length),
        });
        continue;
      }

      const result = buildAggregateGeometry({
        traces,
        stops,
        options: variantOptions,
      });
      if (!result) {
        skipped += 1;
        continue;
      }

      const completeTraces = result.stats.completeTraces;
      const coverage = result.coverage;
      let status = null;

      if (completeTraces >= config.geometryMinCompleteTraces && coverage >= 0.65) {
        status = 'stable';
      } else if (completeTraces >= 1 && coverage >= 0.45) {
        status = 'provisional';
      }

      if (!status) {
        skipped += 1;
        continue;
      }

      const confidence = Math.min(0.95, 0.25 + coverage * 0.7);

      transaction(db, () => {
        insertGeometryVersion(db, variant.id, result, 'gps_aggregate', status, confidence);
      });
      updated += 1;
      results.push({
        route: `${variant.mtype}:${variant.numl}`,
        direction: variant.direction,
        status,
        coverage: Number(coverage.toFixed(2)),
        completeTraces,
        length: Math.round(result.length),
      });
    } catch (error) {
      errors += 1;
    }
  }

  return {
    mode,
    variants: variants.length,
    updated,
    skipped,
    errors,
    results: results.slice(0, 50),
  };
}

export const jobRegistry = {
  'sync-stops': syncStops,
  'sync-vehicles': syncVehicles,
  'discover-routes': discoverRoutes,
  'sync-schedules': syncSchedules,
  'sync-operators': syncOperators,
  'collect-traces': collectTraces,
  'cleanup-traces': cleanupTraces,
  'build-geometry-first-pass': (db) => buildGeometry(db, 'first-pass'),
  'build-geometry-full': (db) => buildGeometry(db, 'full'),
};

export async function runJob(db, name) {
  const job = jobRegistry[name];
  if (!job) throw new Error(`Неизвестная задача: ${name}`);

  return withRun(db, name, () => job(db));
}
