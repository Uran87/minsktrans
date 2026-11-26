import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { jobRegistry, runJob } from './jobs.js';
import { getLiveSnapshot, getAllLiveSnapshot, getLiveSummary, startLivePoller, stopLivePoller } from './live.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { errorMessage } from './util.js';

const startedAt = Date.now();
const liveCache = new Map();

function log(...args) {
  console.log('[api]', ...args);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function parseDirection(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function routeList(db, url) {
  const transport = (url.searchParams.get('transport') || '').trim();
  const search = (url.searchParams.get('q') || '').trim();

  let sql = `
    SELECT r.id, r.mtype, r.numl, r.name, r.active, r.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM route_variants v WHERE v.route_id = r.id) AS variants,
      (SELECT g.status
         FROM route_variants v
         JOIN geometry_versions g ON g.id = v.current_geometry_id
        WHERE v.route_id = r.id
        ORDER BY CASE g.status
          WHEN 'stable' THEN 0
          WHEN 'provisional' THEN 1
          WHEN 'placeholder' THEN 2
          ELSE 3 END
        LIMIT 1) AS geometryStatus
    FROM routes r
    WHERE r.active = 1`;
  const params = [];

  if (transport) {
    sql += ' AND r.mtype = ?';
    params.push(transport);
  }
  if (search) {
    sql += ' AND r.numl LIKE ?';
    params.push(`%${search}%`);
  }

  sql += ' ORDER BY r.mtype, CAST(r.numl AS INTEGER), r.numl';
  return db.prepare(sql).all(...params);
}

function findRouteGeometry(db, routeId, direction) {
  let sql = `
    SELECT v.id AS variantId, v.direction, v.headsign, v.valid_from AS validFrom, v.valid_to AS validTo,
           g.id AS geometryId, g.geometry, g.source, g.status, g.confidence,
           g.length_m AS length, g.stats, g.created_at AS updatedAt
    FROM route_variants v
    JOIN geometry_versions g ON g.id = v.current_geometry_id
    WHERE v.route_id = ?`;
  const params = [routeId];

  if (direction !== null) {
    sql += ' AND v.direction = ?';
    params.push(direction);
  }

  sql += `
    ORDER BY CASE g.status WHEN 'stable' THEN 0 WHEN 'provisional' THEN 1 WHEN 'placeholder' THEN 2 ELSE 3 END,
             v.direction
    LIMIT 1`;

  const row = db.prepare(sql).get(...params);
  if (!row) return null;

  const geometry = JSON.parse(row.geometry);
  let stats = {};
  try {
    stats = JSON.parse(row.stats || '{}');
  } catch {
    stats = {};
  }

  return {
    variant: {
      id: row.variantId,
      direction: row.direction,
      headsign: row.headsign,
      validFrom: row.validFrom,
      validTo: row.validTo,
    },
    geometryId: row.geometryId,
    source: row.source,
    status: row.status,
    confidence: row.confidence,
    length: row.length,
    stats,
    updatedAt: row.updatedAt,
    geometry,
  };
}

function routeDetail(db, routeId) {
  const route = db
    .prepare(
      `SELECT id, mtype, numl, name, active, created_at AS createdAt, updated_at AS updatedAt
       FROM routes WHERE id = ?`,
    )
    .get(routeId);
  if (!route) return null;

  const variants = db
    .prepare(
      `SELECT v.id, v.direction, v.headsign, v.valid_from AS validFrom, v.valid_to AS validTo,
              g.id AS geometryId, g.source, g.status, g.confidence, g.length_m AS length,
              g.created_at AS updatedAt,
              (SELECT COUNT(*) FROM route_variant_stops rs WHERE rs.variant_id = v.id) AS stops
       FROM route_variants v
       LEFT JOIN geometry_versions g ON g.id = v.current_geometry_id
       WHERE v.route_id = ?
       ORDER BY v.direction`,
    )
    .all(routeId);

  const operators = db
    .prepare(
      `SELECT park_name AS parkName, sample_count AS sampleCount, last_seen AS lastSeen
       FROM route_operators WHERE route_id = ?
       ORDER BY sample_count DESC`,
    )
    .all(routeId);

  const total = operators.reduce((sum, item) => sum + item.sampleCount, 0) || 1;
  for (const operator of operators) {
    operator.share = Number((operator.sampleCount / total).toFixed(3));
  }

  return { ...route, variants, operators };
}

function variantStops(db, variantId) {
  return db
    .prepare(
      `SELECT rs.seq, s.stop_id AS stopId, s.name, s.name_ru AS nameRu, s.name_by AS nameBy,
              s.name_en AS nameEn, s.lat, s.lon
       FROM route_variant_stops rs
       JOIN stops s ON s.stop_id = rs.stop_id
       WHERE rs.variant_id = ?
       ORDER BY rs.seq`,
    )
    .all(variantId);
}

function findVariant(db, routeId, direction) {
  let sql = 'SELECT id, direction, headsign FROM route_variants WHERE route_id = ?';
  const params = [routeId];
  if (direction !== null) {
    sql += ' AND direction = ?';
    params.push(direction);
  }
  sql += ' ORDER BY direction LIMIT 1';
  return db.prepare(sql).get(...params);
}

function cachedFetch(url) {
  const now = Date.now();
  const cached = liveCache.get(url);
  if (cached && cached.expires > now) return cached.promise;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  const promise = fetch(url, {
    headers: { Accept: 'application/json' },
    signal: controller.signal,
    cache: 'no-store',
  })
    .then(async (response) => {
      const body = Buffer.from(await response.arrayBuffer());
      const result = {
        status: response.status,
        contentType: response.headers.get('content-type') || 'application/json; charset=utf-8',
        body,
      };
      if (response.ok) {
        liveCache.set(url, { expires: now + config.liveCacheMs, result });
      }
      return result;
    })
    .finally(() => clearTimeout(timer));

  liveCache.set(url, { expires: now + 1_000, promise });
  return promise;
}

async function proxyUpstream(req, res, url) {
  const targetPath = `/api${url.pathname.slice('/api'.length)}${url.search}`;
  const target = `${config.apiOrigin}${targetPath}`;

  try {
    const cached = liveCache.get(target);
    let result;

    if (cached?.result && cached.expires > Date.now()) {
      result = cached.result;
    } else {
      result = await cachedFetch(target);
    }

    res.writeHead(result.status, {
      'Content-Type': result.contentType,
      'Content-Length': result.body.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(result.body);
  } catch (error) {
    sendError(res, 502, `Не удалось получить данные из API: ${errorMessage(error)}`);
  }
}

async function handle(db, req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/health') {
    const stops = db.prepare('SELECT COUNT(*) AS count FROM stops').get();
    const routes = db.prepare('SELECT COUNT(*) AS count FROM routes').get();
    const variants = db.prepare('SELECT COUNT(*) AS count FROM route_variants').get();
    const geometry = db.prepare('SELECT COUNT(*) AS count FROM geometry_versions').get();
    const samples = db.prepare('SELECT COUNT(*) AS count FROM gps_samples').get();

    sendJson(res, 200, {
      status: 'ok',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      database: config.dbFile,
      counts: {
        stops: Number(stops.count),
        routes: Number(routes.count),
        variants: Number(variants.count),
        geometryVersions: Number(geometry.count),
        gpsSamples: Number(samples.count),
      },
      live: getLiveSummary(),
      jobs: Object.keys(jobRegistry),
    });
    return;
  }

  if (path === '/api/live/vehicles') {
    const transport = (url.searchParams.get('transport') || 'all').trim();

    try {
      if (transport === 'all') {
        sendJson(res, 200, await getAllLiveSnapshot(db));
        return;
      }

      if (!['bus', 'trolleybus', 'tram'].includes(transport)) {
        sendError(res, 400, 'Неизвестный тип транспорта');
        return;
      }

      sendJson(res, 200, await getLiveSnapshot(db, transport));
    } catch (error) {
      sendError(res, 502, errorMessage(error));
    }
    return;
  }

  if (path === '/api/routes') {
    sendJson(res, 200, { routes: routeList(db, url) });
    return;
  }

  const routeMatch = path.match(/^\/api\/routes\/(\d+)(?:\/(geometry|stops))?$/);
  if (routeMatch) {
    const routeId = Number(routeMatch[1]);
    const part = routeMatch[2] || '';
    const direction = parseDirection(url.searchParams.get('direction'));

    if (part === 'geometry') {
      const geometry = findRouteGeometry(db, routeId, direction);
      if (!geometry) {
        sendError(res, 404, 'Геометрия маршрута не найдена');
        return;
      }
      sendJson(res, 200, geometry);
      return;
    }

    if (part === 'stops') {
      const variant = findVariant(db, routeId, direction);
      if (!variant) {
        sendError(res, 404, 'Маршрут не найден');
        return;
      }
      sendJson(res, 200, {
        variant,
        stops: variantStops(db, variant.id),
      });
      return;
    }

    const detail = routeDetail(db, routeId);
    if (!detail) {
      sendError(res, 404, 'Маршрут не найден');
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  if (path === '/api/route-geometry') {
    const transport = (url.searchParams.get('transport') || '').trim();
    const routeNumber = (url.searchParams.get('route') || '').trim();
    const direction = parseDirection(url.searchParams.get('direction'));

    if (!transport || !routeNumber) {
      sendError(res, 400, 'Нужны параметры transport и route');
      return;
    }

    const route = db
      .prepare('SELECT id, mtype, numl, name FROM routes WHERE mtype = ? AND numl = ?')
      .get(transport, routeNumber);
    if (!route) {
      sendError(res, 404, 'Маршрут не найден');
      return;
    }

    const geometry = findRouteGeometry(db, route.id, direction);
    if (!geometry) {
      sendError(res, 404, 'Геометрия маршрута не найдена');
      return;
    }

    sendJson(res, 200, { route, ...geometry });
    return;
  }

  if (path === '/api/stops') {
    const search = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(5_000, Math.max(1, Number(url.searchParams.get('limit')) || 5_000));
    let sql = 'SELECT stop_id AS stopId, name, name_ru AS nameRu, name_by AS nameBy, name_en AS nameEn, lat, lon, active FROM stops WHERE active = 1';
    const params = [];
    if (search) {
      sql += ' AND name LIKE ?';
      params.push(`%${search}%`);
    }
    sql += ' ORDER BY name LIMIT ?';
    params.push(limit);
    sendJson(res, 200, { stops: db.prepare(sql).all(...params) });
    return;
  }

  const stopRoutesMatch = path.match(/^\/api\/stops\/(\d+)\/routes$/);
  if (stopRoutesMatch) {
    const stopId = Number(stopRoutesMatch[1]);
    const routes = db
      .prepare(
        `SELECT DISTINCT r.id, r.mtype, r.numl, r.name
         FROM route_variant_stops rs
         JOIN route_variants v ON v.id = rs.variant_id
         JOIN routes r ON r.id = v.route_id
         WHERE rs.stop_id = ?
         ORDER BY r.mtype, r.numl`,
      )
      .all(stopId);
    sendJson(res, 200, { stopId, routes });
    return;
  }

  if (path.startsWith('/api/v1/')) {
    await proxyUpstream(req, res, url);
    return;
  }

  sendError(res, 404, 'Не найдено');
}

export function createApiServer(db) {
  return http.createServer((req, res) => {
    handle(db, req, res).catch((error) => {
      log('request error', errorMessage(error));
      if (!res.headersSent) sendError(res, 500, errorMessage(error));
      else res.end();
    });
  });
}

export async function main() {
  const db = openDatabase(config.dbFile);
  const server = createApiServer(db);

  server.listen(config.apiPort, '0.0.0.0', () => {
    log(`слушаю http://0.0.0.0:${config.apiPort}`);
  });

  startScheduler(db);
  startLivePoller(db);

  const shutdown = () => {
    log('останавливаюсь');
    stopScheduler();
    stopLivePoller();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { handle, runJob };
