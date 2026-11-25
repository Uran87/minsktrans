import path from 'node:path';

function numeric(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true' || value === '1';
}

const dataDir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');

export const config = {
  apiOrigin: (process.env.API_ORIGIN || 'http://194.158.195.62:41290').replace(/\/+$/, ''),
  dataDir,
  dbFile: process.env.DB_FILE || path.join(dataDir, 'minsktrans.db'),
  apiPort: numeric(process.env.API_PORT, 3000),
  upstreamTimeoutMs: numeric(process.env.UPSTREAM_TIMEOUT_MS, 25_000),
  liveCacheMs: numeric(process.env.LIVE_CACHE_MS, 8_000),
  liveEnabled: boolean(process.env.LIVE_ENABLED, true),
  liveRefreshMs: numeric(process.env.LIVE_REFRESH_MS, 30_000),
  liveConcurrency: numeric(process.env.LIVE_CONCURRENCY, 8),
  liveRequestTimeoutMs: numeric(process.env.LIVE_REQUEST_TIMEOUT_MS, 8_000),

  // Импорт справочников.
  syncConcurrency: numeric(process.env.SYNC_CONCURRENCY, 4),
  routeDiscoveryLimit: numeric(process.env.ROUTE_DISCOVERY_LIMIT, 0),
  autoBootstrap: boolean(process.env.AUTO_BOOTSTRAP, true),
  jobsEnabled: boolean(process.env.JOBS_ENABLED, true),

  // Сбор GPS.
  traceIntervalMs: numeric(process.env.TRACE_INTERVAL_MS, 60_000),
  traceFocusSize: numeric(process.env.TRACE_FOCUS_SIZE, 8),
  traceFocusHours: numeric(process.env.TRACE_FOCUS_HOURS, 6),
  traceConcurrency: numeric(process.env.TRACE_CONCURRENCY, 3),
  traceRetentionDays: numeric(process.env.TRACE_RETENTION_DAYS, 14),
  traceTripGapMs: numeric(process.env.TRACE_TRIP_GAP_MS, 15 * 60_000),

  // Геометрия.
  geometryFirstPassIntervalMs: numeric(process.env.GEOMETRY_FIRST_PASS_INTERVAL_MS, 30 * 60_000),
  geometryMinCompleteTraces: numeric(process.env.GEOMETRY_MIN_COMPLETE_TRACES, 2),
  geometryMaxCorridorMeters: numeric(process.env.GEOMETRY_MAX_CORRIDOR_METERS, 1_500),
  geometrySimplifyMeters: numeric(process.env.GEOMETRY_SIMPLIFY_METERS, 6),
  geometryStopToleranceMeters: numeric(process.env.GEOMETRY_STOP_TOLERANCE_METERS, 80),
  geometryMaxLengthFactor: numeric(process.env.GEOMETRY_MAX_LENGTH_FACTOR, 3.5),
};
