const { pool } = require('./db');

const SQL = `
CREATE TABLE IF NOT EXISTS exchange_rates (
  currency     CHAR(3) PRIMARY KEY,
  per_usd      NUMERIC(20,8) NOT NULL CHECK (per_usd > 0),  -- units of currency per 1 USD
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listings (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL DEFAULT 'manual',
  external_id   TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  property_type TEXT NOT NULL DEFAULT 'house',
  status        TEXT NOT NULL DEFAULT 'for_sale',
  price         NUMERIC(18,2) NOT NULL CHECK (price >= 0),
  currency      CHAR(3) NOT NULL,
  price_usd     NUMERIC(18,2),
  bedrooms      SMALLINT,
  bathrooms     NUMERIC(4,1),
  area_sqm      NUMERIC(10,2),
  lot_sqm       NUMERIC(12,2),
  year_built    SMALLINT,
  address       TEXT,
  city          TEXT,
  region        TEXT,
  country       TEXT NOT NULL,
  country_code  CHAR(2) NOT NULL,
  latitude      DOUBLE PRECISION,
  longitude     DOUBLE PRECISION,
  image_url     TEXT,
  listing_url   TEXT,
  is_sample     BOOLEAN NOT NULL DEFAULT false,
  listed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS listings_status_price_usd_idx ON listings (status, price_usd);
CREATE INDEX IF NOT EXISTS listings_country_idx ON listings (country_code);
CREATE INDEX IF NOT EXISTS listings_listed_at_idx ON listings (listed_at DESC);
CREATE INDEX IF NOT EXISTS listings_currency_idx ON listings (currency);

-- One row per feed import, used for incremental sync and troubleshooting.
CREATE TABLE IF NOT EXISTS import_runs (
  id               BIGSERIAL PRIMARY KEY,
  source           TEXT NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  ok               BOOLEAN,
  newest_modified  TIMESTAMPTZ,
  records_seen     INTEGER,
  upserted         INTEGER,
  rejected         INTEGER,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS import_runs_source_idx ON import_runs (source, started_at DESC);
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS is_full BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS withdrawn INTEGER;
`;

async function migrate() {
  await pool.query(SQL);
  console.log('Migrations applied.');
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
