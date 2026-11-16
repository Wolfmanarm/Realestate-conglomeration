# Globe Homes — worldwide homes for sale, priced in USD

A real-estate listings site for homes for sale in any country. Each listing keeps its original
price and currency, and the site converts it to **US dollars** using live exchange rates.

- **Backend:** Node.js + Express, with PostgreSQL through `pg`
- **Frontend:** plain HTML, CSS and JS (no build step), with a Leaflet + OpenStreetMap world map
- **Hosting:** Railway (`railway.json` included)

## Features
- Search by keyword, country, property type, USD price range, bedrooms and bathrooms
- Sort by newest, price, price per m², or size
- List view and world map view; the filter state is kept in the URL so searches can be shared
- Listing detail showing the USD price, the original local price and the exact rate used
- Exchange rates refresh every 6 hours from `open.er-api.com` (free, no API key). If that service is down, the app uses a built-in fallback table.
- `price_usd` is stored on each listing and indexed, so filtering and sorting by USD stays fast
- Admin import API for loading real listing feeds

## Deploy on Railway
1. Push this repo to GitHub, then in Railway choose **New Project → Deploy from GitHub repo**.
2. In the same project, add **Database → PostgreSQL**.
3. On the web service, set these **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `ADMIN_TOKEN` = a long random string, used by the import API
4. Under **Settings → Networking**, click **Generate Domain**.

When the app starts it creates the tables, fetches exchange rates and, if the database is empty,
seeds about 600 **sample** listings in 75 cities so the site isn't blank. To turn that off, set
`SEED_SAMPLE_DATA=false`.

## Run locally
```bash
npm install
cp .env.example .env   # then edit DATABASE_URL
export $(grep -v '^#' .env | xargs)
npm start              # http://localhost:3000
```

## Loading real listings
No single dataset holds every home for sale on Earth. Real listings come through licensed channels:
- MLS feeds in the US and Canada
- Developer programs from national property websites, which usually need an application or agreement
- Paid data providers
- Brokerages' own feeds

Scraping sites like Zillow, Rightmove or Idealista breaks their terms, and their photos are
copyrighted, so this project doesn't do it.

There are three ways to bring listings in. Every listing must have a currency code, and its price
is converted to USD automatically.

### 1. MLS feeds through the RESO Web API (US and Canada)
`src/importers/reso.js` reads the industry-standard RESO Web API (OData) and maps standard fields
into the site's format, including `ListingKey`, `ListPrice`, `StandardStatus`, `BedroomsTotal`,
`LivingArea`, `Latitude`/`Longitude` and `Media`. To get access, you need an MLS data license
through a sponsoring broker, or an IDX/data vendor account.

> **Status:** tested against a local mock RESO server (`test/fixtures`), **not yet against a live MLS**.
> MLSs differ in which fields they fill in and which `$expand` options they support, so run it once
> by hand and check the import log before scheduling it.

Set these variables on Railway:

| Variable | Purpose |
|---|---|
| `RESO_BASE_URL` | OData root, e.g. `https://api.yourmls.com/odata` |
| `RESO_TOKEN` | Static bearer token, **or** set the next three instead |
| `RESO_TOKEN_URL`, `RESO_CLIENT_ID`, `RESO_CLIENT_SECRET` (`RESO_SCOPE`) | OAuth2 client credentials |
| `RESO_SOURCE` | Label stored on the listings (default `reso`); use one label per feed |
| `RESO_CURRENCY` / `RESO_DEFAULT_COUNTRY` | Defaults `USD` / `US`; use `CAD` / `CA` for Canadian boards |
| `RESO_EXTRA_FILTER` | e.g. `PropertyType eq 'Residential'` to import homes only |
| `RESO_EXPAND_MEDIA` | `true` to fetch photos with `$expand=Media`, if your feed supports it |
| `RESO_LISTING_URL_TEMPLATE` | e.g. `https://yourbrokerage.com/listing/{ListingKey}` |
| `RESO_SYNC_MINUTES` | e.g. `60` to sync automatically from the web service |

- The first run imports active listings.
- Later runs fetch only records changed since the last successful run, so a listing that goes pending, sold or withdrawn drops off the site.
- To run a sync by hand, use `npm run import:reso`, or `npm run import:reso -- --full` to re-pull everything.
- You can also call `POST /api/admin/import/reso` or `POST /api/admin/import/reso?full=true`.
- Each run is logged in the `import_runs` table, which you can see at `GET /api/admin/import-runs`.

### 2. CSV or JSON files
```bash
npm run import:file -- listings.csv --source=my-broker
```
Column names are the same as the API fields below. Rows that fail validation are reported and skipped.

### 3. Import API
Map a feed to this format and POST it:

```bash
curl -X POST https://<your-app>.up.railway.app/api/admin/listings \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '[{
    "source": "my-feed", "external_id": "A-123",
    "title": "3-bed house with garden", "price": 450000, "currency": "EUR",
    "country": "Portugal", "country_code": "PT", "city": "Porto",
    "bedrooms": 3, "bathrooms": 2, "area_sqm": 140,
    "latitude": 41.15, "longitude": -8.61,
    "image_url": "https://...", "listing_url": "https://..."
  }]'
```

- Listings are upserted on `(source, external_id)`, so re-sending a feed updates it in place.
- To hide a listing, set `"status"` to `sold`, `pending` or `withdrawn`. Only `for_sale` listings are shown.
- The `currency` field accepts any ISO 4217 code supported by the rates provider. Prices convert to USD automatically.

Other admin endpoints (all take `Authorization: Bearer $ADMIN_TOKEN`):
- `POST /api/admin/refresh-rates`: refresh exchange rates now
- `DELETE /api/admin/sample-listings`: remove the demo listings once real data is loaded

## Public API
- `GET /api/listings?q=&country=FR&type=house&min_price=&max_price=&beds=&baths=&sort=price_asc&page=1&limit=24`
- `GET /api/listings/:id`
- `GET /api/map?…same filters…`
- `GET /api/stats`
- `GET /health`
