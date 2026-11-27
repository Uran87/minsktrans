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
let routeOptions = [];
let routeFiltered = [];
let routeActiveIndex = -1;
let routeMenuShowAll = true;

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

/** Направление для строки списка: строчными, без нагромождения «направление». */
function directionCaption(direction) {
  if (direction === null || direction === undefined || direction === '') return 'не указано';
  const n = Number(direction);
  if (n === 0) return 'прямое';
  if (n === 1) return 'обратное';
  return 'не указано';
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
  els.routeMenu = document.getElementById('route-menu');
  els.vehiclesBlock = document.getElementById('vehicles-block');
  els.vehiclesBadge = document.getElementById('vehicles-badge');
  els.vehiclesRoute = document.getElementById('vehicles-route');
  els.vehiclesList = document.getElementById('vehicles-list');
  els.layerToggle = document.getElementById('layer-toggle');
  els.mockToggle = document.getElementById('mock-toggle');
  els.apiBaseLabel = document.getElementById('api-base-label');
  els.details = document.getElementById('details');
  els.detailsKicker = document.getElementById('details-kicker');
  els.detailsTitle = document.getElementById('details-title');
  els.detailsBody = document.getElementById('details-body');
  els.detailsClose = document.getElementById('details-close');
  els.scheduleOpen = document.getElementById('schedule-open');
  els.scheduleModal = document.getElementById('schedule-modal');
  els.scheduleKicker = document.getElementById('schedule-kicker');
  els.scheduleTitle = document.getElementById('schedule-title');
  els.scheduleSummary = document.getElementById('schedule-summary');
  els.scheduleBody = document.getElementById('schedule-body');
  els.scheduleClose = document.getElementById('schedule-close');
  els.stopsModal = document.getElementById('stops-modal');
  els.stopsClose = document.getElementById('stops-close');
  els.stopsSearch = document.getElementById('stops-search');
  els.stopsLang = document.getElementById('stops-lang');
  els.stopsSummary = document.getElementById('stops-summary');
  els.stopsBody = document.getElementById('stops-body');
  els.stopPopup = document.getElementById('stop-popup');
  els.stopPopupBody = document.getElementById('stop-popup-body');
  els.stopPopupClose = document.getElementById('stop-popup-close');
  els.toasts = document.getElementById('toasts');
  els.loadingBar = document.getElementById('loading-bar');

  setActiveTransport(config.transport || 'bus');
  els.routeInput.value = config.route || '';
  els.mockToggle.checked = Boolean(config.mock);
  els.apiBaseLabel.textContent = config.apiBase || '/api/v1';
  setActiveLayer(config.layer || 'map');

  wireEvents();
}

