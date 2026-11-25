/**
 * Карта на OpenLayers: Google Tiles + слой маршрута + слой транспорта.
 *
 * Фичи транспорта переиспользуются между опросами: обновляется только
 * геометрия (feature.setGeometry) и угол иконки. Новые фичи не создаются.
 */

import OlMap from 'ol/Map.js';
import Overlay from 'ol/Overlay.js';
import View from 'ol/View.js';
import TileLayer from 'ol/layer/Tile.js';
import XYZ from 'ol/source/XYZ.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import { fromLonLat } from 'ol/proj.js';
import { getDistance } from 'ol/sphere.js';
import { createEmpty, extend, isEmpty } from 'ol/extent.js';
import { Style, Icon, Stroke, Fill, Text } from 'ol/style.js';
import { defaults as defaultControls } from 'ol/control/defaults.js';

import { TRANSPORT_COLORS, normalizeTransportType } from './constants.js';

const MINSK_CENTER = [27.5615, 53.9006];

let map = null;
let routeLayer = null;
let vehicleLayer = null;
let stopsLayer = null;
let routeSource = null;
let vehicleSource = null;
let stopsSource = null;
let clickHandler = null;
let stopClickHandler = null;
let emptyClickHandler = null;
let stopPopupOverlay = null;

let currentColor = TRANSPORT_COLORS.bus;
let selectedVehicleId = null;
let stopDisplayTier = null;

let allStopDefs = [];
let allStopGroups = { far: null, near: null };
let allStopsInput = null;
let routeStopDefs = [];
let routeStopGroups = { far: null, near: null };
let routeStopIdSet = new Set();
let routeLineFeature = null;

const FAR_CLUSTER_DISTANCE_METERS = 1000;
const NEAR_CLUSTER_DISTANCE_METERS = 200;
const NEAR_CLUSTER_MIN_ZOOM = 13;
const LABEL_MIN_ZOOM = 17;

/** vehicleId -> { feature, style, icon, color, selected } */
const vehicleEntries = new Map();
const iconCache = new Map();

/* ------------------------------------------------------------------ */
/* Иконки                                                              */
/* ------------------------------------------------------------------ */

function vehicleIconSvg(color, selected) {
  const ring = selected ? '#f8fafc' : 'rgba(255,255,255,0.55)';
  const ringWidth = selected ? 3 : 1.5;
  const glowOpacity = selected ? 0.4 : 0.18;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42" viewBox="0 0 42 42">
    <circle cx="21" cy="21" r="19" fill="${color}" fill-opacity="${glowOpacity}"/>
    <circle cx="21" cy="21" r="18" fill="none" stroke="${ring}" stroke-width="${ringWidth}"/>
    <path d="M21 7 L31 30 L21 25.4 L11 30 Z"
          fill="${color}" stroke="#0b1220" stroke-width="1.4" stroke-linejoin="round"/>
  </svg>`;
}

function vehicleIcon(color, selected) {
  const key = `${color}|${selected ? 1 : 0}`;
  if (!iconCache.has(key)) {
    iconCache.set(
      key,
      'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(vehicleIconSvg(color, selected)),
    );
  }
  return iconCache.get(key);
}

function createVehicleStyle(color, selected, vector = 0) {
  return new Style({
    image: new Icon({
      src: vehicleIcon(color, selected),
      anchor: [0.5, 0.5],
      rotation: (Number(vector) || 0) * (Math.PI / 180),
      rotateWithView: true,
      scale: selected ? 1.15 : 1,
    }),
    zIndex: selected ? 30 : 10,
  });
}

/* ------------------------------------------------------------------ */
/* Иконки остановок                                                    */
/* ------------------------------------------------------------------ */

/**
 * Знак остановки: табличка с автобусом на ножке.
 * Размер 18×15 px ≈ 0,5 см по ширине при 96 dpi.
 * Для остановок маршрута иконка увеличивается через scale.
 */
function stopSignSvg(color = null, width = 18, height = 15) {
  const signFill = color || '#f8fafc';
  const signStroke = color ? '#f8fafc' : '#0b1220';
  const glyph = '#0b1220';
  const windowFill = color || '#f8fafc';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 18 15">
    <rect x="0.8" y="0.8" width="16.4" height="13" rx="2.8"
          fill="${signFill}" stroke="${signStroke}" stroke-width="1.6"/>
    <rect x="3.6" y="3.8" width="10.8" height="7" rx="1.4" fill="${glyph}"/>
    <rect x="4.8" y="4.8" width="2.8" height="2.1" rx="0.5" fill="${windowFill}"/>
    <rect x="8.5" y="4.8" width="2.8" height="2.1" rx="0.5" fill="${windowFill}"/>
    <rect x="12.1" y="4.8" width="1.4" height="2.1" rx="0.4" fill="${windowFill}"/>
    <circle cx="5.6" cy="10.8" r="1" fill="${glyph}"/>
    <circle cx="12.4" cy="10.8" r="1" fill="${glyph}"/>
  </svg>`;
}

