export class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, details);
  }
}

function toArray(payload, extraKeys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  for (const key of [...extraKeys, 'items', 'list', 'rows', 'result', 'data', 'values']) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  return [];
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrEmpty(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

export function unwrapStatus(payload) {
  if (payload === null || payload === undefined) return payload;
  if (Array.isArray(payload)) return payload;

  if (typeof payload === 'object') {
    const rawStatus = payload.status ?? payload.Status;
    const hasStatus = rawStatus !== undefined && rawStatus !== null && rawStatus !== '';
    const status = String(rawStatus ?? '').trim().toLowerCase();
    const success = ['success', 'ok', 'true', '1', '200'];

    if (hasStatus && !success.includes(status)) {
      const message =
        payload.message || payload.error || payload.msg || payload.detail || `API вернул статус «${rawStatus}»`;
      throw new ApiError(String(message), { apiStatus: rawStatus, payload });
    }

    if ('data' in payload) return payload.data;
    if ('Data' in payload) return payload.Data;
  }

  return payload;
}

export function normalizeStops(payload) {
  const stops = [];

  for (const item of toArray(payload, ['stops'])) {
    if (!item || typeof item !== 'object') continue;

    const stopId = Number(item.stopId ?? item.stopid ?? item.id);
    const lat = Number(item.lat);
    const lon = Number(item.lon);

    if (!Number.isFinite(stopId)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const nameRu = stringOrEmpty(item.nameRu);
    const nameBy = stringOrEmpty(item.nameBy);
    const nameEn = stringOrEmpty(item.nameEn);

    stops.push({
      stopId,
      name: nameRu || nameBy || nameEn || `Остановка ${stopId}`,
      nameRu,
      nameBy,
      nameEn,
      lat,
      lon,
      vector: Number(item.vector) || 0,
      mspsid: stringOrEmpty(item.mspsid),
    });
  }

  return stops;
}

export function normalizeScoreboardRoutes(payload) {
  const data = Array.isArray(payload) ? payload[0] : payload;
  const routes = [];

  if (!data || typeof data !== 'object') return { stopName: '', routes };

  for (const route of toArray(data.routes)) {
    if (!route || typeof route !== 'object') continue;
    const numl = stringOrEmpty(route.numl ?? route.num1);
    if (!numl) continue;

    routes.push({
      mtype: stringOrEmpty(route.mType),
      numl,
      endStopName: stringOrEmpty(route.endStopName),
    });
  }

  return { stopName: stringOrEmpty(data.stopName), routes };
}

/**
 * mType из /scoreboard: кириллица «А» — автобус, «Т» — троллейбус, «#» — трамвай.
 * Дополнительно поддерживаем латинские и текстовые варианты.
 */
export function transportFromMType(value) {
  const v = stringOrEmpty(value).toUpperCase();
  if (['А', 'A', 'BUS', 'АВТОБУС'].includes(v)) return 'bus';
  if (['Т', 'T', 'TROLLEY', 'TROLLEYBUS', 'ТРОЛЛЕЙБУС'].includes(v)) return 'trolley';
  if (['#', 'ТР', 'TR', 'TRAM', 'ТРАМВАЙ'].includes(v)) return 'tram';
  return '';
}

/** Значение transport для API: bus, trolleybus, tram, routetaxi. */
export function apiTransportValue(transport) {
  const normalized = String(transport ?? '').trim().toLowerCase();
  if (normalized === 'bus') return 'bus';
  if (normalized === 'trolley' || normalized === 'trolleybus') return 'trolleybus';
  if (normalized === 'tram') return 'tram';
  return transport;
}

function extractStopIds(node) {
  if (Array.isArray(node)) {
    return node
      .map((item) => {
        if (item && typeof item === 'object') return Number(item.stopId ?? item.id ?? item.stop_id);
        return Number(item);
      })
      .filter((n) => Number.isFinite(n));
  }

  if (!node || typeof node !== 'object') return [];
  if (node.stopId !== undefined || node.stop_id !== undefined) {
    const stopId = Number(node.stopId ?? node.stop_id);
    return Number.isFinite(stopId) ? [stopId] : [];
  }

  for (const key of ['directionSchedule', 'stops', 'stopsSchedule', 'schedule', 'departures']) {
    if (Array.isArray(node[key])) return extractStopIds(node[key]);
  }

  return [];
}

function pickLongest(a, b) {
  return a.length >= b.length ? a : b;
}

/**
 * Нормализует /schedule: оба направления, остановки и даты действия.
 * Возвращает направления, сгруппированные по direction 0/1.
 */
export function normalizeSchedule(payload) {
  const rows = toArray(payload, ['schedule']);
  const byRoute = new Map();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;

    const mtype = stringOrEmpty(row.mType);
    const numl = stringOrEmpty(row.numl ?? row.num1);
    if (!numl) continue;

    const key = `${mtype}|${numl}`;
    if (!byRoute.has(key)) {
      byRoute.set(key, {
        mtype,
        numl,
        directions: new Map(),
        validFrom: null,
        validTo: null,
      });
    }

    const entry = byRoute.get(key);
    entry.validFrom = entry.validFrom || stringOrEmpty(row.startDate) || null;
    entry.validTo = entry.validTo || stringOrEmpty(row.completionDate) || null;

    const rightStops = extractStopIds(row.directionRightSchedule);
    const backStops = extractStopIds(row.directionBackSchedule);

    if (rightStops.length > 1) {
      const current = entry.directions.get(0);
      entry.directions.set(0, {
        direction: 0,
        headsign: stringOrEmpty(row.directionRightName) || current?.headsign || '',
        stops: current ? pickLongest(current.stops, rightStops) : rightStops,
      });
    }

    if (backStops.length > 1) {
      const current = entry.directions.get(1);
      entry.directions.set(1, {
        direction: 1,
        headsign: stringOrEmpty(row.directionBackName) || current?.headsign || '',
        stops: current ? pickLongest(current.stops, backStops) : backStops,
      });
    }
  }

  return [...byRoute.values()].map((entry) => ({
    mtype: entry.mtype,
    numl: entry.numl,
    validFrom: entry.validFrom,
    validTo: entry.validTo,
    directions: [...entry.directions.values()],
  }));
}

function directionCode(value) {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  const text = String(value).trim().toLowerCase();
  if (text.includes('обрат') || text === 'back' || text === 'reverse') return 1;
  if (text.includes('круг') || text === 'circle' || text === 'loop') return 2;
  return 0;
}

/**
 * Fallback: /scheduleDay. Группируем рейсы по направлению и берём
 * самый длинный список остановок для каждого направления.
 */
export function normalizeScheduleDay(payload) {
  const trips = [];
  const items = toArray(payload, ['trips', 'schedule']);

  const addTrip = (node) => {
    if (!node || typeof node !== 'object') return;
    let stops = extractStopIds(node);
    if (stops.length < 2 && node.schedule) stops = extractStopIds(node.schedule);
    if (stops.length < 2) return;

    trips.push({
      direction: directionCode(node.direction ?? node.dir ?? null),
      tripNum: node.tripNum ?? node.trip ?? null,
      stops,
    });
  };

  const looksLikeStops = items.some(
    (item) => item && typeof item === 'object' && (item.stopId !== undefined || item.stop_id !== undefined),
  );

  if (looksLikeStops) {
    addTrip({ stops: items });
  } else {
    items.forEach(addTrip);
  }

  const byDirection = new Map();
  for (const trip of trips) {
    const key = trip.direction;
    const current = byDirection.get(key);
    if (!current || trip.stops.length > current.stops.length) {
      byDirection.set(key, { direction: key, headsign: '', stops: trip.stops });
    }
  }

  return [...byDirection.values()];
}

export function normalizeVehicles(payload) {
  const vehicles = [];

  for (const item of toArray(payload, ['vehicles'])) {
    if (!item || typeof item !== 'object') continue;
    const vehicleId = Number(item.vehicleID ?? item.vehicleId ?? item.id);
    if (!Number.isFinite(vehicleId)) continue;

    vehicles.push({
      vehicleId,
      vehicleType: numberOrNull(item.vehicleType),
      gosnum: stringOrEmpty(item.gosnum),
      garnum: numberOrNull(item.garnum),
      model: stringOrEmpty(item.modelName ?? item.model),
      parkName: stringOrEmpty(item.parkName ?? item.park),
    });
  }

  return vehicles;
}

export function normalizeGeoInfo(payload) {
  const vehicles = [];

  for (const item of toArray(payload, ['vehicles', 'geoinfomar', 'transport'])) {
    if (!item || typeof item !== 'object') continue;
    const vehicleId = Number(item.vehicleId ?? item.vehicleid ?? item.id);
    const lat = Number(item.lat ?? item.latitude);
    const lon = Number(item.lon ?? item.lng ?? item.longitude);
    if (!Number.isFinite(vehicleId)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    vehicles.push({
      vehicleId,
      direction: numberOrNull(item.direction),
      lat,
      lon,
      vector: numberOrNull(item.vector ?? item.course ?? item.angle),
    });
  }

  return vehicles;
}

export function stopIdsFromSchedule(schedule) {
  return schedule.flatMap((direction) => direction.stops);
}
