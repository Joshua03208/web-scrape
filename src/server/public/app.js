// src/server/public/app.js
const $ = (sel) => document.querySelector(sel);
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.status === 204 ? null : res.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- tabs ---
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('main section').forEach((s) => (s.hidden = true));
    $(`#tab-${btn.dataset.tab}`).hidden = false;
    if (btn.dataset.tab === 'results') loadResults();
    if (btn.dataset.tab === 'run') {
      loadRuns();
      api('/api/runs/current').then((cur) => {
        if (cur && cur.running && !pollTimer) {
          pollTimer = setInterval(pollRun, 1000);
        }
      }).catch(() => {});
    }
    if (btn.dataset.tab === 'sites') loadSites();
  });
});

// --- sites ---
async function loadSites() {
  const sites = await api('/api/sites');
  $('#sites-table tbody').innerHTML = sites.length === 0
    ? '<tr><td class="empty" colspan="5">No sites yet — add one below.</td></tr>'
    : sites.map((s) => `
    <tr>
      <td><span class="dot ${s.enabled ? 'on' : 'off'}"></span></td>
      <td>${esc(s.name)}</td>
      <td>${s.strategy === 'prefix_search' ? 'Prefix search' : 'Link crawl'}</td>
      <td>${esc(s.prefixes.join(', '))}</td>
      <td>
        ${s.enabled ? `<button data-run="${s.id}">Scrape</button>` : ''}
        <button data-edit="${s.id}">Edit</button>
        <button data-del="${s.id}">Delete</button>
      </td>
    </tr>`).join('');
  $('#sites-table tbody').querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => fillForm(sites.find((s) => s.id === Number(b.dataset.edit)))));
  $('#sites-table tbody').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (confirm('Delete this site?')) { await api(`/api/sites/${b.dataset.del}`, { method: 'DELETE' }); loadSites(); }
    }));
  $('#sites-table tbody').querySelectorAll('[data-run]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api('/api/runs', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteIds: [Number(b.dataset.run)] }),
        });
        document.querySelector('nav button[data-tab="run"]').click();
        $('#run-log').textContent = 'Run started...\n';
        if (!pollTimer) pollTimer = setInterval(pollRun, 1000);
      } catch (err) { $('#site-form-error').textContent = err.message; }
    }));
}

// NOTE: always go through form.elements — `form.name` and `form.id` are
// built-in HTMLFormElement properties and shadow inputs with those names.
function fillForm(s) {
  const el = $('#site-form').elements;
  $('#site-form-title').textContent = `Edit: ${s.name}`;
  el.site_id.value = s.id; el.name.value = s.name; el.base_url.value = s.base_url;
  el.strategy.value = s.strategy; el.search_url_pattern.value = s.search_url_pattern ?? '';
  el.prefixes.value = s.prefixes.join(', '); el.max_pages.value = s.max_pages;
  el.login_url.value = s.login_url ?? ''; el.username.value = s.username ?? '';
  el.password.value = s.password ?? ''; el.enabled.checked = !!s.enabled;
}

$('#site-form-reset').addEventListener('click', () => {
  $('#site-form').reset(); $('#site-form').elements.site_id.value = '';
  $('#site-form-title').textContent = 'Add site';
});