const stopIconCache = new Map();
const clusterIconCache = new Map();

function stopSignIcon(color = null) {
  const key = color || 'default';

  if (!stopIconCache.has(key)) {
    stopIconCache.set(
      key,
      new Icon({
        src: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(stopSignSvg(color)),
        anchor: [0.5, 1],
        scale: color ? 1.55 : 1,
        declutterMode: 'none',
      }),
    );
  }

  return stopIconCache.get(key);
}

/** Кластерный значок на 2 px больше обычного (20×17 вместо 18×15). */
function stopClusterIcon(color = null) {
  const key = color || 'default';

  if (!clusterIconCache.has(key)) {
    clusterIconCache.set(
      key,
      new Icon({
        src:
          'data:image/svg+xml;charset=UTF-8,' +
          encodeURIComponent(stopSignSvg(color, 20, 17)),
        anchor: [0.5, 1],
        scale: color ? 1.55 : 1,
        declutterMode: 'none',
      }),
    );
  }

  return clusterIconCache.get(key);
}

/* ------------------------------------------------------------------ */
/* Базовые слои                                                        */
/* ------------------------------------------------------------------ */

function googleTiles(lyrs) {
  // Важно: crossOrigin не задаём — Google не отдаёт CORS-заголовки на тайлы,
  // а для обычных <img> они и не нужны.
  return new XYZ({
    url: `https://mt1.google.com/vt/lyrs=${lyrs}&x={x}&y={y}&z={z}`,
    maxZoom: 20,
  });
}

const baseLayers = {
  map: new TileLayer({ source: googleTiles('m'), visible: true }),
  satellite: new TileLayer({ source: googleTiles('s'), visible: false }),
  hybrid: new TileLayer({ source: googleTiles('y'), visible: false }),
};

/* ------------------------------------------------------------------ */
/* Стили маршрута и остановок                                          */
/* ------------------------------------------------------------------ */

function stopLabel(name, offsetY) {
  return new Text({
    text: name || '',
    font: '600 12px Inter, "Segoe UI", system-ui, sans-serif',
    offsetY,
    padding: [3, 5, 3, 5],
    overflow: true,
    fill: new Fill({ color: '#f8fafc' }),
    stroke: new Stroke({ color: 'rgba(2, 6, 23, 0.85)', width: 3 }),
  });
}

function allStopStyle(name, showLabel = false) {
  return new Style({
    image: stopSignIcon(null),
    text: showLabel ? stopLabel(name, -20) : undefined,
  });
}

function routeLineStyle(color) {
  return [
    new Style({
      stroke: new Stroke({
        color: 'rgba(2, 6, 23, 0.65)',
        width: 10,
        lineCap: 'round',
        lineJoin: 'round',
      }),
    }),
    new Style({
      stroke: new Stroke({ color, width: 4.5, lineCap: 'round', lineJoin: 'round' }),
    }),
  ];
}

function routeStopStyle(color, name, showLabel = true) {
  return new Style({
    image: stopSignIcon(color),
    text: showLabel ? stopLabel(name, -30) : undefined,
  });
}

function clusterStopStyle(color = null) {
  return new Style({
    image: stopClusterIcon(color),
  });
}

function currentStopTier() {
  const zoom = map?.getView().getZoom() ?? 12;
  if (zoom >= LABEL_MIN_ZOOM) return 'individual';
  if (zoom < NEAR_CLUSTER_MIN_ZOOM) return 'far';
  return 'near';
}

