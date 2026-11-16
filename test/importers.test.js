// Offline tests for the importers. The RESO test runs against a local fixture server that
// mimics an OData RESO Web API (OAuth token, paging via @odata.nextLink, a 429 retry).
// It does NOT prove compatibility with any particular live MLS.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused@localhost:1/unused'; // pool never connects here

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const reso = require('../src/importers/reso');
const { parseCsv, parseListingFile } = require('../src/importers/file');
const { normalize } = require('../src/listings');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function startFixtureServer() {
  const requests = [];
  let throttled = false;
  const server = http.createServer((req, res) => {
    const base = `http://localhost:${server.address().port}/odata`;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    if (req.method === 'POST' && req.url === '/oauth/token') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = new URLSearchParams(body);
        const ok = p.get('grant_type') === 'client_credentials' && p.get('client_id') === 'id' && p.get('client_secret') === 'secret';
        res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(ok ? { access_token: 'tok-123', token_type: 'Bearer' } : { error: 'invalid_client' }));
      });
      return;
    }
    if (req.headers.authorization !== 'Bearer tok-123') { res.writeHead(401); res.end(); return; }
    if (req.url.startsWith('/odata/Property?$skiptoken=page2')) {
      if (!throttled) { throttled = true; res.writeHead(429, { 'Retry-After': '0.01' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fixture('reso-page2.json'));
      return;
    }
    if (req.url.startsWith('/odata/Property?')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fixture('reso-page1.json').replace('__BASE__', base));
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, requests })));
}

const cfgFor = (port, extra = {}) => reso.config({
  RESO_BASE_URL: `http://localhost:${port}/odata/`,
  RESO_TOKEN_URL: `http://localhost:${port}/oauth/token`,
  RESO_CLIENT_ID: 'id',
  RESO_CLIENT_SECRET: 'secret',
  RESO_SOURCE: 'test-mls',
  RESO_LISTING_URL_TEMPLATE: 'https://broker.test/l/{ListingKey}',
  ...extra,
});

test('mapProperty maps RESO Data Dictionary fields', () => {
  const page = JSON.parse(fixture('reso-page1.json'));
  const cfg = reso.config({ RESO_BASE_URL: 'x', RESO_TOKEN: 't', RESO_SOURCE: 'mls' });
  const a = reso.mapProperty(page.value[0], cfg);
  assert.equal(a.external_id, '3yd-ABC-1001');
  assert.equal(a.status, 'for_sale');
  assert.equal(a.property_type, 'house');
  assert.equal(a.price, 549000);
  assert.equal(a.currency, 'USD');
  assert.equal(a.country_code, 'US');
  assert.equal(a.country, 'United States');
  assert.equal(a.address, '1420 Maple Ave');
  assert.equal(Math.round(a.area_sqm), 200); // 2150 ft²
  assert.equal(Math.round(a.lot_sqm), 1012); // 0.25 acre
  assert.equal(a.image_url, 'https://media.example-mls.test/1001/1.jpg'); // lowest Order wins
  assert.equal(a.title, '4-bed house in Boise');
  assert.equal(a.listed_at, '2026-11-01T15:00:00Z');
  assert.deepEqual(normalize(a).errors, []);

  const b = reso.mapProperty(page.value[1], cfg);
  assert.equal(b.property_type, 'condo');
  assert.equal(b.area_sqm, 95); // already m²
  assert.equal(b.bathrooms, 1.5);
  assert.equal(b.address, '88 River St Unit 4');
  assert.equal(b.country_code, 'US'); // default country
});

test('mapStatus handles RESO StandardStatus values', () => {
  assert.equal(reso.mapStatus({ StandardStatus: 'Active' }), 'for_sale');
  assert.equal(reso.mapStatus({ StandardStatus: 'Active Under Contract' }), 'pending');
  assert.equal(reso.mapStatus({ StandardStatus: 'Pending' }), 'pending');
  assert.equal(reso.mapStatus({ StandardStatus: 'Closed' }), 'sold');
  assert.equal(reso.mapStatus({ StandardStatus: 'Coming Soon' }), 'withdrawn');
  assert.equal(reso.mapStatus({}), 'withdrawn');
});

test('first page filters: full sync vs incremental', () => {
  const cfg = reso.config({ RESO_BASE_URL: 'https://api.test/odata', RESO_TOKEN: 't', RESO_EXTRA_FILTER: "PropertyType eq 'Residential'" });
  const full = decodeURIComponent(new URL(reso.firstPageUrl(cfg, null)).search);
  assert.match(full, /\$filter=StandardStatus eq 'Active' and \(PropertyType eq 'Residential'\)/);
  assert.match(full, /\$orderby=ModificationTimestamp asc/);
  const inc = decodeURIComponent(new URL(reso.firstPageUrl(cfg, new Date('2026-11-01T00:00:00Z'))).search);
  assert.match(inc, /ModificationTimestamp gt 2026-11-01T00:00:00.000Z/);
  assert.doesNotMatch(inc, /StandardStatus/); // incremental must see status changes
});

test('runResoImport pages through the feed with OAuth and retries 429', async () => {
  const { server, requests } = await startFixtureServer();
  try {
    const batches = [];
    const r = await reso.runResoImport({
      cfg: cfgFor(server.address().port),
      normalize,
      upsert: async (rows) => { batches.push(rows); return rows.length; },
      log: () => {},
    });
    assert.equal(r.pages, 2);
    assert.equal(r.seen, 4);
    assert.equal(r.upserted, 3);
    assert.equal(r.rejected, 1); // 1004 has no ListPrice
    assert.equal(r.newest.toISOString(), '2026-11-14T19:45:00.000Z');
    const all = batches.flat();
    assert.deepEqual(all.map((l) => l.status), ['for_sale', 'for_sale', 'sold']);
    assert.ok(all.every((l) => l.source === 'test-mls' && !l.is_sample));
    assert.equal(all[0].listing_url, 'https://broker.test/l/3yd-ABC-1001');
    assert.equal(requests[0].url, '/oauth/token');
    assert.ok(requests.slice(1).every((q) => q.auth === 'Bearer tok-123'));
    assert.equal(requests.filter((q) => q.url.includes('skiptoken')).length, 2); // one 429 + retry
  } finally {
    server.close();
  }
});

test('runResoImport fails clearly on bad credentials', async () => {
  const { server } = await startFixtureServer();
  try {
    await assert.rejects(
      reso.runResoImport({ cfg: cfgFor(server.address().port, { RESO_CLIENT_SECRET: 'wrong' }), normalize, upsert: async () => 0, log: () => {} }),
      /token request failed: HTTP 401/
    );
  } finally {
    server.close();
  }
});

test('CSV parser handles quotes, commas and newlines', () => {
  const rows = parseCsv('external_id,title,price,currency,country,country_code\r\n' +
    'a1,"Cottage, ""lake"" view",250000,EUR,Ireland,IE\r\n' +
    'a2,"Two\nlines",100,usd,United States,us\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Cottage, "lake" view');
  assert.equal(rows[1].title, 'Two\nlines');
  const n = normalize(rows[1]);
  assert.deepEqual(n.errors, []);
  assert.equal(n.listing.currency, 'USD');
  assert.equal(n.listing.country_code, 'US');
});

test('parseListingFile accepts JSON arrays and {listings: []}', () => {
  assert.equal(parseListingFile('[{"external_id":"x"}]', 'a.json').length, 1);
  assert.equal(parseListingFile('{"listings":[{},{}]}', 'feed').length, 2);
  assert.throws(() => parseListingFile('{"nope":1}', 'a.json'));
});
