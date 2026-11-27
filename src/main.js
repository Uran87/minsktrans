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
const VALID_LAYERS = ['map', 'satellite', 'mmm'];

const state = {
  transport: 'bus',
  route: '',
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
  stopPopupStopId: null,
  detailsToken: 0,
  scheduleToken: 0,
  scoreboardToken: 0,
  dataGeneration: 0,
  requestId: 0,
};

const prefs = loadPrefs();

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */

function loadPrefs() {
  return {
    transport: 'bus',
    route: '',
    // При загрузке всегда открываем схему, даже если в прошлый раз был другой слой.
    layer: 'map',
    // Демо-режим берётся из сборки (по умолчанию выключен) и далее
    // переключается вручную в панели.
    mock: api.isMockEnabled(),
  };
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
 * при выборе маршрута.
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
    updateVehicleLayer();
    mapView.fitToRoute(state.routeStops, state.routeVehicles);
    renderRouteVehicles();

    const now = new Date();
    state.lastPollAt = now.getTime();

    if (routeVehicles.length > 0 && orderIds.length === 0) {
      ui.toast('Линия маршрута не построена: API не вернул порядок остановок.', 'info', 5000);
    }
  } catch (error) {
    console.error('[showRoute]', error);
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

function vehiclesForRoute(vehicles, route, transport = state.transport) {
  const targetRoute = String(route ?? '');
  const targetType = normalizeTransportType(transport) || transport;

  return vehicles.filter((vehicle) => {
    if (vehicle.route && String(vehicle.route) !== targetRoute) return false;

    const vehicleType =
      normalizeTransportType(vehicle.mtype) || normalizeTransportType(vehicle.tsType);
    return !vehicleType || vehicleType === targetType;
  });
}

const ROUTE_VEHICLES_MIN_ZOOM = 12;
const ALL_VEHICLES_MIN_ZOOM = 14;

function updateVehicleLayer() {
  const zoom = mapView.getZoom();

  if (zoom < ROUTE_VEHICLES_MIN_ZOOM) {
    mapView.updateVehicles([], state.transport);
    return;
  }

  if (zoom < ALL_VEHICLES_MIN_ZOOM) {
    const vehicles = state.route ? vehiclesForRoute(state.vehicles, state.route) : [];
    mapView.updateVehicles(vehicles, state.transport);
    return;
  }

  mapView.updateVehicles(state.vehicles, state.transport);
}

function renderRouteVehicles() {
  if (!state.routeStops.length) {
    ui.setVehiclesVisible(false);
    return;
  }

  ui.setVehiclesVisible(true);
  ui.renderVehicles(
    state.routeVehicles,
    state.transport,
    state.selectedVehicleId,
    'На маршруте пока нет машин',
    { route: state.route, routeName: currentRouteName(), stops: state.routeStops },
  );
}

function currentRouteName() {
  const routes = routeOptionsCache.get(state.transport)?.routes;
  if (!Array.isArray(routes)) return '';

  const route = String(state.route ?? '');
  const option = routes.find((item) => String(item.numl) === route);
  return option?.name ? String(option.name) : '';
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
    const fleet = await api.getAllVehicles();

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
      ? attachNextStops(vehiclesForRoute(state.vehicles, state.route))
      : [];

    updateVehicleLayer();
    renderRouteVehicles();

    state.lastPollAt = Date.now();
    state.pollErrorShown = false;
  } catch (error) {
    console.error('[poll]', error);

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

async function handleScheduleOpen() {
  const route = String(state.route || '').trim();
  if (!route) {
    ui.toast('Сначала выберите маршрут', 'error');
    return;
  }

  const transport = state.transport;
  const token = ++state.scheduleToken;

  ui.showScheduleLoading({ transport, route });

  try {
    const [schedule, stopsMap] = await Promise.all([
      api.getScheduleDay({ transport, route }),
      ensureStops().catch(() => state.stops),
    ]);

    if (token !== state.scheduleToken || !ui.isScheduleOpen()) return;

    ui.renderSchedule({
      transport,
      route,
      trips: schedule?.trips || [],
      stops: stopsMap || state.stops,
    });
  } catch (error) {
    if (token !== state.scheduleToken || !ui.isScheduleOpen()) return;

    console.warn('[schedule]', error);
    ui.renderSchedule({ transport, route, trips: [], stops: state.stops, error });
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

function handleVehicleClick(vehicleId) {
  const vehicle = state.vehicles.find(
    (item) => String(item.vehicleId) === String(vehicleId),
  );
  const type =
    normalizeTransportType(vehicle?.mtype) ||
    normalizeTransportType(vehicle?.tsType) ||
    null;

  selectVehicle(vehicleId, false, type);
}

async function findVehicleCoordinate(transport, route, vehicleId) {
  try {
    const vehicles = await api.getGeoInfo({ transport, route });
    if (!vehicles.length) return null;

    const target =
      vehicles.find((vehicle) => String(vehicle.vehicleId) === String(vehicleId)) ||
      vehicles[0];

    return target ? { lon: target.lon, lat: target.lat } : null;
  } catch (error) {
    console.warn('[scoreboardVehicle]', error);
    return null;
  }
}

async function selectScoreboardVehicle(vehicleId, mType, routeNuml) {
  const type = transportTypeFromMType(mType) || state.transport;
  const route = String(routeNuml || '').trim() || state.route;
  const typeChanged = type !== state.transport;

  closeStopPopup();
  if (ui.isDetailsOpen()) closeDetails();

  state.transport = type;
  state.route = route;
  ui.setActiveTransport(type);
  ui.setRouteValue(route);
  ui.setScheduleVisible(Boolean(route));
  savePrefs({ transport: type, route });
  loadRouteOptions(type);

  if (typeChanged) {
    state.routeGeometry = null;
  }

  state.selectedVehicleId = String(vehicleId);
  mapView.setSelectedVehicle(vehicleId);

  const routePromise = showRoute();
  openDetails(vehicleId, type);
  await routePromise;

  if (typeChanged) pollOnce();
  else renderRouteVehicles();

  const coordinate = await findVehicleCoordinate(type, route, vehicleId);
  if (
    state.selectedVehicleId !== String(vehicleId) ||
    type !== state.transport ||
    route !== state.route
  ) {
    return;
  }

  if (coordinate) {
    mapView.focusCoordinates(coordinate.lon, coordinate.lat, 16);
  } else {
    mapView.focusVehicle(vehicleId);
  }
}

function closeDetails() {
  state.detailsToken += 1;
  state.detailsVehicleId = null;
  state.selectedVehicleId = null;

  ui.closeDetails();
  mapView.clearSelection();
  renderRouteVehicles();
}

function closeSchedule() {
  state.scheduleToken += 1;
  ui.closeSchedule();
}

/* ------------------------------------------------------------------ */
/* Остановки                                                           */
/* ------------------------------------------------------------------ */

function handleStopClick(stopId, coordinate, zoom = null) {
  const stop = state.stops.get(Number(stopId));

  if (!stop) {
    ui.toast(`Остановка ${stopId} не найдена в справочнике`, 'error');
    return;
  }

  if (ui.isDetailsOpen()) closeDetails();

  state.stopPopupStopId = Number(stopId);
  const isRouteStop = state.routeStopIds.includes(Number(stopId));
  const target = mapView.focusStop(stop, zoom) || coordinate;

  ui.renderStopPopup({
    stop,
    isRouteStop,
    route: state.route,
    transport: state.transport,
  });
  mapView.showStopPopupAt(target, isRouteStop ? -44 : -30);

  loadScoreboard(Number(stopId));
}

function handleTripStopSelect(stopId) {
  handleStopClick(stopId, null, 16);
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
  state.stopPopupStopId = null;
  ui.closeStopPopup();
  mapView.hideStopPopup();
}

function handleStopsOpen() {
  if (!state.stops.size) {
    ui.toast('Справочник остановок ещё не загружен', 'error');
    return;
  }

  ui.showStopsModal({
    stops: state.stops,
    currentStopId: state.stopPopupStopId,
  });
}

function handleStopNavigate(stopId) {
  ui.closeStopsModal();
  handleStopClick(Number(stopId), null, 16);
}

/* ------------------------------------------------------------------ */
/* Обработчики UI                                                      */
/* ------------------------------------------------------------------ */

function handleSubmit({ transport, route }) {
  state.transport = TRANSPORT_TYPES.includes(transport) ? transport : 'bus';
  state.route = String(route || '').trim();
  savePrefs({ transport: state.transport, route: state.route });
  ui.setScheduleVisible(Boolean(state.route));

  if (!state.route) {
    ui.toast('Выберите маршрут', 'error');
    return;
  }

  closeDetails();
  if (ui.isScheduleOpen()) closeSchedule();
  showRoute();
}

function handleTransportChange(type) {
  if (!TRANSPORT_TYPES.includes(type)) return;

  const hadRoute = state.routeStops.length > 0 || state.loading;
  state.transport = type;
  savePrefs({ transport: type });
  loadRouteOptions(type);
  ui.setScheduleVisible(Boolean(String(state.route || '').trim()));

  closeStopPopup();
  if (ui.isDetailsOpen()) closeDetails();
  if (ui.isScheduleOpen()) closeSchedule();

  state.routeVehicles = [];
  state.routeGeometry = null;

  if (hadRoute) {
    showRoute();
  } else {
    state.routeStops = [];
    state.routeStopIds = [];
    mapView.clearRoute();
    renderRouteVehicles();
    updateVehicleLayer();
  }
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
  ui.setVehiclesVisible(false);
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
  const applyRoutes = (routes) => {
    if (transport !== state.transport) return;
    ui.renderRouteOptions(routes);
    if (state.routeStops.length) renderRouteVehicles();
  };

  const cached = routeOptionsCache.get(transport);
  if (!force && cached && Date.now() - cached.at < 60_000) {
    applyRoutes(cached.routes);
    return;
  }

  try {
    const routes = await api.getRouteList({ transport });
    routeOptionsCache.set(transport, { at: Date.now(), routes });
    applyRoutes(routes);
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
    onRouteSelect: handleSubmit,
    onTransportChange: handleTransportChange,
    onLayerChange: handleLayerChange,
    onMockChange: handleMockChange,
    onVehicleSelect: (vehicleId) => selectVehicle(vehicleId, true),
    onDetailsClose: closeDetails,
    onDetailsRetry: (vehicleId) => openDetails(vehicleId),
    onScheduleOpen: handleScheduleOpen,
    onScheduleRetry: handleScheduleOpen,
    onStopSelect: handleTripStopSelect,
    onStopPopupClose: closeStopPopup,
    onStopsOpen: handleStopsOpen,
    onStopNavigate: handleStopNavigate,
    onScoreboardRefresh: (stopId) => loadScoreboard(stopId),
    onScoreboardVehicleSelect: (vehicleId, mType, routeNuml) =>
      selectScoreboardVehicle(vehicleId, mType, routeNuml),
  },
});

mapView.initMap('map', {
  onVehicleClick: handleVehicleClick,
  onStopClick: handleStopClick,
  onEmptyClick: closeStopPopup,
  onZoomChange: updateVehicleLayer,
});
mapView.setBaseLayer(prefs.layer);

startPolling();
pollOnce();
loadRouteOptions(prefs.transport);
loadAllStops();

document.addEventListener('visibilitychange', handleVisibility);
window.addEventListener('pagehide', () => stopPolling(true));
