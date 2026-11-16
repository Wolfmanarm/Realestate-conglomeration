// Parses a CSV or JSON listing file into raw listing objects (same field names as the import API).

// Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, commas/newlines inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function parseListingFile(text, filename = '') {
  const trimmed = text.trimStart();
  if (/\.json$/i.test(filename) || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : data.listings;
    if (!Array.isArray(arr)) throw new Error('JSON must be an array of listings or { "listings": [...] }');
    return arr;
  }
  return parseCsv(text);
}

module.exports = { parseCsv, parseListingFile };
