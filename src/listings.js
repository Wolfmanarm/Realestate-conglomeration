const { pool } = require('./db');

const COLUMNS = [
  'source', 'external_id', 'title', 'description', 'property_type', 'status', 'price', 'currency',
  'bedrooms', 'bathrooms', 'area_sqm', 'lot_sqm', 'year_built', 'address', 'city', 'region', 'country',
  'country_code', 'latitude', 'longitude', 'image_url', 'listing_url', 'is_sample', 'listed_at',
];
const STATUSES = new Set(['for_sale', 'pending', 'sold', 'withdrawn']);

const CONVERT_SQL = `
  UPDATE listings l SET price_usd = ROUND(l.price / r.per_usd, 2)
  FROM exchange_rates r
  WHERE r.currency = l.currency AND l.price_usd IS DISTINCT FROM ROUND(l.price / r.per_usd, 2)`;

function normalize(raw) {
  const errors = [];
  const s = (v) => (v === undefined || v === null || v === '' ? null : String(v).trim());
  const n = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  const l = {
    source: s(raw.source) || 'manual',
    external_id: s(raw.external_id),
    title: s(raw.title),
    description: s(raw.description),
    property_type: (s(raw.property_type) || 'house').toLowerCase(),
    status: (s(raw.status) || 'for_sale').toLowerCase(),
    price: n(raw.price),
    currency: (s(raw.currency) || '').toUpperCase(),
    bedrooms: n(raw.bedrooms),
    bathrooms: n(raw.bathrooms),
    area_sqm: n(raw.area_sqm),
    lot_sqm: n(raw.lot_sqm),
    year_built: n(raw.year_built),
    address: s(raw.address),
    city: s(raw.city),
    region: s(raw.region),
    country: s(raw.country),
    country_code: (s(raw.country_code) || '').toUpperCase(),
    latitude: n(raw.latitude),
    longitude: n(raw.longitude),
    image_url: s(raw.image_url),
    listing_url: s(raw.listing_url),
    is_sample: raw.is_sample === true,
    listed_at: s(raw.listed_at) || new Date().toISOString(),
  };
  if (!l.external_id) errors.push('external_id is required');
  if (!l.title) errors.push('title is required');
  if (!Number.isFinite(l.price) || l.price < 0) errors.push('price must be a non-negative number');
  if (!/^[A-Z]{3}$/.test(l.currency)) errors.push('currency must be an ISO 4217 code, e.g. EUR');
  if (!l.country) errors.push('country is required');
  if (!/^[A-Z]{2}$/.test(l.country_code)) errors.push('country_code must be ISO 3166-1 alpha-2, e.g. FR');
  if (!STATUSES.has(l.status)) errors.push(`status must be one of ${[...STATUSES].join(', ')}`);
  for (const k of ['bedrooms', 'bathrooms', 'area_sqm', 'lot_sqm', 'year_built', 'latitude', 'longitude']) {
    if (l[k] !== null && !Number.isFinite(l[k])) errors.push(`${k} must be a number`);
  }
  for (const u of ['image_url', 'listing_url']) {
    if (l[u] && !/^https?:\/\//i.test(l[u])) errors.push(`${u} must be an http(s) URL`);
  }
  return { listing: l, errors };
}

async function upsertListings(listings, chunkSize = 500) {
  let total = 0;
  const updates = COLUMNS.filter((c) => c !== 'source' && c !== 'external_id')
    .map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  for (let i = 0; i < listings.length; i += chunkSize) {
    const chunk = listings.slice(i, i + chunkSize);
    const params = [];
    const tuples = chunk.map((l) => {
      const ph = COLUMNS.map((c) => {
        let v = l[c];
        if (v === undefined) v = c === 'status' ? 'for_sale' : c === 'is_sample' ? false : null;
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(',')})`;
    });
    const { rowCount } = await pool.query(
      `INSERT INTO listings (${COLUMNS.join(',')}) VALUES ${tuples.join(',')}
       ON CONFLICT (source, external_id) DO UPDATE SET ${updates}, updated_at = now()`,
      params
    );
    total += rowCount;
  }
  await pool.query(CONVERT_SQL);
  return total;
}

const SORTS = {
  newest: 'listed_at DESC, id DESC',
  price_asc: 'price_usd ASC NULLS LAST, id',
  price_desc: 'price_usd DESC NULLS LAST, id',
  area_desc: 'area_sqm DESC NULLS LAST, id',
  ppsqm_asc: '(price_usd / NULLIF(area_sqm, 0)) ASC NULLS LAST, id',
};

function buildFilters(q) {
  const where = ["status = 'for_sale'", 'price_usd IS NOT NULL'];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const num = (v) => (v === undefined || v === '' ? NaN : Number(v));

  if (q.q) {
    const t = p(`%${String(q.q).slice(0, 100)}%`);
    where.push(`(title ILIKE ${t} OR city ILIKE ${t} OR region ILIKE ${t} OR country ILIKE ${t} OR address ILIKE ${t})`);
  }
  if (q.country) where.push(`country_code = ${p(String(q.country).toUpperCase().slice(0, 2))}`);
  if (q.type) where.push(`property_type = ${p(String(q.type).toLowerCase())}`);
  const ranges = [
    ['min_price', 'price_usd >='], ['max_price', 'price_usd <='],
    ['beds', 'bedrooms >='], ['baths', 'bathrooms >='], ['min_area', 'area_sqm >='],
  ];
  for (const [key, expr] of ranges) {
    const v = num(q[key]);
    if (Number.isFinite(v)) where.push(`${expr} ${p(v)}`);
  }
  return { where: where.join(' AND '), params };
}

async function searchListings(q) {
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 24, 1), 100);
  const page = Math.min(Math.max(parseInt(q.page, 10) || 1, 1), 10000);
  const order = SORTS[q.sort] || SORTS.newest;
  const { where, params } = buildFilters(q);

  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT id, title, property_type, price, currency, price_usd, bedrooms, bathrooms, area_sqm,
              city, region, country, country_code, latitude, longitude, image_url, is_sample, listed_at
       FROM listings WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params
    ),
    pool.query(`SELECT count(*)::int AS total FROM listings WHERE ${where}`, params),
  ]);
  return { page, limit, total: count.rows[0].total, results: rows.rows };
}

async function mapPoints(q) {
  const { where, params } = buildFilters(q);
  const { rows } = await pool.query(
    `SELECT id, latitude AS lat, longitude AS lng, price_usd, title FROM listings
     WHERE ${where} AND latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY listed_at DESC LIMIT 5000`,
    params
  );
  return rows;
}

async function getListing(id) {
  const { rows } = await pool.query(
    `SELECT l.*, r.per_usd AS rate_per_usd, r.updated_at AS rate_updated_at
     FROM listings l LEFT JOIN exchange_rates r ON r.currency = l.currency
     WHERE l.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function stats() {
  const [summary, countries, types] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS listings,
              count(DISTINCT country_code)::int AS countries,
              count(DISTINCT currency)::int AS currencies,
              coalesce(bool_or(is_sample), false) AS has_sample,
              (SELECT max(updated_at) FROM exchange_rates) AS rates_updated_at
       FROM listings WHERE status = 'for_sale' AND price_usd IS NOT NULL`
    ),
    pool.query(
      `SELECT country_code AS code, min(country) AS name, count(*)::int AS n FROM listings
       WHERE status = 'for_sale' AND price_usd IS NOT NULL
       GROUP BY country_code ORDER BY min(country)`
    ),
    pool.query(
      `SELECT property_type AS type, count(*)::int AS n FROM listings
       WHERE status = 'for_sale' GROUP BY property_type ORDER BY n DESC`
    ),
  ]);
  return { ...summary.rows[0], country_list: countries.rows, types: types.rows };
}

module.exports = { normalize, upsertListings, searchListings, mapPoints, getListing, stats, CONVERT_SQL };
