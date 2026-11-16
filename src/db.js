const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. On Railway, add a PostgreSQL service and reference ${{Postgres.DATABASE_URL}}.');
  process.exit(1);
}

// Railway's internal network (*.railway.internal) does not use SSL; public proxy URLs do.
const useSsl =
  process.env.PGSSL === 'true' ||
  (process.env.PGSSL !== 'false' && /proxy\.rlwy\.net|railway\.app/.test(connectionString));

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
});

module.exports = { pool, query: (text, params) => pool.query(text, params) };
