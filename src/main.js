/**
 * Точка входа: связывает API, карту и интерфейс.
 *
 * Поллинг строго через setInterval (30 с), без WebSocket/SSE.
 * При обновлении координат фичи не пересоздаются — map.js делает
 * feature.setGeometry() и меняет rotation иконки.
 */

import 'ol/ol.css';
import './style.css';

import * as api from './api.js';
import * as mapView from './map.js';
import * as ui from './ui.js';
import { POLL_INTERVAL, TRANSPORT_TYPES, normalizeTransportType, transportTypeFromMType } from './constants.js';

const PREFS_KEY = 'minsktrans:prefs:v1';
const VALID_LAYERS = ['map', 'satellite', 'hybrid'];

const state = {
  transport: 'bus',
  route: '1',
  stops: new Map(),
  stopsPromise: null,
  vehicles: [],
  routeVehicles: [],
  fleetRoutes: 0,
  routeStops: [],
  routeStopIds: [],
  routeGeometry: null,
  timer: null,
  polling: false,
  loading: false,
  inFlight: false,
  pollQueued: false,
  allStopsGeneration: -1,
  lastPollAt: 0,
  pollErrorShown: false,
  selectedVehicleId: null,
  detailsVehicleId: null,
  detailsToken: 0,
  scoreboardToken: 0,
  dataGeneration: 0,
  requestId: 0,
};

const prefs = loadPrefs();

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */

function loadPrefs() {
  const defaults = {
    transport: 'bus',
    route: '1',
    layer: 'map',
    mock: api.isMockEnabled(),
  };

  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return {
      transport: TRANSPORT_TYPES.includes(stored.transport) ? stored.transport : defaults.transport,
      route:
        typeof stored.route === 'string' && stored.route.trim()
          ? stored.route.trim().slice(0, 8)
          : defaults.route,
      layer: VALID_LAYERS.includes(stored.layer) ? stored.layer : defaults.layer,
      mock: typeof stored.mock === 'boolean' ? stored.mock : defaults.mock,
    };
  } catch {
    return defaults;
  }
}

function savePrefs(patch) {
  Object.assign(prefs, patch);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* localStorage может быть недоступен — не критично */
  }
}

/* ------------------------------------------------------------------ */
/* Загрузка справочника остановок                                      */
/* ------------------------------------------------------------------ */

function ensureStops() {
  if (state.stops.size) return Promise.resolve(state.stops);
  if (state.stopsPromise) return state.stopsPromise;

  const generation = state.dataGeneration;

  state.stopsPromise = api
    .getStops()
    .then((stops) => {
      if (generation === state.dataGeneration) state.stops = stops;
      return stops;
    })
    .finally(() => {
      if (generation === state.dataGeneration) state.stopsPromise = null;
    });

  return state.stopsPromise;
}

function renderAllStops(stopsMap) {
  if (state.allStopsGeneration === state.dataGeneration) return;

  mapView.setAllStops(stopsMap);
  state.allStopsGeneration = state.dataGeneration;
}

/**
 * Фоновый предзагруз справочника: все остановки должны появиться на карте
 * сразу, ещё до выбора маршрута. Ошибку здесь не показываем — она всплывёт
 * при нажатии «Показать маршрут».
 */
function loadAllStops() {
  const generation = state.dataGeneration;

  ensureStops()
    .then((stopsMap) => {
      if (generation !== state.dataGeneration) return;
      renderAllStops(stopsMap);
    })
    .catch((error) => {
      console.warn('[stops] preload:', error);
    });
}

/* ------------------------------------------------------------------ */
/* Маршрут и поллинг                                                   */
/* ------------------------------------------------------------------ */

