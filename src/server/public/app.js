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
    if (btn.dataset.tab === 'run') loadRuns();
    if (btn.dataset.tab === 'sites') loadSites();
  });
});

// --- sites ---
async function loadSites() {
  const sites = await api('/api/sites');
  $('#sites-table tbody').innerHTML = sites.map((s) => `
    <tr>
      <td>${s.enabled ? '&#x2705;' : '&#x2B1C;'}</td>
      <td>${esc(s.name)}</td>
      <td>${s.strategy === 'prefix_search' ? 'Prefix search' : 'Link crawl'}</td>
      <td>${esc(s.prefixes.join(', '))}</td>
      <td>
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
    $('#site-form-reset').click();
    loadSites();
  } catch (err) { alert(err.message); }
});

// --- run ---
let pollTimer = null;
$('#run-button').addEventListener('click', async () => {
  try {
    await api('/api/runs', { method: 'POST' });
    $('#run-log').textContent = 'Run started...\n';
    pollTimer = setInterval(pollRun, 1000);
  } catch (err) { alert(err.message); }
});

async function pollRun() {
  const cur = await api('/api/runs/current');
  $('#run-log').textContent = cur.events.map((e) =>
    e.phase === 'crawling'
      ? `[${e.siteName}] pages: ${e.pagesVisited}, parts: ${e.partsFound}`
      : `[${e.siteName ?? 'run'}] ${e.phase}${e.error ? ': ' + e.error : ''}${e.partsFound != null ? ` (${e.partsFound} parts)` : ''}`
  ).join('\n');
  if (!cur.running) { clearInterval(pollTimer); $('#run-log').textContent += '\nFinished.'; loadRuns(); }
}

async function loadRuns() {
  const runs = await api('/api/runs');
  $('#runs-table tbody').innerHTML = runs.map((r) => `
    <tr><td>#${r.id}</td><td>${esc(r.started_at)}</td><td>${esc(r.status)}</td>
    <td>${r.site_summaries.map((s) =>
      `site ${s.site_id}: ${s.parts_found} parts, ${s.pages_visited} pages` +
      (s.pages_failed ? `, ${s.pages_failed} failed` : '') +
      (s.warnings.length ? ` &#x26A0; ${esc(s.warnings.join('; '))}` : '')).join('<br>')}</td></tr>`).join('');
}

// --- results ---
let allResults = [];
async function loadResults() {
  allResults = await api('/api/results');
  renderResults();
  const missing = await api('/api/parts/missing');
  $('#missing-parts ul').innerHTML = missing.map((m) => `<li>${esc(m.part_number)}</li>`).join('');
  $('#missing-parts summary').textContent = `My parts not found on any site (${missing.length})`;
}

function renderResults() {
  const q = $('#results-filter').value.toLowerCase();
  const rows = allResults.filter((r) =>
    !q || r.part_number.toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q));
  $('#results-table tbody').innerHTML = rows.map((r) => {
    const changed = r.prev_price != null && r.prev_price !== r.price;
    return `<tr class="${changed ? 'changed' : ''} ${r.low_confidence ? 'lowconf' : ''}">
      <td><a href="${esc(r.url)}" target="_blank">${esc(r.part_number)}</a></td>
      <td>${esc(r.name)}${r.low_confidence ? ' &#x26A0;' : ''}</td>
      <td>${r.currency === 'GBP' ? '&pound;' : esc(r.currency) + ' '}${r.price.toFixed(2)}</td>
      <td>${changed ? `${r.prev_price.toFixed(2)} &rarr; ${r.price.toFixed(2)}` : ''}</td>
      <td>${esc(r.site_name)}</td>
      <td>${r.in_my_list ? '&#x2714;' : ''}</td>
      <td>${esc(r.observed_at)}</td></tr>`;
  }).join('');
}
$('#results-filter').addEventListener('input', renderResults);

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
});

loadSites();
