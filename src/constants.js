/**
 * Общие константы и небольшие утилиты форматирования.
 */

export const POLL_INTERVAL = 30_000;

export const TRANSPORT_TYPES = ['bus', 'trolley', 'tram'];

export const TRANSPORT_LABELS = {
  bus: 'Автобус',
  trolley: 'Троллейбус',
  tram: 'Трамвай',
};

export const TRANSPORT_COLORS = {
  bus: '#fbbf24',
  trolley: '#38bdf8',
  tram: '#fb7185',
};

export function normalizeTransportType(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (['bus', 'avtobus', 'автобус', 'a'].includes(v)) return 'bus';
  if (['trolley', 'trolleybus', 'troll', 'троллейбус', 't'].includes(v)) return 'trolley';
  if (['tram', 'tramway', 'трамвай', 'tr'].includes(v)) return 'tram';
  return null;
}

/** Значения transport для API: bus, trolleybus, tram, routetaxi. */
export function apiTransportValue(type) {
  const normalized = normalizeTransportType(type);
  if (normalized === 'bus') return 'bus';
  if (normalized === 'trolley') return 'trolleybus';
  if (normalized === 'tram') return 'tram';
  return type;
}

/**
 * mType из /scoreboard: "А" — автобус, "Т" — троллейбус, "#" — трамвай.
 * Дополнительно поддерживаем текстовые варианты.
 */
export function transportTypeFromMType(value) {
  const v = String(value ?? '').trim().toUpperCase();
  if (!v) return null;

  if (['А', 'A', 'BUS', 'АВТОБУС'].includes(v)) return 'bus';
  if (['Т', 'T', 'TROLLEY', 'TROLLEYBUS', 'ТРОЛЛЕЙБУС'].includes(v)) return 'trolley';
  if (['#', 'ТР', 'TR', 'TRAM', 'ТРАМВАЙ'].includes(v)) return 'tram';

  return normalizeTransportType(v);
}

export function mTypeBadge(value, type = null) {
  const t = type || transportTypeFromMType(value);
  if (t === 'bus') return 'А';
  if (t === 'trolley') return 'Т';
  if (t === 'tram') return 'Тр';
  return value ? String(value) : '?';
}

export function hexToRgba(hex, alpha = 1) {
  const clean = String(hex).replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function directionLabel(direction) {
  if (direction === null || direction === undefined || direction === '') {
    return 'Не указано';
  }
  const n = Number(direction);
  if (n === 0) return 'Прямое';
  if (n === 1) return 'Обратное';
  return `Направление ${direction}`;
}

/**
 * API отдаёт время отправления как минуты от полуночи ("314" => 05:14).
 * Дополнительно поддерживаем "05:14", "0514" и ISO-даты.
 */
export function formatDeparture(value) {
  if (value === null || value === undefined || value === '') return '—';

  const raw = String(value).trim();

  // Основной формат API — минуты от полуночи: "314" => 05:14.
  if (typeof value === 'number' || /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      if (n >= 0 && n < 1440) {
        const h = Math.floor(n / 60);
        const m = n % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
      if (n >= 1000 && n <= 2359) {
        return `${raw.slice(0, 2)}:${raw.slice(2, 4)}`;
      }
    }
  }

  const hhmm = raw.match(/(?:T|\s|^)(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (hhmm) {
    return `${hhmm[1].padStart(2, '0')}:${hhmm[2]}`;
  }

  return raw;
}

export function formatClock(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
  } catch {
    return date.toLocaleTimeString();
  }
}

export function pluralize(count, forms) {
  const n = Math.abs(Number(count)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}