async function showRoute() {
  const transport = state.transport;
  const route = state.route;
  if (!route) {
    ui.toast('Введите номер маршрута', 'error');
    return;
  }

  closeStopPopup();

  const requestId = ++state.requestId;
  const generation = state.dataGeneration;
  state.routeGeometry = null;

  state.loading = true;
  ui.setLoading(true);
  ui.setStatus({ text: 'Загружаем маршрут…', live: false });

  try {
    const stopsMap = await ensureStops();

    if (
      requestId !== state.requestId ||
      generation !== state.dataGeneration ||
      transport !== state.transport ||
      route !== state.route
    ) {
      return;
    }

    renderAllStops(stopsMap);

    const routeVehicles = vehiclesForRoute(state.vehicles, route);
    const orderIds = await resolveRouteOrder(transport, route, routeVehicles, stopsMap);

    if (
      requestId !== state.requestId ||
      generation !== state.dataGeneration ||
      transport !== state.transport ||
      route !== state.route
    ) {
      return;
    }

    drawRoute(orderIds);
    state.routeVehicles = attachNextStops(vehiclesForRoute(state.vehicles, route));
    const preferredDirection = pickVehicleDirection(
      state.routeVehicles.length ? state.routeVehicles : state.vehicles,
    );
    applyRouteGeometry(transport, route, generation, requestId, preferredDirection);
    mapView.updateVehicles(state.vehicles, transport);
    mapView.fitToRoute(state.routeStops, state.routeVehicles);
    renderRouteVehicles();

    const now = new Date();
    state.lastPollAt = now.getTime();

    ui.setStatus({ text: fleetStatusText(), time: now, live: true });

    if (routeVehicles.length > 0 && orderIds.length === 0) {
      ui.toast('Линия маршрута не построена: API не вернул порядок остановок.', 'info', 5000);
    }
  } catch (error) {
    console.error('[showRoute]', error);
    ui.setStatus({ text: 'Ошибка загрузки', live: false, error: true });
    ui.toast(`Не удалось загрузить маршрут: ${error.message}`, 'error', 7000);
  } finally {
    if (requestId === state.requestId) {
      state.loading = false;
      ui.setLoading(false);
    }
  }
}

async function resolveRouteOrder(transport, route, vehicles, stopsMap) {
  const pickExisting = (ids) => {
    const result = [];
    for (const rawId of ids) {
      const id = Number(rawId);
      if (!stopsMap.has(id)) continue;
      if (result.length === 0 || result[result.length - 1] !== id) result.push(id);
    }
    return result;
  };

  // 1. Порядок остановок текущего рейса есть в vehicleState.
  if (vehicles.length > 0) {
    try {
      const vehicleState = await api.getVehicleState(vehicles[0].vehicleId);
      const ids = pickExisting(vehicleState.marshrutStops);
      if (ids.length > 1) return ids;
    } catch (error) {
      console.warn('[resolveRouteOrder] vehicleState:', error);
    }
  }

  // 2. Резерв — порядок остановок из расписания.
  try {
    const schedule = await api.getScheduleDay({ transport, route });
    const trip = [...schedule.trips]
      .sort((a, b) => b.stops.length - a.stops.length)
      .find((item) => item.stops.length > 1);

    if (trip) return pickExisting(trip.stops.map((stop) => stop.stopId));
  } catch (error) {
    console.warn('[resolveRouteOrder] scheduleDay:', error);
  }

  return [];
}

function drawRoute(orderIds, geometry = state.routeGeometry) {
  state.routeStopIds = orderIds;
  state.routeStops = orderIds.map((id) => state.stops.get(id)).filter(Boolean);
  state.routeGeometry = geometry;
  mapView.setRoute(state.routeStops, state.transport, geometry);
}

function vehiclesForRoute(vehicles, route) {
  const target = String(route ?? '');
  return vehicles.filter((vehicle) => !vehicle.route || String(vehicle.route) === target);
}

function renderRouteVehicles() {
  if (!state.routeStops.length) {
    ui.renderVehicles([], state.transport, null, 'Нажмите «Показать маршрут»');
  } else {
    ui.renderVehicles(
      state.routeVehicles,
      state.transport,
      state.selectedVehicleId,
      'На маршруте пока нет машин',
      { route: state.route, stops: state.routeStops },
    );
  }

  ui.setStatusVehiclesCount(
    state.routeStops.length ? state.routeVehicles.length : state.vehicles.length,
  );
}

