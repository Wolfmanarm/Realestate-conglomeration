// Imports listings from a CSV or JSON file: `npm run import:file -- path/to/listings.csv [--source=name]`
// Column names match the import API (external_id, title, price, currency, country, country_code, ...).
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const { migrate } = require('./migrate');
const { normalize, upsertListings } = require('./listings');
const { parseListingFile } = require('./importers/file');

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const sourceArg = args.find((a) => a.startsWith('--source='));
  if (!file) throw new Error('Usage: npm run import:file -- <file.csv|file.json> [--source=name]');

  const raws = parseListingFile(fs.readFileSync(file, 'utf8'), file);
  const source = sourceArg ? sourceArg.slice('--source='.length) : null;
  const valid = [];
  let rejected = 0;
  raws.forEach((raw, i) => {
    const { listing, errors } = normalize(source ? { ...raw, source } : raw);
    if (errors.length) { rejected++; console.warn(`Row ${i + 1} (${raw.external_id || 'no id'}): ${errors.join('; ')}`); }
    else valid.push(listing);
  });
  await migrate();
  const upserted = valid.length ? await upsertListings(valid) : 0;
  console.log(`${path.basename(file)}: ${raws.length} rows, ${upserted} upserted, ${rejected} rejected.`);
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error(e.message); pool.end().finally(() => process.exit(1)); });
