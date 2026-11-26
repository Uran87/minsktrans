import { config } from './config.js';
import { ApiError, apiTransportValue, unwrapStatus } from './normalize.js';

function buildUrl(path, params = {}) {
  const url = new URL(`${config.apiOrigin}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

export async function fetchUpstream(path, params = {}, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? config.upstreamTimeoutMs,
  );

  try {
    const response = await fetch(buildUrl(path, params), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });

    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError('API вернул ответ, который не является JSON', {
          statusCode: response.status,
        });
      }
    }

    if (!response.ok) {
      const message =
        payload && typeof payload === 'object'
          ? payload.message || payload.error || payload.msg || payload.detail
          : null;
      throw new ApiError(message ? String(message) : `API ответил HTTP ${response.status}`, {
        statusCode: response.status,
        payload,
      });
    }

    return unwrapStatus(payload);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new ApiError('Превышено время ожидания ответа API', { timeout: true });
    }
    throw new ApiError('Не удалось связаться с API', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export function fetchStops() {
  return fetchUpstream('/api/v1/stops');
}

export function fetchScoreboard(stopId) {
  return fetchUpstream('/api/v1/scoreboard', { idStop: stopId, txt: 'false' });
}

export function fetchSchedule(transport, route) {
  return fetchUpstream('/api/v1/schedule', {
    transport: apiTransportValue(transport),
    route,
  });
}

export function fetchScheduleDay(transport, route) {
  return fetchUpstream('/api/v1/scheduleDay', {
    transport: apiTransportValue(transport),
    route,
  });
}

export function fetchVehicles() {
  return fetchUpstream('/api/v1/vehicles');
}

export function fetchGeoInfoMar(transport, route, options = {}) {
  return fetchUpstream(
    '/api/v1/geoinfomar',
    { transport: apiTransportValue(transport), route },
    options,
  );
}

export function fetchRaw(path) {
  return fetchUpstream(path);
}
