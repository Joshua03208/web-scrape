import express from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  listSites, createSite, updateSite, deleteSite, getSite,
  listRuns, latestSnapshot, fullHistory, replaceMyParts, missingMyParts,
  listShowerSpares,
} from '../db.js';
import { executeRun } from '../crawler/run.js';
import { harvestImages, imagesRoot } from '../crawler/imageHarvest.js';
import { existsSync } from 'node:fs';
import archiver from 'archiver';
import { normalisePartNumber } from '../extract/partNumber.js';
import { rowsToCsv } from '../export/csv.js';
import { rowsToXlsxBuffer } from '../export/xlsx.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const SNAPSHOT_COLUMNS = [
  { key: 'part_number', header: 'Part Number' },
  { key: 'name', header: 'Name' },
  { key: 'price', header: 'Price' },
  { key: 'currency', header: 'Currency' },
  { key: 'prev_price', header: 'Previous Price' },
  { key: 'site_name', header: 'Site' },
  { key: 'url', header: 'URL' },
  { key: 'in_my_list', header: 'In My List' },
  { key: 'low_confidence', header: 'Low Confidence' },
  { key: 'observed_at', header: 'Last Seen (UTC)' },
];
const HISTORY_COLUMNS = [
  { key: 'part_number', header: 'Part Number' },
  { key: 'name', header: 'Name' },
  { key: 'price', header: 'Price' },
  { key: 'currency', header: 'Currency' },
  { key: 'site_name', header: 'Site' },
  { key: 'url', header: 'URL' },
  { key: 'run_id', header: 'Run' },
  { key: 'observed_at', header: 'Observed (UTC)' },
];

function validateSite(body) {
  if (!body.name || !body.base_url) return 'name and base_url are required';
  if (!['prefix_search', 'category_crawl', 'link_crawl', 'spares_map'].includes(body.strategy)) return 'invalid strategy';
  if (body.strategy === 'prefix_search' && !body.search_url_pattern)
    return 'search_url_pattern required for prefix_search';
  // an empty prefix list would make the part-number matcher match any digit run
  // (spares_map doesn't use prefixes — codes come from explicit "Spares –" lines)
  if (body.strategy !== 'spares_map' &&
      (!Array.isArray(body.prefixes) || body.prefixes.filter((p) => String(p).trim()).length === 0))
    return 'at least one part-number prefix is required';
  return null;
}

async function rowsFromUpload(file) {
  const name = file.originalname.toLowerCase();
  if (!name.endsWith('.csv') && !name.endsWith('.xlsx')) {
    const err = new Error('Unsupported file type — save as .csv or .xlsx');
    err.code = 'UNSUPPORTED_FILE_TYPE';
    throw err;
  }
  if (name.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    const rows = [];
    wb.worksheets[0].eachRow((row) => rows.push(row.values.slice(1).map((v) => String(v ?? ''))));
    return rows;
  }
  return parse(file.buffer.toString('utf8'), { skip_empty_lines: true });
}

async function parsePartsUpload(file) {
  const rows = await rowsFromUpload(file);
  if (rows.length === 0) return [];
  // Pick the part-number column: header containing "part", else first column.
  const header = rows[0].map((h) => String(h).toLowerCase());
  let col = header.findIndex((h) => h.includes('part'));
  const dataRows = col >= 0 ? rows.slice(1) : rows;
  if (col < 0) col = 0;
  return dataRows
    .map((r) => String(r[col] ?? '').trim())
    .filter(Boolean)
    .map((partNumber) => ({ partNumber }));
}

// Parse an old price list (e.g. an EPOS export) into { code, norm, price } rows.
// Part column: header containing epos/part/code, else first column; any letter
// prefix like "FRANKE-" is stripped. Price column: header containing rrp, else price.
async function parseCompareUpload(file) {
  const rows = await rowsFromUpload(file);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => String(h).toLowerCase().trim());
  let partCol = header.findIndex((h) => h.includes('epos') || h.includes('part') || h.includes('code'));
  const hasHeader = partCol >= 0 || header.some((h) => h.includes('rrp') || h.includes('price') || h.includes('desc'));
  if (partCol < 0) partCol = 0;
  let priceCol = header.findIndex((h) => h.includes('rrp'));
  if (priceCol < 0) priceCol = header.findIndex((h) => h.includes('price'));
  const parts = [];
  for (const r of hasHeader ? rows.slice(1) : rows) {
    const code = String(r[partCol] ?? '').trim().replace(/^[^0-9]*/, '');
    if (!code) continue;
    let price = null;
    if (priceCol >= 0) {
      const n = Number(String(r[priceCol] ?? '').replace(/[£$€,\s]/g, ''));
      if (Number.isFinite(n)) price = n;
    }
    parts.push({ code, norm: normalisePartNumber(code), price });
  }
  return parts;
}

// Fix 4: wrap multer so errors come back as JSON 400 instead of HTML 500
const uploadSingle = (req, res, next) =>
  upload.single('file')(req, res, (err) => err ? res.status(400).json({ error: err.message }) : next());