function fleetStatusText() {
  if (!state.routeStops.length) {
    return state.vehicles.length > 0
      ? `Онлайн · ${state.vehicles.length} машин на карте`
      : 'Машин на карте нет';
  }

  return state.routeVehicles.length > 0
    ? `Онлайн · маршрут №${state.route} · ${state.routeVehicles.length} машин`
    : `Машин на маршруте №${state.route} нет`;
}

/**
 * Подтягивает сохранённую геометрию маршрута из backend и заменяет
 * резервную линию по остановкам. Если геометрии нет — остаётся линия
 * «остановка → остановка».
 */
function pickVehicleDirection(vehicles) {
  const counts = new Map();

  for (const vehicle of vehicles) {
    const direction = Number(vehicle.direction);
    if (!Number.isFinite(direction)) continue;
    counts.set(direction, (counts.get(direction) || 0) + 1);
  }

  let bestDirection = null;
  let bestCount = 0;
  for (const [direction, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestDirection = direction;
    }
  }

  return bestDirection;
}

async function applyRouteGeometry(transport, route, generation, requestId, direction = null) {
  try {
    let data = await api.getRouteGeometry({ transport, route, direction });
    if (!data && direction !== null) {
      data = await api.getRouteGeometry({ transport, route });
    }
    if (!data) return;

    if (
      generation !== state.dataGeneration ||
      requestId !== state.requestId ||
      transport !== state.transport ||
      route !== state.route
    ) {
      return;
    }

    state.routeGeometry = data.geometry;
    if (state.routeStops.length > 0) {
      mapView.setRoute(state.routeStops, state.transport, state.routeGeometry);
    }
  } catch (error) {
    console.warn('[routeGeometry]', error);
  }
}

/* ------------------------------------------------------------------ */
/* Следующая остановка для списка машин                                */
/* ------------------------------------------------------------------ */

function squaredDistance(a, b) {
  const latScale = Math.cos((a.lat * Math.PI) / 180);
  const dx = (b.lon - a.lon) * latScale;
  const dy = b.lat - a.lat;
  return dx * dx + dy * dy;
}

function bearingBetween(a, b) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function angleDifference(a, b) {
  return Math.abs(((((a - b + 540) % 360) + 360) % 360) - 180);
}

/**
 * Ближайшая остановка «впереди»: находим ближайшую точку маршрута,
 * затем из двух соседей выбираем ту, что лучше совпадает с курсом машины.
 */
function pickNextStop(vehicle, stops) {
  if (!Array.isArray(stops) || stops.length < 2) return null;

  let nearestIndex = -1;
  let bestDistance = Infinity;

  stops.forEach((stop, index) => {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) return;
    const distance = squaredDistance(vehicle, stop);
    if (distance < bestDistance) {
      bestDistance = distance;
      nearestIndex = index;
    }
  });

  if (nearestIndex < 0) return null;

  const candidates = [];
  if (nearestIndex + 1 < stops.length) candidates.push(nearestIndex + 1);
  if (nearestIndex - 1 >= 0) candidates.push(nearestIndex - 1);

  if (!candidates.length) return null;
  if (candidates.length === 1) return stops[candidates[0]];

  const heading = Number(vehicle.vector);
  if (!Number.isFinite(heading)) return stops[candidates[0]];

  const [forward, backward] = candidates;
  return angleDifference(bearingBetween(vehicle, stops[forward]), heading) <=
    angleDifference(bearingBetween(vehicle, stops[backward]), heading)
    ? stops[forward]
    : stops[backward];
}

function attachNextStops(vehicles) {
  return vehicles.map((vehicle) => {
    const nextStop = pickNextStop(vehicle, state.routeStops);
    return { ...vehicle, nextStopName: nextStop?.name || '' };
  });
}

function startPolling() {
  stopPolling(true);
  state.polling = true;

  state.timer = setInterval(() => {
    if (document.hidden) return;
    pollOnce();
  }, POLL_INTERVAL);
}

function stopPolling(silent = false) {
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.polling = false;
}