function wireEvents() {
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const route = els.routeInput.value.trim();
    closeRouteMenu();
    handlers.onSubmit?.({ transport: currentTransport, route });
  });

  els.routeInput.addEventListener('focus', () => openRouteMenu(true));
  els.routeInput.addEventListener('click', () => openRouteMenu(true));

  els.routeInput.addEventListener('input', () => {
    routeMenuShowAll = false;
    routeActiveIndex = 0;
    renderRouteMenu();
  });

  els.routeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeRouteMenu();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (els.routeMenu.hidden) openRouteMenu(false);
      if (!routeFiltered.length) return;

      const direction = event.key === 'ArrowDown' ? 1 : -1;
      routeActiveIndex = (routeActiveIndex + direction + routeFiltered.length) % routeFiltered.length;
      renderRouteMenu();
      return;
    }

    if (event.key === 'Enter' && !els.routeMenu.hidden) {
      if (routeActiveIndex >= 0 && routeFiltered[routeActiveIndex]) {
        event.preventDefault();
        chooseRoute(routeFiltered[routeActiveIndex].numl);
      }
    }
  });

  els.routeMenu.addEventListener('mousedown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  els.routeMenu.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const option = event.target.closest('[data-route]');
    if (option) chooseRoute(option.dataset.route);
  });

  els.routeInput.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (!els.routeMenu.contains(document.activeElement)) closeRouteMenu();
    }, 120);
  });

  els.transportToggle.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-type]');
    if (!button) return;
    const type = button.dataset.type;
    if (!type || type === currentTransport) return;
    setActiveTransport(type);
    handlers.onTransportChange?.(type);
  });

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

  els.scheduleOpen?.addEventListener('click', () => handlers.onScheduleOpen?.());
  els.scheduleClose?.addEventListener('click', closeSchedule);
  els.scheduleModal?.addEventListener('click', (event) => {
    if (event.target.closest('[data-schedule-close]')) closeSchedule();
  });
  els.scheduleBody?.addEventListener('click', (event) => {
    if (event.target.closest('[data-schedule-retry]')) handlers.onScheduleRetry?.();
  });

  els.stopsClose?.addEventListener('click', closeStopsModal);
  els.stopsModal?.addEventListener('click', (event) => {
    if (event.target.closest('[data-stops-close]')) closeStopsModal();
  });
  els.stopsSearch?.addEventListener('input', () => renderStopsList(els.stopsSearch.value));
  els.stopsLang?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-lang]');
    if (button) setStopsLang(button.dataset.lang);
  });
  els.stopsBody?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-stop-id]');
    if (!button) return;
    const stopId = Number(button.dataset.stopId);
    if (Number.isFinite(stopId)) handlers.onStopNavigate?.(stopId);
  });

  els.stopPopupClose?.addEventListener('click', () => handlers.onStopPopupClose?.());

  els.stopPopupBody.addEventListener('click', (event) => {
    if (event.target.closest('[data-open-stops]')) {
      handlers.onStopsOpen?.();
      return;
    }

    const vehicleButton = event.target.closest('[data-scoreboard-vehicle-id]');
    if (vehicleButton) {
      const vehicleId = Number(vehicleButton.dataset.scoreboardVehicleId);
      if (Number.isFinite(vehicleId) && vehicleId > 0) {
        handlers.onScoreboardVehicleSelect?.(
          vehicleId,
          vehicleButton.dataset.scoreboardVehicleType || '',
          vehicleButton.dataset.scoreboardRoute || '',
        );
      }
      return;
    }

    const button = event.target.closest('[data-scoreboard-refresh-id], [data-scoreboard-retry-id]');
    if (!button) return;

    const stopId = button.dataset.scoreboardRefreshId ?? button.dataset.scoreboardRetryId;
    if (stopId !== undefined) handlers.onScoreboardRefresh?.(Number(stopId));
  });

  els.detailsBody.addEventListener('click', (event) => {
    const stopButton = event.target.closest('button[data-stop-id]');
    if (stopButton) {
      handlers.onStopSelect?.(Number(stopButton.dataset.stopId));
      return;
    }

    const button = event.target.closest('button[data-retry-id]');
    if (!button) return;
    handlers.onDetailsRetry?.(button.dataset.retryId);
  });

  els.hamburger.addEventListener('click', () => setSidebarOpen(true));
  els.sidebarClose.addEventListener('click', () => setSidebarOpen(false));

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.stopsModal.hidden) {
      closeStopsModal();
      return;
    }
    if (!els.scheduleModal.hidden) {
      closeSchedule();
      return;
    }
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
  closeRouteMenu();

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

export function setRouteValue(route) {
  els.routeInput.value = route || '';
  closeRouteMenu();
}

export function setActiveLayer(layer) {
  els.layerToggle.querySelectorAll('button[data-layer]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.layer === layer);
  });
}

function sortedRoutes(routes) {
  return [...routes].sort((a, b) =>
    String(a.numl).localeCompare(String(b.numl), 'ru', {
      numeric: true,
      sensitivity: 'base',
    }),
  );
}

function filterRoutes() {
  const query = routeMenuShowAll ? '' : els.routeInput.value.trim().toLowerCase();
  if (!query) return routeOptions;
  return routeOptions.filter((route) => String(route.numl).toLowerCase().startsWith(query));
}