export function createApp(db, { runExecutor = executeRun } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // in-memory state for the current run
  const current = { running: false, runId: null, events: [] };

  // --- sites ---
  app.get('/api/sites', (req, res) => res.json(listSites(db)));
  app.post('/api/sites', (req, res) => {
    // Fix 3: guard against undefined body (Express 5 with no Content-Type)
    const err = validateSite(req.body ?? {});
    if (err) return res.status(400).json({ error: err });
    const id = createSite(db, req.body ?? {});
    res.status(201).json(getSite(db, id));
  });
  app.put('/api/sites/:id', (req, res) => {
    // Fix 3 + Fix 6: guard body and check site existence
    const err = validateSite(req.body ?? {});
    if (err) return res.status(400).json({ error: err });
    const id = Number(req.params.id);
    if (!getSite(db, id)) return res.status(404).json({ error: 'Site not found' });
    updateSite(db, id, req.body ?? {});
    res.json(getSite(db, id));
  });
  app.delete('/api/sites/:id', (req, res) => {
    deleteSite(db, Number(req.params.id));
    res.status(204).end();
  });

  // --- runs ---
  app.post('/api/runs', (req, res) => {
    if (current.running) return res.status(409).json({ error: 'A run is already in progress' });
    current.running = true;
    // Fix 5: reset runId when a new run starts
    current.runId = null;
    current.events = [];
    // optional: run only specific sites (per-site Scrape button)
    const siteIds = Array.isArray(req.body?.siteIds) ? req.body.siteIds : undefined;
    // Fix 5: use Promise.resolve().then() so a synchronous throw doesn't leave running=true
    Promise.resolve().then(() => runExecutor(db, {
      siteIds,
      onProgress: (e) => {
        current.events.push(e);
        // Fix 5: cap events at 2000 to avoid unbounded memory growth
        if (current.events.length > 2000) current.events.shift();
      },
    }))
      .then((runId) => { current.runId = runId; })
      .catch((err) => current.events.push({ phase: 'fatal', error: err.message }))
      .finally(() => { current.running = false; });
    // Fix 7: respond with { started: true } instead of { runId: 'pending' }
    res.status(202).json({ started: true });
  });
  app.get('/api/runs/current', (req, res) =>
    res.json({ running: current.running, runId: current.runId, events: current.events.slice(-200) }));
  app.get('/api/runs', (req, res) => res.json(listRuns(db)));

  // --- results & export ---
  app.get('/api/results', (req, res) => res.json(latestSnapshot(db)));
  app.get('/api/export/latest.csv', (req, res) => {
    // UTF-8 BOM so Excel on Windows decodes £ correctly
    res.type('text/csv').attachment('latest-prices.csv')
      .send('﻿' + rowsToCsv(latestSnapshot(db), SNAPSHOT_COLUMNS));
  });
  app.get('/api/export/latest.xlsx', async (req, res) => {
    const buf = await rowsToXlsxBuffer(latestSnapshot(db), SNAPSHOT_COLUMNS);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .attachment('latest-prices.xlsx').send(Buffer.from(buf));
  });
  app.get('/api/export/history.csv', (req, res) => {
    // UTF-8 BOM so Excel on Windows decodes £ correctly
    res.type('text/csv').attachment('price-history.csv')
      .send('﻿' + rowsToCsv(fullHistory(db), HISTORY_COLUMNS));
  });

  // --- my parts ---
  app.post('/api/parts', uploadSingle, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    try {
      const parts = await parsePartsUpload(req.file);
      // Fix 2: reject empty uploads — never wipe the parts list with zero rows
      if (parts.length === 0) {
        return res.status(400).json({ error: 'No part numbers found in file' });
      }
      replaceMyParts(db, parts);
      res.json({ count: parts.length });
    } catch (err) {
      if (err.code === 'UNSUPPORTED_FILE_TYPE') {
        return res.status(400).json({ error: err.message });
      }
      res.status(400).json({ error: `Could not parse file: ${err.message}` });
    }
  });
  app.get('/api/parts/missing', (req, res) => res.json(missingMyParts(db)));

  // --- product image harvest ---
  const img = { running: false, siteName: null, stats: null, error: null };
  app.post('/api/images', (req, res) => {
    if (img.running) return res.status(409).json({ error: 'An image harvest is already running' });
    if (current.running) return res.status(409).json({ error: 'Wait for the current scrape to finish first' });
    const site = getSite(db, Number(req.body?.siteId));
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const prefix = String(req.body?.prefix ?? '');
    img.running = true;
    img.siteName = site.name;
    img.stats = null;
    img.error = null;
    Promise.resolve()
      .then(() => harvestImages(db, site, { prefix, onProgress: (s) => { img.stats = s; } }))
      .then((s) => { img.stats = s; })
      .catch((err) => { img.error = err.message; })
      .finally(() => { img.running = false; });
    res.status(202).json({ started: true });
  });
  app.get('/api/images/current', (req, res) => res.json(img));
  app.get('/api/images/archive.zip', (req, res) => {
    if (!existsSync(imagesRoot())) return res.status(404).json({ error: 'No images downloaded yet' });
    res.type('application/zip').attachment('product-images.zip');
    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.on('error', () => res.end());
    archive.directory(imagesRoot(), false);
    archive.pipe(res);
    archive.finalize();
  });

  // --- shower spares map ---
  app.get('/api/spares', (req, res) => res.json(listShowerSpares(db)));
  app.get('/api/export/spares.csv', (req, res) => {
    const cols = [
      { key: 'spare', header: 'Spare Part' },
      { key: 'shower', header: 'Shower' },
      { key: 'sku', header: 'Shower SKU' },
      { key: 'site_name', header: 'Site' },
      { key: 'url', header: 'URL' },
    ];
    res.type('text/csv').attachment('shower-spares.csv')
      .send('﻿' + rowsToCsv(listShowerSpares(db), cols));
  });

  // --- price list comparison (no data is stored; parse and return) ---
  app.post('/api/compare', uploadSingle, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    try {
      const parts = await parseCompareUpload(req.file);
      if (parts.length === 0) return res.status(400).json({ error: 'No part numbers found in file' });
      res.json({ parts });
    } catch (err) {
      res.status(400).json({ error: `Could not parse file: ${err.message}` });
    }
  });

  return app;
}
