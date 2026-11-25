import { config } from './config.js';
import { getMeta, setMeta } from './db.js';
import { runJob } from './jobs.js';
import { errorMessage } from './util.js';

const TIME_ZONE = 'Europe/Minsk';
const running = new Set();
let timers = [];
let stopped = false;

function log(...args) {
  console.log('[scheduler]', ...args);
}

function localDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    weekday: values.weekday,
    dateKey: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

async function guard(db, name) {
  if (running.has(name) || stopped) return;

  running.add(name);
  try {
    await runJob(db, name);
  } catch (error) {
    log(`${name}: ${errorMessage(error)}`);
  } finally {
    running.delete(name);
  }
}

async function runOncePerPeriod(db, name, periodKey, shouldRun) {
  const metaKey = `job:${name}:last`;
  const last = getMeta(db, metaKey);
  if (last === periodKey) return;

  setMeta(db, metaKey, periodKey);
  await guard(db, name);
}

async function checkCalendar(db) {
  const { weekday, dateKey, hour, minute } = localDateParts();

  if (hour === 3 && minute === 0) {
    await runOncePerPeriod(db, 'sync-stops', dateKey, true);
  }
  if (hour === 3 && minute === 15) {
    await runOncePerPeriod(db, 'sync-vehicles', dateKey, true);
  }
  if (hour === 4 && minute === 0) {
    await runOncePerPeriod(db, 'cleanup-traces', dateKey, true);
  }

  if (weekday === 'Sunday' && hour === 3 && minute === 30) {
    await runOncePerPeriod(db, 'discover-routes', dateKey, true);
  }
  if (weekday === 'Sunday' && hour === 4 && minute === 30) {
    await runOncePerPeriod(db, 'sync-schedules', dateKey, true);
  }
  if (weekday === 'Sunday' && hour === 5 && minute === 30) {
    await runOncePerPeriod(db, 'sync-operators', dateKey, true);
  }
  if (weekday === 'Sunday' && hour === 6 && minute === 0) {
    await runOncePerPeriod(db, 'build-geometry-full', dateKey, true);
  }
}

async function bootstrap(db) {
  const stops = db.prepare('SELECT COUNT(*) AS count FROM stops').get();
  if (Number(stops.count) > 0) return;

  log('пустая база: первичная загрузка справочников');
  for (const job of ['sync-stops', 'sync-vehicles', 'discover-routes', 'sync-schedules']) {
    try {
      await runJob(db, job);
    } catch (error) {
      log(`${job}: ${errorMessage(error)}`);
      break;
    }
  }
}

export function startScheduler(db) {
  if (!config.jobsEnabled) {
    log('планировщик отключён (JOBS_ENABLED=false)');
    return;
  }

  stopped = false;

  if (config.autoBootstrap) {
    setTimeout(() => {
      bootstrap(db).catch((error) => log(`bootstrap: ${errorMessage(error)}`));
    }, 2_000).unref?.();
  }

  timers.push(
    setInterval(() => {
      guard(db, 'collect-traces').catch(() => {});
    }, config.traceIntervalMs),
  );

  timers.push(
    setInterval(() => {
      guard(db, 'build-geometry-first-pass').catch(() => {});
    }, config.geometryFirstPassIntervalMs),
  );

  timers.push(
    setInterval(() => {
      checkCalendar(db).catch((error) => log(`calendar: ${errorMessage(error)}`));
    }, 60_000),
  );

  for (const timer of timers) timer.unref?.();

  log('планировщик запущен');
}

export function stopScheduler() {
  stopped = true;
  for (const timer of timers) clearInterval(timer);
  timers = [];
}
