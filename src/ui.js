/**
 * Слой интерфейса: панель, список машин, карточка машины, тосты, лоадер.
 * Не знает про API и карту — общается с main.js через колбэки.
 */

import {
  TRANSPORT_COLORS,
  TRANSPORT_LABELS,
  TRANSPORT_TYPES,
  directionLabel,
  formatClock,
  formatDeparture,
  hexToRgba,
  mTypeBadge,
  normalizeTransportType,
  pluralize,
  transportTypeFromMType,
} from './constants.js';

const els = {};
let handlers = {};
let currentTransport = 'bus';

/* ------------------------------------------------------------------ */
/* Утилиты                                                             */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/* ------------------------------------------------------------------ */
/* Инициализация                                                       */
/* ------------------------------------------------------------------ */

export function init(config) {
  handlers = config.handlers || {};

  els.sidebar = document.getElementById('sidebar');
  els.hamburger = document.getElementById('hamburger');
  els.sidebarClose = document.getElementById('sidebar-close');
  els.form = document.getElementById('route-form');
  els.transportToggle = document.getElementById('transport-toggle');
  els.routeInput = document.getElementById('route-input');
  els.showBtn = document.getElementById('show-btn');
  els.showBtnLabel = document.getElementById('show-btn-label');
  els.stopBtn = document.getElementById('stop-btn');
  els.statusText = document.getElementById('status-text');
  els.statusTime = document.getElementById('last-update');
  els.liveDot = document.getElementById('live-dot');
  els.vehiclesCount = document.getElementById('vehicles-count');
  els.vehiclesBadge = document.getElementById('vehicles-badge');
  els.vehiclesList = document.getElementById('vehicles-list');
  els.layerToggle = document.getElementById('layer-toggle');
  els.mockToggle = document.getElementById('mock-toggle');
  els.apiBaseLabel = document.getElementById('api-base-label');
  els.details = document.getElementById('details');
  els.detailsKicker = document.getElementById('details-kicker');
  els.detailsTitle = document.getElementById('details-title');
  els.detailsBody = document.getElementById('details-body');
  els.detailsClose = document.getElementById('details-close');
  els.stopPopup = document.getElementById('stop-popup');
  els.stopPopupBody = document.getElementById('stop-popup-body');
  els.stopPopupClose = document.getElementById('stop-popup-close');
  els.toasts = document.getElementById('toasts');
  els.loadingBar = document.getElementById('loading-bar');

  setActiveTransport(config.transport || 'bus');
  els.routeInput.value = config.route || '1';
  els.mockToggle.checked = Boolean(config.mock);
  els.apiBaseLabel.textContent = config.apiBase || '/api/v1';
  setActiveLayer(config.layer || 'map');

  wireEvents();
}

function wireEvents() {
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const route = els.routeInput.value.trim();
    handlers.onSubmit?.({ transport: currentTransport, route });
  });

  els.transportToggle.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-type]');
    if (!button) return;
    const type = button.dataset.type;
    if (!type || type === currentTransport) return;
    setActiveTransport(type);
    handlers.onTransportChange?.(type);
  });

  els.stopBtn.addEventListener('click', () => handlers.onStop?.());

  els.layerToggle.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-layer]');
    if (!button) return;
    const layer = button.dataset.layer;
    if (!layer) return;
    setActiveLayer(layer);
    handlers.onLayerChange?.(layer);
  });

  els.mockToggle.addEventListener('change', () => {
    handlers.onMockChange?.(els.mockToggle.checked);
  });

  els.vehiclesList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-vehicle-id]');
    if (!button) return;
    handlers.onVehicleSelect?.(button.dataset.vehicleId);
  });

  els.detailsClose.addEventListener('click', () => handlers.onDetailsClose?.());

  els.stopPopupClose?.addEventListener('click', () => handlers.onStopPopupClose?.());

  els.stopPopupBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-scoreboard-refresh-id], [data-scoreboard-retry-id]');
    if (!button) return;

    const stopId = button.dataset.scoreboardRefreshId ?? button.dataset.scoreboardRetryId;
    if (stopId !== undefined) handlers.onScoreboardRefresh?.(Number(stopId));
  });

  els.detailsBody.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-retry-id]');
    if (!button) return;
    handlers.onDetailsRetry?.(button.dataset.retryId);
  });

  els.hamburger.addEventListener('click', () => setSidebarOpen(true));
  els.sidebarClose.addEventListener('click', () => setSidebarOpen(false));

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.stopPopup.hidden) handlers.onStopPopupClose?.();
    if (!els.details.hidden) handlers.onDetailsClose?.();
    setSidebarOpen(false);
  });
}

