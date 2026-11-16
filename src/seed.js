// Seeds the database with SAMPLE listings across the world (flagged is_sample = true) so the
// site is usable immediately. Replace/augment with real feeds via POST /api/admin/listings.
const { pool } = require('./db');
const { migrate } = require('./migrate');
const { refreshRates } = require('./rates');

// [city, region, country, countryCode, currency, lat, lng, typical price per sqm in local currency]
const CITIES = [
  ['New York', 'NY', 'United States', 'US', 'USD', 40.7128, -74.006, 11000],
  ['Los Angeles', 'CA', 'United States', 'US', 'USD', 34.0522, -118.2437, 8000],
  ['Austin', 'TX', 'United States', 'US', 'USD', 30.2672, -97.7431, 4200],
  ['Miami', 'FL', 'United States', 'US', 'USD', 25.7617, -80.1918, 6000],
  ['Chicago', 'IL', 'United States', 'US', 'USD', 41.8781, -87.6298, 3600],
  ['Denver', 'CO', 'United States', 'US', 'USD', 39.7392, -104.9903, 4800],
  ['Seattle', 'WA', 'United States', 'US', 'USD', 47.6062, -122.3321, 7200],
  ['Toronto', 'ON', 'Canada', 'CA', 'CAD', 43.6532, -79.3832, 10500],
  ['Vancouver', 'BC', 'Canada', 'CA', 'CAD', 49.2827, -123.1207, 12500],
  ['Mexico City', 'CDMX', 'Mexico', 'MX', 'MXN', 19.4326, -99.1332, 45000],
  ['Tulum', 'Quintana Roo', 'Mexico', 'MX', 'MXN', 20.2114, -87.4654, 55000],
  ['São Paulo', 'SP', 'Brazil', 'BR', 'BRL', -23.5505, -46.6333, 11000],
  ['Rio de Janeiro', 'RJ', 'Brazil', 'BR', 'BRL', -22.9068, -43.1729, 10500],
  ['Buenos Aires', 'CABA', 'Argentina', 'AR', 'ARS', -34.6037, -58.3816, 2300000],
  ['Santiago', 'RM', 'Chile', 'CL', 'CLP', -33.4489, -70.6693, 2400000],
  ['Medellín', 'Antioquia', 'Colombia', 'CO', 'COP', 6.2442, -75.5812, 6500000],
  ['Lima', 'Lima', 'Peru', 'PE', 'PEN', -12.0464, -77.0428, 7000],
  ['San José', 'San José', 'Costa Rica', 'CR', 'CRC', 9.9281, -84.0907, 900000],
  ['London', 'England', 'United Kingdom', 'GB', 'GBP', 51.5074, -0.1278, 11000],
  ['Edinburgh', 'Scotland', 'United Kingdom', 'GB', 'GBP', 55.9533, -3.1883, 4500],
  ['Dublin', 'Leinster', 'Ireland', 'IE', 'EUR', 53.3498, -6.2603, 6000],
  ['Paris', 'Île-de-France', 'France', 'FR', 'EUR', 48.8566, 2.3522, 10500],
  ['Nice', "Provence-Alpes-Côte d'Azur", 'France', 'FR', 'EUR', 43.7102, 7.262, 6200],
  ['Berlin', 'Berlin', 'Germany', 'DE', 'EUR', 52.52, 13.405, 5800],
  ['Munich', 'Bavaria', 'Germany', 'DE', 'EUR', 48.1351, 11.582, 9500],
  ['Madrid', 'Madrid', 'Spain', 'ES', 'EUR', 40.4168, -3.7038, 5000],
  ['Barcelona', 'Catalonia', 'Spain', 'ES', 'EUR', 41.3851, 2.1734, 5200],
  ['Lisbon', 'Lisboa', 'Portugal', 'PT', 'EUR', 38.7223, -9.1393, 5500],
  ['Rome', 'Lazio', 'Italy', 'IT', 'EUR', 41.9028, 12.4964, 4200],
  ['Milan', 'Lombardy', 'Italy', 'IT', 'EUR', 45.4642, 9.19, 5800],
  ['Amsterdam', 'North Holland', 'Netherlands', 'NL', 'EUR', 52.3676, 4.9041, 7800],
  ['Zurich', 'Zurich', 'Switzerland', 'CH', 'CHF', 47.3769, 8.5417, 17000],
  ['Stockholm', 'Stockholm', 'Sweden', 'SE', 'SEK', 59.3293, 18.0686, 90000],
  ['Oslo', 'Oslo', 'Norway', 'NO', 'NOK', 59.9139, 10.7522, 85000],
  ['Copenhagen', 'Capital Region', 'Denmark', 'DK', 'DKK', 55.6761, 12.5683, 50000],
  ['Reykjavík', 'Capital Region', 'Iceland', 'IS', 'ISK', 64.1466, -21.9426, 850000],
  ['Warsaw', 'Masovia', 'Poland', 'PL', 'PLN', 52.2297, 21.0122, 16000],
  ['Prague', 'Prague', 'Czechia', 'CZ', 'CZK', 50.0755, 14.4378, 140000],
  ['Budapest', 'Budapest', 'Hungary', 'HU', 'HUF', 47.4979, 19.0402, 1300000],
  ['Athens', 'Attica', 'Greece', 'GR', 'EUR', 37.9838, 23.7275, 3000],
  ['Istanbul', 'Istanbul', 'Türkiye', 'TR', 'TRY', 41.0082, 28.9784, 60000],
  ['Tbilisi', 'Tbilisi', 'Georgia', 'GE', 'GEL', 41.7151, 44.8271, 3800],
  ['Dubai', 'Dubai', 'United Arab Emirates', 'AE', 'AED', 25.2048, 55.2708, 18000],
  ['Riyadh', 'Riyadh', 'Saudi Arabia', 'SA', 'SAR', 24.7136, 46.6753, 6500],
  ['Doha', 'Doha', 'Qatar', 'QA', 'QAR', 25.2854, 51.531, 12000],
  ['Tel Aviv', 'Tel Aviv', 'Israel', 'IL', 'ILS', 32.0853, 34.7818, 55000],
  ['Cairo', 'Cairo', 'Egypt', 'EG', 'EGP', 30.0444, 31.2357, 35000],
  ['Marrakesh', 'Marrakesh-Safi', 'Morocco', 'MA', 'MAD', 31.6295, -7.9811, 14000],
  ['Cape Town', 'Western Cape', 'South Africa', 'ZA', 'ZAR', -33.9249, 18.4241, 30000],
  ['Johannesburg', 'Gauteng', 'South Africa', 'ZA', 'ZAR', -26.2041, 28.0473, 15000],
  ['Nairobi', 'Nairobi', 'Kenya', 'KE', 'KES', -1.2921, 36.8219, 140000],
  ['Lagos', 'Lagos', 'Nigeria', 'NG', 'NGN', 6.5244, 3.3792, 900000],
  ['Port Louis', 'Port Louis', 'Mauritius', 'MU', 'MUR', -20.1609, 57.5012, 120000],
  ['Mumbai', 'Maharashtra', 'India', 'IN', 'INR', 19.076, 72.8777, 320000],
  ['Bengaluru', 'Karnataka', 'India', 'IN', 'INR', 12.9716, 77.5946, 110000],
  ['Colombo', 'Western', 'Sri Lanka', 'LK', 'LKR', 6.9271, 79.8612, 600000],
  ['Bangkok', 'Bangkok', 'Thailand', 'TH', 'THB', 13.7563, 100.5018, 130000],
  ['Phuket', 'Phuket', 'Thailand', 'TH', 'THB', 7.8804, 98.3923, 110000],
  ['Kuala Lumpur', 'Federal Territory', 'Malaysia', 'MY', 'MYR', 3.139, 101.6869, 9000],
  ['Singapore', 'Central', 'Singapore', 'SG', 'SGD', 1.3521, 103.8198, 20000],
  ['Bali', 'Bali', 'Indonesia', 'ID', 'IDR', -8.3405, 115.092, 28000000],
  ['Manila', 'Metro Manila', 'Philippines', 'PH', 'PHP', 14.5995, 120.9842, 180000],
  ['Ho Chi Minh City', 'HCMC', 'Vietnam', 'VN', 'VND', 10.8231, 106.6297, 75000000],
  ['Hong Kong', 'Hong Kong Island', 'Hong Kong', 'HK', 'HKD', 22.3193, 114.1694, 160000],
  ['Shanghai', 'Shanghai', 'China', 'CN', 'CNY', 31.2304, 121.4737, 70000],
  ['Taipei', 'Taipei', 'Taiwan', 'TW', 'TWD', 25.033, 121.5654, 750000],
  ['Seoul', 'Seoul', 'South Korea', 'KR', 'KRW', 37.5665, 126.978, 14000000],
  ['Tokyo', 'Tokyo', 'Japan', 'JP', 'JPY', 35.6762, 139.6503, 1300000],
  ['Kyoto', 'Kyoto', 'Japan', 'JP', 'JPY', 35.0116, 135.7681, 700000],
  ['Sydney', 'NSW', 'Australia', 'AU', 'AUD', -33.8688, 151.2093, 14000],
  ['Melbourne', 'VIC', 'Australia', 'AU', 'AUD', -37.8136, 144.9631, 9000],
  ['Auckland', 'Auckland', 'New Zealand', 'NZ', 'NZD', -36.8485, 174.7633, 10000],
  ['Nassau', 'New Providence', 'Bahamas', 'BS', 'BSD', 25.0443, -77.3504, 5500],
  ['Kingston', 'Surrey', 'Jamaica', 'JM', 'JMD', 18.0179, -76.8099, 450000],
  ['Punta Cana', 'La Altagracia', 'Dominican Republic', 'DO', 'DOP', 18.582, -68.4055, 140000],
];