function clusterStops(defs, distanceMeters) {
  const groups = [];

  for (const def of defs) {
    let best = null;
    let bestDistance = Infinity;

    for (const group of groups) {
      const distance = getDistance(
        [def.lon, def.lat],
        [group.lon, group.lat],
      );

      if (distance <= distanceMeters && distance < bestDistance) {
        best = group;
        bestDistance = distance;
      }
    }

    if (!best) {
      groups.push({ stops: [def], lon: def.lon, lat: def.lat });
      continue;
    }

    const count = best.stops.length;
    best.lon = (best.lon * count + def.lon) / (count + 1);
    best.lat = (best.lat * count + def.lat) / (count + 1);
    best.stops.push(def);
  }

  return groups;
}

function groupsFor(defs, cache, tier) {
  if (tier === 'individual') return null;
  if (!cache[tier]) {
    cache[tier] = clusterStops(
      defs,
      tier === 'far' ? FAR_CLUSTER_DISTANCE_METERS : NEAR_CLUSTER_DISTANCE_METERS,
    );
  }
  return cache[tier];
}

function makeStopFeature(def, kind, style) {
  const feature = new Feature({
    geometry: new Point(fromLonLat([def.lon, def.lat])),
  });
  feature.set('kind', kind);
  feature.set('stopId', def.stopId);
  feature.set('name', def.name);
  feature.setStyle(style);
  return feature;
}

function makeClusterFeature(group, style) {
  const feature = new Feature({
    geometry: new Point(fromLonLat([group.lon, group.lat])),
  });
  feature.set('kind', 'cluster');
  feature.set('stopIds', group.stops.map((stop) => stop.stopId));
  feature.set('name', `${group.stops.length} остановки`);
  feature.setStyle(style);
  return feature;
}

function displayStopFeatures(defs, groups, tier, color, kind) {
  if (tier === 'individual') {
    return defs.map((def) => {
      const showLabel = color ? true : !routeStopIdSet.has(def.stopId);
      return makeStopFeature(
        def,
        kind,
        color
          ? routeStopStyle(color, def.name, showLabel)
          : allStopStyle(def.name, showLabel),
      );
    });
  }

  return groups.map((group) => {
    if (group.stops.length === 1) {
      const def = group.stops[0];
      return makeStopFeature(
        def,
        kind,
        color ? routeStopStyle(color, def.name, false) : allStopStyle(def.name, false),
      );
    }

    return makeClusterFeature(group, clusterStopStyle(color));
  });
}

function renderAllStopsDisplay() {
  if (!stopsSource) return;

  const tier = currentStopTier();
  stopDisplayTier = tier;
  const groups = groupsFor(allStopDefs, allStopGroups, tier);
  stopsSource.clear();
  stopsSource.addFeatures(
    displayStopFeatures(allStopDefs, groups, tier, null, 'allstop'),
  );
}

function renderRouteStopsDisplay() {
  if (!routeSource) return;

  const tier = currentStopTier();
  routeSource.clear();
  if (routeLineFeature) routeSource.addFeature(routeLineFeature);
  routeSource.addFeatures(
    displayStopFeatures(
      routeStopDefs,
      groupsFor(routeStopDefs, routeStopGroups, tier),
      tier,
      currentColor,
      'stop',
    ),
  );
}

function updateStopDisplay() {
  if (!map) return;

  const tier = currentStopTier();
  if (tier === stopDisplayTier) return;

  stopDisplayTier = tier;
  renderAllStopsDisplay();
  renderRouteStopsDisplay();

  // В некоторых версиях OL смены стиля фичи недостаточно для перерисовки
  // слоя с declutter — явно просим слой обновиться.
  stopsLayer?.changed();
  routeLayer?.changed();
}

/* ------------------------------------------------------------------ */
/* Инициализация                                                       */
/* ------------------------------------------------------------------ */

