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
    renderComparison(parts, current);
    $('#compare-status').textContent =
      `Compared ${parts.length} parts in your file against ${current.length} scraped parts.`;
  } catch (err) {
    $('#compare-status').textContent = `Failed: ${err.message}`;
    $('#compare-output').hidden = true;
  }
  e.target.value = '';
});

function renderComparison(oldParts, current) {
  const oldByNorm = new Map(oldParts.map((p) => [p.norm, p]));
  const curByNorm = new Map(current.map((r) => [r.part_number_norm, r]));
  const changed = [], added = [], removed = [];
  for (const [norm, cur] of curByNorm) {
    const old = oldByNorm.get(norm);
    if (!old) added.push(cur);
    else if (old.price != null && Math.abs(old.price - cur.price) >= 0.005) changed.push({ old, cur });
  }
  for (const [norm, old] of oldByNorm) {
    if (!curByNorm.has(norm)) removed.push(old);
  }
  changed.sort((a, b) => Math.abs(b.cur.price - b.old.price) - Math.abs(a.cur.price - a.old.price));

  $('#compare-changed-title').textContent = `Changed prices (${changed.length})`;
  $('#compare-changed tbody').innerHTML = changed.length === 0
    ? '<tr><td class="empty" colspan="5">No price changes.</td></tr>'
    : changed.map(({ old, cur }) => {
      const diff = cur.price - old.price;
      const pct = old.price ? (diff / old.price) * 100 : 0;
      return `<tr>
        <td>${esc(cur.part_number)}</td><td>${esc(cur.name)}</td>
        <td>${money(old.price)}</td><td>${money(cur.price)}</td>
        <td class="${diff > 0 ? 'diff-up' : 'diff-down'}">${diff > 0 ? '+£' : '-£'}${Math.abs(diff).toFixed(2)} (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)</td>
      </tr>`;
    }).join('');

  $('#compare-added-title').textContent = `Added — scraped now, not in your file (${added.length})`;
  $('#compare-added tbody').innerHTML = added.length === 0
    ? '<tr><td class="empty" colspan="4">Nothing new.</td></tr>'
    : added.map((r) => `<tr>
        <td>${esc(r.part_number)}</td><td>${esc(r.name)}</td>
        <td>${money(r.price)}</td><td>${esc(r.site_name)}</td></tr>`).join('');

  $('#compare-removed-title').textContent = `Removed — in your file, no longer scraped (${removed.length})`;
  $('#compare-removed tbody').innerHTML = removed.length === 0
    ? '<tr><td class="empty" colspan="2">Nothing missing.</td></tr>'
    : removed.map((p) => `<tr>
        <td>${esc(p.code)}</td><td>${p.price != null ? money(p.price) : ''}</td></tr>`).join('');

  $('#compare-output').hidden = false;
}

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