/* ------------------------------------------------------------------ */
/* Панель                                                              */
/* ------------------------------------------------------------------ */

export function setActiveTransport(type) {
  const safeType = TRANSPORT_TYPES.includes(type) ? type : 'bus';
  currentTransport = safeType;

  const color = TRANSPORT_COLORS[safeType];
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-soft', hexToRgba(color, 0.14));
  document.documentElement.style.setProperty('--accent-glow', hexToRgba(color, 0.35));

  els.transportToggle.querySelectorAll('button[data-type]').forEach((button) => {
    const active = button.dataset.type === safeType;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

export function getTransport() {
  return currentTransport;
}

export function setActiveLayer(layer) {
  els.layerToggle.querySelectorAll('button[data-layer]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.layer === layer);
  });
}

export function setMockChecked(checked) {
  els.mockToggle.checked = Boolean(checked);
}

export function setLoading(loading) {
  els.loadingBar.classList.toggle('is-active', loading);
  els.showBtn.classList.toggle('is-loading', loading);
  els.showBtn.disabled = loading;
  els.showBtnLabel.textContent = loading ? 'Загрузка…' : 'Показать маршрут';
}

export function setStopEnabled(enabled) {
  els.stopBtn.disabled = !enabled;
}

export function setStatus({ text, time = null, live = false, error = false }) {
  els.statusText.textContent = text || '';
  els.statusTime.textContent = time ? formatClock(new Date(time)) : '';
  els.statusTime.dateTime = time ? new Date(time).toISOString() : '';

  els.liveDot.classList.toggle('is-live', Boolean(live) && !error);
  els.liveDot.classList.toggle('is-error', Boolean(error));
}

export function renderVehicles(vehicles, transport, selectedId = null, emptyText = null, context = {}) {
  const count = vehicles.length;
  const type = normalizeTransportType(transport) || 'bus';
  const color = TRANSPORT_COLORS[type] || TRANSPORT_COLORS.bus;
  const typeLabel = TRANSPORT_LABELS[type] || 'Транспорт';
  const routeNumber = context.route ? String(context.route).trim() : '';
  const routeTitle = routeNumber ? `${typeLabel} №${routeNumber}` : typeLabel;

  els.vehiclesCount.textContent = `${count} ${pluralize(count, ['машина', 'машины', 'машин'])}`;
  els.vehiclesBadge.textContent = String(count);

  if (!count) {
    els.vehiclesList.innerHTML = `<li class="empty">${esc(
      emptyText || 'Нажмите «Показать маршрут»',
    )}</li>`;
    return;
  }

  els.vehiclesList.innerHTML = vehicles
    .map((vehicle) => {
      const id = String(vehicle.vehicleId);
      const active = selectedId !== null && String(selectedId) === id;
      return `<li>
        <button type="button" class="vehicle-item${active ? ' is-active' : ''}"
                data-vehicle-id="${esc(id)}" title="Борт ${esc(id)}"
                aria-label="Открыть карточку: ${esc(routeTitle)}, борт ${esc(id)}">
          <span class="vehicle-dot" style="--dot-color:${color}" aria-hidden="true"></span>
          <span class="vehicle-main">
            <strong>${esc(routeTitle)}</strong>
            <small>${esc(directionLabel(vehicle.direction))}</small>
            ${vehicle.nextStopName ? `<small class="vehicle-next" title="Следующая остановка">→ ${esc(vehicle.nextStopName)}</small>` : ''}
          </span>
          <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </li>`;
    })
    .join('');
}

export function setSidebarOpen(open) {
  els.sidebar.classList.toggle('is-open', Boolean(open));
}

/* ------------------------------------------------------------------ */
/* Карточка машины                                                     */
/* ------------------------------------------------------------------ */

export function showDetailsLoading(vehicleId, transport) {
  const type = normalizeTransportType(transport) || 'bus';
  els.details.hidden = false;
  els.detailsKicker.textContent = `${TRANSPORT_LABELS[type] || 'Транспорт'} · борт ${vehicleId}`;
  els.detailsTitle.textContent = 'Загрузка…';
  els.detailsBody.innerHTML = `
    <div class="skeleton-meta">
      <span class="skeleton"></span><span class="skeleton"></span>
      <span class="skeleton"></span><span class="skeleton"></span>
    </div>
    <div class="skeleton-list">
      <span class="skeleton"></span><span class="skeleton"></span>
      <span class="skeleton"></span><span class="skeleton"></span>
      <span class="skeleton"></span>
    </div>`;
}

export function renderDetails({
  vehicle,
  trip,
  stops,
  transport,
  fallbackTransport,
  scheduleError = null,
}) {
  const type =
    normalizeTransportType(vehicle.tsType) || normalizeTransportType(transport) || normalizeTransportType(fallbackTransport) || 'bus';

  const routeNumber = vehicle.marNuml || vehicle.marNum || '—';
  const title = vehicle.gosnum || `Борт ${vehicle.vehicleId}`;
  const tripNumber = trip?.tripNum ?? vehicle.tripNum ?? vehicle.tripId ?? null;
  const lastStopId = Number(vehicle.lastStopId);
  const lastStop = stops.get(lastStopId);

  els.details.hidden = false;
  els.detailsKicker.textContent = `${TRANSPORT_LABELS[type] || 'Транспорт'} · маршрут №${routeNumber}`;
  els.detailsTitle.textContent = title;

  const metaItems = [
    ['Модель', vehicle.model || vehicle.tsTypeAdd || '—'],
    ['Маршрут', routeNumber],
    ['Рейс', tripNumber !== null && tripNumber !== '' ? tripNumber : '—'],
    ['Направление', directionLabel(vehicle.direction)],
    ['Последняя остановка', lastStop?.name || '—'],
    ['Госномер', vehicle.gosnum || '—'],
  ];

  let lastIndex = -1;
  let nextIndex = -1;

  if (trip) {
    lastIndex = trip.stops.findIndex((stop) => stop.stopId === lastStopId);
    if (lastIndex >= 0 && lastIndex < trip.stops.length - 1) nextIndex = lastIndex + 1;
  }

  const rows = trip
    ? trip.stops
        .map((stop, index) => {
          const info = stops.get(stop.stopId);
          const name = info?.name || `Остановка ${stop.stopId}`;
          const isPast = lastIndex >= 0 && index <= lastIndex;
          const isNext = index === nextIndex;

          const classes = ['stop-item'];
          if (isPast) classes.push('is-past');
          if (isNext) classes.push('is-next');

          let flag = '';
          if (isNext) flag = '<span class="stop-flag">следующая</span>';
          else if (index === lastIndex) flag = '<span class="stop-flag is-muted">пройдена</span>';

          return `<li class="${classes.join(' ')}">
            <span class="stop-time">${esc(formatDeparture(stop.departures))}</span>
            <span class="stop-dot" aria-hidden="true"></span>
            <span class="stop-info">
              <span class="stop-name">${esc(name)}</span>
              ${flag}
            </span>
          </li>`;
        })
        .join('')
    : '';

  const stopsNote = !trip
    ? `<p class="empty-note">${
        scheduleError
          ? `Расписание недоступно: ${esc(scheduleError.message)}`
          : 'Рейс не найден в расписании на день. Показаны только данные машины.'
      }</p>`
    : '';

  const scheduleWarning =
    scheduleError && trip
      ? `<p class="warn">Часть данных расписания недоступна: ${esc(scheduleError.message)}</p>`
      : '';

  els.detailsBody.innerHTML = `
    <dl class="meta-grid">
      ${metaItems
        .map(
          ([label, value]) =>
            `<div class="meta-item"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`,
        )
        .join('')}
    </dl>
    ${scheduleWarning}
    <div class="stops-head">
      <h3>Остановки рейса</h3>
      <span>${trip ? `${trip.stops.length} ${pluralize(trip.stops.length, ['остановка', 'остановки', 'остановок'])}` : 'нет данных'}</span>
    </div>
    ${stopsNote}
    ${rows ? `<div class="stop-scroll"><ol class="stop-list">${rows}</ol></div>` : ''}
  `;

  centerNextStop();
}

/**
 * Прокручивает список остановок так, чтобы следующая остановка была
 * в середине видимой области (насколько позволяет высота списка).
 */
function centerNextStop() {
  const scroller = els.detailsBody.querySelector('.stop-scroll');
  const target = scroller?.querySelector('.stop-item.is-next');
  if (!scroller || !target) return;

  const align = () => {
    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const delta =
      targetRect.top + targetRect.height / 2 - (scrollerRect.top + scroller.clientHeight / 2);
    scroller.scrollTop += delta;
  };

  align();
  requestAnimationFrame(align);
}

export function renderDetailsError(vehicleId, error) {
  els.details.hidden = false;
  els.detailsKicker.textContent = `Борт ${vehicleId}`;
  els.detailsTitle.textContent = 'Не удалось загрузить';
  els.detailsBody.innerHTML = `
    <p class="warn">${esc(error?.message || 'Неизвестная ошибка')}</p>
    <button type="button" class="btn btn-ghost btn-sm" data-retry-id="${esc(vehicleId)}">Повторить</button>`;
}

export function closeDetails() {
  els.details.hidden = true;
  els.detailsBody.innerHTML = '';
  els.detailsTitle.textContent = '—';
  els.detailsKicker.textContent = 'Транспорт';
}

export function isDetailsOpen() {
  return !els.details.hidden;
}

/* ------------------------------------------------------------------ */
/* Попап остановки                                                     */
/* ------------------------------------------------------------------ */

export function renderStopPopup({ stop, isRouteStop = false, route, transport }) {
  if (!els.stopPopup || !stop) return;

  const typeLabel = TRANSPORT_LABELS[normalizeTransportType(transport)] || 'Транспорт';
  const title = stop.name || stop.nameRu || `Остановка ${stop.stopId}`;

  const rows = [['ID остановки', stop.stopId]];

  if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) {
    rows.push(['Координаты', `${stop.lat.toFixed(6)}, ${stop.lon.toFixed(6)}`]);
  }

  if (stop.nameBy && stop.nameBy !== title) rows.push(['Па-беларуску', stop.nameBy]);
  if (stop.nameEn && stop.nameEn !== title) rows.push(['English', stop.nameEn]);
  if (stop.mspsid) rows.push(['MSPS ID', stop.mspsid]);

  els.stopPopup.classList.toggle('is-route', Boolean(isRouteStop));
  els.stopPopupBody.innerHTML = `
    <span class="stop-popup-kicker">${isRouteStop ? 'Остановка маршрута' : 'Остановка'}</span>
    <h3>${esc(title)}</h3>
    <span class="stop-popup-badge${isRouteStop ? '' : ' is-muted'}">
      ${isRouteStop ? `${esc(typeLabel)} · маршрут №${esc(route || '—')}` : 'Все остановки'}
    </span>
    <dl class="stop-popup-list">
      ${rows
        .map(
          ([label, value]) =>
            `<div class="stop-popup-row"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`,
        )
        .join('')}
    </dl>
    <section class="stop-scoreboard" data-stop-scoreboard aria-live="polite"></section>`;

  els.stopPopup.hidden = false;
}

/* ------------------------------------------------------------------ */
/* Табло остановки                                                     */
/* ------------------------------------------------------------------ */

function getScoreboardElement() {
  return els.stopPopupBody?.querySelector('[data-stop-scoreboard]') || null;
}

function formatArrival(arrival = {}) {
  const attribute = String(arrival.attribute ?? '').trim();
  const seconds = Number(arrival.estimated);
  const distance = Number(arrival.distance);
  const vehicleId = Number(arrival.vehicleId);

  let text = '—';
  let now = false;
  let empty = true;

  if (/^[aа]$/i.test(attribute)) {
    text = 'сейчас';
    now = true;
    empty = false;
  } else if (/^\d+$/.test(attribute)) {
    const minutes = Number(attribute);
    if (minutes <= 0) {
      text = 'сейчас';
      now = true;
    } else {
      text = `${minutes} мин`;
    }
    empty = false;
  } else if (Number.isFinite(seconds) && seconds > 30) {
    text = `${Math.max(1, Math.round(seconds / 60))} мин`;
    empty = false;
  } else if (Number.isFinite(seconds) && (vehicleId > 0 || seconds > 0)) {
    text = 'сейчас';
    now = true;
    empty = false;
  }

  const titleParts = [];
  if (Number.isFinite(distance) && distance > 0) titleParts.push(`${distance} м до остановки`);
  if (Number.isFinite(seconds)) {
    titleParts.push(
      seconds > 30
        ? `расчётное прибытие ≈ ${Math.round(seconds / 60)} мин`
        : 'расчётное прибытие: сейчас',
    );
  }

  return { text, now, empty, title: titleParts.join(' · ') || 'нет данных' };
}

function renderEtaPill(arrival, className = '', label = 'Прибытие') {
  const eta = formatArrival(arrival);
  const classes = ['eta-pill'];
  if (className) classes.push(className);
  if (eta.now) classes.push('is-now');
  if (eta.empty) classes.push('is-empty');

  return `<span class="${classes.join(' ')}" title="${esc(eta.title)}"
    aria-label="${esc(label)}: ${esc(eta.text)}">${esc(eta.text)}</span>`;
}

export function renderScoreboardLoading() {
  const box = getScoreboardElement();
  if (!box) return;

  box.innerHTML = `
    <div class="scoreboard-head">
      <div>
        <h4>Табло остановки</h4>
        <span class="scoreboard-sub">Запрашиваем прибытие…</span>
      </div>
    </div>
    <div class="scoreboard-loading">
      <span class="mini-spinner" aria-hidden="true"></span>
      <span>Загрузка табло…</span>
    </div>`;
}

export function renderScoreboard({ stopId, routes = [], updatedAt = new Date() }) {
  const box = getScoreboardElement();
  if (!box) return;

  const count = routes.length;
  const rows = routes
    .map((route) => {
      const type = transportTypeFromMType(route.mType);
      const color = TRANSPORT_COLORS[type] || '#94a3b8';
      const badgeStyle = `--type-color:${color};--type-soft:${hexToRgba(color, 0.16)};--type-border:${hexToRgba(color, 0.35)}`;
      const destination = route.endStopName || '—';

      return `<li class="score-row">
        <span class="score-type" style="${badgeStyle}" title="${esc(TRANSPORT_LABELS[type] || route.mType || 'Транспорт')}">
          ${esc(mTypeBadge(route.mType, type))}
        </span>
        <span class="score-route">
          <strong>${esc(route.numl)}</strong>
          <small title="${esc(destination)}">→ ${esc(destination)}</small>
        </span>
        <span class="score-etas">
          ${renderEtaPill(route.first, '', 'Ближайший')}
          ${renderEtaPill(route.next, 'is-next', 'Следующий')}
        </span>
      </li>`;
    })
    .join('');

  box.innerHTML = `
    <div class="scoreboard-head">
      <div>
        <h4>Табло остановки</h4>
        <span class="scoreboard-sub">
          ${count} ${pluralize(count, ['маршрут', 'маршрута', 'маршрутов'])} · 2 ближайших · обновлено ${formatClock(new Date(updatedAt))}
        </span>
      </div>
      <button type="button" class="scoreboard-refresh" data-scoreboard-refresh-id="${esc(stopId)}"
              aria-label="Обновить табло остановки" title="Обновить табло">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0-2.34 6.34M20 4v7h-7" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
    ${
      rows
        ? `<ul class="scoreboard-list">${rows}</ul>`
        : '<p class="empty-note">На этой остановке сейчас нет данных о маршрутах.</p>'
    }`;
}

export function renderScoreboardError(stopId, error) {
  const box = getScoreboardElement();
  if (!box) return;

  box.innerHTML = `
    <div class="scoreboard-head">
      <div>
        <h4>Табло остановки</h4>
        <span class="scoreboard-sub">не удалось загрузить</span>
      </div>
    </div>
    <p class="scoreboard-error">${esc(error?.message || 'Ошибка API')}</p>
    <button type="button" class="btn btn-ghost btn-sm" data-scoreboard-retry-id="${esc(stopId)}">
      Повторить
    </button>`;
}

export function closeStopPopup() {
  if (!els.stopPopup) return;
  els.stopPopup.hidden = true;
  els.stopPopupBody.innerHTML = '';
  els.stopPopup.classList.remove('is-route');
}

/* ------------------------------------------------------------------ */
/* Тосты                                                               */
/* ------------------------------------------------------------------ */

export function toast(message, type = 'info', ttl = 5200) {
  const node = document.createElement('div');
  node.className = `toast toast-${type}`;
  node.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Закрыть уведомление');
  close.textContent = '×';

  node.append(text, close);
  els.toasts.append(node);

  while (els.toasts.children.length > 4) {
    els.toasts.firstElementChild?.remove();
  }

  let timer = setTimeout(() => node.remove(), ttl);

  close.addEventListener('click', () => {
    clearTimeout(timer);
    node.remove();
  });

  node.addEventListener('mouseenter', () => clearTimeout(timer));
  node.addEventListener('mouseleave', () => {
    timer = setTimeout(() => node.remove(), 1800);
  });
}
