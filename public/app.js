(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const form = $('#filters');
  const grid = $('#grid');
  const pager = $('#pager');
  const dialog = $('#detail');
  const state = { page: 1, view: 'grid', map: null, layer: null };

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const usdShort = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
  const num = new Intl.NumberFormat('en-US');
  const local = (amount, currency) => {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
    } catch { return `${num.format(amount)} ${currency}`; }
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const flag = (cc) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
  const sqft = (m2) => Math.round(m2 * 10.7639);

  const HOUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 11h3v9h5v-6h4v6h5v-9h3z"/></svg>';
  // Deterministic gradient per listing so placeholders look distinct.
  function placeholderBg(id, type) {
    const base = { house: 168, apartment: 210, villa: 28, townhouse: 260, condo: 190, cottage: 95 }[type] ?? 168;
    const h = (base + (Number(id) * 37) % 40) % 360;
    return `linear-gradient(135deg, hsl(${h} 45% 42%), hsl(${(h + 30) % 360} 50% 30%))`;
  }
  function thumb(l) {
    const img = l.image_url ? `<img src="${esc(l.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : HOUSE_ICON;
    return `<div class="thumb" style="background:${placeholderBg(l.id, l.property_type)}">${img}
      <span class="flag">${flag(l.country_code)} ${esc(l.country)}</span></div>`;
  }

  function params() {
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v !== '') p.set(k, v);
    return p;
  }
  function syncUrl() {
    const p = params();
    if (state.page > 1) p.set('page', state.page);
    if (state.view === 'map') p.set('view', 'map');
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }
  function restoreFromUrl() {
    const p = new URLSearchParams(location.search);
    for (const el of form.elements) if (el.name && p.has(el.name)) el.value = p.get(el.name);
    state.page = Math.max(1, parseInt(p.get('page'), 10) || 1);
    state.view = p.get('view') === 'map' ? 'map' : 'grid';
  }

  async function api(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }

  async function loadStats() {
    const s = await api('/api/stats');
    $('#hero-stats').textContent =
      `${num.format(s.listings)} homes for sale in ${s.countries} countries, converted from ${s.currencies} currencies into US dollars.`;
    const country = form.elements.country;
    const type = form.elements.type;
    const want = { country: country.value, type: type.value };
    for (const c of s.country_list) country.add(new Option(`${flag(c.code)} ${c.name} (${c.n})`, c.code));
    for (const t of s.types) type.add(new Option(`${cap(t.type)} (${t.n})`, t.type));
    country.value = want.country; type.value = want.type;
    $('#sample-note').hidden = !s.has_sample;
    if (s.rates_updated_at) {
      $('#rates-note').textContent += ` Exchange rates last updated ${new Date(s.rates_updated_at).toLocaleString()}.`;
    }
  }

  async function loadListings() {
    const p = params();
    p.set('page', state.page);
    p.set('limit', 24);
    grid.setAttribute('aria-busy', 'true');
    try {
      const data = await api(`/api/listings?${p}`);
      $('#result-count').textContent = `${num.format(data.total)} ${data.total === 1 ? 'home' : 'homes'} found`;
      grid.innerHTML = data.results.length ? data.results.map(card).join('') :
        '<div class="empty">No homes match these filters. Try widening your price range or clearing filters.</div>';
      renderPager(data);
    } catch (e) {
      grid.innerHTML = `<div class="empty">Couldn't load listings. ${esc(e.message)}</div>`;
    } finally {
      grid.removeAttribute('aria-busy');
    }
  }

  function card(l) {
    const facts = [
      l.bedrooms != null && `${l.bedrooms} bd`,
      l.bathrooms != null && `${Number(l.bathrooms)} ba`,
      l.area_sqm != null && `${num.format(Math.round(l.area_sqm))} m² · ${num.format(sqft(l.area_sqm))} ft²`,
    ].filter(Boolean).map((f) => `<span>${f}</span>`).join('');
    const showLocal = l.currency !== 'USD';
    return `<button type="button" class="card" data-id="${l.id}">
      ${thumb(l)}
      <div class="card-body">
        <div class="price">${usd.format(l.price_usd)}</div>
        ${showLocal ? `<div class="local">${esc(local(Number(l.price), l.currency))}</div>` : '<div class="local">&nbsp;</div>'}
        <div class="title">${esc(l.title)}</div>
        <div class="facts">${facts}</div>
        <div class="place">${esc([l.city, l.region].filter(Boolean).join(', '))}</div>
      </div>
    </button>`;
  }

  function renderPager({ page, limit, total }) {
    const pages = Math.ceil(total / limit);
    if (pages <= 1) { pager.innerHTML = ''; return; }
    pager.innerHTML = `
      <button type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
      <span class="muted">Page ${page} of ${num.format(pages)}</span>
      <button type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next →</button>`;
  }

  async function openDetail(id) {
    const l = await api(`/api/listings/${encodeURIComponent(id)}`);
    const rows = [
      ['Type', cap(l.property_type)],
      ['Bedrooms', l.bedrooms],
      ['Bathrooms', l.bathrooms != null ? Number(l.bathrooms) : null],
      ['Living area', l.area_sqm != null ? `${num.format(Math.round(l.area_sqm))} m² (${num.format(sqft(l.area_sqm))} ft²)` : null],
      ['Lot size', l.lot_sqm != null ? `${num.format(Math.round(l.lot_sqm))} m²` : null],
      ['Year built', l.year_built],
      ['Price per m²', l.area_sqm ? usd.format(l.price_usd / l.area_sqm) : null],
      ['Listed', new Date(l.listed_at).toLocaleDateString()],
    ].filter(([, v]) => v != null && v !== '');
    const rate = Number(l.rate_per_usd);
    const conv = l.currency === 'USD' ? 'Listed in US dollars.' :
      `Listed at ${esc(local(Number(l.price), l.currency))}. Converted at 1 USD = ${num.format(rate)} ${esc(l.currency)}` +
      (l.rate_updated_at ? ` (rate as of ${new Date(l.rate_updated_at).toLocaleString()}).` : '.');
    $('#detail-body').innerHTML = `
      ${thumb(l)}
      <div class="detail-content">
        <div class="price">${usd.format(l.price_usd)}</div>
        <h2>${esc(l.title)}</h2>
        <div class="place">${esc([l.address, l.city, l.region, l.country].filter(Boolean).join(', '))}</div>
        <ul class="spec">${rows.map(([k, v]) => `<li><b>${k}</b>${esc(v)}</li>`).join('')}</ul>
        ${l.description ? `<p>${esc(l.description)}</p>` : ''}
        ${l.listing_url ? `<p><a class="btn" href="${esc(l.listing_url)}" target="_blank" rel="noopener noreferrer">View original listing</a></p>` : ''}
        <p class="conv">${conv}${l.is_sample ? ' This is a demonstration listing.' : ''}</p>
      </div>`;
    dialog.showModal();
  }

  // ---- Map ---------------------------------------------------------------------------------
  function ensureMap() {
    if (state.map || !window.L) return;
    state.map = L.map('map', { worldCopyJump: true }).setView([20, 10], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(state.map);
    state.layer = L.layerGroup().addTo(state.map);
  }
  async function loadMap() {
    ensureMap();
    if (!state.map) return;
    state.map.invalidateSize();
    const points = await api(`/api/map?${params()}`);
    state.layer.clearLayers();
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0f766e';
    for (const pt of points) {
      const m = L.circleMarker([pt.lat, pt.lng], { radius: 6, weight: 1, color: '#fff', fillColor: accent, fillOpacity: 0.9 });
      m.bindTooltip(usdShort.format(pt.price_usd));
      m.on('click', () => openDetail(pt.id));
      m.addTo(state.layer);
    }
    if (points.length) {
      const b = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
      state.map.fitBounds(b.pad(0.1), { maxZoom: 12 });
    }
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.seg button').forEach((b) => {
      const on = b.dataset.view === view;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    $('#map-view').hidden = view !== 'map';
    grid.hidden = pager.hidden = view === 'map';
    syncUrl();
    if (view === 'map') loadMap().catch(console.error);
  }

  function refresh() {
    syncUrl();
    if (state.view === 'map') loadMap().catch(console.error);
    loadListings();
  }

  // ---- Events ------------------------------------------------------------------------------
  let t;
  form.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.page = 1; refresh(); }, 300); });
  form.addEventListener('submit', (e) => { e.preventDefault(); state.page = 1; refresh(); });
  form.addEventListener('reset', () => setTimeout(() => { state.page = 1; refresh(); }, 0));
  pager.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (!b || b.disabled) return;
    state.page = Number(b.dataset.page);
    refresh();
    window.scrollTo({ top: form.offsetTop - 16, behavior: 'smooth' });
  });
  grid.addEventListener('click', (e) => {
    const c = e.target.closest('.card');
    if (c) openDetail(c.dataset.id).catch(console.error);
  });
  document.querySelector('.seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  restoreFromUrl();
  loadStats().catch(console.error).finally(() => { loadListings(); setView(state.view); });
})();