const TYPES = [
  ['house', 0.42], ['apartment', 0.28], ['villa', 0.1], ['townhouse', 0.1], ['condo', 0.06], ['cottage', 0.04],
];
const ADJ = ['Sunny', 'Modern', 'Charming', 'Spacious', 'Renovated', 'Elegant', 'Cozy', 'Bright', 'Historic', 'Contemporary', 'Quiet', 'Stylish', 'Luxury', 'Family'];
const FEATURES = ['a private garden', 'a rooftop terrace', 'panoramic city views', 'an open-plan kitchen', 'a swimming pool', 'high ceilings', 'a home office', 'a two-car garage', 'sea views', 'original hardwood floors', 'a wraparound balcony', 'solar panels', 'a walk-in closet', 'a fireplace'];
const STREETS = ['Oak', 'Harbour', 'Garden', 'Park', 'Hill', 'River', 'Station', 'Market', 'Church', 'Lake', 'Palm', 'Cedar', 'Bay', 'Castle'];

// Deterministic PRNG so the sample data is stable across re-seeds.
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function buildListings(perCity) {
  const rnd = mulberry32(20261116);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const weighted = () => { let r = rnd(), acc = 0; for (const [t, w] of TYPES) { acc += w; if (r <= acc) return t; } return 'house'; };
  const out = [];
  for (const [city, region, country, cc, currency, lat, lng, ppsqm] of CITIES) {
    for (let i = 0; i < perCity; i++) {
      const type = weighted();
      const beds = type === 'apartment' || type === 'condo' ? 1 + Math.floor(rnd() * 3) : 2 + Math.floor(rnd() * 5);
      const baths = Math.max(1, Math.round((beds * (0.5 + rnd() * 0.6)) * 2) / 2);
      const area = Math.round(beds * (28 + rnd() * 30) + 25);
      const premium = type === 'villa' ? 1.5 : type === 'cottage' ? 0.85 : 1;
      const rawPrice = area * ppsqm * premium * (0.65 + rnd() * 0.8);
      const magnitude = Math.pow(10, Math.max(0, Math.floor(Math.log10(rawPrice)) - 2));
      const price = Math.round(rawPrice / magnitude) * magnitude;
      const adj = pick(ADJ);
      const feat1 = pick(FEATURES); let feat2 = pick(FEATURES); if (feat2 === feat1) feat2 = FEATURES[(FEATURES.indexOf(feat1) + 1) % FEATURES.length];
      const daysAgo = Math.floor(rnd() * 120);
      out.push({
        source: 'sample',
        external_id: `${cc}-${city}-${i}`.replace(/\s+/g, '_'),
        title: `${adj} ${beds}-bed ${type} in ${city}`,
        description: `${adj} ${type} with ${beds} bedroom${beds === 1 ? "" : "s"} and ${baths} bathroom${baths === 1 ? "" : "s"}, offering ${feat1} and ${feat2}. Located in ${city}, ${country}. Sample listing for demonstration.`,
        property_type: type,
        price, currency,
        bedrooms: beds, bathrooms: baths, area_sqm: area,
        lot_sqm: type === 'apartment' || type === 'condo' ? null : Math.round(area * (1.2 + rnd() * 4)),
        year_built: 1900 + Math.floor(rnd() * 125),
        address: `${1 + Math.floor(rnd() * 250)} ${pick(STREETS)} ${pick(['Street', 'Road', 'Avenue', 'Lane'])}`,
        city, region, country, country_code: cc,
        latitude: lat + (rnd() - 0.5) * 0.12,
        longitude: lng + (rnd() - 0.5) * 0.12,
        is_sample: true,
        listed_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
      });
    }
  }
  return out;
}

async function seed({ perCity = Number(process.env.SEED_PER_CITY || 8), onlyIfEmpty = false } = {}) {
  await migrate();
  if (onlyIfEmpty) {
    const { rows } = await pool.query('SELECT 1 FROM listings LIMIT 1');
    if (rows.length) return { skipped: true };
  }
  const { upsertListings } = require('./listings');
  const listings = buildListings(perCity);
  const n = await upsertListings(listings);
  await refreshRates();
  console.log(`Seeded ${n} sample listings across ${CITIES.length} cities.`);
  return { inserted: n };
}

module.exports = { seed, buildListings };

if (require.main === module) {
  seed().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
