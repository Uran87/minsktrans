import { config } from './config.js';
import { openDatabase } from './db.js';
import { jobRegistry, runJob } from './jobs.js';
import { errorMessage } from './util.js';

function printHelp() {
  console.log(`MinskTrans data worker

Использование:
  node server/cli.js <job>
  node server/cli.js bootstrap
  node server/cli.js status

Задачи:
  ${Object.keys(jobRegistry).join('\n  ')}

Переменные окружения:
  API_ORIGIN=${config.apiOrigin}
  DB_FILE=${config.dbFile}
`);
}

function printStatus(db) {
  const tables = ['stops', 'routes', 'route_variants', 'geometry_versions', 'vehicles', 'gps_samples'];
  const counts = {};

  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    counts[table] = Number(row.count);
  }

  const runs = db
    .prepare(
      `SELECT job, started_at, finished_at, status, stats, error
       FROM ingest_runs ORDER BY id DESC LIMIT 10`,
    )
    .all();

  console.log(JSON.stringify({ database: config.dbFile, counts, runs }, null, 2));
}

async function bootstrap(db) {
  for (const job of ['sync-stops', 'sync-vehicles', 'discover-routes', 'sync-schedules']) {
    try {
      await runJob(db, job);
    } catch (error) {
      console.error(`[bootstrap] ${job}: ${errorMessage(error)}`);
      if (job === 'sync-stops') break;
    }
  }
}

async function main() {
  const command = process.argv[2];
  if (!command || command === 'help' || command === '--help') {
    printHelp();
    return;
  }

  const db = openDatabase(config.dbFile);

  try {
    if (command === 'bootstrap') {
      await bootstrap(db);
    } else if (command === 'status') {
      printStatus(db);
    } else if (jobRegistry[command]) {
      await runJob(db, command);
    } else {
      console.error(`Неизвестная задача: ${command}`);
      printHelp();
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
