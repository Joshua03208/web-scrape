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
  // Fix 2: reject unsupported file types
  const name = file.originalname.toLowerCase();
  if (!name.endsWith('.csv') && !name.endsWith('.xlsx')) {
    const err = new Error('Unsupported file type — save as .csv or .xlsx');
    err.code = 'UNSUPPORTED_FILE_TYPE';
    throw err;
  }

  let rows;
  if (name.endsWith('.xlsx')) {
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
    // Fix 5: use Promise.resolve().then() so a synchronous throw doesn't leave running=true
    Promise.resolve().then(() => runExecutor(db, {
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
    res.type('text/csv').attachment('latest-prices.csv')
      // Fix 7: replaced invisible BOM literal with escape sequence (byte-identical)
      .send('﻿' + rowsToCsv(latestSnapshot(db), SNAPSHOT_COLUMNS));
  });
  app.get('/api/export/latest.xlsx', async (req, res) => {
    const buf = await rowsToXlsxBuffer(latestSnapshot(db), SNAPSHOT_COLUMNS);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .attachment('latest-prices.xlsx').send(Buffer.from(buf));
  });
  app.get('/api/export/history.csv', (req, res) => {
    res.type('text/csv').attachment('price-history.csv')
      // Fix 7: replaced invisible BOM literal with escape sequence (byte-identical)
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

  return app;
}
