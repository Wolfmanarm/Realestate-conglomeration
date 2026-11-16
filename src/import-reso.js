// Runs one RESO Web API sync: `npm run import:reso` (auto), `-- --full`, or `-- --incremental`.
// The web server also calls syncReso() on a timer when RESO_SYNC_MINUTES is set.
//
// Auto mode does a FULL sync if there has been no successful full sync in RESO_FULL_SYNC_HOURS
// (default 24), otherwise an incremental one. Full syncs also withdraw listings from this source
// that are no longer in the feed (MLSs often drop listings without sending a status change).
const { pool } = require('./db');
const { migrate } = require('./migrate');
const { normalize, upsertListings } = require('./listings');
const reso = require('./importers/reso');

const FULL_SYNC_HOURS = Number(process.env.RESO_FULL_SYNC_HOURS || 24);
let running = false;

async function chooseMode(source, mode) {
  if (mode === 'full' || mode === 'incremental') return mode;
  const { rows } = await pool.query(
    `SELECT max(started_at) AS t FROM import_runs WHERE source = $1 AND ok AND is_full`, [source]);
  const last = rows[0].t ? new Date(rows[0].t) : null;
  return !last || Date.now() - last.getTime() > FULL_SYNC_HOURS * 3600 * 1000 ? 'full' : 'incremental';
}

async function syncReso({ mode = 'auto', log = console.log } = {}) {
  const cfg = reso.config();
  if (!reso.isConfigured(cfg)) throw new Error('RESO importer is not configured.');
  if (running) { log('RESO sync already running; skipping.'); return { skipped: true }; }
  running = true;
  let runId = null;
  try {
    mode = await chooseMode(cfg.source, mode);
    const full = mode === 'full';
    const { rows: [run] } = await pool.query(
      'INSERT INTO import_runs (source, is_full) VALUES ($1, $2) RETURNING id', [cfg.source, full]);
    runId = run.id;

    let since = null;
    if (!full) {
      const { rows } = await pool.query(
        'SELECT max(newest_modified) AS t FROM import_runs WHERE source = $1 AND ok', [cfg.source]);
      since = rows[0].t ? new Date(rows[0].t) : null;
    }
    log(since ? `RESO incremental sync since ${since.toISOString()}` : 'RESO full sync of active listings');
    const r = await reso.runResoImport({ cfg, since, upsert: upsertListings, normalize, log });

    let withdrawn = 0;
    if (full && !since && r.complete) {
      if (r.keys.size === 0) {
        log('RESO full sync returned 0 records; NOT withdrawing existing listings (check filters/credentials).');
        // Don't let an empty run count as the daily full sync, so the next auto run retries a full one.
        await pool.query(`UPDATE import_runs SET is_full = false, error = $2 WHERE id = $1`,
          [runId, 'full sync returned 0 records; withdrawal skipped']);
      } else {
        ({ rowCount: withdrawn } = await pool.query(
          `UPDATE listings SET status = 'withdrawn', updated_at = now()
           WHERE source = $1 AND status = 'for_sale' AND NOT (external_id = ANY($2::text[]))`,
          [cfg.source, [...r.keys]]));
        if (withdrawn) log(`RESO full sync: withdrew ${withdrawn} listings no longer in the feed.`);
      }
    }

    await pool.query(
      `UPDATE import_runs SET finished_at = now(), ok = true, newest_modified = $2,
         records_seen = $3, upserted = $4, rejected = $5, withdrawn = $6 WHERE id = $1`,
      [runId, r.newest, r.seen, r.upserted, r.rejected, withdrawn]);
    log(`RESO ${mode} sync done: ${r.seen} records, ${r.upserted} upserted, ${r.rejected} rejected, ${withdrawn} withdrawn.`);
    return { mode, pages: r.pages, seen: r.seen, upserted: r.upserted, rejected: r.rejected, withdrawn, newest: r.newest };
  } catch (err) {
    if (runId) {
      await pool.query('UPDATE import_runs SET finished_at = now(), ok = false, error = $2 WHERE id = $1',
        [runId, String(err.message).slice(0, 2000)]);
    }
    throw err;
  } finally {
    running = false;
  }
}

module.exports = { syncReso };

if (require.main === module) {
  const mode = process.argv.includes('--full') ? 'full' : process.argv.includes('--incremental') ? 'incremental' : 'auto';
  migrate()
    .then(() => syncReso({ mode }))
    .then(() => pool.end())
    .catch((e) => { console.error(e.message); pool.end().finally(() => process.exit(1)); });
}
