import express from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  listSites, createSite, updateSite, deleteSite, getSite,
  listRuns, latestSnapshot, fullHistory, replaceMyParts, missingMyParts,
} from '../db.js';
import { executeRun } from '../crawler/run.js';
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
  if (!['prefix_search', 'link_crawl'].includes(body.strategy)) return 'invalid strategy';
  if (body.strategy === 'prefix_search' && !body.search_url_pattern)
    return 'search_url_pattern required for prefix_search';
  return null;
}

async function parsePartsUpload(file) {
  let rows;
  if (file.originalname.toLowerCase().endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    rows = [];
    wb.worksheets[0].eachRow((row) => rows.push(row.values.slice(1).map((v) => String(v ?? ''))));
  } else {
    rows = parse(file.buffer.toString('utf8'), { skip_empty_lines: true });
  }
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

export function createApp(db, { runExecutor = executeRun } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // in-memory state for the current run
  const current = { running: false, runId: null, events: [] };

  // --- sites ---
  app.get('/api/sites', (req, res) => res.json(listSites(db)));
  app.post('/api/sites', (req, res) => {
    const err = validateSite(req.body);
    if (err) return res.status(400).json({ error: err });
    const id = createSite(db, req.body);
    res.status(201).json(getSite(db, id));
  });
  app.put('/api/sites/:id', (req, res) => {
    const err = validateSite(req.body);
    if (err) return res.status(400).json({ error: err });
    updateSite(db, Number(req.params.id), req.body);
    res.json(getSite(db, Number(req.params.id)));
  });
  app.delete('/api/sites/:id', (req, res) => {
    deleteSite(db, Number(req.params.id));
    res.status(204).end();
  });

  // --- runs ---
  app.post('/api/runs', (req, res) => {
    if (current.running) return res.status(409).json({ error: 'A run is already in progress' });
    current.running = true;
    current.events = [];
    const promise = runExecutor(db, { onProgress: (e) => current.events.push(e) });
    res.status(202).json({ runId: 'pending' });
    promise
      .then((runId) => { current.runId = runId; })
      .catch((err) => current.events.push({ phase: 'fatal', error: err.message }))
      .finally(() => { current.running = false; });
  });
  app.get('/api/runs/current', (req, res) =>
    res.json({ running: current.running, runId: current.runId, events: current.events.slice(-200) }));
  app.get('/api/runs', (req, res) => res.json(listRuns(db)));

  // --- results & export ---
  app.get('/api/results', (req, res) => res.json(latestSnapshot(db)));
  app.get('/api/export/latest.csv', (req, res) => {
    res.type('text/csv').attachment('latest-prices.csv')
      .send('﻿' + rowsToCsv(latestSnapshot(db), SNAPSHOT_COLUMNS));
  });
  app.get('/api/export/latest.xlsx', async (req, res) => {
    const buf = await rowsToXlsxBuffer(latestSnapshot(db), SNAPSHOT_COLUMNS);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .attachment('latest-prices.xlsx').send(Buffer.from(buf));
  });
  app.get('/api/export/history.csv', (req, res) => {
    res.type('text/csv').attachment('price-history.csv')
      .send('﻿' + rowsToCsv(fullHistory(db), HISTORY_COLUMNS));
  });

  // --- my parts ---
  app.post('/api/parts', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    try {
      const parts = await parsePartsUpload(req.file);
      replaceMyParts(db, parts);
      res.json({ count: parts.length });
    } catch (err) {
      res.status(400).json({ error: `Could not parse file: ${err.message}` });
    }
  });
  app.get('/api/parts/missing', (req, res) => res.json(missingMyParts(db)));

  return app;
}
