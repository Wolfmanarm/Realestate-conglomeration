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
No single free, public API covers every home for sale in the world. Real listings come from
MLS/IDX feeds (US/Canada), portal partner APIs (Rightmove, Idealista, Zillow, Domain and so on,
which usually require agreements), or brokerage feeds. Map each feed to this format and POST it:

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
