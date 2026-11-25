PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS stops (
  stop_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  name_ru TEXT NOT NULL DEFAULT '',
  name_by TEXT NOT NULL DEFAULT '',
  name_en TEXT NOT NULL DEFAULT '',
  lat REAL,
  lon REAL,
  vector REAL NOT NULL DEFAULT 0,
  mspsid TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stops_name ON stops(name);

CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mtype TEXT NOT NULL,
  numl TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (mtype, numl)
);

CREATE TABLE IF NOT EXISTS route_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL,
  direction INTEGER NOT NULL DEFAULT 0,
  headsign TEXT NOT NULL DEFAULT '',
  valid_from TEXT,
  valid_to TEXT,
  current_geometry_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (route_id, direction)
);

CREATE INDEX IF NOT EXISTS idx_variants_route ON route_variants(route_id);

CREATE TABLE IF NOT EXISTS route_variant_stops (
  variant_id INTEGER NOT NULL,
  stop_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (variant_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_variant_stops_stop ON route_variant_stops(stop_id);

CREATE TABLE IF NOT EXISTS geometry_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL,
  geometry TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  length_m REAL NOT NULL DEFAULT 0,
  stats TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_geometry_variant ON geometry_versions(variant_id, id DESC);

CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id INTEGER PRIMARY KEY,
  vehicle_type INTEGER,
  gosnum TEXT NOT NULL DEFAULT '',
  garnum INTEGER,
  model TEXT NOT NULL DEFAULT '',
  park_name TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_operators (
  route_id INTEGER NOT NULL,
  park_name TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (route_id, park_name)
);

CREATE TABLE IF NOT EXISTS gps_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL,
  direction INTEGER,
  vehicle_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  vector REAL,
  ts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (route_id, vehicle_id, ts)
);

CREATE INDEX IF NOT EXISTS idx_gps_variant ON gps_samples(route_id, direction, ts);
CREATE INDEX IF NOT EXISTS idx_gps_vehicle ON gps_samples(vehicle_id, ts);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  stats TEXT NOT NULL DEFAULT '{}',
  error TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