function renderRouteMenu() {
  if (!els.routeMenu) return;

  routeFiltered = filterRoutes();
  routeActiveIndex = routeFiltered.length
    ? Math.min(Math.max(routeActiveIndex, 0), routeFiltered.length - 1)
    : -1;

  if (!routeFiltered.length) {
    els.routeMenu.innerHTML = `<li class="route-menu-empty">${
      routeOptions.length ? 'Ничего не найдено' : 'Маршруты не загружены'
    }</li>`;
  } else {
    els.routeMenu.innerHTML = routeFiltered
      .map(
        (route, index) => `<li
          id="route-option-${index}"
          class="route-menu-item${index === routeActiveIndex ? ' is-active' : ''}"
          role="option"
          data-route="${esc(route.numl)}"
          aria-selected="${index === routeActiveIndex}">
          <strong>№${esc(route.numl)}</strong>
          ${route.name ? `<span>${esc(route.name)}</span>` : ''}
        </li>`,
      )
      .join('');
  }

  els.routeMenu.hidden = false;
  els.routeInput.setAttribute('aria-expanded', 'true');
  els.routeInput.setAttribute('aria-activedescendant', routeActiveIndex >= 0 ? `route-option-${routeActiveIndex}` : '');

  if (routeActiveIndex >= 0) {
    els.routeMenu
      .querySelector(`#route-option-${routeActiveIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }
}

function openRouteMenu(showAll) {
  routeMenuShowAll = Boolean(showAll);
  const current = els.routeInput.value.trim();
  routeActiveIndex = routeMenuShowAll
    ? routeOptions.findIndex((route) => String(route.numl) === current)
    : -1;
  renderRouteMenu();
}

function closeRouteMenu() {
  if (!els.routeMenu) return;
  els.routeMenu.hidden = true;
  els.routeInput.setAttribute('aria-expanded', 'false');
  els.routeInput.removeAttribute('aria-activedescendant');
  routeActiveIndex = -1;
}

function chooseRoute(route) {
  els.routeInput.value = route;
  closeRouteMenu();
  handlers.onRouteSelect?.({ transport: currentTransport, route });
}

export function renderRouteOptions(routes = []) {
  routeOptions = sortedRoutes(routes);
  if (!els.routeMenu?.hidden) renderRouteMenu();
}

export function setMockChecked(checked) {
  els.mockToggle.checked = Boolean(checked);
}

export function setLoading(loading) {
  els.loadingBar.classList.toggle('is-active', loading);
}

export function setVehiclesVisible(visible) {
  if (els.vehiclesBlock) els.vehiclesBlock.hidden = !visible;
}

export function renderVehicles(vehicles, transport, selectedId = null, emptyText = null, context = {}) {
  const count = vehicles.length;
  const type = normalizeTransportType(transport) || 'bus';
  const color = TRANSPORT_COLORS[type] || TRANSPORT_COLORS.bus;
  const typeLabel = TRANSPORT_LABELS[type] || 'Транспорт';
  const routeNumber = context.route ? String(context.route).trim() : '';
  const routeName = context.routeName ? String(context.routeName).trim() : '';
  const routeTitle = routeNumber ? `${typeLabel} №${routeNumber}` : typeLabel;
  const routeCaption =
    routeNumber && routeName && routeName !== routeTitle
      ? `${routeTitle} · ${routeName}`
      : routeTitle;

  els.vehiclesBadge.textContent = String(count);
  if (els.vehiclesRoute) els.vehiclesRoute.textContent = routeCaption;

  if (!count) {
    els.vehiclesList.innerHTML = `<li class="empty">${esc(
      emptyText || 'Нет данных',
    )}</li>`;
    return;
  }

  els.vehiclesList.innerHTML = vehicles
    .map((vehicle) => {
      const id = String(vehicle.vehicleId);
      const active = selectedId !== null && String(selectedId) === id;
      const gosnum = String(vehicle.gosnum ?? '').trim();
      const direction = directionCaption(vehicle.direction);

      return `<li>
        <button type="button" class="vehicle-item${active ? ' is-active' : ''}"
                data-vehicle-id="${esc(id)}" title="${esc(routeTitle)}"
                aria-label="Открыть карточку: ${esc(routeTitle)}${gosnum ? `, госномер ${esc(gosnum)}` : ''}, направление ${esc(direction)}">
          <span class="vehicle-dot" style="--dot-color:${color}" aria-hidden="true"></span>
          <span class="vehicle-main">
            <span class="vehicle-line">
              ${
                gosnum
                  ? `<span class="vehicle-plate">
                       <span class="vehicle-plate-number">${esc(gosnum)}</span>
                       <span class="vehicle-plate-label">госномер</span>
                     </span>`
                  : ''
              }
              <span class="vehicle-direction">направление: ${esc(direction)}</span>
            </span>
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
  els.hamburger.classList.toggle('is-hidden', Boolean(open));
}

/* ------------------------------------------------------------------ */
/* Карточка машины                                                     */
/* ------------------------------------------------------------------ */

export function showDetailsLoading(vehicleId, transport) {
  const type = normalizeTransportType(transport) || 'bus';
  els.details.hidden = false;
  els.detailsKicker.textContent = TRANSPORT_LABELS[type] || 'Транспорт';
  els.detailsTitle.hidden = false;
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
  const tripNumber = trip?.tripNum ?? vehicle.tripNum ?? vehicle.tripId ?? null;
  const lastStopId = Number(vehicle.lastStopId);

  els.details.hidden = false;
  els.detailsKicker.textContent = `${TRANSPORT_LABELS[type] || 'Транспорт'} · маршрут №${routeNumber}`;
  els.detailsTitle.hidden = true;
  els.detailsTitle.textContent = '';

  const metaItems = [
    ['Модель', vehicle.model || vehicle.tsTypeAdd || '—'],
    ['Рейс', tripNumber !== null && tripNumber !== '' ? tripNumber : '—'],
    ['Направление', directionLabel(vehicle.direction)],
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

          return `<li>
            <button type="button" class="${classes.join(' ')}" data-stop-id="${esc(stop.stopId)}"
                    title="Перейти к остановке «${esc(name)}»"
                    aria-label="Открыть остановку ${esc(name)}">
              <span class="stop-time">${esc(formatDeparture(stop.departures))}</span>
              <span class="stop-dot" aria-hidden="true"></span>
              <span class="stop-info">
                <span class="stop-name">${esc(name)}</span>
                ${flag}
              </span>
            </button>
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
    ${
      rows
        ? `<div class="stop-scroll">
             <div class="stop-spacer" aria-hidden="true"></div>
             <ol class="stop-list">${rows}</ol>
             <div class="stop-spacer" aria-hidden="true"></div>
           </div>`
        : ''
    }
  `;

  centerNextStop();
}

/**
 * Прокручивает список остановок так, чтобы следующая остановка была
 * ровно в середине видимой области. Верхний и нижний отступы-распорки
 * позволяют центрировать даже первую/последнюю остановку.
 */
function centerNextStop() {
  const scroller = els.detailsBody.querySelector('.stop-scroll');
  const target = scroller?.querySelector('.stop-item.is-next');
  if (!scroller || !target) return;

  const align = () => {
    const targetHeight = target.getBoundingClientRect().height || 30;
    const spacerHeight = Math.max(0, (scroller.clientHeight - targetHeight) / 2);
    scroller.querySelectorAll('.stop-spacer').forEach((spacer) => {
      spacer.style.height = `${spacerHeight}px`;
    });

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
  els.detailsKicker.textContent = 'Транспорт';
  els.detailsTitle.hidden = false;
  els.detailsTitle.textContent = 'Не удалось загрузить';
  els.detailsBody.innerHTML = `
    <p class="warn">${esc(error?.message || 'Неизвестная ошибка')}</p>
    <button type="button" class="btn btn-ghost btn-sm" data-retry-id="${esc(vehicleId)}">Повторить</button>`;
}

export function closeDetails() {
  els.details.hidden = true;
  els.detailsBody.innerHTML = '';
  els.detailsTitle.textContent = '';
  els.detailsTitle.hidden = false;
  els.detailsKicker.textContent = 'Транспорт';
}

export function isDetailsOpen() {
  return !els.details.hidden;
}

/* ------------------------------------------------------------------ */
/* Полное расписание на день                                           */
/* ------------------------------------------------------------------ */

export function setScheduleVisible(visible) {
  if (!els.scheduleOpen) return;
  els.scheduleOpen.hidden = !visible;
  if (!visible) closeSchedule();
}

export function isScheduleOpen() {
  return Boolean(els.scheduleModal) && !els.scheduleModal.hidden;
}

export function closeSchedule() {
  if (!els.scheduleModal) return;
  els.scheduleModal.hidden = true;
  els.scheduleBody.innerHTML = '';
  els.scheduleSummary.hidden = true;
  els.scheduleSummary.textContent = '';
}

function openSchedule() {
  if (!els.scheduleModal) return;
  els.scheduleModal.hidden = false;
  els.scheduleBody.scrollTop = 0;
}

function scheduleHeading(transport, route) {
  const typeLabel = TRANSPORT_LABELS[normalizeTransportType(transport)] || 'Транспорт';
  const routeTitle = String(route ?? '').trim() || '—';
  els.scheduleKicker.textContent = `${typeLabel} · маршрут №${routeTitle}`;
}

export function showScheduleLoading({ transport, route }) {
  if (!els.scheduleModal) return;

  openSchedule();
  scheduleHeading(transport, route);
  els.scheduleSummary.hidden = true;
  els.scheduleBody.innerHTML = `
    <div class="schedule-skeleton">
      <span class="skeleton"></span><span class="skeleton"></span>
      <span class="skeleton"></span><span class="skeleton"></span>
      <span class="skeleton"></span>
    </div>`;
}

function tripStartLabel(trip) {
  const first = trip?.stops?.[0]?.departures;
  return formatDeparture(first);
}

function tripEndLabel(trip) {
  const last = trip?.stops?.[trip.stops.length - 1]?.departures;
  return formatDeparture(last);
}

function tripSortKey(trip) {
  const label = tripStartLabel(trip);
  return label === '—' ? '99:99' : String(label);
}

function renderTrip(trip, stops) {
  const stopsList = Array.isArray(trip.stops) ? trip.stops : [];
  const tripNumber = trip.tripNum !== null && trip.tripNum !== undefined && trip.tripNum !== ''
    ? String(trip.tripNum)
    : null;
  const title = tripNumber ? `Рейс ${tripNumber}` : 'Рейс';
  const start = tripStartLabel(trip);
  const end = tripEndLabel(trip);
  const range = start === '—' && end === '—' ? 'время не указано' : `${start} — ${end}`;
  const stopCount = stopsList.length;

  const stopRows = stopsList
    .map((stop) => {
      const info = stops?.get(stop.stopId);
      const name = info?.name || `Остановка ${stop.stopId}`;
      return `<li class="trip-stop">
        <time>${esc(formatDeparture(stop.departures))}</time>
        <span>${esc(name)}</span>
      </li>`;
    })
    .join('');

  return `<details class="trip-card">
    <summary class="trip-summary">
      <span class="trip-num">${esc(title)}</span>
      <span class="trip-range">${esc(range)}</span>
      <span class="trip-count">${stopCount} ${esc(pluralize(stopCount, ['остановка', 'остановки', 'остановок']))}</span>
      <svg class="trip-chevron" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </summary>
    ${
      stopRows
        ? `<ol class="trip-stops">${stopRows}</ol>`
        : '<p class="trip-empty">Остановки рейса не переданы API.</p>'
    }
  </details>`;
}

export function renderSchedule({ transport, route, trips = [], stops = new Map(), error = null }) {
  if (!els.scheduleModal) return;

  openSchedule();
  scheduleHeading(transport, route);

  if (error) {
    els.scheduleSummary.hidden = true;
    els.scheduleBody.innerHTML = `
      <p class="warn">Не удалось загрузить расписание: ${esc(error?.message || 'неизвестная ошибка')}</p>
      <button type="button" class="btn btn-ghost btn-sm" data-schedule-retry>Повторить</button>`;
    return;
  }

  const groups = new Map();
  for (const trip of trips) {
    const direction =
      trip.direction === null || trip.direction === undefined || trip.direction === ''
        ? 'none'
        : String(trip.direction);
    if (!groups.has(direction)) groups.set(direction, []);
    groups.get(direction).push(trip);
  }

  const orderedGroups = [...groups.entries()].sort(([a], [b]) => {
    if (a === b) return 0;
    if (a === 'none') return 1;
    if (b === 'none') return -1;
    return Number(a) - Number(b);
  });

  const tripCount = trips.length;
  const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  els.scheduleSummary.hidden = false;
  els.scheduleSummary.textContent = `${tripCount} ${pluralize(tripCount, ['рейс', 'рейса', 'рейсов'])} на ${today}`;

  if (!tripCount) {
    els.scheduleBody.innerHTML = '<p class="empty-note">На этот день рейсы не найдены.</p>';
    return;
  }

  els.scheduleBody.innerHTML = orderedGroups
    .map(([direction, groupTrips]) => {
      const sortedTrips = [...groupTrips].sort((a, b) =>
        tripSortKey(a).localeCompare(tripSortKey(b)),
      );
      const directionName = direction === 'none' ? 'Все рейсы' : directionLabel(Number(direction));

      return `<section class="schedule-group">
        <div class="schedule-group-head">
          <h3>${esc(directionName)}</h3>
          <span>${sortedTrips.length} ${esc(pluralize(sortedTrips.length, ['рейс', 'рейса', 'рейсов']))}</span>
        </div>
        ${sortedTrips.map((trip) => renderTrip(trip, stops)).join('')}
      </section>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* Модальное окно «Все остановки»                                      */
/* ------------------------------------------------------------------ */

const STOPS_LANGS = ['ru', 'by', 'en'];

let stopsModalState = { list: [], currentStopId: null, lang: 'ru' };

export function isStopsModalOpen() {
  return Boolean(els.stopsModal) && !els.stopsModal.hidden;
}

export function closeStopsModal() {
  if (!els.stopsModal) return;
  els.stopsModal.hidden = true;
  els.stopsBody.innerHTML = '';
  els.stopsSearch.value = '';
  els.stopsSummary.textContent = '';
  stopsModalState = { list: [], currentStopId: null, lang: 'ru' };
}

function stopNameValue(stop, lang) {
  if (lang === 'by') return String(stop.nameBy ?? '').trim();
  if (lang === 'en') return String(stop.nameEn ?? '').trim();
  return String(stop.nameRu ?? '').trim() || String(stop.name ?? '').trim();
}

function syncStopsLangButtons() {
  els.stopsLang?.querySelectorAll('button[data-lang]').forEach((button) => {
    const active = button.dataset.lang === stopsModalState.lang;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function stopRowMarkup(stop) {
  const lang = stopsModalState.lang;
  const names = {
    ru: stopNameValue(stop, 'ru'),
    by: stopNameValue(stop, 'by'),
    en: stopNameValue(stop, 'en'),
  };

  const fallback = names.ru || names.by || names.en || `Остановка ${stop.stopId}`;
  const primary = names[lang] || fallback;

  const others = STOPS_LANGS.filter((key) => key !== lang)
    .map((key) => ({ key, value: names[key] }))
    .filter((item) => item.value && item.value !== primary);

  const lat = Number.isFinite(Number(stop.lat)) ? Number(stop.lat).toFixed(6) : '—';
  const lon = Number.isFinite(Number(stop.lon)) ? Number(stop.lon).toFixed(6) : '—';
  const current =
    stopsModalState.currentStopId !== null &&
    String(stopsModalState.currentStopId) === String(stop.stopId);

  return `<button type="button" class="stop-row${current ? ' is-current' : ''}"
                  data-stop-id="${esc(stop.stopId)}" title="Перейти к остановке «${esc(primary)}»">
    <span class="stop-row-main">
      <span class="stop-row-name">${esc(primary)}</span>
      ${others
        .map(
          (item) =>
            `<span class="stop-row-alt"><span class="stop-lang">${item.key.toUpperCase()}</span>${esc(item.value)}</span>`,
        )
        .join('')}
    </span>
    <span class="stop-row-coords">
      <span>${esc(lat)}</span>
      <span>${esc(lon)}</span>
    </span>
    <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </button>`;
}

function setStopsLang(lang) {
  if (!STOPS_LANGS.includes(lang) || stopsModalState.lang === lang) return;

  stopsModalState.lang = lang;
  syncStopsLangButtons();
  renderStopsList(els.stopsSearch.value);

  const current = els.stopsBody.querySelector('.stop-row.is-current');
  current?.scrollIntoView({ block: 'center' });
}

function renderStopsList(query = '') {
  if (!els.stopsBody) return;

  const q = String(query ?? '').trim().toLowerCase();
  const all = stopsModalState.list;
  const list = q
    ? all.filter((stop) =>
        [stop.name, stop.nameRu, stop.nameBy, stop.nameEn]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
    : all;

  els.stopsSummary.textContent = q
    ? `${list.length} из ${all.length}`
    : `${all.length} ${pluralize(all.length, ['остановка', 'остановки', 'остановок'])}`;

  if (!list.length) {
    els.stopsBody.innerHTML = '<p class="empty-note">Остановки не найдены.</p>';
    return;
  }

  els.stopsBody.innerHTML = list.map(stopRowMarkup).join('');
}

export function showStopsModal({ stops = new Map(), currentStopId = null } = {}) {
  if (!els.stopsModal) return;

  const list = [...stops.values()]
    .filter((stop) => stop && stop.stopId !== undefined)
    .sort((a, b) =>
      String(a.name || a.nameRu || '').localeCompare(String(b.name || b.nameRu || ''), 'ru'),
    );

  stopsModalState = { list, currentStopId, lang: 'ru' };
  els.stopsModal.hidden = false;
  els.stopsSearch.value = '';
  els.stopsBody.scrollTop = 0;
  syncStopsLangButtons();
  renderStopsList('');

  els.stopsBody.querySelector('.stop-row.is-current')?.scrollIntoView({ block: 'center' });
}

/* ------------------------------------------------------------------ */
/* Попап остановки                                                     */
/* ------------------------------------------------------------------ */

export function renderStopPopup({ stop, isRouteStop = false, route, transport }) {
  if (!els.stopPopup || !stop) return;

  const typeLabel = TRANSPORT_LABELS[normalizeTransportType(transport)] || 'Транспорт';
  const title = stop.name || stop.nameRu || `Остановка ${stop.stopId}`;

  const rows = [];

  if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) {
    rows.push(['Координаты', `${stop.lat.toFixed(6)}, ${stop.lon.toFixed(6)}`]);
  }

  if (stop.nameBy && stop.nameBy !== title) rows.push(['Па-беларуску', stop.nameBy]);
  if (stop.nameEn && stop.nameEn !== title) rows.push(['English', stop.nameEn]);
  if (stop.mspsid) rows.push(['MSPS ID', stop.mspsid]);

  els.stopPopup.classList.toggle('is-route', Boolean(isRouteStop));
  els.stopPopupBody.innerHTML = `
    <span class="stop-popup-kicker">${isRouteStop ? 'Остановка маршрута' : 'Остановка'}</span>
    <div class="stop-popup-title-row">
      <h3>${esc(title)}</h3>
      ${
        isRouteStop
          ? ''
          : '<button type="button" class="stop-popup-badge is-muted" data-open-stops>Все остановки</button>'
      }
    </div>
    ${
      isRouteStop
        ? `<span class="stop-popup-badge">${esc(typeLabel)} · маршрут №${esc(route || '—')}</span>`
        : ''
    }
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
      const firstId = Number(route.first?.vehicleId) || 0;
      const nextId = Number(route.next?.vehicleId) || 0;
      const nearestId = firstId > 0 ? firstId : nextId;
      const mainTag = nearestId > 0 ? 'button' : 'span';
      const mainAttrs =
        nearestId > 0
          ? ` type="button" data-scoreboard-vehicle-id="${nearestId}" data-scoreboard-vehicle-type="${esc(route.mType)}" data-scoreboard-route="${esc(route.numl)}" title="Открыть карточку транспорта маршрута ${esc(route.numl)}"`
          : '';

      return `<li class="score-row">
        <${mainTag} class="score-main"${mainAttrs}>
          <span class="score-type" style="${badgeStyle}" title="${esc(TRANSPORT_LABELS[type] || route.mType || 'Транспорт')}">
            ${esc(mTypeBadge(route.mType, type))}
          </span>
          <span class="score-route">
            <strong>${esc(route.numl)}</strong>
            <small title="${esc(destination)}">→ ${esc(destination)}</small>
          </span>
        </${mainTag}>
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
