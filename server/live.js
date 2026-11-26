import { config } from './config.js';
import { normalizeGeoInfo } from './normalize.js';
import { fetchGeoInfoMar } from './upstream.js';
import { mapLimit } from './util.js';

const TRANSPORTS = ['bus', 'trolleybus', 'tram'];
const snapshots = new Map();
const attempts = new Map();
const cooldowns = new Map();
let timer = null;
let ticking = false;

function log(...args) {
  console.log('[live]', ...args);
}

async function refreshTransport(db, transport) {
  if (attempts.has(transport)) return attempts.get(transport);

  const attempt = (async () => {
    const cooldownUntil = cooldowns.get(transport) || 0;
    if (Date.now() < cooldownUntil) {
      return snapshots.get(transport) || emptySnapshot(transport);
    }

    const routes = db
      .prepare('SELECT id, mtype, numl FROM routes WHERE active = 1 AND mtype = ? ORDER BY id')
      .all(transport);

    if (!routes.length) {
      const snapshot = emptySnapshot(transport);
      snapshots.set(transport, snapshot);
      return snapshot;
    }

    const previous = snapshots.get(transport)?.vehicles || [];
    const previousByRoute = new Map();
    for (const vehicle of previous) {
      if (!previousByRoute.has(vehicle.route)) previousByRoute.set(vehicle.route, []);
      previousByRoute.get(vehicle.route).push(vehicle);
    }

    const vehicles = [];
    const succeeded = new Set();
    let errors = 0;
    let successes = 0;
    let failures = 0;
    let aborted = false;

    await mapLimit(routes, config.liveConcurrency, async (route) => {
      if (aborted) {
        errors += 1;
        return;
      }

      try {
        const payload = await fetchGeoInfoMar(route.mtype, route.numl, {
          timeoutMs: config.liveRequestTimeoutMs,
        });
        const list = normalizeGeoInfo(payload);
        succeeded.add(route.numl);
        successes += 1;

        for (const vehicle of list) {
          vehicles.push({
            ...vehicle,
            route: route.numl,
            routeId: route.id,
            mtype: route.mtype,
          });
        }
      } catch {
        errors += 1;
        failures += 1;

        // Если API массово недоступен, не ждём таймауты по всем маршрутам.
        if (successes === 0 && failures >= 6) aborted = true;
      }
    });

    for (const route of routes) {
      if (succeeded.has(route.numl)) continue;
      const stale = previousByRoute.get(route.numl);
      if (stale) vehicles.push(...stale);
    }

    const unique = new Map();
    for (const vehicle of vehicles) unique.set(String(vehicle.vehicleId), vehicle);

    const list = enrichWithVehicleInfo(db, [...unique.values()]);

    const now = Date.now();
    const allFailed = errors === routes.length;

    if (allFailed) {
      cooldowns.set(transport, now + 5 * 60_000);
    } else {
      cooldowns.delete(transport);
    }

    const snapshot = {
      transport,
      updatedAt: new Date(now).toISOString(),
      updatedAtMs: now,
      routes: routes.length,
      vehicles: list,
      errors,
      stale: errors > 0,
    };

    snapshots.set(transport, snapshot);
    return snapshot;
  })().finally(() => attempts.delete(transport));

  attempts.set(transport, attempt);
  return attempt;
}

/**
 * Дополняет live-снимок справочными данными ТС из SQLite
 * (госномер, модель, парк), чтобы список «Машины на маршруте»
 * не делал отдельный запрос на каждую машину.
 */
function enrichWithVehicleInfo(db, vehicles) {
  if (!vehicles.length) return vehicles;

  const ids = [...new Set(vehicles.map((vehicle) => Number(vehicle.vehicleId)))].filter(
    (id) => Number.isFinite(id),
  );
  if (!ids.length) return vehicles;

  const byId = new Map();
  const chunkSize = 400;

  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT vehicle_id, gosnum, garnum, model, park_name
           FROM vehicles
          WHERE vehicle_id IN (${placeholders})`,
      )
      .all(...chunk);

    for (const row of rows) byId.set(Number(row.vehicle_id), row);
  }

  for (const vehicle of vehicles) {
    const info = byId.get(Number(vehicle.vehicleId));
    if (!info) continue;

    vehicle.gosnum = info.gosnum || '';
    vehicle.garnum = info.garnum ?? null;
    vehicle.model = info.model || '';
    vehicle.parkName = info.park_name || '';
  }

  return vehicles;
}

function emptySnapshot(transport) {
  const now = Date.now();
  return {
    transport,
    updatedAt: new Date(now).toISOString(),
    updatedAtMs: now,
    routes: 0,
    vehicles: [],
    errors: 0,
    stale: false,
  };
}

async function tick(db) {
  if (ticking) return;
  ticking = true;

  try {
    for (const transport of TRANSPORTS) {
      await refreshTransport(db, transport);
    }
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  } finally {
    ticking = false;
  }
}

export function startLivePoller(db) {
  if (!config.liveEnabled) {
    log('опрос транспорта отключён (LIVE_ENABLED=false)');
    return;
  }

  tick(db).catch(() => {});
  timer = setInterval(() => {
    tick(db).catch(() => {});
  }, config.liveRefreshMs);
  timer.unref?.();

  log(`опрос всех маршрутов включён, интервал ${config.liveRefreshMs} мс`);
}

export function stopLivePoller() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function getLiveSnapshot(db, transport) {
  const snapshot = snapshots.get(transport);
  const fresh =
    snapshot &&
    snapshot.routes > 0 &&
    Date.now() - snapshot.updatedAtMs < config.liveRefreshMs * 1.5;

  if (fresh) return Promise.resolve(snapshot);
  return refreshTransport(db, transport);
}

export async function getAllLiveSnapshot(db) {
  const snapshotsList = await Promise.all(
    TRANSPORTS.map((transport) => getLiveSnapshot(db, transport)),
  );

  const unique = new Map();
  for (const snapshot of snapshotsList) {
    for (const vehicle of snapshot.vehicles) {
      unique.set(String(vehicle.vehicleId), vehicle);
    }
  }

  const updatedAtMs = Math.max(
    0,
    ...snapshotsList.map((snapshot) => snapshot.updatedAtMs || 0),
  );
  const now = updatedAtMs || Date.now();

  return {
    transport: 'all',
    updatedAt: new Date(now).toISOString(),
    updatedAtMs: now,
    routes: snapshotsList.reduce((sum, snapshot) => sum + (snapshot.routes || 0), 0),
    vehicles: [...unique.values()],
    errors: snapshotsList.reduce((sum, snapshot) => sum + (snapshot.errors || 0), 0),
    stale: snapshotsList.some((snapshot) => snapshot.stale),
  };
}

export function getLiveSummary() {
  return TRANSPORTS.map((transport) => {
    const snapshot = snapshots.get(transport);
    return {
      transport,
      vehicles: snapshot?.vehicles.length || 0,
      routes: snapshot?.routes || 0,
      errors: snapshot?.errors || 0,
      stale: snapshot?.stale || false,
      updatedAt: snapshot?.updatedAt || null,
    };
  });
}