export function initMap(target, { onVehicleClick, onStopClick, onEmptyClick } = {}) {
  clickHandler = onVehicleClick;
  stopClickHandler = onStopClick;
  emptyClickHandler = onEmptyClick;

  stopsSource = new VectorSource({ attributions: 'Данные: СНОиПД' });
  routeSource = new VectorSource({ attributions: 'Данные: СНОиПД' });
  vehicleSource = new VectorSource({ attributions: 'Данные: СНОиПД' });

  stopsLayer = new VectorLayer({
    source: stopsSource,
    opacity: 0.9,
    declutter: true,
    updateWhileAnimating: false,
    updateWhileInteracting: false,
  });

  routeLayer = new VectorLayer({
    source: routeSource,
    declutter: true,
    updateWhileAnimating: false,
    updateWhileInteracting: false,
  });

  vehicleLayer = new VectorLayer({
    source: vehicleSource,
    updateWhileAnimating: true,
    updateWhileInteracting: true,
  });

  map = new OlMap({
    target,
    layers: [
      baseLayers.map,
      baseLayers.satellite,
      baseLayers.hybrid,
      stopsLayer,
      routeLayer,
      vehicleLayer,
    ],
    view: new View({
      center: fromLonLat(MINSK_CENTER),
      zoom: 12,
      minZoom: 9,
      maxZoom: 19,
      constrainResolution: false,
    }),
    controls: defaultControls({
      attributionOptions: { collapsible: false },
    }),
  });

  map.on('singleclick', (event) => {
    const vehicleFeature = map.forEachFeatureAtPixel(
      event.pixel,
      (candidate) => candidate,
      {
        hitTolerance: 10,
        layerFilter: (layer) => layer === vehicleLayer,
      },
    );

    if (vehicleFeature) {
      const vehicleId = vehicleFeature.get('vehicleId');
      if (vehicleId !== undefined && vehicleId !== null && clickHandler) {
        clickHandler(vehicleId);
      }
      return;
    }

    const stopFeature = map.forEachFeatureAtPixel(
      event.pixel,
      (candidate) => candidate,
      {
        hitTolerance: 10,
        layerFilter: (layer) => layer === routeLayer || layer === stopsLayer,
      },
    );

    const stopId = stopFeature?.get('stopId');
    if (stopFeature?.get('kind') === 'cluster') {
      const geometry = stopFeature.getGeometry();
      const coordinate = geometry?.getCoordinates?.();
      if (coordinate) {
        const view = map.getView();
        const currentZoom = view.getZoom() ?? 12;
        const targetZoom =
          currentZoom < NEAR_CLUSTER_MIN_ZOOM ? NEAR_CLUSTER_MIN_ZOOM : LABEL_MIN_ZOOM;

        view.animate({
          center: coordinate,
          zoom: targetZoom,
          duration: 500,
        });
      }
      return;
    }

    if (stopId !== undefined && stopId !== null) {
      const geometry = stopFeature.getGeometry();
      const coordinate = geometry?.getCoordinates?.() || event.coordinate;
      stopClickHandler?.(stopId, coordinate);
      return;
    }

    emptyClickHandler?.();
  });

  map.on('pointermove', (event) => {
    if (event.dragging) return;
    const targetElement = map.getTargetElement();
    if (!targetElement) return;

    const feature = map.forEachFeatureAtPixel(
      event.pixel,
      (candidate) => candidate,
      {
        hitTolerance: 8,
        layerFilter: (layer) => layer === vehicleLayer || layer === stopsLayer || layer === routeLayer,
      },
    );

    const interactive =
      feature &&
      (feature.get('vehicleId') !== undefined ||
        feature.get('stopId') !== undefined ||
        feature.get('kind') === 'cluster');

    targetElement.style.cursor = interactive ? 'pointer' : '';
  });

  const popupElement = document.getElementById('stop-popup');
  if (popupElement) {
    stopPopupOverlay = new Overlay({
      element: popupElement,
      positioning: 'bottom-center',
      offset: [0, -14],
      stopEvent: true,
      autoPan: { margin: 24, animation: { duration: 250 } },
    });
    map.addOverlay(stopPopupOverlay);
  }

  map.on('moveend', updateStopDisplay);

  return map;
}

export function showStopPopupAt(coordinate, offsetY = -30) {
  if (!stopPopupOverlay) return;
  stopPopupOverlay.setOffset([0, offsetY]);
  stopPopupOverlay.setPosition(coordinate);
}

export function hideStopPopup() {
  stopPopupOverlay?.setPosition(undefined);
}

/* ------------------------------------------------------------------ */
/* Все остановки                                                       */
/* ------------------------------------------------------------------ */

