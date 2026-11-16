const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { pool } = require('./db');
const { migrate } = require('./migrate');
const { refreshRates } = require('./rates');
const listings = require('./listings');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const RATES_REFRESH_HOURS = Number(process.env.RATES_REFRESH_HOURS || 6);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
}));

app.get('/api/stats', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await listings.stats());
}));

app.get('/api/listings', wrap(async (req, res) => {
  res.json(await listings.searchListings(req.query));
}));

app.get('/api/map', wrap(async (req, res) => {
  res.json(await listings.mapPoints(req.query));
}));

app.get('/api/listings/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const l = await listings.getListing(id);
  if (!l) return res.status(404).json({ error: 'not found' });
  res.json(l);
}));

// ---- Admin: bulk import from external feeds ------------------------------------------------
function requireAdmin(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const ok = ADMIN_TOKEN && token.length === ADMIN_TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/api/admin/listings', requireAdmin, wrap(async (req, res) => {
  const input = Array.isArray(req.body) ? req.body : req.body.listings;
  if (!Array.isArray(input)) return res.status(400).json({ error: 'expected a JSON array of listings' });
  const valid = [], rejected = [];
  input.forEach((raw, i) => {
    const { listing, errors } = listings.normalize(raw || {});
    if (errors.length) rejected.push({ index: i, external_id: raw && raw.external_id, errors });
    else valid.push(listing);
  });
  const upserted = valid.length ? await listings.upsertListings(valid) : 0;
  res.json({ upserted, rejected });
}));

app.post('/api/admin/refresh-rates', requireAdmin, wrap(async (req, res) => {
  res.json(await refreshRates());
}));

app.post('/api/admin/import/reso', requireAdmin, wrap(async (req, res) => {
  const { syncReso } = require('./import-reso');
  const mode = ['full', 'incremental'].includes(req.query.mode) ? req.query.mode : 'auto';
  const r = await syncReso({ mode });
  res.json({ ...r, newest: r.newest || null });
}));

app.get('/api/admin/import-runs', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM import_runs ORDER BY started_at DESC LIMIT 50');
  res.json(rows);
}));

app.delete('/api/admin/sample-listings', requireAdmin, wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM listings WHERE is_sample = true');
  res.json({ deleted: rowCount });
}));

// ---- Frontend ------------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

async function start() {
  await migrate();
  if (process.env.SEED_SAMPLE_DATA !== 'false') {
    const { seed } = require('./seed');
    const r = await seed({ onlyIfEmpty: true });
    if (r.skipped) await refreshRates();
  } else {
    await refreshRates();
  }
  setInterval(() => refreshRates().catch((e) => console.error('rate refresh failed', e)),
    RATES_REFRESH_HOURS * 3600 * 1000).unref();

  const resoMinutes = Number(process.env.RESO_SYNC_MINUTES || 0);
  if (resoMinutes > 0 && require('./importers/reso').isConfigured()) {
    const { syncReso } = require('./import-reso');
    const run = () => syncReso().catch((e) => console.error('RESO sync failed:', e.message));
    setTimeout(run, 10000).unref();
    setInterval(run, resoMinutes * 60 * 1000).unref();
    console.log(`RESO sync scheduled every ${resoMinutes} minutes.`);
  }

  const server = app.listen(PORT, () => console.log(`Listening on :${PORT}`));
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((e) => { console.error('Failed to start', e); process.exit(1); });