$('#site-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const el = e.target.elements;
  const body = {
    name: el.name.value, base_url: el.base_url.value, strategy: el.strategy.value,
    search_url_pattern: el.search_url_pattern.value || null,
    prefixes: el.prefixes.value.split(',').map((p) => p.trim()).filter(Boolean),
    max_pages: Number(el.max_pages.value) || 200,
    login_url: el.login_url.value || null, username: el.username.value || null,
    password: el.password.value || null, enabled: el.enabled.checked ? 1 : 0,
  };
  try {
    if (el.site_id.value) await api(`/api/sites/${el.site_id.value}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    else await api('/api/sites', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('#site-form-error').textContent = '';
    $('#site-form-reset').click();
    loadSites();
  } catch (err) { $('#site-form-error').textContent = err.message; }
});

// --- run ---
let pollTimer = null;
$('#run-button').addEventListener('click', async () => {
  try {
    await api('/api/runs', { method: 'POST' });
    $('#run-log').textContent = 'Run started...\n';
    if (!pollTimer) pollTimer = setInterval(pollRun, 1000);
  } catch (err) { $('#run-log').textContent = `Could not start: ${err.message}`; }
});

let pollFailures = 0;
async function pollRun() {
  try {
    const cur = await api('/api/runs/current');
    pollFailures = 0;
    $('#run-log').textContent = cur.events.map((e) =>
      e.phase === 'crawling'
        ? `[${e.siteName}] pages: ${e.pagesVisited}, parts: ${e.partsFound}`
        : `[${e.siteName ?? 'run'}] ${e.phase}${e.error ? ': ' + e.error : ''}${e.partsFound != null ? ` (${e.partsFound} parts)` : ''}`
    ).join('\n');
    if (!cur.running) { clearInterval(pollTimer); pollTimer = null; $('#run-log').textContent += '\nFinished.'; loadRuns(); }
  } catch (err) {
    pollFailures += 1;
    if (pollFailures >= 5) {
      clearInterval(pollTimer);
      pollTimer = null;
      $('#run-log').textContent += '\nLost connection to server.';
    }
  }
}

async function loadRuns() {
  const runs = await api('/api/runs');
  const badge = (status) => {
    const known = ['done', 'failed', 'running'].includes(status) ? status : 'other';
    return `<span class="badge badge-${known}">${esc(status)}</span>`;
  };
  $('#runs-table tbody').innerHTML = runs.length === 0
    ? '<tr><td class="empty" colspan="4">No runs yet.</td></tr>'
    : runs.map((r) => `
    <tr><td>#${r.id}</td><td>${esc(r.started_at)}</td><td>${badge(r.status)}</td>
    <td>${r.site_summaries.map((s) =>
      `site ${s.site_id}: ${s.parts_found} parts, ${s.pages_visited} pages` +
      (s.pages_failed ? `, ${s.pages_failed} failed` : '') +
      (s.warnings.length ? ` &#x26A0; ${esc(s.warnings.join('; '))}` : '')).join('<br>')}</td></tr>`).join('');
}

// --- results ---
let allResults = [];
let activePrefix = null; // null = all categories
let activeSite = null;   // null = all sites

function renderSiteChips() {
  const counts = new Map();
  for (const r of allResults) counts.set(r.site_name, (counts.get(r.site_name) ?? 0) + 1);
  const wrap = $('#site-chips');
  if (counts.size <= 1) { wrap.hidden = true; wrap.innerHTML = ''; activeSite = null; return; }
  if (activeSite && !counts.has(activeSite)) activeSite = null;
  wrap.hidden = false;
  const chips = [[null, allResults.length], ...[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))];
  wrap.innerHTML = chips.map(([s, n]) =>
    `<button class="chip ${s === activeSite ? 'active' : ''}" data-site="${esc(s ?? '')}">
      ${s ? esc(s) : 'All sites'} <span>${n}</span></button>`).join('');
  wrap.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => {
      activeSite = c.dataset.site || null;
      renderSiteChips();
      renderPrefixChips();
      renderResults();
    }));
}

const prefixOf = (pn) => (pn.match(/^[^.]*\./) ?? [pn.slice(0, 4)])[0];

function renderPrefixChips() {
  const inSite = activeSite ? allResults.filter((r) => r.site_name === activeSite) : allResults;
  const counts = new Map();
  for (const r of inSite) {
    const p = prefixOf(r.part_number);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  if (activePrefix && !counts.has(activePrefix)) activePrefix = null;
  const chips = [[null, inSite.length], ...[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))];
  $('#prefix-chips').innerHTML = chips.map(([p, n]) =>
    `<button class="chip ${p === activePrefix ? 'active' : ''}" data-prefix="${esc(p ?? '')}">
      ${p ? esc(p) : 'All'} <span>${n}</span></button>`).join('');
  $('#prefix-chips').querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => {
      activePrefix = c.dataset.prefix || null;
      renderPrefixChips();
      renderResults();
    }));
}

async function loadResults() {
  allResults = await api('/api/results');
  renderSiteChips();
  renderPrefixChips();
  renderResults();
  const missing = await api('/api/parts/missing');
  $('#missing-parts ul').innerHTML = missing.map((m) => `<li>${esc(m.part_number)}</li>`).join('');
  $('#missing-parts summary').textContent = `My parts not found on any site (${missing.length})`;
}

function filteredRows() {
  const q = $('#results-filter').value.toLowerCase();
  return allResults.filter((r) =>
    (!activeSite || r.site_name === activeSite) &&
    (!activePrefix || prefixOf(r.part_number) === activePrefix) &&
    (!q || r.part_number.toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q)));
}

function renderResults() {
  const rows = filteredRows();
  $('#results-count').textContent = allResults.length
    ? `Showing ${rows.length} of ${allResults.length} parts${activePrefix ? ` in ${activePrefix}` : ''}`
    : '';
  $('#epos-scope').textContent = `Exports the ${rows.length} part(s) currently shown${activePrefix ? ` (${activePrefix} category)` : ''}.`;
  $('#results-table tbody').innerHTML = rows.length === 0
    ? `<tr><td class="empty" colspan="7">${allResults.length === 0 ? 'No results yet — start a scrape from the Run tab.' : 'No parts match that filter.'}</td></tr>`
    : rows.map((r) => {
    const changed = r.prev_price != null && r.prev_price !== r.price;
    return `<tr class="${changed ? 'changed' : ''} ${r.low_confidence ? 'lowconf' : ''}">
      <td>${r.url ? `<a href="${esc(r.url)}" target="_blank">${esc(r.part_number)}</a>` : esc(r.part_number)}</td>
      <td>${esc(r.name)}${r.low_confidence ? ' <span class="warn">&#x26A0;</span>' : ''}</td>
      <td>${r.currency === 'GBP' ? '&pound;' : esc(r.currency) + ' '}${r.price.toFixed(2)}</td>
      <td>${changed ? `${r.prev_price.toFixed(2)} &rarr; ${r.price.toFixed(2)}` : ''}</td>
      <td>${esc(r.site_name)}</td>
      <td>${r.in_my_list ? '<span class="ok">&#x2714;</span>' : ''}</td>
      <td>${esc(r.observed_at)}</td></tr>`;
  }).join('');
}
$('#results-filter').addEventListener('input', renderResults);

// --- custom EPOS export ---
const EPOS_TIERS = ['COST', 'WEBSITE', 'TRADE', 'ENGINEER', 'MERCHANT', 'STAFF', 'AMAZON', 'EBAY'];

function eposSettings() {
  try { return JSON.parse(localStorage.getItem('eposSettings')) ?? {}; } catch { return {}; }
}
function saveEposSettings() {
  const s = { prefix: $('#epos-prefix').value, brand: $('#epos-brand').value, tiers: {} };
  for (const t of EPOS_TIERS) s.tiers[t] = $(`#epos-tier-${t}`).value;
  localStorage.setItem('eposSettings', JSON.stringify(s));
}

function initEpos() {
  const s = eposSettings();
  $('#epos-prefix').value = s.prefix ?? 'FRANKE-';
  $('#epos-brand').value = s.brand ?? 'Franke';
  $('#epos-tiers').innerHTML = EPOS_TIERS.map((t) =>
    `<label>${t} % off <input id="epos-tier-${t}" type="number" step="0.1" value="${esc(s.tiers?.[t] ?? '0')}"></label>`).join('');
  $('#epos-export').querySelectorAll('input').forEach((i) => i.addEventListener('change', saveEposSettings));
}

function eposCsvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

$('#epos-download').addEventListener('click', () => {
  const rows = filteredRows();
  if (rows.length === 0) { $('#epos-scope').textContent = 'Nothing to export — adjust the filter.'; return; }
  const prefix = $('#epos-prefix').value.trim();
  const brand = $('#epos-brand').value.trim();
  const pct = {};
  for (const t of EPOS_TIERS) pct[t] = Number($(`#epos-tier-${t}`).value) || 0;
  const header = ['Epos Code', 'Description', 'RRP', ...EPOS_TIERS, 'Brand', 'RowStatus'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const desc = `${brand ? brand + ' ' : ''}${r.name ?? ''} - ${r.part_number}`.trim();
    const tiers = EPOS_TIERS.map((t) => (r.price * (1 - pct[t] / 100)).toFixed(2));
    lines.push([
      eposCsvCell(`${prefix}${r.part_number}`), eposCsvCell(desc), r.price.toFixed(2),
      ...tiers, eposCsvCell(brand), '',
    ].join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `epos-export${activePrefix ? '-' + activePrefix.replace(/\.$/, '') : ''}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// --- compare price lists ---
const money = (n) => `£${n.toFixed(2)}`;
const diffCell = (diff, pct) =>
  `<td class="${diff > 0 ? 'diff-up' : 'diff-down'}">${diff > 0 ? '+£' : '-£'}${Math.abs(diff).toFixed(2)} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)</td>`;

let cmp = null;           // { changed, added, removed }
let cmpFilter = 'all';    // all | up | down | added | removed
let cmpUpload = null;     // last uploaded parts list
let cmpResults = null;    // scraped results fetched at upload time

function rebuildComparison() {
  const site = $('#compare-site').value;
  const current = site ? cmpResults.filter((r) => r.site_name === site) : cmpResults;
  cmp = buildComparison(cmpUpload, current);
  $('#compare-status').textContent =
    `Compared ${cmpUpload.length} parts in your file against ${current.length} scraped parts${site ? ` from ${site}` : ''}.`;
  renderCompareStats();
  renderCompare();
  $('#compare-output').hidden = false;
}

$('#compare-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  $('#compare-status').textContent = 'Comparing...';
  try {
    const [{ parts }, current] = await Promise.all([
      api('/api/compare', { method: 'POST', body: form }),
      api('/api/results'),
    ]);
    cmpUpload = parts;
    cmpResults = current;
    cmpFilter = 'all';
    $('#compare-search').value = '';
    // populate the site dropdown, keeping the current choice if still valid
    const sites = [...new Set(current.map((r) => r.site_name))].sort();
    const chosen = $('#compare-site').value;
    $('#compare-site').innerHTML = '<option value="">All sites</option>' +
      sites.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (sites.includes(chosen)) $('#compare-site').value = chosen;
    rebuildComparison();
  } catch (err) {
    $('#compare-status').textContent = `Failed: ${err.message}`;
    $('#compare-output').hidden = true;
  }
  e.target.value = '';
});

$('#compare-site').addEventListener('change', () => cmpUpload && rebuildComparison());

function buildComparison(oldParts, current) {
  const oldByNorm = new Map(oldParts.map((p) => [p.norm, p]));
  const curByNorm = new Map(current.map((r) => [r.part_number_norm, r]));
  const changed = [], added = [], removed = [];
  for (const [norm, cur] of curByNorm) {
    const old = oldByNorm.get(norm);
    if (!old) {
      added.push(cur);
    } else if (old.price != null && Math.abs(old.price - cur.price) >= 0.005) {
      const diff = cur.price - old.price;
      changed.push({
        part_number: cur.part_number, name: cur.name, site_name: cur.site_name,
        oldPrice: old.price, newPrice: cur.price,
        diff, pct: old.price ? (diff / old.price) * 100 : 0,
      });
    }
  }
  for (const [norm, old] of oldByNorm) {
    if (!curByNorm.has(norm)) removed.push(old);
  }
  return { changed, added, removed };
}

function renderCompareStats() {
  const up = cmp.changed.filter((c) => c.diff > 0);
  const down = cmp.changed.filter((c) => c.diff < 0);
  const avgPct = cmp.changed.length
    ? cmp.changed.reduce((s, c) => s + c.pct, 0) / cmp.changed.length : 0;
  const rise = up.length ? up.reduce((a, b) => (b.diff > a.diff ? b : a)) : null;
  const fall = down.length ? down.reduce((a, b) => (b.diff < a.diff ? b : a)) : null;
  const card = (label, value, sub = '') =>
    `<div class="stat"><span class="stat-label">${label}</span>
      <span class="stat-value">${value}</span>
      ${sub ? `<span class="stat-sub">${sub}</span>` : ''}</div>`;
  $('#compare-stats').innerHTML = [
    card('Changed', cmp.changed.length,
      `<span class="diff-up">&#9650; ${up.length}</span> &nbsp; <span class="diff-down">&#9660; ${down.length}</span>`),
    card('Average change', `${avgPct > 0 ? '+' : ''}${avgPct.toFixed(1)}%`),
    rise ? card('Biggest rise', `+${money(rise.diff)}`, esc(rise.part_number)) : '',
    fall ? card('Biggest fall', `-${money(Math.abs(fall.diff))}`, esc(fall.part_number)) : '',
    card('Added', cmp.added.length, 'not in your file'),
    card('Removed', cmp.removed.length, 'no longer scraped'),
  ].join('');
}

function compareUnifiedRows() {
  return [
    ...cmp.changed.map((c) => ({ status: 'changed', ...c })),
    ...cmp.added.map((r) => ({
      status: 'added', part_number: r.part_number, name: r.name, site_name: r.site_name,
      oldPrice: null, newPrice: r.price, diff: 0, pct: 0,
    })),
    ...cmp.removed.map((p) => ({
      status: 'removed', part_number: p.code, name: null, site_name: null,
      oldPrice: p.price, newPrice: null, diff: 0, pct: 0,
    })),
  ];
}

function renderCompare() {
  const all = compareUnifiedRows();
  const up = cmp.changed.filter((c) => c.diff > 0).length;
  const down = cmp.changed.filter((c) => c.diff < 0).length;
  const filters = [
    ['all', 'All', all.length],
    ['up', 'Risen', up],
    ['down', 'Fallen', down],
    ['added', 'New on site', cmp.added.length],
    ['removed', 'No longer scraped', cmp.removed.length],
  ];
  $('#compare-filter').innerHTML = filters.map(([key, label, n]) =>
    `<button class="chip ${key === cmpFilter ? 'active' : ''}" data-filter="${key}">${label} <span>${n}</span></button>`).join('');
  $('#compare-filter').querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => { cmpFilter = c.dataset.filter; renderCompare(); }));

  const q = $('#compare-search').value.toLowerCase();
  const matchesFilter = (r) =>
    cmpFilter === 'all' ? true
    : cmpFilter === 'up' ? r.status === 'changed' && r.diff > 0
    : cmpFilter === 'down' ? r.status === 'changed' && r.diff < 0
    : r.status === cmpFilter;
  const matchesSearch = (r) =>
    !q || r.part_number.toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q);

  const sort = $('#compare-sort').value;
  const rows = all.filter((r) => matchesFilter(r) && matchesSearch(r)).sort((a, b) => {
    if (sort === 'part') return a.part_number.localeCompare(b.part_number);
    const key = sort === 'pct'
      ? Math.abs(b.pct) - Math.abs(a.pct)
      : Math.abs(b.diff) - Math.abs(a.diff);
    return key !== 0 ? key : a.part_number.localeCompare(b.part_number);
  });

  const changeCell = (r) =>
    r.status === 'changed' ? diffCell(r.diff, r.pct)
    : r.status === 'added' ? '<td><span class="badge badge-done">new</span></td>'
    : '<td><span class="badge badge-failed">gone</span></td>';

  $('#compare-table tbody').innerHTML = rows.length === 0
    ? '<tr><td class="empty" colspan="6">Nothing matches this filter.</td></tr>'
    : rows.map((r) => `<tr>
        <td>${esc(r.part_number)}</td><td>${esc(r.name)}</td>
        <td>${r.oldPrice != null ? money(r.oldPrice) : ''}</td>
        <td>${r.newPrice != null ? money(r.newPrice) : ''}</td>
        ${changeCell(r)}
        <td>${esc(r.site_name)}</td></tr>`).join('');
  $('#compare-count').textContent = `Showing ${rows.length} of ${all.length} differences`;
}