async function pollOnce() {
  if (!state.polling) return;
  if (state.inFlight) {
    state.pollQueued = true;
    return;
  }

  const transport = state.transport;
  const generation = state.dataGeneration;

  state.inFlight = true;

  try {
    const fleet = await api.getAllVehicles({ transport });

    if (generation !== state.dataGeneration || transport !== state.transport) {
      return;
    }

    let vehicles = fleet.vehicles;

    // Пока каталог маршрутов на backend пуст, сохраняем работоспособность:
    // показываем хотя бы выбранный маршрут через /geoinfomar.
    if (!vehicles.length && fleet.routes === 0 && state.route) {
      const fallback = await api.getGeoInfo({ transport, route: state.route });
      vehicles = fallback.map((vehicle) => ({
        ...vehicle,
        route: state.route,
        mtype: transport,
      }));

      if (generation !== state.dataGeneration || transport !== state.transport) {
        return;
      }
    }

    state.vehicles = vehicles;
    state.fleetRoutes = fleet.routes;
    state.routeVehicles = state.routeStops.length
      ? attachNextStops(vehiclesForRoute(vehicles, state.route))
      : [];

    mapView.updateVehicles(state.vehicles, transport);
    renderRouteVehicles();

    state.lastPollAt = Date.now();
    state.pollErrorShown = false;

    ui.setStatus({
      text: fleetStatusText(),
      time: new Date(),
      live: true,
    });
  } catch (error) {
    console.error('[poll]', error);
    ui.setStatus({
      text: 'Нет связи с API',
      live: false,
      error: true,
      time: state.lastPollAt ? new Date(state.lastPollAt) : null,
    });

    if (!state.pollErrorShown) {
      state.pollErrorShown = true;
      ui.toast(`Обновление не удалось: ${error.message}`, 'error', 6000);
    }
  } finally {
    state.inFlight = false;
    if (state.pollQueued && state.polling) {
      state.pollQueued = false;
      pollOnce();
    }
  }
}

function handleVisibility() {
  if (document.hidden) return;
  if (state.polling && Date.now() - state.lastPollAt >= POLL_INTERVAL) {
    pollOnce();
  }
}

/* ------------------------------------------------------------------ */
/* Карточка машины                                                     */
/* ------------------------------------------------------------------ */

function pickTrip(trips, vehicle) {
  if (!trips.length) return null;

  const tripNumber = vehicle.tripNum ?? vehicle.tripId ?? null;

  if (tripNumber !== null && tripNumber !== undefined && tripNumber !== '') {
    const byNumber = trips.find((trip) => String(trip.tripNum) === String(tripNumber));
    if (byNumber) return byNumber;
  }

  const direction = vehicle.direction;
  const lastStopId = Number(vehicle.lastStopId);

  const sameDirection = trips.filter(
    (trip) =>
      direction === null ||
      direction === undefined ||
      trip.direction === null ||
      trip.direction === undefined ||
      String(trip.direction) === String(direction),
  );

  return (
    sameDirection.find((trip) => trip.stops.some((stop) => stop.stopId === lastStopId)) ||
    sameDirection[0] ||
    trips.find((trip) => trip.stops.some((stop) => stop.stopId === lastStopId)) ||
    trips[0]
  );
}

async function openDetails(vehicleId, transportHint = null) {
  const token = ++state.detailsToken;
  closeStopPopup();
  state.detailsVehicleId = String(vehicleId);

  ui.showDetailsLoading(vehicleId, transportHint || state.transport);

  try {
    const vehicle = await api.getVehicleState(vehicleId);
    const transport =
      normalizeTransportType(vehicle.tsType) ||
      normalizeTransportType(transportHint) ||
      state.transport;
    const route = vehicle.marNuml || state.route;

    let schedule = null;
    let scheduleError = null;

    try {
      schedule = await api.getScheduleDay({ transport, route });
    } catch (error) {
      scheduleError = error;
      console.warn('[scheduleDay]', error);
    }

    if (token !== state.detailsToken) return;

    if (state.stops.size === 0) {
      try {
        await ensureStops();
      } catch (error) {
        console.warn('[openDetails] stops:', error);
      }
    }

    if (token !== state.detailsToken) return;

    const trip = pickTrip(schedule?.trips || [], vehicle);

    ui.renderDetails({
      vehicle: { ...vehicle, vehicleId },
      trip,
      stops: state.stops,
      transport,
      fallbackTransport: state.transport,
      scheduleError,
    });
  } catch (error) {
    if (token !== state.detailsToken) return;
    console.error('[openDetails]', error);
    ui.renderDetailsError(vehicleId, error);
    ui.toast(`Карточка машины: ${error.message}`, 'error', 6000);
  }
}

