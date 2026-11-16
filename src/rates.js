// Exchange rates: every listing is stored in its original currency and converted to USD
// using the latest rates. Rates are fetched from a free public API and refreshed periodically;
// a built-in fallback table is used if the API is unreachable so the site always works.
const { pool } = require('./db');

const RATES_URL = process.env.EXCHANGE_RATES_URL || 'https://open.er-api.com/v6/latest/USD';

// Approximate units per 1 USD — used only when live rates cannot be fetched.
const FALLBACK_RATES = {
  USD: 1, EUR: 0.92, GBP: 0.79, JPY: 150, CNY: 7.2, INR: 84, CAD: 1.37, AUD: 1.52, NZD: 1.66,
  CHF: 0.88, SEK: 10.6, NOK: 10.8, DKK: 6.9, PLN: 3.95, CZK: 23, HUF: 360, RON: 4.6, TRY: 34,
  RUB: 95, AED: 3.6725, SAR: 3.75, QAR: 3.64, ILS: 3.7, EGP: 49, ZAR: 18, NGN: 1600, KES: 129,
  MAD: 9.9, BRL: 5.6, MXN: 19.5, ARS: 1000, CLP: 950, COP: 4200, PEN: 3.75, SGD: 1.34, HKD: 7.8,
  KRW: 1380, TWD: 32, THB: 35, MYR: 4.5, IDR: 15800, PHP: 58, VND: 25300, PKR: 278, BDT: 120,
  LKR: 300, ISK: 138, CRC: 510, DOP: 60, JMD: 157, XCD: 2.7, BSD: 1, MUR: 46, GEL: 2.7,
};

async function fetchLiveRates() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(RATES_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const rates = body.rates || body.conversion_rates;
    if (!rates || typeof rates !== 'object' || !rates.EUR) throw new Error('unexpected response shape');
    return rates;
  } finally {
    clearTimeout(timer);
  }
}

async function upsertRates(rates) {
  const codes = [], values = [];
  for (const [code, v] of Object.entries(rates)) {
    const n = Number(v);
    if (/^[A-Z]{3}$/.test(code) && Number.isFinite(n) && n > 0) { codes.push(code); values.push(n); }
  }
  await pool.query(
    `INSERT INTO exchange_rates (currency, per_usd, updated_at)
     SELECT c, r, now() FROM unnest($1::text[], $2::numeric[]) AS t(c, r)
     ON CONFLICT (currency) DO UPDATE SET per_usd = EXCLUDED.per_usd, updated_at = now()`,
    [codes, values]
  );
  return codes.length;
}

// Recompute the stored USD price for every listing (stored so it can be indexed, filtered and sorted).
async function recomputeUsdPrices() {
  const { rowCount } = await pool.query(
    `UPDATE listings l SET price_usd = ROUND(l.price / r.per_usd, 2)
     FROM exchange_rates r WHERE r.currency = l.currency
       AND l.price_usd IS DISTINCT FROM ROUND(l.price / r.per_usd, 2)`
  );
  return rowCount;
}

async function refreshRates({ log = console.log } = {}) {
  let source = 'live';
  let rates;
  try {
    rates = await fetchLiveRates();
  } catch (err) {
    log(`Live exchange rates unavailable (${err.message}).`);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM exchange_rates');
    if (rows[0].n > 0) { log('Keeping previously stored rates.'); await recomputeUsdPrices(); return { source: 'stored' }; }
    rates = FALLBACK_RATES;
    source = 'fallback';
  }
  const n = await upsertRates(rates);
  const updated = await recomputeUsdPrices();
  log(`Exchange rates refreshed from ${source} (${n} currencies); ${updated} listing prices re-converted to USD.`);
  return { source, currencies: n, updated };
}

module.exports = { refreshRates, recomputeUsdPrices, FALLBACK_RATES };

if (require.main === module) {
  require('./migrate').migrate()
    .then(() => refreshRates())
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