$('#compare-search').addEventListener('input', () => cmp && renderCompare());
$('#compare-sort').addEventListener('change', () => cmp && renderCompare());

$('#compare-export').addEventListener('click', () => {
  if (!cmp) return;
  const lines = ['Status,Part Number,Name,Old Price,New Price,Change,Change %,Site'];
  for (const c of cmp.changed) {
    lines.push(['changed', eposCsvCell(c.part_number), eposCsvCell(c.name), c.oldPrice.toFixed(2),
      c.newPrice.toFixed(2), c.diff.toFixed(2), c.pct.toFixed(1), eposCsvCell(c.site_name)].join(','));
  }
  for (const r of cmp.added) {
    lines.push(['added', eposCsvCell(r.part_number), eposCsvCell(r.name), '',
      r.price.toFixed(2), '', '', eposCsvCell(r.site_name)].join(','));
  }
  for (const p of cmp.removed) {
    lines.push(['removed', eposCsvCell(p.code), '', p.price != null ? p.price.toFixed(2) : '',
      '', '', '', ''].join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'price-comparison-report.csv';
  a.click();
  URL.revokeObjectURL(a.href);
});

initEpos();

$('#parts-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const out = await api('/api/parts', { method: 'POST', body: form });
    $('#parts-status').textContent = `Parts list uploaded: ${out.count} part numbers.`;
    loadResults();
  } catch (err) { $('#parts-status').textContent = `Upload failed: ${err.message}`; }
  e.target.value = '';
});

loadSites();
