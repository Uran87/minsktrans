/**
 * Модуль работы с REST API СНОиПД (МинскТранс).
 *
 * База по умолчанию — /api/v1 (same-origin, проксируется nginx или Vite).
 * В dev-режиме Vite проксирует /api на http://194.158.195.62:41290,
 * в Docker — nginx проксирует на API_ORIGIN. Так мы не зависим от CORS API.
 *
 * Все публичные функции возвращают уже нормализованные данные.
 */

import * as mockApi from './mock.js';

const API_BASE = (import.meta.env.VITE_API_BASE || '/api/v1').replace(/\/+$/, '');
const REQUEST_TIMEOUT = 25_000;

const envMockDefault = import.meta.env.VITE_MOCK_DEFAULT;
let mockEnabled =
  envMockDefault === undefined || envMockDefault === null || envMockDefault === ''
    ? Boolean(import.meta.env.DEV)
    : String(envMockDefault).toLowerCase() === 'true';

export class ApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, details);
  }
}

export function setMockEnabled(enabled) {
  mockEnabled = Boolean(enabled);
}

export function isMockEnabled() {
  return mockEnabled;
}

export function getApiBase() {
  return API_BASE;
}

function buildUrl(path, params) {
  const url = new URL(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`, window.location.origin);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url.toString();
}

/**
 * Снимает обёртку StatusResponse: { status: "success", data: [...] }.
 * Массивы и "голые" объекты возвращаются как есть.
 * status !== "success" превращается в ApiError — карта при этом не ломается.
 */
function unwrapStatus(payload) {
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

async function fetchJson(path, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(buildUrl(path, params), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });

    const text = await response.text();
    let payload = null;
    let parseFailed = false;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        parseFailed = true;
      }
    }

    if (!response.ok) {
      const bodyMessage =
        payload && typeof payload === 'object'
          ? payload.message || payload.error || payload.msg || payload.detail
          : null;

      throw new ApiError(
        bodyMessage ? String(bodyMessage) : `API ответил HTTP ${response.status}`,
        {
          statusCode: response.status,
          payload,
        },
      );
    }

    if (parseFailed) {
      throw new ApiError('API вернул ответ, который не является JSON', {
        statusCode: response.status,
      });
    }

    return unwrapStatus(payload);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new ApiError('Превышено время ожидания ответа API', { timeout: true });
    }
    throw new ApiError('Не удалось связаться с API. Проверьте сеть или включите демо-режим.', {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Нормализация                                                        */
/* ------------------------------------------------------------------ */

function toArray(payload, extraKeys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const keys = [...extraKeys, 'items', 'list', 'rows', 'result', 'data', 'values'];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

export function normalizeVehicles(payload) {
  return toArray(payload, ['vehicles', 'geoinfomar', 'transport'])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const vehicleId = item.vehicleId ?? item.vehicleid ?? item.id;
      const lat = Number(item.lat ?? item.latitude);
      const lon = Number(item.lon ?? item.lng ?? item.longitude);
      const vector = Number(item.vector ?? item.course ?? item.angle ?? 0);

      if (vehicleId === undefined || vehicleId === null) return null;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

      return {
        vehicleId: Number.isFinite(Number(vehicleId)) ? Number(vehicleId) : vehicleId,
        direction: item.direction ?? null,
        lat,
        lon,
        vector: Number.isFinite(vector) ? vector : 0,
      };
    })
    .filter(Boolean);
}

export function normalizeStops(payload) {
  const result = new Map();

  for (const item of toArray(payload, ['stops'])) {
    if (!item || typeof item !== 'object') continue;

    const stopId = item.stopId ?? item.stopid ?? item.id;
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (stopId === null || stopId === undefined) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const nameRu = (item.nameRu && String(item.nameRu).trim()) || '';
    const nameBy = (item.nameBy && String(item.nameBy).trim()) || '';
    const nameEn = (item.nameEn && String(item.nameEn).trim()) || '';

    const name = nameRu || nameBy || nameEn || `Остановка ${stopId}`;

    result.set(Number(stopId), {
      stopId: Number(stopId),
      name,
      nameRu,
      nameBy,
      nameEn,
      lat,
      lon,
      vector: Number(item.vector) || 0,
      mspsid: item.mspsid ? String(item.mspsid) : '',
    });
  }

  return result;
}

export function normalizeVehicleState(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new ApiError('API вернул пустые данные о машине');
  }

  const rawStops =
    payload.marshrutStops ?? payload.marsRouteStops ?? payload.routeStops ?? payload.stops ?? [];

  const marshrutStops = (Array.isArray(rawStops) ? rawStops : [])
    .map((item) => {
      if (item && typeof item === 'object') return Number(item.stopId ?? item.id);
      return Number(item);
    })
    .filter((n) => Number.isFinite(n));

  return {
    ...payload,
    marNuml: payload.marNuml ?? payload.marNum1 ?? payload.marNum ?? payload.route ?? '',
    marshrutStops,
    gosnum: payload.gosnum ?? payload.gosNum ?? payload.stateNumber ?? '',
    model:
      payload.model ??
      payload.modelName ??
      payload.tsModel ??
      payload.vehicleModel ??
      '',
  };
}

const STOP_ARRAY_KEYS = [
  'stops',
  'stopSchedule',
  'scheduleStops',
  'directionStops',
  'stopsSchedule',
  'schedule',
  'departures',
  'raspisanie',
];

function extractStopArray(node) {
  if (!node || typeof node !== 'object') return [];
  if (node.stopId !== undefined || node.stop_id !== undefined) return [node];

  for (const key of STOP_ARRAY_KEYS) {
    const value = node[key];
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (first && typeof first === 'object' && (first.stopId !== undefined || first.stop_id !== undefined)) {
        return value;
      }
    }
  }

  // Резервный поиск: неизвестное имя поля, но структура — массив остановок.
  for (const value of Object.values(node)) {
    if (Array.isArray(value) && value.length > 0) {
      const first = value[0];
      if (first && typeof first === 'object' && (first.stopId !== undefined || first.stop_id !== undefined)) {
        return value;
      }
    }
  }

  return [];
}

function parseScheduleStops(list) {
  return list
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const stopId = Number(item.stopId ?? item.stop_id ?? item.id);
      if (!Number.isFinite(stopId)) return null;

      const departure =
        item.departures ??
        item.departure ??
        item.time ??
        item.departureTime ??
        item.value ??
        item.hhmm ??
        null;

      return { stopId, departures: departure };
    })
    .filter(Boolean);
}

/**
 * Приводит ответ /scheduleDay к виду:
 * { trips: [{ tripNum, direction, stops: [{ stopId, departures }] }] }
 *
 * Поддерживаются оба известных формата:
 *  - массив остановок (как в примере API);
 *  - объект с directionSchedule / schedule / trips.
 */
export function normalizeScheduleDay(payload) {
  const trips = [];

  const addTrip = (node, fallback = {}) => {
    if (!node || typeof node !== 'object') return;

    let stops = parseScheduleStops(extractStopArray(node));

    // Иногда остановки лежат глубже: { schedule: { stops: [...] } }
    if (!stops.length && node.schedule && typeof node.schedule === 'object') {
      stops = parseScheduleStops(extractStopArray(node.schedule));
    }

    if (!stops.length) return;

    trips.push({
      tripNum: node.tripNum ?? node.trip ?? node.run ?? node.tripId ?? fallback.tripNum ?? null,
      direction: node.direction ?? node.dir ?? fallback.direction ?? null,
      stops,
    });
  };

  if (Array.isArray(payload)) {
    const looksLikeStops = payload.some(
      (item) => item && typeof item === 'object' && (item.stopId !== undefined || item.stop_id !== undefined),
    );

    if (looksLikeStops) {
      addTrip({ stops: payload });
    } else {
      payload.forEach((item) => addTrip(item));
    }
  } else if (payload && typeof payload === 'object') {
    const schedule =
      payload.directionSchedule ?? payload.trips ?? payload.scheduleList ?? payload.raspisanie;

    if (Array.isArray(schedule)) {
      schedule.forEach((item) => addTrip(item));
    } else if (schedule && typeof schedule === 'object') {
      // directionSchedule может быть объектом вида { "0": [...], "1": [...] }
      Object.values(schedule).forEach((item) => {
        if (Array.isArray(item)) item.forEach((child) => addTrip(child));
        else addTrip(item);
      });
    }

    if (!trips.length) addTrip(payload);

    // Резервный поиск: ищем первый массив объектов с tripNum/direction.
    if (!trips.length) {
      for (const value of Object.values(payload)) {
        if (Array.isArray(value) && value.some((x) => x && typeof x === 'object' && 'tripNum' in x)) {
          value.forEach((item) => addTrip(item));
          break;
        }
      }
    }
  }

  return { trips };
}

/**
 * Нормализация /scoreboard: табло остановки с двумя ближайшими ТС на маршрут.
 */
function normalizeArrival(route, suffix) {
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const attribute = route[`attribute${suffix}`];

  return {
    attribute: attribute === null || attribute === undefined ? '' : String(attribute).trim(),
    vehicleId: number(route[`idVehicle${suffix}`]),
    distance: number(route[`distanceFactMeters${suffix}`]),
    planned: number(route[`plannedArrivalTimeSec${suffix}`]),
    deviation: number(route[`deviationPlanFactSec${suffix}`]),
    estimated: number(route[`estimatedTimeArrivalSec${suffix}`]),
  };
}

export function normalizeScoreboard(payload) {
  const data = Array.isArray(payload) ? payload[0] : payload;

  if (!data || typeof data !== 'object') {
    return { stopName: '', routes: [] };
  }

  const routeList = Array.isArray(data.routes) ? data.routes : [];

  const routes = routeList
    .map((route) => {
      if (!route || typeof route !== 'object') return null;

      const numl = String(route.numl ?? route.num1 ?? '').trim();
      if (!numl) return null;

      return {
        mType: String(route.mType ?? '').trim(),
        numl,
        endStopName: String(route.endStopName ?? '').trim(),
        first: normalizeArrival(route, 'First'),
        next: normalizeArrival(route, 'Next'),
      };
    })
    .filter(Boolean);

  return {
    stopName: String(data.stopName ?? '').trim(),
    routes,
  };
}

/* ------------------------------------------------------------------ */
/* Публичные запросы                                                   */
/* ------------------------------------------------------------------ */

export async function getGeoInfo({ transport, route }) {
  const raw = mockEnabled
    ? await mockApi.geoInfo({ transport, route })
    : await fetchJson('/geoinfomar', { transport, route });

  return normalizeVehicles(raw);
}

export async function getStops() {
  const raw = mockEnabled ? await mockApi.stops() : await fetchJson('/stops');
  return normalizeStops(raw);
}

export async function getVehicleState(vehicleId) {
  const raw = mockEnabled
    ? await mockApi.vehicleState(vehicleId)
    : await fetchJson('/vehicleState', { id: vehicleId });

  return normalizeVehicleState(raw);
}

export async function getScheduleDay({ transport, route }) {
  const raw = mockEnabled
    ? await mockApi.scheduleDay({ transport, route })
    : await fetchJson('/scheduleDay', { transport, route });

  return normalizeScheduleDay(raw);
}

export async function getScoreboard(stopId) {
  const raw = mockEnabled
    ? await mockApi.scoreboard(stopId)
    : await fetchJson('/scoreboard', { idStop: stopId, txt: 'false' });

  return normalizeScoreboard(raw);
}