function selectVehicle(vehicleId, focus, transportHint = null) {
  closeStopPopup();
  state.selectedVehicleId = String(vehicleId);
  mapView.setSelectedVehicle(vehicleId);

  renderRouteVehicles();

  if (focus) mapView.focusVehicle(vehicleId);
  openDetails(vehicleId, transportHint);
}

function closeDetails() {
  state.detailsToken += 1;
  state.detailsVehicleId = null;
  state.selectedVehicleId = null;

  ui.closeDetails();
  mapView.clearSelection();
  renderRouteVehicles();
}

/* ------------------------------------------------------------------ */
/* Остановки                                                           */
/* ------------------------------------------------------------------ */

function handleStopClick(stopId, coordinate) {
  const stop = state.stops.get(Number(stopId));

  if (!stop) {
    ui.toast(`Остановка ${stopId} не найдена в справочнике`, 'error');
    return;
  }

  if (ui.isDetailsOpen()) closeDetails();

  const isRouteStop = state.routeStopIds.includes(Number(stopId));

  ui.renderStopPopup({
    stop,
    isRouteStop,
    route: state.route,
    transport: state.transport,
  });
  mapView.showStopPopupAt(coordinate, isRouteStop ? -44 : -30);

  loadScoreboard(Number(stopId));
}

function handleTripStopSelect(stopId) {
  const stop = state.stops.get(Number(stopId));

  if (!stop) {
    ui.toast(`Остановка ${stopId} не найдена в справочнике`, 'error');
    return;
  }

  const coordinate = mapView.focusStop(stop);
  handleStopClick(stopId, coordinate);
}

async function loadScoreboard(stopId) {
  const token = ++state.scoreboardToken;

  ui.renderScoreboardLoading();

  try {
    const data = await api.getScoreboard(stopId);

    if (token !== state.scoreboardToken) return;

    ui.renderScoreboard({
      stopId,
      routes: data.routes,
      updatedAt: new Date(),
    });
  } catch (error) {
    if (token !== state.scoreboardToken) return;

    console.warn('[scoreboard]', error);
    ui.renderScoreboardError(stopId, error);
  }
}

function closeStopPopup() {
  state.scoreboardToken += 1;
  ui.closeStopPopup();
  mapView.hideStopPopup();
}

/* ------------------------------------------------------------------ */
/* Обработчики UI                                                      */
/* ------------------------------------------------------------------ */

function handleSubmit({ transport, route }) {
  state.transport = TRANSPORT_TYPES.includes(transport) ? transport : 'bus';
  state.route = String(route || '').trim();
  savePrefs({ transport: state.transport, route: state.route });

  if (!state.route) {
    ui.toast('Введите номер маршрута', 'error');
    return;
  }

  closeDetails();
  showRoute();
}

function handleTransportChange(type) {
  if (!TRANSPORT_TYPES.includes(type)) return;

  const hadRoute = state.routeStops.length > 0 || state.loading;
  state.transport = type;
  savePrefs({ transport: type });
  loadRouteOptions(type);

  closeStopPopup();
  if (ui.isDetailsOpen()) closeDetails();

  state.vehicles = [];
  state.routeVehicles = [];
  state.routeGeometry = null;
  state.fleetRoutes = 0;
  mapView.clearVehicles();

  if (hadRoute) {
    showRoute();
  } else {
    state.routeStops = [];
    state.routeStopIds = [];
    mapView.clearRoute();
    renderRouteVehicles();
  }

  pollOnce();
}

