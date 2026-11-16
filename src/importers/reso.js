// RESO Web API importer (the OData standard used by MLSs in the US and Canada).
//
// Access requires credentials from an MLS (via a sponsoring broker) or an IDX/data vendor.
// Configure with environment variables:
//   RESO_BASE_URL        e.g. https://api.yourmls.com/odata          (required)
//   RESO_TOKEN           static bearer token                          (or the OAuth trio below)
//   RESO_TOKEN_URL, RESO_CLIENT_ID, RESO_CLIENT_SECRET, RESO_SCOPE  OAuth2 client-credentials
//   RESO_SOURCE          name stored on listings (default "reso")
//   RESO_RESOURCE        default "Property"
//   RESO_CURRENCY        default "USD" (use CAD for Canadian boards)
//   RESO_DEFAULT_COUNTRY default "US"
//   RESO_EXTRA_FILTER    extra OData filter ANDed in, e.g. "PropertyType eq 'Residential'"
//   RESO_EXPAND_MEDIA    "true" to $expand=Media for the first photo (if your vendor supports it)
//   RESO_LISTING_URL_TEMPLATE  e.g. https://yourbrokerage.com/listing/{ListingKey}
//   RESO_PAGE_SIZE       default 200
//
// First run imports active listings. Later runs fetch everything modified since the last
// successful run (any status), so sold/pending/withdrawn changes take listings off the site.

const SQFT_TO_SQM = 0.09290304;
const ACRE_TO_SQM = 4046.8564224;

const STATUS_MAP = {
  active: 'for_sale',
  comingsoon: 'withdrawn',
  activeundercontract: 'pending',
  pending: 'pending',
  closed: 'sold',
  canceled: 'withdrawn',
  cancelled: 'withdrawn',
  expired: 'withdrawn',
  withdrawn: 'withdrawn',
  hold: 'withdrawn',
  delete: 'withdrawn',
  incomplete: 'withdrawn',
};

const COUNTRY_NAMES = { US: 'United States', CA: 'Canada' };

function config(env = process.env) {
  return {
    baseUrl: (env.RESO_BASE_URL || '').replace(/\/+$/, ''),
    token: env.RESO_TOKEN || '',
    tokenUrl: env.RESO_TOKEN_URL || '',
    clientId: env.RESO_CLIENT_ID || '',
    clientSecret: env.RESO_CLIENT_SECRET || '',
    scope: env.RESO_SCOPE || '',
    source: env.RESO_SOURCE || 'reso',
    resource: env.RESO_RESOURCE || 'Property',
    currency: (env.RESO_CURRENCY || 'USD').toUpperCase(),
    defaultCountry: (env.RESO_DEFAULT_COUNTRY || 'US').toUpperCase(),
    extraFilter: env.RESO_EXTRA_FILTER || '',
    expandMedia: env.RESO_EXPAND_MEDIA === 'true',
    listingUrlTemplate: env.RESO_LISTING_URL_TEMPLATE || '',
    pageSize: Math.min(Math.max(parseInt(env.RESO_PAGE_SIZE, 10) || 200, 1), 1000),
  };
}

