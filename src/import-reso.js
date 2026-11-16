// Runs one RESO Web API sync: `npm run import:reso` (or `-- --full` to re-pull all active listings).
// The web server also calls syncReso() on a timer when RESO_SYNC_MINUTES is set.
const { pool } = require('./db');
const { migrate } = require('./migrate');
const { normalize, upsertListings } = require('./listings');
const reso = require('./importers/reso');

let running = false;

async function syncReso({ full = false, log = console.log } = {}) {
  const cfg = reso.config();
  if (!reso.isConfigured(cfg)) throw new Error('RESO importer is not configured.');
  if (running) { log('RESO sync already running; skipping.'); return { skipped: true }; }
  running = true;
  const { rows: [run] } = await pool.query('INSERT INTO import_runs (source) VALUES ($1) RETURNING id', [cfg.source]);
  try {
    let since = null;
    if (!full) {
      const { rows } = await pool.query(
        'SELECT max(newest_modified) AS t FROM import_runs WHERE source = $1 AND ok', [cfg.source]);
      since = rows[0].t ? new Date(rows[0].t) : null;
    }
    log(since ? `RESO incremental sync since ${since.toISOString()}` : 'RESO full sync of active listings');
    const r = await reso.runResoImport({ cfg, since, upsert: upsertListings, normalize, log });
    await pool.query(
      `UPDATE import_runs SET finished_at = now(), ok = true, newest_modified = $2,
         records_seen = $3, upserted = $4, rejected = $5 WHERE id = $1`,
      [run.id, r.newest, r.seen, r.upserted, r.rejected]);
    log(`RESO sync done: ${r.seen} records, ${r.upserted} upserted, ${r.rejected} rejected.`);
    return r;
  } catch (err) {
    await pool.query('UPDATE import_runs SET finished_at = now(), ok = false, error = $2 WHERE id = $1',
      [run.id, String(err.message).slice(0, 2000)]);
    throw err;
  } finally {
    running = false;
  }
}

module.exports = { syncReso };

if (require.main === module) {
  migrate()
    .then(() => syncReso({ full: process.argv.includes('--full') }))
    .then(() => pool.end())
    .catch((e) => { console.error(e.message); pool.end().finally(() => process.exit(1)); });
}