export function setAllStops(stops) {
  if (!stopsSource) return;

  if (stops === allStopsInput && allStopDefs.length) {
    renderAllStopsDisplay();
    return;
  }

  const list = stops instanceof Map ? [...stops.values()] : Array.isArray(stops) ? stops : [];
  allStopsInput = stops;
  allStopDefs = [];

  for (const stop of list) {
    if (!stop) continue;
    const lon = Number(stop.lon);
    const lat = Number(stop.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    allStopDefs.push({
      stopId: stop.stopId,
      name: stop.name,
      lon,
      lat,
    });
  }

  allStopGroups = { far: null, near: null };
  renderAllStopsDisplay();
}

export function clearAllStops() {
  allStopDefs = [];
  allStopGroups = { far: null, near: null };
  allStopsInput = null;
  stopsSource?.clear();
}

/* ------------------------------------------------------------------ */
/* Маршрут                                                             */
/* ------------------------------------------------------------------ */

export function setRoute(stops, transport, geometryLine = null) {
  if (!routeSource) return;

  const type = normalizeTransportType(transport) || transport;
  currentColor = TRANSPORT_COLORS[type] || TRANSPORT_COLORS.bus;

  const coordinates = [];
  const addCoordinate = (lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const coordinate = fromLonLat([lon, lat]);
    const previous = coordinates[coordinates.length - 1];
    if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
      coordinates.push(coordinate);
    }
  };

  if (Array.isArray(geometryLine) && geometryLine.length >= 2) {
    for (const point of geometryLine) {
      if (Array.isArray(point)) addCoordinate(Number(point[0]), Number(point[1]));
      else addCoordinate(Number(point?.lon), Number(point?.lat));
    }
  } else {
    for (const stop of stops) addCoordinate(stop.lon, stop.lat);
  }

  routeLineFeature = null;
  if (coordinates.length > 1) {
    const line = new Feature({ geometry: new LineString(coordinates) });
    line.set('kind', 'line');
    line.setStyle(routeLineStyle(currentColor));
    routeLineFeature = line;
  }

  routeStopDefs = [];

  for (const stop of stops) {
    const lon = Number(stop.lon);
    const lat = Number(stop.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    routeStopDefs.push({
      stopId: stop.stopId,
      name: stop.name,
      lon,
      lat,
    });
  }

  routeStopGroups = { far: null, near: null };
  routeStopIdSet = new Set(routeStopDefs.map((stop) => stop.stopId));
  renderRouteStopsDisplay();
  renderAllStopsDisplay();
}

export function clearRoute() {
  routeLineFeature = null;
  routeStopDefs = [];
  routeStopGroups = { far: null, near: null };
  routeStopIdSet = new Set();
  routeSource?.clear();
  renderAllStopsDisplay();
}

/* ------------------------------------------------------------------ */
/* Транспорт                                                           */
/* ------------------------------------------------------------------ */

function applySelection(entry, selected) {
  entry.selected = selected;
  entry.icon.setSrc(vehicleIcon(entry.color, selected));
  entry.icon.setScale(selected ? 1.15 : 1);
  entry.style.setZIndex(selected ? 30 : 10);
}

export function updateVehicles(vehicles, transport) {
  if (!vehicleSource) return;

  const type = normalizeTransportType(transport) || transport;
  const color = TRANSPORT_COLORS[type] || TRANSPORT_COLORS.bus;
  const seen = new Set();

  for (const vehicle of vehicles) {
    const key = String(vehicle.vehicleId);
    seen.add(key);

    let entry = vehicleEntries.get(key);
    const coordinate = fromLonLat([vehicle.lon, vehicle.lat]);

    if (!entry) {
      const selected = selectedVehicleId !== null && selectedVehicleId === key;
      const style = createVehicleStyle(color, selected, vehicle.vector);
      const feature = new Feature({ geometry: new Point(coordinate) });
      feature.set('vehicleId', vehicle.vehicleId);
      feature.set('vehicle', vehicle);
      feature.setStyle(style);

      const icon = style.getImage();
      entry = { feature, style, icon, color, selected };
      vehicleEntries.set(key, entry);
      vehicleSource.addFeature(feature);
    } else {
      entry.feature.setGeometry(new Point(coordinate));
      entry.feature.set('vehicle', vehicle);

      if (entry.color !== color) {
        entry.color = color;
        entry.icon.setSrc(vehicleIcon(color, entry.selected));
      }

      entry.icon.setRotation(((Number(vehicle.vector) || 0) * Math.PI) / 180);
      entry.style.setZIndex(entry.selected ? 30 : 10);
    }
  }

  for (const [key, entry] of vehicleEntries) {
    if (!seen.has(key)) {
      vehicleSource.removeFeature(entry.feature);
      vehicleEntries.delete(key);
    }
  }
}

export function clearVehicles() {
  vehicleSource?.clear();
  vehicleEntries.clear();
}

export function setSelectedVehicle(vehicleId) {
  selectedVehicleId = vehicleId === null || vehicleId === undefined ? null : String(vehicleId);

  for (const [key, entry] of vehicleEntries) {
    applySelection(entry, selectedVehicleId === key);
  }

  map?.render();
}

export function clearSelection() {
  setSelectedVehicle(null);
}

export function focusVehicle(vehicleId) {
  if (!map) return;
  const entry = vehicleEntries.get(String(vehicleId));
  const geometry = entry?.feature.getGeometry();
  if (!geometry) return;

  const view = map.getView();
  view.animate({
    center: geometry.getCoordinates(),
    zoom: Math.max(view.getZoom() ?? 12, 15),
    duration: 500,
  });
}

export function focusCoordinates(lon, lat, zoom = 16) {
  if (!map) return;

  const view = map.getView();
  view.animate({
    center: fromLonLat([lon, lat]),
    zoom: Math.max(view.getZoom() ?? 12, zoom),
    duration: 500,
  });
}

/**
 * Приближает/центрирует карту к остановке и возвращает её координату,
 * чтобы можно было сразу показать попап. Центр учитывает левую панель.
 */
function visibleMapCenter() {
  const size = map.getSize();
  if (!size) return [0, 0];

  let left = 0;
  const sidebar = document.getElementById('sidebar');

  if (sidebar) {
    const style = getComputedStyle(sidebar);
    const rect = sidebar.getBoundingClientRect();
    const viewport = map.getViewport().getBoundingClientRect();

    if (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.right > viewport.left &&
      rect.left < viewport.right
    ) {
      left = Math.max(0, Math.min(rect.right - viewport.left, size[0]));
    }
  }

  return [left + (size[0] - left) / 2, size[1] / 2];
}

export function focusStop(stop, zoom = null) {
  const coordinate = fromLonLat([stop.lon, stop.lat]);
  if (!map) return coordinate;

  const view = map.getView();
  const size = map.getSize();
  const targetPixel = visibleMapCenter();

  if (!size) {
    view.animate({ center: coordinate, duration: 500 });
    return coordinate;
  }

  const currentZoom = view.getZoom() ?? 12;
  const targetZoom = zoom === null ? currentZoom : Math.max(currentZoom, zoom);
  const resolution = view.getResolutionForZoom(targetZoom);

  const center = [
    coordinate[0] - (targetPixel[0] - size[0] / 2) * resolution,
    coordinate[1] + (targetPixel[1] - size[1] / 2) * resolution,
  ];

  view.animate({
    center,
    zoom: targetZoom,
    duration: 500,
  });

  return coordinate;
}

/* ------------------------------------------------------------------ */
/* Прочее                                                              */
/* ------------------------------------------------------------------ */

export function fitToRoute(stops, vehicles = []) {
  if (!map) return;

  const extent = createEmpty();

  for (const stop of stops) extend(extent, fromLonLat([stop.lon, stop.lat]));
  if (stops.length < 2) {
    for (const vehicle of vehicles) extend(extent, fromLonLat([vehicle.lon, vehicle.lat]));
  }

  if (isEmpty(extent)) return;

  const leftPadding = window.innerWidth > 950 ? 400 : 70;
  map.getView().fit(extent, {
    padding: [90, 90, 90, leftPadding],
    maxZoom: 14.5,
    duration: 700,
  });
}

export function setBaseLayer(name) {
  const selected = baseLayers[name] ? name : 'map';
  for (const [key, layer] of Object.entries(baseLayers)) {
    layer.setVisible(key === selected);
  }
}

export function getMap() {
  return map;
}