function isConfigured(cfg = config()) {
  return Boolean(cfg.baseUrl && (cfg.token || (cfg.tokenUrl && cfg.clientId && cfg.clientSecret)));
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function areaToSqm(value, units) {
  const v = num(value);
  if (v === null) return null;
  const u = String(units || 'SquareFeet').toLowerCase().replace(/[^a-z]/g, '');
  if (u.startsWith('squaremeter') || u === 'sqm' || u === 'm') return v;
  if (u.startsWith('acre')) return v * ACRE_TO_SQM;
  if (u.startsWith('hectare')) return v * 10000;
  return v * SQFT_TO_SQM;
}

// Lease/rental records carry a monthly rent in ListPrice; never show them as homes for sale.
const isLease = (p) => /lease|rental/i.test(`${p.PropertyType || ''} ${p.PropertySubType || ''}`);

function mapStatus(p) {
  if (isLease(p)) return 'withdrawn';
  const raw = String(p.StandardStatus || p.MlsStatus || '').toLowerCase().replace(/[^a-z]/g, '');
  return STATUS_MAP[raw] || 'withdrawn';
}

function mapPropertyType(p) {
  const sub = String(p.PropertySubType || '').toLowerCase();
  const type = String(p.PropertyType || '').toLowerCase();
  if (/condo/.test(sub)) return 'condo';
  if (/townho|row/.test(sub)) return 'townhouse';
  if (/apartment|stock cooperative|co-?op/.test(sub)) return 'apartment';
  if (/cabin|cottage/.test(sub)) return 'cottage';
  if (/manufactured|mobile/.test(sub + type)) return 'manufactured';
  if (/land/.test(type)) return 'land';
  if (/farm|ranch/.test(type)) return 'farm';
  if (/commercial|business|lease/.test(type)) return 'commercial';
  return 'house';
}

function buildAddress(p) {
  if (p.UnparsedAddress) return String(p.UnparsedAddress).split(',')[0].trim();
  const parts = [p.StreetNumber, p.StreetDirPrefix, p.StreetName, p.StreetSuffix, p.StreetDirSuffix]
    .filter((x) => x !== null && x !== undefined && x !== '');
  let a = parts.join(' ');
  if (a && p.UnitNumber) a += ` #${p.UnitNumber}`;
  return a || null;
}

function firstPhoto(p) {
  const media = Array.isArray(p.Media) ? p.Media : [];
  const photos = media
    .filter((m) => m && m.MediaURL && (!m.MediaCategory || /photo/i.test(m.MediaCategory)))
    .sort((a, b) => (num(a.Order) ?? 1e9) - (num(b.Order) ?? 1e9));
  return photos.length ? photos[0].MediaURL : null;
}

// Maps one RESO Data Dictionary "Property" record into the shape listings.normalize() expects.
function mapProperty(p, cfg) {
  const key = p.ListingKey || p.ListingId;
  const cc = String(p.Country || cfg.defaultCountry).toUpperCase().slice(0, 2);
  const beds = num(p.BedroomsTotal);
  const baths = num(p.BathroomsTotalDecimal) ?? num(p.BathroomsTotalInteger) ??
    (num(p.BathroomsFull) !== null ? num(p.BathroomsFull) + 0.5 * (num(p.BathroomsHalf) || 0) : null);
  const type = mapPropertyType(p);
  const city = p.City || null;
  const lotSqm = num(p.LotSizeSquareFeet) !== null ? num(p.LotSizeSquareFeet) * SQFT_TO_SQM
    : areaToSqm(p.LotSizeArea, p.LotSizeUnits) ?? (num(p.LotSizeAcres) !== null ? num(p.LotSizeAcres) * ACRE_TO_SQM : null);
  const title = [
    beds !== null ? `${beds}-bed` : null,
    type,
    city ? `in ${city}` : null,
  ].filter(Boolean).join(' ');

  return {
    source: cfg.source,
    external_id: key ? String(key) : null,
    title: title.charAt(0).toUpperCase() + title.slice(1),
    description: p.PublicRemarks || null,
    property_type: type,
    status: mapStatus(p),
    price: num(p.ListPrice),
    currency: cfg.currency,
    bedrooms: beds,
    bathrooms: baths,
    area_sqm: areaToSqm(p.LivingArea, p.LivingAreaUnits) ?? areaToSqm(p.BuildingAreaTotal, p.BuildingAreaUnits),
    lot_sqm: lotSqm !== null ? Math.round(lotSqm * 100) / 100 : null,
    year_built: num(p.YearBuilt),
    address: buildAddress(p),
    city,
    region: p.StateOrProvince || null,
    country: COUNTRY_NAMES[cc] || cc,
    country_code: cc,
    latitude: num(p.Latitude),
    longitude: num(p.Longitude),
    image_url: firstPhoto(p),
    listing_url: cfg.listingUrlTemplate && key
      ? cfg.listingUrlTemplate.replace(/\{(\w+)\}/g, (_, f) => encodeURIComponent(p[f] ?? '')) : null,
    is_sample: false,
    listed_at: p.OnMarketTimestamp || p.OriginalEntryTimestamp || p.ListingContractDate || p.ModificationTimestamp || null,
  };
}

async function getToken(cfg, fetchImpl) {
  if (cfg.token) return cfg.token;
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret });
  if (cfg.scope) body.set('scope', cfg.scope);
  const res = await fetchImpl(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`RESO token request failed: HTTP ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('RESO token response had no access_token');
  return j.access_token;
}

function firstPageUrl(cfg, since) {
  const filters = [since ? `ModificationTimestamp ge ${since.toISOString()}` : "StandardStatus eq 'Active'"];
  if (cfg.extraFilter) filters.push(`(${cfg.extraFilter})`);
  const q = new URLSearchParams({
    $filter: filters.join(' and '),
    $top: String(cfg.pageSize),
    $orderby: 'ModificationTimestamp asc',
  });
  if (cfg.expandMedia) q.set('$expand', 'Media');
  return `${cfg.baseUrl}/${cfg.resource}?${q.toString().replace(/\+/g, '%20')}`;
}

// Pulls every page from the feed and hands mapped listings to `upsert` in batches.
// Returns counts plus the newest ModificationTimestamp seen (for the next incremental run).
async function runResoImport({ cfg = config(), since = null, upsert, normalize, fetchImpl = fetch, log = console.log, maxPages = 100000 }) {
  if (!isConfigured(cfg)) throw new Error('RESO importer is not configured (set RESO_BASE_URL and RESO_TOKEN or OAuth credentials).');
  let token = await getToken(cfg, fetchImpl);
  const canRefresh = !cfg.token; // OAuth tokens can be re-issued mid-run
  let url = firstPageUrl(cfg, since);
  let pages = 0, seen = 0, upserted = 0, rejected = 0, refreshedFor = null;
  const keys = new Set(); // every ListingKey seen, for withdrawing listings that left the feed
  let newest = since;

  while (url && pages < maxPages) {
    let res;
    for (let attempt = 1; ; attempt++) {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
      if (res.status === 401 && canRefresh && refreshedFor !== url) {
        refreshedFor = url; // token expired mid-run: get a new one and retry this page once
        log('RESO token rejected, requesting a new one');
        token = await getToken(cfg, fetchImpl);
        continue;
      }
      if (res.status !== 429 && res.status < 500) break;
      if (attempt >= 5) break;
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * attempt;
      log(`RESO HTTP ${res.status}, retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!res.ok) throw new Error(`RESO request failed: HTTP ${res.status} for ${url}`);
    const page = await res.json();
    const records = Array.isArray(page.value) ? page.value : [];
    pages++;
    seen += records.length;

    const valid = [];
    for (const rec of records) {
      const key = rec.ListingKey || rec.ListingId;
      if (key) keys.add(String(key));
      const ts = rec.ModificationTimestamp ? new Date(rec.ModificationTimestamp) : null;
      if (ts && !Number.isNaN(ts.getTime()) && (!newest || ts > newest)) newest = ts;
      const { listing, errors } = normalize(mapProperty(rec, cfg));
      if (errors.length) { rejected++; continue; }
      valid.push(listing);
    }
    if (valid.length) upserted += await upsert(valid);
    log(`RESO page ${pages}: ${records.length} records, ${valid.length} valid`);
    url = page['@odata.nextLink'] || null;
  }
  return { pages, seen, upserted, rejected, newest, keys, complete: !url };
}

module.exports = { config, isConfigured, mapProperty, mapStatus, areaToSqm, firstPageUrl, runResoImport };