function handleLayerChange(layer) {
  if (!VALID_LAYERS.includes(layer)) return;
  mapView.setBaseLayer(layer);
  savePrefs({ layer });
}

function resetData() {
  state.dataGeneration += 1;
  state.requestId += 1;
  state.detailsToken += 1;
  state.stops = new Map();
  state.stopsPromise = null;
  state.vehicles = [];
  state.routeVehicles = [];
  state.fleetRoutes = 0;
  state.routeStops = [];
  state.routeStopIds = [];
  state.routeGeometry = null;
  state.loading = false;
  state.allStopsGeneration = -1;
  state.selectedVehicleId = null;
  state.detailsVehicleId = null;

  mapView.clearVehicles();
  mapView.clearRoute();
  mapView.clearAllStops();
  mapView.clearSelection();

  closeStopPopup();
  ui.closeDetails();
  ui.setLoading(false);
  ui.renderVehicles([], state.transport, null);
}

function handleMockChange(enabled) {
  const hadRoute = state.routeStops.length > 0 || state.loading;
  stopPolling(true);
  api.setMockEnabled(enabled);
  savePrefs({ mock: enabled });
  resetData();
  routeOptionsCache.clear();
  loadRouteOptions(state.transport, true);

  ui.setMockChecked(enabled);
  ui.setStatus({
    text: enabled ? 'Демо-режим включён' : 'Режим API включён',
    live: false,
  });

  ui.toast(
    enabled
      ? 'Включены демо-данные маршрута №1 — API не используется.'
      : 'Демо-данные выключены, запросы идут в реальный API.',
    'info',
    4500,
  );

  startPolling();
  pollOnce();

  if (hadRoute) showRoute();
  else loadAllStops();
}

/* ------------------------------------------------------------------ */
/* Подсказки номеров маршрутов                                         */
/* ------------------------------------------------------------------ */

const routeOptionsCache = new Map();

async function loadRouteOptions(transport, force = false) {
  const cached = routeOptionsCache.get(transport);
  if (!force && cached && Date.now() - cached.at < 60_000) {
    if (transport === state.transport) ui.renderRouteOptions(cached.routes);
    return;
  }

  try {
    const routes = await api.getRouteList({ transport });
    routeOptionsCache.set(transport, { at: Date.now(), routes });
    if (transport === state.transport) ui.renderRouteOptions(routes);
  } catch (error) {
    console.warn('[routeOptions]', error);
  }
}

/* ------------------------------------------------------------------ */
/* Запуск                                                              */
/* ------------------------------------------------------------------ */

api.setMockEnabled(prefs.mock);
state.transport = prefs.transport;
state.route = prefs.route;

ui.init({
  transport: prefs.transport,
  route: prefs.route,
  layer: prefs.layer,
  mock: prefs.mock,
  apiBase: api.getApiBase(),
  handlers: {
    onSubmit: handleSubmit,
    onTransportChange: handleTransportChange,
    onLayerChange: handleLayerChange,
    onMockChange: handleMockChange,
    onVehicleSelect: (vehicleId) => selectVehicle(vehicleId, true),
    onDetailsClose: closeDetails,
    onDetailsRetry: (vehicleId) => openDetails(vehicleId),
    onStopSelect: handleTripStopSelect,
    onStopPopupClose: closeStopPopup,
    onScoreboardRefresh: (stopId) => loadScoreboard(stopId),
    onScoreboardVehicleSelect: (vehicleId, mType) =>
      selectVehicle(vehicleId, true, transportTypeFromMType(mType)),
  },
});

mapView.initMap('map', {
  onVehicleClick: (vehicleId) => selectVehicle(vehicleId, false),
  onStopClick: handleStopClick,
  onEmptyClick: closeStopPopup,
});
mapView.setBaseLayer(prefs.layer);

startPolling();
pollOnce();
loadRouteOptions(prefs.transport);
loadAllStops();

ui.setStatus({
  text: prefs.mock ? 'Демо-режим · маршрут №1' : 'Готово к запуску',
  live: false,
});

document.addEventListener('visibilitychange', handleVisibility);
window.addEventListener('pagehide', () => stopPolling(true));
